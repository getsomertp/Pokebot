// src/kickConnector.js


const content =
payload?.content ?? payload?.message ?? payload?.text ?? payload?.body;
const username =
payload?.sender?.username ??
payload?.user?.username ??
payload?.user ??
payload?.displayName;


if (content && username && typeof onMessage === 'function') {
onMessage(String(username), String(content), payload);
}
} catch {}
});


ws.on('close', () => {
console.warn('Kick websocket closed');
scheduleReconnect();
});


ws.on('error', (err) => {
console.warn('Kick websocket error:', err?.message ?? err);
try {
ws.close();
} catch {}
});
} catch (err) {
console.warn('Kick WS connect error:', err?.message ?? err);
scheduleReconnect();
}
}


async function startKickConnector({ channel, onMessage }) {
if (!channel) {
console.log('KICK_CHANNEL not set; Kick connector will not start.');
return null;
}


const info = await fetchChannelInfo(channel);
const chatroomId = info?.chatroom?.id;
const channelId = info?.id ?? null;


if (!chatroomId) {
throw new Error(`Could not determine chatroom id for channel: ${channel}`);
}


stopped = false;
currentConnArgs = { chatroomId, channelId, onMessage };
connectWS(currentConnArgs);


return { stop: stopKickConnector };
}


function stopKickConnector() {
stopped = true;
currentConnArgs = null;


if (ws) {
try {
ws.removeAllListeners();
ws.terminate();
} catch {}
ws = null;
}
}


module.exports = { startKickConnector, stopKickConnector };
