// kickConnector.js (ws-only wrapper, no Playwright)
const axios = require('axios');

let connectionInstance = null;

/**
 * startKickConnector({ pool, channel, onMessage, clientId, clientSecret })
 *
 * - Uses @pagoru/kick_live_ws to subscribe to chat messages without Playwright.
 * - Falls back to no-op if the module isn't available.
 */
async function startKickConnector({ pool, channel, onMessage, clientId, clientSecret }) {
  if (!channel) {
    console.log('KICK channel not configured (KICK_CHANNEL). Kick connector will not start.');
    return null;
  }

  let WebSocketConnection, MessageEvents;
  try {
    ({ WebSocketConnection, MessageEvents } = require('@pagoru/kick_live_ws'));
  } catch (err) {
    console.warn('@pagoru/kick_live_ws not available or failed to import. Kick websocket connector will not start.');
    console.warn(err);
    return null;
  }

  // create connection; the constructor accepts { name: channel } or { chatroom: chatroomId }
  const conn = new WebSocketConnection({ name: channel });

  conn.on('connected', (info) => {
    console.log('Kick WS connector connected', info);
  });

  conn.on('error', (err) => {
    console.error('Kick WS connector error', err);
  });

  // Message event name depends on library; expose a few fallbacks.
  const CHAT_EVENT = MessageEvents?.CHATMESSAGE ?? 'chatMessage';

  conn.on(CHAT_EVENT, (data) => {
    try {
      // try to handle several shapes from different wrapper versions
      const username = data?.sender?.username ?? data?.username ?? data?.user ?? 'unknown';
      const content = data?.content ?? data?.message ?? data?.text ?? '';
      if (onMessage && typeof onMessage === 'function') onMessage(username, content, data);
    } catch (e) {
      console.error('Error handling incoming chat message', e);
    }
  });

  try {
    await conn.connect();
    connectionInstance = conn;
    console.log('Kick websocket connector started for channel', channel);
  } catch (err) {
    console.error('Failed to connect to Kick websocket:', err);
    return null;
  }

  // sendToChat: try connector send methods if available, otherwise fallback to HTTP with token
  async function sendToChat(text) {
    try {
      if (conn && typeof conn.send === 'function') {
        await conn.send(text);
        return true;
      }
      if (conn && typeof conn.sendMessage === 'function') {
        await conn.sendMessage(text);
        return true;
      }
    } catch (err) {
      console.warn('Connector send failed, falling back to HTTP send if token available', err);
    }

    // HTTP fallback (uses Kick API and stored tokens) - try best-effort
    try {
      const res = await pool.query(`SELECT value FROM tokens WHERE key = $1`, ['kick:access_token']);
      if (res.rowCount === 0) {
        console.warn('No Kick access token found in DB; cannot send chat message.');
        return false;
      }
      const accessToken = res.rows[0].value;
      const channelRes = await axios.get(`https://kick.com/api/v2/channels/${encodeURIComponent(channel)}`);
      const chatroomId = channelRes.data?.data?.chatroom?.id;
      if (!chatroomId) {
        console.warn('Could not obtain chatroom id for channel', channel);
        return false;
      }
      const postUrl = `https://kick.com/api/v2/chat/${chatroomId}/message`;
      await axios.post(postUrl, { message: text }, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });
      return true;
    } catch (err) {
      console.warn('HTTP send fallback failed (Kick API may differ).', err?.response?.data ?? err.message);
      return false;
    }
  }

  return { conn, sendToChat };
}

async function stopKickConnector() {
  try {
    if (connectionInstance && typeof connectionInstance.disconnect === 'function') {
      await connectionInstance.disconnect();
    }
  } catch (err) {
    console.warn('Error stopping Kick connector', err);
  } finally {
    connectionInstance = null;
  }
}

module.exports = { startKickConnector, stopKickConnector };
