<p align="center">
  <img src="public/assets/brand/og-banner.png" alt="Drone Hive Studios — Websites | Bots | Games" width="720">
</p>

# Drone Hive AI

An AI assistant by **Drone Hive Studios**, built for code, ideas and writing.

- **Zero dependencies.** Plain HTML, CSS and JavaScript. There's no `npm install`, no build step and no framework.
- **Free to run.** It runs on Netlify's free plan using Edge Functions, with no paid add-ons.
- **Works before an AI is connected.** Chats, history, search and settings all work. Until you add a key, the app clearly says that no AI is connected, and it never makes up replies.
- **API keys stay on the server.** Keys are never sent to the browser.

> Developed by Drone Hive Studios | Developer @ndrone40

---

## Quick start (Windows)

1. Install **Node.js 18 or newer** (the free "LTS" version from nodejs.org).
2. Open the project folder in a terminal (in File Explorer, right-click the folder and choose **Open in Terminal**).
3. Run:

   ```bash
   npm start
   ```

4. Open **http://localhost:8888** in your browser.

That's it. You don't need `npm install` because the project has no dependencies. Press **Ctrl + C** in the terminal to stop it.

Run the backend tests with `npm test`.

---

## Deploy to Netlify (free)

1. Push this repo to GitHub (it's already set up for `ndrone2014-blip/Drone-Hive-AI`).
2. In Netlify, go to **Add new project → Import an existing project → GitHub** and pick **Drone-Hive-AI**.
3. Leave the build settings as they are. `netlify.toml` already sets them:
   - Build command: *(empty)*
   - Publish directory: `public`
4. Click **Deploy**.

The site works right away, and the status pill says **"AI not connected"** until you add a key.

> Why Edge Functions? Regular Netlify Functions stop streaming responses after 10 seconds, which is too short for long AI answers. Edge Functions can keep streaming as long as the AI starts replying within 40 seconds. They're included on the free plan.

---

## 🔑 Where to add your API key later

API keys **only** go in server environment variables. Never put them in any file inside `public/`.

### Option A: Anthropic Claude

**On Netlify**

1. Go to **Project configuration (called Site configuration on some accounts) → Environment variables → Add a variable**.
2. Set the key to `ANTHROPIC_API_KEY`. For the value, paste your key from [console.anthropic.com](https://console.anthropic.com).
3. Make sure the variable's **scope includes Functions**.
4. Go to **Deploys → Trigger deploy** so the new variable takes effect.

**On your PC**

1. Copy `.env.example` to a new file called `.env` in the same folder.
2. Set `ANTHROPIC_API_KEY=your-key-here`.
3. Restart `npm start`.

`.env` is in `.gitignore`, so it will never be committed.

> Note: Anthropic bills API usage per request. Nothing in this project requires it. The app runs fine without any key, and you choose if and when to connect one.

### Option B: Ollama

1. Create a key at [ollama.com](https://ollama.com) (Settings → Keys).
2. Add the environment variable `OLLAMA_API_KEY` with that key. Use the same Netlify steps as above, or put it in `.env` on your PC.
3. Redeploy. The default model is `gpt-oss:120b`, and `gpt-oss:20b` is also listed. To use other models, set `OLLAMA_MODEL` / `OLLAMA_MODELS` with the exact names from ollama.com.

Running Ollama on your own PC instead? Set `OLLAMA_BASE_URL=http://localhost:11434/v1` in `.env`. No key is needed. This only works with `npm start` on that PC, not on Netlify.

> Check Ollama's site for their current free usage limits and pricing.

### Option C: any other OpenAI-compatible API

Many AI services, including some with free tiers, use the "OpenAI-compatible" format. Set these variables:

```
OPENAI_COMPAT_NAME=My Provider
OPENAI_COMPAT_BASE_URL=https://provider.example.com/v1
OPENAI_COMPAT_API_KEY=your-key
OPENAI_COMPAT_MODEL=model-id
```

### Netlify AI Gateway is blocked

Netlify automatically adds a Claude connection to every site and bills it to your Netlify credits. Drone Hive AI **ignores it**, so it never spends your credits. To allow it on purpose, set `ALLOW_NETLIFY_AI_GATEWAY=true`.

## 🔒 Security & token limits

Built in, no setup needed:

| Protection | What it stops |
|---|---|
| Netlify rate limit (10 chats/min per IP, enforced by Netlify) | Bots hammering the API |
| Per-visitor limits: 6 messages/min, 100/day, 150k tokens/day | One person draining your AI usage |
| Max 2,048 tokens per reply, ~12k tokens per request, 2-minute reply cap | Single huge or endless requests |
| Same-origin check | Other websites using your AI through their visitors |
| Strict Content-Security-Policy + safe Markdown renderer | Injected scripts (XSS) |
| API keys only on the server, provider error details never sent to browsers | Key / info leaks |
| Access code: constant-time check, 5 wrong tries = 15-minute lockout | Guessing the code |

All limits can be changed with environment variables — see [`.env.example`](.env.example).

### Lock the AI with an access code (strongly recommended)

The limits above slow strangers down; an access code shuts them out completely. In Netlify → Environment variables add (marked as secret):

```
DRONEHIVE_ACCESS_CODE=use-12-or-more-random-characters
```

Then enter the same code in the app under **Settings → AI Configuration → Access code**, and only share it with people you trust.

### Make sure nobody can cost you money

- **Don't put a payment card on your AI provider account** (or set a hard monthly spend limit there). On a free plan, the worst case is hitting the free limit — never a bill.
- **Stay on Netlify's free plan** with no card, so too much traffic pauses the site instead of charging you.
- **Turn on two-factor login** for GitHub, Netlify and your AI provider. Those logins are where your keys actually live.
- **Never put keys in `/public` or commit `.env`** (it's already in `.gitignore`). If a key ever leaks, delete it at the provider and make a new one.

### All settings

See [`.env.example`](.env.example) for everything you can configure: model list, max reply length, system prompt and more.

---

## Folder structure

```
Drone-Hive-AI/
├── public/                     ← the website (served as-is)
│   ├── index.html              app shell
│   ├── manifest.webmanifest
│   ├── assets/brand/           Drone Hive logos, favicon, banner
│   ├── css/
│   │   ├── tokens.css          brand colors, fonts, light/dark themes
│   │   ├── base.css            buttons, inputs, dialogs, toasts, menus
│   │   ├── sidebar.css         sidebar + layout shell
│   │   ├── chat.css            welcome screen, messages, composer
│   │   └── settings.css        settings dashboard
│   └── js/
│       ├── main.js             entry point
│       ├── app.js              controller: send / stop / regenerate flow
│       ├── config.js           app info, feature flags, prompts, defaults
│       ├── core/
│       │   ├── storage.js              storage adapter (localStorage)
│       │   ├── conversation-store.js   conversation management
│       │   ├── settings-store.js       user preferences
│       │   └── emitter.js
│       ├── services/
│       │   ├── ai-client.js    talks to /api/* (never to providers directly)
│       │   └── connection.js   connection status
│       └── ui/
│           ├── sidebar.js  chat-view.js  composer.js  settings-modal.js
│           ├── markdown.js     safe Markdown renderer for replies
│           ├── overlays.js     toasts, dialogs, menus
│           ├── icons.js        inline SVG icons
│           └── dom.js          helpers
├── server/                     ← backend (shared by Netlify + local server)
│   ├── config.js               server settings + built-in personality
│   ├── env.js                  reads environment variables
│   ├── handlers.js             HTTP handlers for /api/status and /api/chat
│   └── ai/
│       ├── service.js          the AI service (validation → provider → stream)
│       ├── messages.js         the shared message format
│       ├── errors.js           error codes
│       ├── sse.js              streaming parser
│       └── providers/
│           ├── index.js        provider registry (add new providers here)
│           ├── anthropic.js
│           ├── ollama.js
│           └── openai-compatible.js
├── netlify/edge-functions/     ← Netlify entry points
│   ├── chat.js                 POST /api/chat
│   └── status.js               GET  /api/status
├── scripts/dev-server.mjs      local server (no dependencies)
├── tests/server.test.js        backend tests (npm test)
├── docs/ARCHITECTURE.md        how to add future features
├── netlify.toml
├── .env.example
└── package.json
```

---

## API

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/status` | GET | Connection status, available providers and models (never includes keys) |
| `/api/chat` | POST | Send a conversation and get a reply. Streams NDJSON by default, or returns JSON with `"stream": false` |

Request body for `/api/chat`:

```json
{
  "messages": [{ "role": "user", "content": "Hello!" }],
  "provider": "auto",
  "model": "claude-sonnet-5-5",
  "options": { "temperature": 0.7, "maxTokens": 2048, "customInstructions": "Be brief." },
  "stream": true
}
```

Stream events, one JSON object per line:

```
{"type":"start","provider":{...},"model":"..."}
{"type":"delta","text":"Hel"}
{"type":"done","stopReason":"end_turn","usage":{...}}
{"type":"error","error":{"code":"...","message":"..."}}
```

Error codes: `PROVIDER_NOT_CONFIGURED`, `INVALID_REQUEST`, `UNAUTHORIZED`, `PROVIDER_AUTH`, `RATE_LIMITED`, `MODEL_NOT_FOUND`, `PROVIDER_BAD_REQUEST`, `PROVIDER_UNAVAILABLE`, `PROVIDER_ERROR`.

---

## ✅ Completed features

**Branding & design**
- Drone Hive Studios branding throughout: logo, emblem, wordmark, favicon and social banner
- Colors taken from the brand: ink black, warm off-white and honey gold, plus a subtle honeycomb pattern
- Light, dark and system themes, three text sizes and a reduce-motion option
- Responsive layout: desktop sidebar, plus a drawer on narrow screens and phones

**Sidebar**
- New chat, conversation history grouped by date, and search over titles and message text (Ctrl + K)
- Rename (menu, double-click or F2), delete (menu or Delete key) and export a chat as Markdown
- Settings button, local profile with avatar initials, and collapse/expand

**Chat**
- Welcome screen with greeting, description and four suggested-prompt cards that fill in the message box
- User and AI message bubbles, timestamps, copy message, copy code blocks and regenerate the last reply
- Markdown in replies: code blocks, lists, tables, links, quotes and headings, rendered safely (HTML is escaped)
- Live streaming with a typing indicator and caret, stop button (or Esc), smooth auto-scroll and a "jump to latest" button
- Clear notices when the AI isn't connected or the server can't be reached, with "AI settings" and "Try again" buttons

**Composer**
- Auto-growing input, Enter to send and Shift + Enter for a new line (configurable)
- Clear button, character counter near the limit, and a disabled state for empty messages
- Attachment button placeholder that shows "coming soon"

**Data**
- Saved in browser localStorage, so conversations survive refreshes
- Separate history per conversation, with automatic titles from the first message
- Prevents duplicate sends; replies interrupted by closing the tab are marked "Interrupted"
- Export all chats as JSON, delete individual chats, clear all history and reset settings
- Storage usage stats, plus a warning if browser storage is full

**AI backend**
- Dedicated AI service, separate from the frontend
- Provider registry with Anthropic Claude, Ollama (cloud or local) and any OpenAI-compatible API
- Shared message format, streaming and non-streaming modes, and stable error codes
- The server allowlists which models can be requested, caps reply length and enforces message size limits
- Optional access code to protect your key (constant-time check + lockout)
- Rate limits, daily token budgets and per-request token caps
- Connection status endpoint and status pill
- 12 automated backend tests

## 🔜 Left for future development

The architecture is ready for these (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)):

- Long-term AI memory
- File uploads, PDF understanding, and image uploads with image understanding
- Web search and tool use
- Advanced code assistance (running code, project context)
- Conversation folders
- Voice input and voice responses
- Custom AI personalities
- Multiple models side by side
- User accounts and cross-device conversation sync
- Importing exported conversations

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Server offline" pill | You opened `index.html` directly or used a plain static server. Use `npm start` or the Netlify site. |
| "AI not connected" after adding a key on Netlify | Make sure the variable scope includes **Functions**, then trigger a new deploy. |
| "rejected the API key" | The key is wrong or disabled. Re-copy it into the environment variable. |
| "requires an access code" | Enter the code from `DRONEHIVE_ACCESS_CODE` in Settings → AI Configuration. |
| Port 8888 already in use | Run `set PORT=3000 && npm start` (cmd) or `$env:PORT=3000; npm start` (PowerShell). |
