require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { initPool, runMigrations } = require('./db');
const GameEngine = require('./gameEngine');
const { startKickConnector } = require('./kickConnector');
const axios = require('axios');
const crypto = require('crypto');
const tokenManager = require('./tokenManager');

const PORT = process.env.PORT || 3000;
const BOT_ADMIN_SECRET = process.env.BOT_ADMIN_SECRET || 'dev_secret';
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI; // must match Kick app redirect
const KICK_CHANNEL = process.env.KICK_CHANNEL; // streamer username to connect to

const oauthStateStore = new Map();

async function main() {
  const pool = initPool();
  await runMigrations();

  const engine = new GameEngine(pool, {
    spawnDuration: Number(process.env.SPAWN_DURATION ?? 30),
    minInterval: Number(process.env.SPAWN_MIN_INTERVAL ?? 30),
    maxInterval: Number(process.env.SPAWN_MAX_INTERVAL ?? 120),
    cooldownSeconds: Number(process.env.COOLDOWN_SECONDS ?? 5),
    shinyRate: Number(process.env.SHINY_RATE ?? (1/4096))
  });

  await engine.ensureSamplePokemon();

  const stopRefreshScheduler = tokenManager.schedulePeriodicRefresh(pool, CLIENT_ID, CLIENT_SECRET);

  const app = express();
  app.use(bodyParser.json());

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.post('/admin/spawn', async (req, res) => {
    const secret = req.headers['x-admin-secret'] || req.body.secret;
    if (secret !== BOT_ADMIN_SECRET) return res.status(403).json({ error: 'forbidden' });
    const pokemonId = req.body.pokemonId ?? null;
    try {
      const spawn = await engine.spawnOnce(pokemonId);
      if (!spawn) return res.json({ ok: false, reason: 'already_active' });
      if (connectorSend) connectorSend(`A wild ${spawn.name} appeared! Type !catch to try to catch it!`);
      return res.json({ ok: true, spawn });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'server_error' });
    }
  });

  app.post('/admin/clear', async (req, res) => {
    const secret = req.headers['x-admin-secret'] || req.body.secret;
    if (secret !== BOT_ADMIN_SECRET) return res.status(403).json({ error: 'forbidden' });
    try {
      const now = new Date();
      await pool.query(`UPDATE spawns SET expires_at = $1 WHERE captured_by IS NULL AND expires_at > $1`, [now.toISOString()]);
      return res.json({ ok: true });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'server_error' });
    }
  });

  app.get('/leaderboard', async (req, res) => {
    const rows = await engine.leaderboard(20);
    res.json(rows);
  });

  app.get('/pokedex/:userId', async (req, res) => {
    const rows = await engine.getPokedex(req.params.userId);
    res.json(rows);
  });

  app.post('/chat', async (req, res) => {
    const { username, message } = req.body;
    if (!username || !message) return res.status(400).json({ error: 'username and message are required' });

    const lower = message.trim().toLowerCase();
    if (lower === '!catch') {
      try {
        const userId = username.toLowerCase();
        const result = await engine.attemptCatch(userId, { ball: 'pokeball' });
        if (result.ok) {
          const text = `${username} caught ${result.pokemon.name}${result.shiny ? ' (shiny!)' : ''}!`;
          console.log('[BOT]', text);
          if (connectorSend) connectorSend(text);
          return res.json({ ok: true, message: text, result });
        } else {
          let text;
          if (result.reason === 'no_spawn') text = `${username}, there's nothing to catch right now.`;
          else if (result.reason === 'already_captured') text = `${username}, someone already caught it.`;
          else if (result.reason === 'cooldown') text = `${username}, you're on cooldown.`;
          else if (result.reason === 'failed') text = `${username} tried to catch it but failed.`;
          else text = `${username}: ${result.reason}`;
          console.log('[BOT]', text);
          if (connectorSend) connectorSend(text);
          return res.json({ ok: false, message: text, result });
        }
      } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'server_error' });
      }
    } else if (lower === '!pokedex') {
      const userId = username.toLowerCase();
      const rows = await engine.getPokedex(userId);
      return res.json({ ok: true, pokedex: rows });
    } else if (lower === '!leaderboard') {
      const rows = await engine.leaderboard(10);
      return res.json({ ok: true, leaderboard: rows });
    }

    return res.json({ ok: true, echo: true });
  });

  app.get('/kick/auth', (req, res) => {
    if (!CLIENT_ID || !REDIRECT_URI) return res.status(500).send('CLIENT_ID and REDIRECT_URI must be configured');
    const state = crypto.randomBytes(12).toString('hex');
    oauthStateStore.set(state, Date.now());
    const scope = encodeURIComponent('chat:read chat:write');
    const authUrl = `https://id.kick.com/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${scope}&state=${state}`;
    res.redirect(authUrl);
  });

  app.get('/kick/callback', async (req, res) => {
    const code = req.query.code;
    const state = req.query.state;
    if (!code || !state) return res.status(400).send('Missing code or state');
    if (!oauthStateStore.has(state)) return res.status(400).send('Invalid state');
    oauthStateStore.delete(state);

    if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
      return res.status(500).send('CLIENT_ID, CLIENT_SECRET, and REDIRECT_URI must be configured in environment');
    }

    try {
      const params = new URLSearchParams();
      params.append('grant_type', 'authorization_code');
      params.append('code', code);
      params.append('redirect_uri', REDIRECT_URI);
      params.append('client_id', CLIENT_ID);
      params.append('client_secret', CLIENT_SECRET);

      const tokenResp = await axios.post('https://id.kick.com/oauth/token', params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });

      const data = tokenResp.data;
      await pool.query(`INSERT INTO tokens (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, ['kick:access_token', data.access_token]);
      if (data.refresh_token) {
        await pool.query(`INSERT INTO tokens (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, ['kick:refresh_token', data.refresh_token]);
      }
      if (data.expires_in) {
        const expiresAt = new Date(Date.now() + Number(data.expires_in) * 1000).toISOString();
        await pool.query(`INSERT INTO tokens (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, ['kick:access_expires_at', expiresAt]);
      }
      res.send('Kick authorization successful. You can close this window.');
    } catch (err) {
      console.error('OAuth token exchange failed', err?.response?.data ?? err.message);
      res.status(500).send('OAuth token exchange failed. Check server logs.');
    }
  });

  let connectorSend = null;
  try {
    const connector = await startKickConnector({
      pool,
      channel: KICK_CHANNEL,
      onMessage: async (username, message, raw) => {
        try {
          const lower = (message ?? '').trim().toLowerCase();
          if (lower === '!catch') {
            const userId = username.toLowerCase();
            const result = await engine.attemptCatch(userId, { ball: 'pokeball' });
            if (result.ok) {
              const text = `${username} caught ${result.pokemon.name}${result.shiny ? ' (shiny!)' : ''}!`;
              console.log('[BOT]', text);
              if (connectorSend) connectorSend(text);
            } else {
              let text;
              if (result.reason === 'no_spawn') text = `${username}, there's nothing to catch right now.`;
              else if (result.reason === 'already_captured') text = `${username}, someone already caught it.`;
              else if (result.reason === 'cooldown') text = `${username}, you're on cooldown.`;
              else if (result.reason === 'failed') text = `${username} tried to catch it but failed.`;
              else text = `${username}: ${result.reason}`;
              console.log('[BOT]', text);
              if (connectorSend) connectorSend(text);
            }
          } else if (lower === '!pokedex') {
            const rows = await engine.getPokedex(username.toLowerCase());
            const list = rows.map(r => `${r.name} x${r.count}${r.shiny_count ? ' (shiny x' + r.shiny_count + ')' : ''}`).join(', ');
            const text = list.length ? `${username}'s pokedex: ${list}` : `${username}, your pokedex is empty.`;
            if (connectorSend) connectorSend(text);
          } else if (lower === '!leaderboard') {
            const rows = await engine.leaderboard(10);
            const text = rows.map((r, i) => `${i+1}. ${r.user_id} — ${r.total_caught} (shiny ${r.shiny_total})`).join(' | ');
            if (connectorSend) connectorSend(`Leaderboard: ${text}`);
          }
        } catch (err) {
          console.error('Error processing chat message', err);
        }
      },
      sendMessageCallback: null,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET
    });

    if (connector && connector.sendToChat) {
      connectorSend = connector.sendToChat;
    } else {
      connectorSend = (text) => {
        console.log('[BOT-SAY]', text);
        return false;
      };
    }
  } catch (err) {
    console.warn('Kick connector not started:', err);
  }

  engine.startAutoSpawner((spawn) => {
    const text = `A wild ${spawn.name} appeared! Type !catch to try to catch it!`;
    console.log('[SPAWN]', text);
    if (connectorSend) connectorSend(text);
  });

  app.listen(PORT, () => {
    console.log(`Server listening on ${PORT}`);
    if (!CLIENT_ID) console.log('Warning: CLIENT_ID not set; /kick/auth will not work until CLIENT_ID is configured.');
    if (!KICK_CHANNEL) console.log('Warning: KICK_CHANNEL not set; Kick chat connector will not start until configured.');
  });

  process.on('SIGINT', () => {
    try { stopRefreshScheduler && stopRefreshScheduler(); } catch {}
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Fatal startup error', err);
  process.exit(1);
});
