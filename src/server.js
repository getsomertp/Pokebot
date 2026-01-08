/**
 * src/server.js — Railway-safe Kick Pokémon Bot (copy/paste full file)
 *
 * What this version does:
 * - Fixes your crash (no routes defined outside app scope)
 * - Keeps /kick/auth and /kick/callback working
 * - Uses WebSocket connector for READING chat (auto-reconnect handled in kickConnector.js)
 * - Uses HTTP send queue for WRITING chat (rate-limit + retry + token refresh)
 * - Caches chatroom_id in Postgres to avoid repeated channel lookups
 *
 * Required env vars on Railway:
 * - DATABASE_URL (from Railway Postgres)
 * - PORT (Railway sets this automatically)
 * - BOT_ADMIN_SECRET (set a random string)
 * - CLIENT_ID, CLIENT_SECRET, REDIRECT_URI (Kick OAuth)
 * - KICK_CHANNEL (streamer username)
 */

'use strict';

require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const crypto = require('crypto');

const { initPool, runMigrations } = require('./db');
const GameEngine = require('./gameEngine');
const tokenManager = require('./tokenManager');
const { startKickConnector } = require('./kickConnector');

const PORT = Number(process.env.PORT || 3000);

const BOT_ADMIN_SECRET = process.env.BOT_ADMIN_SECRET || 'dev_secret';
const CLIENT_ID = process.env.CLIENT_ID || '';
const CLIENT_SECRET = process.env.CLIENT_SECRET || '';
const REDIRECT_URI = process.env.REDIRECT_URI || '';
const KICK_CHANNEL = process.env.KICK_CHANNEL || '';

const oauthStateStore = new Map();

/** Kick tends to dislike “unknown” clients from cloud IPs; set a stable UA */
function kickHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (KickBot/1.0)',
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

/**
 * Chat sender:
 * - Queues messages
 * - Sends via Kick HTTP API using OAuth token
 * - Retries with backoff on 401 / 429 / transient failures
 * - Caches chatroom_id in Postgres (tokens table) to reduce Kick HTTP calls
 */
function createChatSender({ pool, channel, getClientCreds }) {
  let sending = false;
  const q = [];
  let cachedChatroomId = null;

  async function getChatroomId() {
    if (cachedChatroomId) return cachedChatroomId;

    // Try DB cache first
    const cached = await pool.query(
      `SELECT value FROM tokens WHERE key = $1`,
      ['kick:chatroom_id']
    );
    if (cached.rowCount) {
      const v = Number(cached.rows[0].value);
      if (Number.isFinite(v) && v > 0) {
        cachedChatroomId = v;
        return cachedChatroomId;
      }
    }

    // One-time fallback: fetch channel info (may be blocked on some cloud IPs)
    const res = await axios.get(
      `https://kick.com/api/v2/channels/${encodeURIComponent(channel)}`,
      { headers: kickHeaders(), timeout: 15000 }
    );

    const id = res.data?.data?.chatroom?.id;
    if (!id) throw new Error('Could not determine Kick chatroom id (Kick blocked or channel not found).');

    cachedChatroomId = Number(id);

    // Store to DB
    await pool.query(
      `INSERT INTO tokens (key,value) VALUES ($1,$2)
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
      ['kick:chatroom_id', String(cachedChatroomId)]
    );

    return cachedChatroomId;
  }

  async function sendNow(text) {
    const { clientId, clientSecret } = getClientCreds();
    const accessToken = await tokenManager.getValidAccessToken(pool, clientId, clientSecret);
    if (!accessToken) throw new Error('No access token available for chat send.');

    const chatroomId = await getChatroomId();
    const postUrl = `https://kick.com/api/v2/chat/${chatroomId}/message`;

    const resp = await axios.post(
      postUrl,
      { message: text },
      {
        timeout: 15000,
        headers: { ...kickHeaders(), Authorization: `Bearer ${accessToken}` },
        validateStatus: () => true,
      }
    );

    // Handle common failure modes
    if (resp.status === 429) {
      const retryAfter = Number(resp.headers?.['retry-after'] ?? 2);
      const waitMs = Math.min(10000, Math.max(1000, retryAfter * 1000));
      await new Promise((r) => setTimeout(r, waitMs));
      throw new Error('rate_limited');
    }

    if (resp.status === 401) {
      // Force refresh and retry
      await tokenManager.refreshAccessToken(pool, clientId, clientSecret);
      throw new Error('unauthorized_retry');
    }

    if (resp.status < 200 || resp.status >= 300) {
      const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data ?? {});
      throw new Error(`kick_send_failed_${resp.status}:${body.slice(0, 200)}`);
    }

    return true;
  }

  async function pump() {
    if (sending) return;
    sending = true;

    try {
      while (q.length) {
        const msg = q.shift();
        if (!msg) continue;

        // Retry up to 3 times with exponential backoff
        let attempts = 0;
        while (attempts < 3) {
          attempts += 1;
          try {
            await sendNow(msg);
            break;
          } catch (e) {
            const delay = Math.min(8000, 500 * 2 ** attempts);
            await new Promise((r) => setTimeout(r, delay));

            if (attempts >= 3) {
              console.warn('Dropping message after retries:', msg, e?.message ?? e);
            }
          }
        }

        // Small spacing to reduce rate-limit chance
        await new Promise((r) => setTimeout(r, 350));
      }
    } finally {
      sending = false;
    }
  }

  return {
    send(text) {
      if (!text) return false;
      // Keep messages short/safe
      q.push(String(text).slice(0, 300));
      pump();
      return true;
    },
    async primeChatroomId() {
      try {
        await getChatroomId();
        return true;
      } catch (e) {
        console.warn('Unable to prime chatroom id:', e?.message ?? e);
        return false;
      }
    },
    clearChatroomIdCache() {
      cachedChatroomId = null;
    },
  };
}

