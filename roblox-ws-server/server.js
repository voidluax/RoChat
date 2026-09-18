'use strict';

/**
 * roblox-chat-ws — Global chat WebSocket API for a Roblox game.
 *
 * - One global room: "main". Every connected client is in it automatically.
 * - Clients send chat messages as JSON text frames:
 *     { "userid": 0, "username": "string", "message": "string", "developer": false }
 * - The server validates the payload, OVERRIDES the `developer` flag using
 *   developers.json (clients can never set it themselves), and broadcasts the
 *   corrected message to every client in the room — including the sender.
 * - A small HTTP layer provides:
 *     GET  / and /health  -> Render health check / service status
 *     GET  /messages      -> recent history (polling fallback for Roblox HttpService)
 *     POST /send          -> send a chat message over HTTP (HttpService fallback)
 *   Roblox's HttpService cannot open WebSocket connections, so these two HTTP
 *   endpoints let a real game server script chat without any plugins.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

/* ------------------------------- configuration ------------------------------ */

const PORT = Number(process.env.PORT) || 8080; // Render injects PORT automatically
const ROOM = 'main';

const MAX_USERNAME_LENGTH = 32;
const MAX_MESSAGE_LENGTH = 500;
const MAX_WS_PAYLOAD_BYTES = 16 * 1024; // ws closes oversized frames automatically
const MAX_HTTP_BODY_BYTES = 8 * 1024;
const HISTORY_LIMIT = 100; // messages kept for GET /messages

const WS_RATE_LIMIT_COUNT = 5; // chat messages...
const WS_RATE_LIMIT_WINDOW_MS = 3_000; // ...per window, per connection
const HTTP_RATE_LIMIT_COUNT = 30; // HTTP requests...
const HTTP_RATE_LIMIT_WINDOW_MS = 10_000; // ...per window, per IP

const HEARTBEAT_INTERVAL_MS = 30_000; // ping clients (proxies drop idle sockets)

/* ------------------------------ developers.json ----------------------------- */

function loadDevelopers() {
  const file = path.join(__dirname, 'developers.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) {
      throw new Error('expected a JSON array of numeric user IDs');
    }
    const ids = new Set(parsed.map(Number).filter((n) => Number.isFinite(n)));
    console.log(`[startup] loaded ${ids.size} developer user ID(s) from developers.json`);
    return ids;
  } catch (err) {
    console.error(`[startup] failed to load developers.json: ${err.message}`);
    console.error('[startup] continuing with an EMPTY developer list');
    return new Set();
  }
}

const developers = loadDevelopers();

/* ---------------------------------- state ----------------------------------- */

const clients = new Set(); // every connected WebSocket client (all in "main")
const history = []; // recent chat messages, for GET /messages
let nextMessageId = 1;
const httpHits = new Map(); // ip -> timestamp[] (rate limiting)

/* --------------------------------- helpers ---------------------------------- */

// Sliding-window rate limiter. Returns true when the caller is OVER the limit.
function slidingWindowLimited(stamps, now, count, windowMs) {
  while (stamps.length > 0 && now - stamps[0] >= windowMs) stamps.shift();
  if (stamps.length >= count) return true;
  stamps.push(now);
  return false;
}

// Validates an incoming payload and builds the authoritative chat message.
// Whatever the client sent in `developer` is ignored — the server decides.
function validateChatPayload(data) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, code: 'bad_payload', error: 'Payload must be a JSON object.' };
  }

  let { userid, username, message } = data;

  // Tolerate a numeric string like "2333436583" — always output a number.
  if (typeof userid === 'string' && userid.trim() !== '' && Number.isFinite(Number(userid))) {
    userid = Number(userid);
  }
  if (typeof userid !== 'number' || !Number.isFinite(userid)) {
    return { ok: false, code: 'bad_userid', error: '"userid" must be a number.' };
  }

  if (typeof username !== 'string' || username.trim() === '') {
    return { ok: false, code: 'bad_username', error: '"username" must be a non-empty string.' };
  }
  username = username.trim().slice(0, MAX_USERNAME_LENGTH);

  if (typeof message !== 'string' || message.trim() === '') {
    return { ok: false, code: 'bad_message', error: '"message" must be a non-empty string.' };
  }
  message = message.trim().slice(0, MAX_MESSAGE_LENGTH);

  return {
    ok: true,
    chat: {
      userid,
      username,
      message,
      developer: developers.has(userid), // server-side override, always
    },
  };
}

