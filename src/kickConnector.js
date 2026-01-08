const axios = require('axios');
const tokenManager = require('./tokenManager');

let connectionInstance = null;

async function startKickConnector({ pool, channel, onMessage, sendMessageCallback, clientId, clientSecret }) {
  if (!channel) {
    console.log('KICK channel not configured (KICK_CHANNEL). Kick connector will not start.');
    return null;
  }

  let KickConnection, Events;
  try {
    ({ KickConnection, Events } = require('kick-live-connector'));
  } catch (err) {
    console.warn('kick-live-connector not available or failed to import. Install it to use real-time Kick chat. Falling back to HTTP-only testing.');
    console.warn(err);
    return null;
  }

  const conn = new KickConnection(channel);

  conn.on(Events.Connected, (info) => {
    console.log('Kick connector connected to', info.roomID || channel);
  });

  conn.on(Events.Error, (err) => {
    console.error('Kick connector error', err);
  });

  conn.on(Events.ChatMessage, (data) => {
    try {
      const username = data.sender?.username ?? data.username ?? data.user ?? 'unknown';
      const content = data.content ?? data.message ?? data.text ?? '';
      if (onMessage && typeof onMessage === 'function') {
        onMessage(username, content, data);
      }
    } catch (e) {
      console.error('Error handling incoming chat message', e);
    }
  });

  try {
    await conn.connect();
    connectionInstance = conn;
    console.log('Kick connector started for channel', channel);
  } catch (err) {
    console.error('Failed to connect to Kick chat:', err);
    return null;
  }

  async function sendToChat(text) {
    try {
      if (conn && typeof conn.sendMessage === 'function') {
        await conn.sendMessage(text);
        return true;
      }
      if (conn && typeof conn.send === 'function') {
        await conn.send(text);
        return true;
      }
    } catch (err) {
      console.warn('Connector send failed; falling back to HTTP send if token available', err);
    }

    try {
      const accessToken = await tokenManager.getValidAccessToken(pool, clientId, clientSecret);
      if (!accessToken) {
        console.warn('No Kick access token available; cannot send chat message.');
        return false;
      }

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