async function main() {
  const pool = initPool();
  await runMigrations();

  const engine = new GameEngine(pool, {
    spawnDuration: Number(process.env.SPAWN_DURATION ?? 30),
    minInterval: Number(process.env.SPAWN_MIN_INTERVAL ?? 30),
    maxInterval: Number(process.env.SPAWN_MAX_INTERVAL ?? 120),
    cooldownSeconds: Number(process.env.COOLDOWN_SECONDS ?? 5),
    shinyRate: Number(process.env.SHINY_RATE ?? 1 / 4096),
  });

  await engine.ensureSamplePokemon();

  // Start periodic refresh; it will warn until OAuth is completed (refresh token exists)
  const stopRefreshScheduler = tokenManager.schedulePeriodicRefresh(
    pool,
    CLIENT_ID,
    CLIENT_SECRET
  );

  const app = express();
  app.use(bodyParser.json());

  // Chat sender (HTTP) used by both the websocket handler and admin endpoints
  const chatSender = createChatSender({
    pool,
    channel: KICK_CHANNEL,
    getClientCreds: () => ({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
  });

  // Health
  app.get('/health', (req, res) => res.json({ ok: true }));

  // ---------- Admin endpoints ----------
  app.post('/admin/spawn', async (req, res) => {
    const secret = req.headers['x-admin-secret'] || req.body?.secret;
    if (secret !== BOT_ADMIN_SECRET) return res.status(403).json({ error: 'forbidden' });

    const pokemonId = req.body?.pokemonId ?? null;
    try {
      const spawn = await engine.spawnOnce(pokemonId);
      if (!spawn) return res.json({ ok: false, reason: 'already_active' });

      chatSender.send(`A wild ${spawn.name} appeared! Type !catch to try to catch it!`);
      return res.json({ ok: true, spawn });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'server_error' });
    }
  });

  app.post('/admin/clear', async (req, res) => {
    const secret = req.headers['x-admin-secret'] || req.body?.secret;
    if (secret !== BOT_ADMIN_SECRET) return res.status(403).json({ error: 'forbidden' });

    try {
      const now = new Date();
      await pool.query(
        `UPDATE spawns
         SET expires_at = $1
         WHERE captured_by IS NULL AND expires_at > $1`,
        [now.toISOString()]
      );
      return res.json({ ok: true });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'server_error' });
    }
  });

  // ---------- Public endpoints ----------
  app.get('/leaderboard', async (req, res) => {
    const rows = await engine.leaderboard(20);
    res.json(rows);
  });

  app.get('/pokedex/:userId', async (req, res) => {
    const rows = await engine.getPokedex(req.params.userId);
    res.json(rows);
  });

  // Local testing stub (does not require Kick)
  app.post('/chat', async (req, res) => {
    const { username, message } = req.body || {};
    if (!username || !message) return res.status(400).json({ error: 'username and message are required' });

    await handleChatMessage({ engine, chatSender, username, message });
    return res.json({ ok: true });
  });

  // ---------- Kick OAuth ----------
  app.get('/kick/auth', (req, res) => {
    if (!CLIENT_ID || !REDIRECT_URI) {
      return res.status(500).send('CLIENT_ID and REDIRECT_URI must be configured');
    }

    const state = crypto.randomBytes(12).toString('hex');
    oauthStateStore.set(state, Date.now());

    const scope = encodeURIComponent('chat:read chat:write');
    const authUrl =
      `https://id.kick.com/oauth/authorize` +
      `?client_id=${encodeURIComponent(CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&response_type=code` +
      `&scope=${scope}` +
      `&state=${encodeURIComponent(state)}`;

    res.redirect(authUrl);
  });

  app.get('/kick/callback', async (req, res) => {
    const code = req.query?.code;
    const state = req.query?.state;

    if (!code || !state) return res.status(400).send('Missing code or state');
    if (!oauthStateStore.has(state)) return res.status(400).send('Invalid state');

    oauthStateStore.delete(state);

    if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
      return res.status(500).send('CLIENT_ID, CLIENT_SECRET, and REDIRECT_URI must be configured');
    }

    try {
      const params = new URLSearchParams();
      params.append('grant_type', 'authorization_code');
      params.append('code', String(code));
      params.append('redirect_uri', REDIRECT_URI);
      params.append('client_id', CLIENT_ID);
      params.append('client_secret', CLIENT_SECRET);

      const tokenResp = await axios.post(
        'https://id.kick.com/oauth/token',
        params.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (KickBot/1.0)',
          },
          timeout: 15000,
        }
      );

      const data = tokenResp.data || {};
      if (!data.access_token) {
        console.error('OAuth token exchange missing access_token:', data);
        return res.status(500).send('OAuth token exchange failed: missing access_token');
      }

      await tokenManager.setTokenValue(pool, 'kick:access_token', data.access_token);
      if (data.refresh_token) {
        await tokenManager.setTokenValue(pool, 'kick:refresh_token', data.refresh_token);
      }

      const expiresAt = new Date(
        Date.now() + Number(data.expires_in || 3600) * 1000
      ).toISOString();
      await tokenManager.setTokenValue(pool, 'kick:access_expires_at', expiresAt);

      // Optional: prime cached chatroom id after auth (best effort)
      if (KICK_CHANNEL) await chatSender.primeChatroomId();

      res.send('Kick authorization successful. You can close this window.');
    } catch (err) {
      console.error('OAuth token exchange failed', err?.response?.data ?? err?.message ?? err);
      res.status(500).send('OAuth token exchange failed. Check server logs.');
    }
  });

  // ---------- Kick chat (read via websocket) ----------
  if (KICK_CHANNEL) {
    try {
      await startKickConnector({
        channel: KICK_CHANNEL,
        onMessage: async (username, message) => {
          await handleChatMessage({ engine, chatSender, username, message });
        },
      });
      console.log('Kick connector started for channel:', KICK_CHANNEL);
    } catch (err) {
      console.warn('Kick connector not started:', err?.message ?? err);
    }
  } else {
    console.log('Warning: KICK_CHANNEL not set; Kick chat connector will not start.');
  }

  // ---------- Spawner ----------
  engine.startAutoSpawner((spawn) => {
    const text = `A wild ${spawn.name} appeared! Type !catch to try to catch it!`;
    console.log('[SPAWN]', text);
    chatSender.send(text);
  });

  app.listen(PORT, () => {
    console.log(`Server listening on ${PORT}`);
    if (!CLIENT_ID) console.log('Warning: CLIENT_ID not set; /kick/auth will not work.');
    if (!CLIENT_SECRET) console.log('Warning: CLIENT_SECRET not set; OAuth token exchange will not work.');
    if (!REDIRECT_URI) console.log('Warning: REDIRECT_URI not set; OAuth callback must match Kick app settings.');
  });

  process.on('SIGINT', () => {
    try { stopRefreshScheduler && stopRefreshScheduler(); } catch {}
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    try { stopRefreshScheduler && stopRefreshScheduler(); } catch {}
    process.exit(0);
  });
}

