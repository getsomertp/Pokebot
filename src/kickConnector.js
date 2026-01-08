// src/kickConnector.js
'use strict';

const WebSocket = require('ws');

const PUSHER_WS =
  'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false';

let ws = null;
let stopped = false;
let args = null;
let attempts = 0;

function jparse(x) {
  try { return JSON.parse(x); } catch (e) { return null; }
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

/**
 * Kick-safe connector: requires chatroomId from DB/env (no Kick HTTP calls).
 *
 * options:
 * - chatroomId (required)
 * - channelId (optional)
 * - onMessage (function)
 */
async function startKickConnector(options) {
  const chatroomId = Number(options && options.chatroomId);
  const channelId = options && options.channelId ? Number(options.channelId) : null;
  const onMessage = options && options.onMessage ? options.onMessage : null;

  if (!chatroomId || !Number.isFinite(chatroomId)) {
    throw new Error('Missing chatroomId (store it in Postgres tokens table as kick:chatroom_id)');
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