function storeMessage(chat) {
  const record = { id: nextMessageId++, ...chat };
  history.push(record);
  if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
  return record;
}

function sendWs(ws, obj) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(obj));
  } catch (err) {
    console.error('[ws] send failed:', err.message);
  }
}

function sendWsError(ws, code, error) {
  sendWs(ws, { type: 'error', code, error });
}

// Broadcast to EVERY client in the "main" room.
function broadcast(obj) {
  const frame = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(frame);
      } catch (err) {
        console.error('[ws] broadcast send failed:', err.message);
      }
    }
  }
}

function broadcastOnlineCount() {
  broadcast({ type: 'system', event: 'online', room: ROOM, online: clients.size });
}

/* --------------------------------- HTTP layer -------------------------------- */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return sendJson(res, 400, { type: 'error', code: 'bad_url', error: 'Malformed request URL.' });
  }

  const pathName = url.pathname;

  // CORS preflight (harmless for Roblox, convenient for browser test pages).
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  // GET / and /health — health check for Render + status for humans.
  if (req.method === 'GET' && (pathName === '/' || pathName === '/health')) {
    return sendJson(res, 200, {
      status: 'ok',
      service: 'roblox-chat-ws',
      room: ROOM,
      online: clients.size,
      developers: developers.size,
      uptimeSeconds: Math.floor(process.uptime()),
    });
  }

  // GET /messages?limit=50&after=0 — history for HttpService-style polling.
  // `after` = only return messages with id greater than this (0 = recent history).
  if (req.method === 'GET' && pathName === '/messages') {
    const limitParam = Number(url.searchParams.get('limit'));
    const limit = Number.isFinite(limitParam)
      ? Math.min(HISTORY_LIMIT, Math.max(1, Math.floor(limitParam)))
      : 50;
    const afterParam = Number(url.searchParams.get('after'));
    const after = Number.isFinite(afterParam) ? afterParam : 0;

    const messages = history.filter((m) => m.id > after).slice(-limit);
    return sendJson(res, 200, {
      room: ROOM,
      latest: history.length > 0 ? history[history.length - 1].id : 0,
      count: messages.length,
      messages,
    });
  }

  // POST /send — send a chat message over HTTP (Roblox HttpService fallback).
  // Body is the same JSON object as the WebSocket frame.
  if (req.method === 'POST' && pathName === '/send') {
    const forwarded = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = forwarded || (req.socket && req.socket.remoteAddress) || 'unknown';
    const now = Date.now();
    const stamps = httpHits.get(ip) || [];
    if (slidingWindowLimited(stamps, now, HTTP_RATE_LIMIT_COUNT, HTTP_RATE_LIMIT_WINDOW_MS)) {
      return sendJson(res, 429, {
        type: 'error',
        code: 'rate_limited',
        error: 'Too many requests. Slow down.',
      });
    }
    httpHits.set(ip, stamps);
    if (httpHits.size > 5000) httpHits.clear(); // crude guard against unbounded growth

    let body = '';
    let overflow = false;
    req.on('data', (chunk) => {
      if (overflow) return;
      body += chunk;
      if (body.length > MAX_HTTP_BODY_BYTES) {
        overflow = true;
        sendJson(res, 413, {
          type: 'error',
          code: 'payload_too_large',
          error: 'Request body is too large.',
        });
        req.destroy();
      }
    });
    req.on('end', () => {
      if (overflow) return;

      let data;
      try {
        data = JSON.parse(body);
      } catch {
        return sendJson(res, 400, {
          type: 'error',
          code: 'invalid_json',
          error: 'Request body must be valid JSON.',
        });
      }

      const result = validateChatPayload(data);
      if (!result.ok) {
        return sendJson(res, 400, { type: 'error', code: result.code, error: result.error });
      }

      const record = storeMessage(result.chat);
      broadcast(result.chat); // live-update every connected WebSocket client too
      return sendJson(res, 201, { ok: true, message: record });
    });
    req.on('error', () => {
      /* client went away mid-upload; nothing to do */
    });
    return;
  }

  return sendJson(res, 404, {
    type: 'error',
    code: 'not_found',
    error: `Unknown route: ${req.method} ${pathName}`,
  });
});

