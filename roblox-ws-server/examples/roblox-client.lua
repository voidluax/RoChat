--[[
	roblox-client.lua — talk to the roblox-chat-ws API from a Roblox game.

	────────────────────────────────────────────────────────────────────────────
	IMPORTANT — READ THIS FIRST

	Roblox's HttpService CANNOT open WebSocket connections. There are exactly
	two ways to use this API from Roblox:

	  OPTION A (recommended for a real game): HTTP polling with HttpService.
	  The server exposes GET /messages and POST /send purely for this.
	  Use a server-side Script (NOT a LocalScript), and enable
	  "Allow HTTP Requests" in Game Settings → Security.

	  OPTION B (Studio testing): a WebSocket plugin/module from the
	  Creator Store that wraps a real WebSocket client. Plugin APIs vary,
	  so a generic snippet is shown at the bottom of this file.
	────────────────────────────────────────────────────────────────────────────
]]

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")

-- Replace with your Render service URL (no trailing slash, use https://).
local BASE_URL = "https://roblox-chat-ws.onrender.com"

local ChatClient = {}
ChatClient.__index = ChatClient

function ChatClient.new(baseUrl: string?)
	local self = setmetatable({}, ChatClient)
	self._base = baseUrl or BASE_URL
	self._lastId = 0 -- tracks which messages we've already seen
	return self
end

-- Send one chat message. `developer` is always decided by the server,
-- so we send false and the server overwrites it when appropriate.
function ChatClient:SendMessage(userid: number, username: string, message: string): boolean
	local payload = {
		userid = userid,
		username = username,
		message = message,
		developer = false, -- ignored/overridden server-side
	}

	local ok, response = pcall(function()
		return HttpService:PostAsync(
			self._base .. "/send",
			HttpService:JSONEncode(payload),
			Enum.HttpContentType.ApplicationJson
		)
	end)

	if not ok then
		warn("[chat] send failed:", response)
		return false
	end

	local data = HttpService:JSONDecode(response)
	if not data.ok then
		warn("[chat] server rejected message:", data.error)
		return false
	end
	return true
end

-- Fetch only the messages that arrived since the last poll.
-- Returns an array of: { id, userid, username, message, developer }
function ChatClient:GetNewMessages(): { any }
	local url = string.format("%s/messages?after=%d&limit=50", self._base, self._lastId)

	local ok, response = pcall(function()
		return HttpService:GetAsync(url)
	end)
	if not ok then
		return {} -- transient error; try again next poll
	end

	local data = HttpService:JSONDecode(response)
	for _, msg in ipairs(data.messages or {}) do
		if msg.id > self._lastId then
			self._lastId = msg.id
		end
	end
	return data.messages or {}
end

-- ─────────────────────────── example usage ───────────────────────────

local chat = ChatClient.new()

-- 1. Forward in-game chat to the API (server Script).
Players.PlayerAdded:Connect(function(player)
	player.Chatted:Connect(function(text)
		chat:SendMessage(player.UserId, player.Name, text)
		-- NOTE: player.Chatted only fires for legacy chat. With TextChatService,
		-- hook TextChatService.SendingMessage / a CommandWebhook instead.
	end)
end)

-- 2. Poll for messages from other servers / external clients.
task.spawn(function()
	while true do
		local messages = chat:GetNewMessages()
		for _, msg in ipairs(messages) do
			-- When msg.developer == true, render YOUR developer badge next to
			-- the name in your own chat UI (e.g. an ImageLabel with your dev
			-- icon, or an emoji such as the laptop emoji). The API only ever
			-- sends plain true/false — the badge graphic lives in YOUR game.
			local tag = msg.developer and "[DEV] " or ""
			print(tag .. msg.username .. ": " .. msg.message)
		end
		task.wait(2) -- poll every 2 seconds; GET /messages allows 30 req / 10 s per IP
	end
end)

--[[
	────────────────────────────────────────────────────────────────────────
	OPTION B — WebSocket plugin (Studio testing only)

	With a WebSocket plugin/module installed, typical usage looks like this
	(the exact API depends on the plugin you choose):

	local WebSocketClient = require(game.ReplicatedStorage.SomeWsModule)

	local ws = WebSocketClient.new("wss://roblox-chat-ws.onrender.com")

	ws.MessageReceived:Connect(function(text)
		local data = HttpService:JSONDecode(text)
		if data.userid then
			-- chat frame: { userid, username, message, developer }
			local tag = data.developer and "[DEV] " or ""
			print(tag .. data.username .. ": " .. data.message)
		elseif data.type == "error" then
			warn("[chat] error frame:", data.code, data.error)
		elseif data.type == "system" then
			print("[chat] system:", data.event, "online:", data.online)
		end
	end)

	ws:Send(HttpService:JSONEncode({
		userid = 2333436583,
		username = "StudioTester",
		message = "hello from Studio",
		developer = false, -- server overrides this
	}))
	────────────────────────────────────────────────────────────────────────
]]
