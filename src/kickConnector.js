// src/kickConnector.js
`https://kick.com/api/v2/channels/${encodeURIComponent(channel)}`,
{ headers: kickHeaders(), timeout: 10000 }
);
return res.data?.data;
}


function connect({ chatroomId, channelId, onMessage }) {
ws = new WebSocket(PUSHER_WS, { perMessageDeflate: false });


ws.on('open', () => {
reconnectAttempts = 0;
ws.send(JSON.stringify({
event: 'pusher:subscribe',
data: { channel: `chatrooms.${chatroomId}.v2` }
}));


if (channelId) {
ws.send(JSON.stringify({
event: 'pusher:subscribe',
data: { channel: `channel.${channelId}` }
}));
}


console.log('Kick websocket connected');
});


ws.on('message', (msg) => {
try {
const parsed = JSON.parse(msg.toString());
let payload = parsed.data;
if (typeof payload === 'string') payload = JSON.parse(payload);


const content = payload?.content;
const username = payload?.sender?.username;


if (content && username) {
onMessage(username, content, payload);
}
} catch {}
});


ws.on('close', () => scheduleReconnect({ chatroomId, channelId, onMessage }));
ws.on('error', () => ws.close());
}


function scheduleReconnect(args) {
if (stopped) return;


reconnectAttempts++;
const delay = Math.min(30000, 1000 * 2 ** reconnectAttempts);


console.warn(`Kick WS reconnecting in ${delay}ms`);
setTimeout(() => connect(args), delay);
}


async function startKickConnector({ channel, onMessage }) {
const data = await fetchChannel(channel);
if (!data?.chatroom?.id) throw new Error('No chatroom id');


connect({
chatroomId: data.chatroom.id,
channelId: data.id,
onMessage
});
}


function stopKickConnector() {
stopped = true;
if (ws) ws.close();
}


module.exports = { startKickConnector, stopKickConnector };
