// src/kickConnector.js
'use strict';

const axios = require('axios');
const WebSocket = require('ws');

// Known Pusher endpoint used by Kick (may change in the future)
const PUSHER_WS =
  'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false';

let ws = null;
let stopped = false;
let reconnectAttempts = 0;
let currentConnArgs = null;

function kickHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (KickBot/1.0)',
    Accept: 'application/json',
  };
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

async function fetchChannelInfo(channel) {
  const url = `https://kick.com/api/v2/channels/${encodeURIComponent(channel)}`;
  const res = await axios.get(url, { headers: kickHeaders(), timeout: 15000 });
  return res.data && res.data.data ? res.data.data : null;
}

function scheduleReconnect() {
  if (stopped || !currentConnArgs) return;

  reconnectAttempts += 1;

  // Exponential backoff with jitter, capped
  const exp = Math.min(reconnectAttempts, 6); // cap exponent
  const base = 1000 * Math.pow(2, exp); // 2s..64s-ish
  const jitter = Math.floor(Math.random() * 500);
  const delay = Math.min(30000, base + jitter);

  console.warn(
    `Kick WS reconnecting in ${delay}ms (attempt ${reconnectAttempts})`
  );

  setTimeout(function () {
    if (stopped) return;
    connectWS(currentConnArgs);
  }, delay);
}

function cleanupWS() {
  if (!ws) return;
  try {
    ws.removeAllListeners();
  } catch (e) {}
  try {
    ws.terminate();
  } catch (e) {}
  ws = null;
}

function connectWS(args) {
  const chatroomId = args.chatroomId;
  const channelId = args.channelId;
  const onMessage = args.onMessage;