/* ------------------------------ WebSocket layer ------------------------------ */

const wss = new WebSocketServer({ server, maxPayload: MAX_WS_PAYLOAD_BYTES });

wss.on('connection', (ws, req) => {
  ws.__isAlive = true;
  ws.__hits = []; // rate-limit timestamps
  clients.add(ws);

  const forwarded = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = forwarded || (req.socket && req.socket.remoteAddress) || 'unknown';
  console.log(`[ws] client connected from ${ip} (${clients.size} online)`);

  // Greet the new client (only this client receives this frame).
  sendWs(ws, {
    type: 'system',
    event: 'welcome',
    room: ROOM,
    online: clients.size,
    message:
      'Connected to room "main". Send chat as JSON text: ' +
      '{"userid":0,"username":"name","message":"text","developer":false}',
  });
  broadcastOnlineCount();

  ws.on('pong', () => {
    ws.__isAlive = true;
  });

  ws.on('message', (raw, isBinary) => {
    ws.__isAlive = true; // any traffic counts as alive

    if (isBinary) {
      return sendWsError(ws, 'binary_unsupported', 'Binary frames are not supported. Send a JSON text frame.');
    }

    const now = Date.now();
    if (slidingWindowLimited(ws.__hits, now, WS_RATE_LIMIT_COUNT, WS_RATE_LIMIT_WINDOW_MS)) {
      return sendWsError(ws, 'rate_limited', 'You are sending messages too fast. Slow down.');
    }

    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return sendWsError(ws, 'invalid_json', 'Message must be valid JSON.');
    }

    const result = validateChatPayload(data);
    if (!result.ok) {
      return sendWsError(ws, result.code, result.error);
    }

    storeMessage(result.chat);
    broadcast(result.chat); // everyone in "main", including the sender
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[ws] client disconnected (${clients.size} online)`);
    broadcastOnlineCount();
  });

  ws.on('error', (err) => {
    // 'close' always fires after this, which is where cleanup happens.
    console.error('[ws] connection error:', err.message);
  });
});

/* --------------------------------- heartbeat --------------------------------- */

// Render (like most proxies) silently drops idle connections. Ping every 30s
// and terminate clients that fail to respond between pings.
const heartbeat = setInterval(() => {
  for (const ws of clients) {
    if (ws.__isAlive === false) {
      clients.delete(ws);
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      continue;
    }
    ws.__isAlive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }
}, HEARTBEAT_INTERVAL_MS);

/* --------------------------------- start/stop -------------------------------- */

server.listen(PORT, () => {
  console.log(`[startup] roblox-chat-ws listening on port ${PORT}`);
  console.log(`[startup] room: "${ROOM}" | developer IDs loaded: ${developers.size}`);
  console.log(`[startup] health check available at GET http://localhost:${PORT}/`);
});

// Render sends SIGTERM on deploys/shutdown — close cleanly.
function shutdown(signal) {
  console.log(`\n[shutdown] received ${signal}, closing gracefully...`);
  clearInterval(heartbeat);
  for (const ws of clients) {
    try {
      ws.close(1001, 'Server shutting down');
    } catch {
      /* ignore */
    }
  }
  wss.close(() => {
    server.close(() => process.exit(0));
  });
  // Never hang: force-exit if sockets take too long to drain.
  setTimeout(() => process.exit(0), 3_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
