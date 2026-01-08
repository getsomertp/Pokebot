// src/kickConnector.js
// Minimal websocket connector to Kick chat (no Playwright).
// - Uses Kick channel API to find chatroom ID, then connects to Pusher websocket endpoint.
// - Listens for chat messages and forwards them to onMessage(username, message, raw).
// - Provides sendToChat(text) which prefers websocket send (if possible) else HTTP fallback using tokenManager.

const axios = require('axios');
const WebSocket = require('ws');
const tokenManager = require('./tokenManager');

let wsInstance = null;
let wsConnected = false;

// Known Pusher endpoint used by Kick (may change in the future)
const PUSHER_WS = 'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0-rc2&flash=false';

async function startKickConnector({ pool, channel, onMessage, clientId, clientSecret }) {
  if (!channel) {
    console.log('KICK channel not configured (KICK_CHANNEL). Kick connector will not start.');
    return null;
  }

  // Step 1: fetch channel info to get chatroom id and channel id
  let chatroomId = null;
  let channelId = null;
  try {
    const res = await axios.get(   `https://kick.com/api/v2/channels/${encodeURIComponent(channel)}`,   {     timeout: 10000,     headers: {       'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',       'Accept': 'application/json',       'Content-Type': 'application/json'     }   } );
    const data = res.data?.data;
    chatroomId = data?.chatroom?.id;
    channelId = data?.id ?? data?.channel_id ?? null;
    if (!chatroomId) {
      console.warn('Could not determine chatroom id for channel', channel);
      return null;
    }
  } catch (err) {
    console.warn('Failed to fetch channel info from Kick API:', err?.response?.data ?? err.message);
    return null;
  }

  // Step 2: connect to pusher websocket endpoint
  const ws = new WebSocket(PUSHER_WS, { perMessageDeflate: false });
  wsInstance = ws;

  ws.on('open', () => {
    wsConnected = true;
    console.log('Kick websocket connected.');
    // subscribe to chatroom and channel topics
    try {
      const subscribeChatroom = { event: 'pusher:subscribe', data: { channel: `chatrooms.${chatroomId}.v2` } };
      ws.send(JSON.stringify(subscribeChatroom));
      if (channelId) {
        const subscribeChannel = { event: 'pusher:subscribe', data: { channel: `channel.${channelId}` } };
        ws.send(JSON.stringify(subscribeChannel));
      }
    } catch (e) {
      console.warn('Error sending subscribe messages', e);
    }
  });

  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());
      const event = parsed.event;
      const data = parsed.data;
      if (!event || !data) return;

      // data may be a JSON string
      let payload = data;
      if (typeof data === 'string') {
        try { payload = JSON.parse(data); } catch (e) { payload = data; }
      }

      // Determine event type from 'event' string; try to split by backslash
      const parts = String(event).split('\\');
      const type = parts[2] ?? parts[1] ?? parts[0];

      if (type && (type.toLowerCase().includes('chatmessage') || type.includes('ChatMessageEvent'))) {
        // attempt to extract message and sender
        const content = payload?.content ?? payload?.message ?? payload?.text ?? payload?.message?.content ?? payload?.body ?? '';
        const username = payload?.sender?.username ?? payload?.user ?? payload?.displayName ?? payload?.senderUsername ?? 'unknown';
        if (onMessage && typeof onMessage === 'function') {
          onMessage(username, content, payload);
        }
      }
    } catch (err) {
      // ignore non-critical parse errors
    }
  });

  ws.on('error', (err) => {
    console.error('Kick websocket error', err);
  });

  ws.on('close', () => {
    wsConnected = false;
    console.log('Kick websocket closed.');
    wsInstance = null;
  });

  // sendToChat: best-effort posting to chat (try websocket, then HTTP fallback with token)
  async function sendToChat(text) {
    try {
      if (wsConnected && ws && typeof ws.send === 'function') {
        try {
          ws.send(JSON.stringify({ event: 'chat_msg', data: { message: text } }));
          return true;
        } catch (e) {
          // try HTTP fallback
        }
      }
    } catch (e) {
      // fallback
    }

    // HTTP fallback using stored tokens
    try {
      const accessToken = await tokenManager.getValidAccessToken(pool, clientId, clientSecret);
      if (!accessToken) {
        console.warn('No access token available for HTTP chat send.');
        return false;
      }
      const channelRes = await axios.get(`https://kick.com/api/v2/channels/${encodeURIComponent(channel)}`);
      const chatroomId = channelRes.data?.data?.chatroom?.id;
      if (!chatroomId) {
        console.warn('Could not obtain chatroom id for HTTP send fallback.');
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
      console.warn('HTTP send fallback failed:', err?.response?.data ?? err.message);
      return false;
    }
  }

  return { conn: ws, sendToChat };
}

async function stopKickConnector() {
  try {
    if (wsInstance) {
      wsInstance.close();
      wsInstance = null;
      wsConnected = false;
    }
  } catch (err) {
    console.warn('Error stopping Kick connector', err);
  }
}

module.exports = { startKickConnector, stopKickConnector };
