# roblox-chat-ws

A tiny, production-ready **global chat WebSocket API** for a Roblox game. One room —
`"main"` — everyone is in it. Built with **Node.js + [`ws`](https://github.com/websockets/ws)**
and ready to deploy on **Render** in about 2 minutes.

## What's inside

```
roblox-ws-server/
├── package.json                 # ws dependency + start script
├── server.js                    # the whole server (WS + HTTP health check + polling API)
├── developers.json              # developer UserID list (read once on startup)
├── render.yaml                  # Render Blueprint (buildCommand + startCommand)
├── .gitignore
├── README.md                    # this file
└── examples/
    ├── node-test-client.js      # quick command-line WebSocket client
    └── roblox-client.lua        # server-side Roblox script (HttpService + polling)
```

## Quick start (local)

```bash
npm install
npm start
# [startup] roblox-chat-ws listening on port 8080
```

Then, in a second terminal:

```bash
# health check
curl http://localhost:8080/

# connect a test WebSocket client (developer user!)
node examples/node-test-client.js ws://localhost:8080 2333436583 Builderman "hello"

# or chat over plain HTTP
curl -X POST http://localhost:8080/send \
  -H "Content-Type: application/json" \
  -d '{"userid":42,"username":"Guest42","message":"hi over http","developer":false}'
```

## Deploying to Render

### Option A — Blueprint (uses `render.yaml`)

1. Push **this folder** to a GitHub repo (the repo root must contain `render.yaml`).
2. Render dashboard → **New → Blueprint** → pick the repo → **Apply**.
3. Done. Render runs exactly what the Blueprint says:
   - `buildCommand: npm install`
   - `startCommand: npm start` (which runs `node server.js`)

### Option B — Manual Web Service

1. **New → Web Service** → connect the repo.
2. Settings:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/`
3. Deploy.

Notes:

- Render injects `PORT` automatically — `server.js` reads `process.env.PORT || 8080`. Nothing to configure.
- Render terminates TLS for you. From the outside always use **`wss://`** and **`https://`**.
- On the **free** plan the service sleeps after inactivity; the first connect after sleep can take ~50 seconds (cold start). Upgrade the plan for always-on.

---

# API Documentation

## 1. Connection URLs

| Purpose | Local | On Render |
|---|---|---|
| WebSocket | `ws://localhost:8080` | `wss://<your-service>.onrender.com` |
| HTTP (health, polling) | `http://localhost:8080` | `https://<your-service>.onrender.com` |

The WebSocket upgrade is accepted on **any path** — connecting to the root URL works.

## 2. Sending a chat message

Send a **JSON text frame** (binary frames are rejected) shaped exactly like this:

```json
{
  "userid": 2333436583,
  "username": "Builderman",
  "message": "Hello world!",
  "developer": false
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `userid` | number | yes | The sender's Roblox UserID. Numeric strings like `"123"` are tolerated and converted to numbers. |
| `username` | string | yes | 1–32 characters (trimmed / truncated). |
| `message` | string | yes | 1–500 characters (trimmed / truncated); must not be empty. |
| `developer` | boolean | ignored | **You may send anything (or omit it). The server always overwrites this field** based on `developers.json`. Clients can never grant themselves the badge. |

## 3. Receiving a chat message (broadcast)

Every valid message is broadcast to **all** connected clients in `"main"` —
including the sender — as a JSON text frame with **exactly these four fields**:

```json
{
  "userid": 2333436583,
  "username": "Builderman",
  "message": "Hello world!",
  "developer": true
}
```

| Field | Type | Meaning |
|---|---|---|
| `userid` | number | Sender's Roblox UserID. |
| `username` | string | Sender's Roblox username. |
| `message` | string | The chat text. |
| `developer` | boolean | `true` if the `userid` is in `developers.json`, otherwise `false`. Set by the server. |

You can identify a chat frame by the presence of the `userid` field (system and
error frames always have a `type` field instead).

## 4. The `developer` field and the developer badge

- Developer UserIDs live in **`developers.json`** — a plain JSON array of numbers,
  loaded once when the server starts:

  ```json
  [2333436583, 11684358676]
  ```

- For every incoming message, the server checks `developers.has(userid)` and sets
  `developer` to `true` or `false` — **overriding whatever the client sent**.
  A normal user sending `"developer": true` will still be broadcast as `false`.
- The wire format only ever contains the boolean `true` / `false`. **No badge
  graphic is sent.** The visual badge (e.g. the laptop emoji, or your own
  `ImageLabel` icon) is rendered **by your Roblox client/UI** when it receives a
  message with `developer == true`. See `examples/roblox-client.lua` for the
  exact pattern.
- To change the developer list: edit `developers.json`, push, and Render
  redeploys (autoDeploy). A restart is required because the file is read at startup.

## 5. System frames (informational)

Sent to clients as `{ "type": "system", ... }`. Safe to ignore if you don't need them.

```json
{ "type": "system", "event": "welcome", "room": "main", "online": 3, "message": "Connected to room \"main\"..." }
{ "type": "system", "event": "online", "room": "main", "online": 4 }
```

- `welcome` — sent only to the newly connected client.
- `online` — broadcast to everyone whenever the connection count changes.

## 6. Error frames

Invalid input never disconnects you; you get an error frame back (only you see it):

```json
{ "type": "error", "code": "bad_userid", "error": "\"userid\" must be a number." }
```

| `code` | Cause |
|---|---|
| `invalid_json` | Frame wasn't valid JSON. |
| `bad_payload` | JSON value wasn't an object. |
| `bad_userid` | `userid` missing or not a number. |
| `bad_username` | `username` missing / empty / not a string. |
| `bad_message` | `message` missing / empty / not a string. |
| `binary_unsupported` | Sent a binary frame. Send a JSON *text* frame. |
| `rate_limited` | More than 5 messages in 3 seconds from one connection. |

## 7. Sequence example

```
client -> {"userid":2333436583,"username":"Builderman","message":"hi","developer":false}
all    <- {"userid":2333436583,"username":"Builderman","message":"hi","developer":true}

client -> {"userid":42,"username":"Guest","message":"i am totally a dev","developer":true}
all    <- {"userid":42,"username":"Guest","message":"i am totally a dev","developer":false}

client -> not-valid-json
sender <- {"type":"error","code":"invalid_json","error":"Message must be valid JSON."}
```

## 8. HTTP endpoints (health check + HttpService fallback)

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/` | Health check (Render pings this). Returns status JSON `200`. |
| `GET` | `/health` | Same as `/`. |
| `GET` | `/messages?limit=50&after=0` | Recent messages. Each has an extra `id` for dedupe/polling. |
| `POST` | `/send` | Send a chat message over HTTP (same JSON body as a WS frame). Also broadcasts to all WS clients. |

Health check:

```bash
curl https://<your-service>.onrender.com/
# {"status":"ok","service":"roblox-chat-ws","room":"main","online":2,"developers":2,"uptimeSeconds":3601}
```

Poll messages (use `after` = highest `id` you've seen to get only new ones):

```bash
curl "https://<your-service>.onrender.com/messages?after=0&limit=50"
# {"room":"main","latest":3,"count":1,"messages":[
#   {"id":3,"userid":42,"username":"Guest","message":"hi over http","developer":false}
# ]}
```

Send over HTTP:

```bash
curl -X POST https://<your-service>.onrender.com/send \
  -H "Content-Type: application/json" \
  -d '{"userid":42,"username":"Guest","message":"hello","developer":false}'
# HTTP 201
# {"ok":true,"message":{"id":4,"userid":42,"username":"Guest","message":"hello","developer":false}}
```

Errors come back as `{"type":"error","code":"...","error":"..."}` with HTTP 400/413/429.

## 9. Limits

| Limit | Value |
|---|---|
| WebSocket frame size | 16 KB (bigger frames are dropped by `ws`) |
| HTTP body size | 8 KB |
| Username length | 32 chars (truncated) |
| Message length | 500 chars (truncated) |
| WS rate limit | 5 messages / 3 s per connection |
| HTTP rate limit | 30 requests / 10 s per IP |
| History kept for `/messages` | last 100 messages (in-memory) |
| Heartbeat | server pings every 30 s (keeps Render/proxy connections alive) |

History is in-memory only — it resets on restart/redeploy. Add a database later
if you need persistence.

---

## Connecting from a Roblox game

**HttpService cannot open WebSocket connections.** So:

- **Option A — HttpService polling (works in live games, no plugins):**
  use `POST /send` to send and `GET /messages?after=<lastId>` every ~2 seconds
  from a **server-side Script**. Requires *Game Settings → Security → Allow HTTP Requests*.
  A complete, ready-to-customize implementation is in
  [`examples/roblox-client.lua`](examples/roblox-client.lua). Core idea:

  ```lua
  local HttpService = game:GetService("HttpService")
  local BASE = "https://<your-service>.onrender.com"

  -- send
  HttpService:PostAsync(BASE .. "/send", HttpService:JSONEncode({
      userid = player.UserId, username = player.Name,
      message = text, developer = false, -- server overrides this
  }), Enum.HttpContentType.ApplicationJson)

  -- receive (poll)
  local data = HttpService:JSONDecode(HttpService:GetAsync(BASE .. "/messages?after=" .. lastId))
  for _, msg in ipairs(data.messages) do
      lastId = math.max(lastId, msg.id)
      local tag = msg.developer and "[DEV] " or "" -- render YOUR badge when developer is true
      print(tag .. msg.username .. ": " .. msg.message)
  end
  ```

- **Option B — WebSocket plugin (Studio testing):** install a WebSocket client
  plugin/module and connect to `wss://<your-service>.onrender.com`. Chat frames
  have the four fields from section 3; frames with a `type` field are
  system/error frames. A generic snippet is included at the bottom of
  `examples/roblox-client.lua`.

## License

MIT — do whatever you want with it.
