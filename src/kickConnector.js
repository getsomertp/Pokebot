// src/kickConnector.js
'use strict';

const axios = require('axios');
const WebSocket = require('ws');

const PUSHER_WS =
  'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false';

let ws = null;
let stopped = false;
let args = null;
let attempts = 0;

function headers() {
  return { 'User-Agent': 'Mozilla/5.0 (KickBot/1.0)', Accept: 'application/json' };
}

function jparse(x) {
  try { return JSON.parse(x); } catch (e) { return null; }
}

async function getChannel(channel) {
  const url = `https://kick.com/api/v2/channels/${encodeURIComponent(channel)}`;
  const res = await axios.get(url, { headers: headers(), timeout: 15000 });
  return res && res.data && res.data.data ? res.data.data : null;
}

function cleanup() {
  if (!ws) return;
  try { ws.removeAllListeners(); } catch (e) {}
  try { ws.terminate(); } catch (e) {}
  ws = null;
}

function reconnect() {
  if (stopped || !args) return;
  attempts += 1;
  const exp = Math.min(attempts, 6);
  const base = 1000 * Math.pow(2, exp);
  const delay = Math.min(30000, base + Math.floor(Math.random() * 400));
  console.warn(`Kick WS reconnect in ${delay}ms (attempt ${attempts})`);
  setTimeout(function () {
    if (!stopped) connect(args);
  }, delay);
}

function connect(a) {
  cleanup();
  args = a;

  ws = new WebSocket(PUSHER_WS, { perMessageDeflate: false });

  ws.on('open', function () {
    attempts = 0;
    console.log('Kick websocket connected');

    ws.send(JSON.stringify({
      event: 'pusher:subscribe',
      data: { channel: `chatrooms.${a.chatroomId}.v2` }
    }));

    if (a.channelId) {
      ws.send(JSON.stringify({
        event: 'pusher:subscribe',
        data: { channel: `channel.${a.channelId}` }
      }));
    }
  });

  ws.on('message', function (buf) {
    const outer = jparse(buf.toString());
    if (!outer) return;

    let payload = outer.data;
    if (typeof payload === 'string') payload = jparse(payload);
    if (!payload) return;

    const content = payload.content || payload.message || payload.text || payload.body;
    const username =
      (payload.sender && payload.sender.username) ||
      (payload.user && payload.user.username) ||
      payload.user ||
      payload.displayName;

    if (content && username && typeof a.onMessage === 'function') {
      a.onMessage(String(username), String(content), payload);
    }
  });

  ws.on('close', function () {
    console.warn('Kick websocket closed');
    reconnect();
  });

  ws.on('error', function (err) {
    console.warn('Kick websocket error:', err && err.message ? err.message : err);
    try { ws.close(); } catch (e) {}
  });
}

async function startKickConnector(options) {
  const channel = options && options.channel ? options.channel : '';
  const onMessage = options && options.onMessage ? options.onMessage : null;

  if (!channel) {
    console.log('KICK_CHANNEL not set; Kick connector will not start.');
    return null;
  }

  const info = await getChannel(channel);
  const chatroomId = info && info.chatroom ? info.chatroom.id : null;
  const channelId = info && info.id ? info.id : null;

  if (!chatroomId) {
    throw new Error(`Could not determine chatroom id for channel: ${channel}`);
  }

  stopped = false;
  connect({ chatroomId: chatroomId, channelId: channelId, onMessage: onMessage });

  return { stop: stopKickConnector };
}

function stopKickConnector() {
  stopped = true;
  args = null;
  cleanup();
}

module.exports = { startKickConnector, stopKickConnector };