/** Shared chat command handler used by both /chat stub and Kick WS */
async function handleChatMessage({ engine, chatSender, username, message }) {
  try {
    const lower = (message ?? '').trim().toLowerCase();

    if (lower === '!catch') {
      const userId = String(username).toLowerCase();
      const result = await engine.attemptCatch(userId, { ball: 'pokeball' });

      if (result.ok) {
        const text = `${username} caught ${result.pokemon.name}${result.shiny ? ' (shiny!)' : ''}!`;
        console.log('[BOT]', text);
        chatSender.send(text);
      } else {
        let text;
        if (result.reason === 'no_spawn') text = `${username}, there's nothing to catch right now.`;
        else if (result.reason === 'already_captured') text = `${username}, someone already caught it.`;
        else if (result.reason === 'cooldown') text = `${username}, you're on cooldown.`;
        else if (result.reason === 'failed') text = `${username} tried to catch it but failed.`;
        else text = `${username}: ${result.reason}`;
        console.log('[BOT]', text);
        chatSender.send(text);
      }

      return;
    }

    if (lower === '!pokedex') {
      const rows = await engine.getPokedex(String(username).toLowerCase());
      const list = rows
        .map((r) => `${r.name} x${r.count}${r.shiny_count ? ` (shiny x${r.shiny_count})` : ''}`)
        .join(', ');
      const text = list.length ? `${username}'s pokedex: ${list}` : `${username}, your pokedex is empty.`;
      chatSender.send(text);
      return;
    }

    if (lower === '!leaderboard') {
      const rows = await engine.leaderboard(10);
      const text = rows
        .map((r, i) => `${i + 1}. ${r.user_id} — ${r.total_caught} (shiny ${r.shiny_total})`)
        .join(' | ');
      chatSender.send(`Leaderboard: ${text}`);
      return;
    }
  } catch (err) {
    console.error('Error processing chat message', err);
  }
}

main().catch((err) => {
  console.error('Fatal startup error', err);
  process.exit(1);
});
