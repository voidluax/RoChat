'use strict';

/**
 * node-test-client.js — minimal WebSocket client for testing the server.
 *
 * Usage:
 *   node examples/node-test-client.js [url] [userid] [username] [message...]
 *
 * Examples:
 *   node examples/node-test-client.js
 *   node examples/node-test-client.js wss://roblox-chat-ws.onrender.com 2333436583 Builderman "hello world"
 */

const WebSocket = require('ws');

const url = process.argv[2] || process.env.WS_URL || 'ws://localhost:8080';
const userid = Number(process.argv[3] || 123456);
const username = process.argv[4] || 'TestUser';
const text = process.argv.slice(5).join(' ') || 'Hello from the test client!';

const ws = new WebSocket(url);

ws.on('open', () => {
  console.log('-> connected to', url);

  // NOTE: the client sends `developer: false` here, but the server ignores
  // whatever value you send and decides the real value from developers.json.
  const payload = { userid, username, message: text, developer: false };
  console.log('-> sending:', JSON.stringify(payload));
  ws.send(JSON.stringify(payload));
});

ws.on('message', (data) => {
  const frame = JSON.parse(data.toString());
  if (frame.type === 'system') {
    console.log('<- [system]', frame.event, '| online:', frame.online);
  } else if (frame.type === 'error') {
    console.log('<- [error]', frame.code, '|', frame.error);
  } else {
    const badge = frame.developer ? ' [DEV]' : '';
    console.log(`<-${badge} ${frame.username} (${frame.userid}): ${frame.message}`);
  }
});

ws.on('error', (err) => console.error('error:', err.message));
ws.on('close', (code, reason) => {
  console.log('closed:', code, reason.toString());
  process.exit(0);
});

// Stay connected for 10s so you can watch other traffic, then leave.
setTimeout(() => ws.close(1000, 'test done'), 10_000);
