<p align="center">
  <img src="public/assets/brand/og-banner.png" alt="Drone Hive Studios — Websites | Bots | Games" width="720">
</p>

# Drone Hive AI

An AI assistant by **Drone Hive Studios**, built for code, ideas and writing.

- **Zero dependencies.** Plain HTML, CSS and JavaScript. There's no `npm install`, no build step and no framework.
- **Free to run.** It runs on Netlify's free plan using Edge Functions, with no paid add-ons.
- **Works before an AI is connected.** Chats, history, search and settings all work. Until you add a key, the app clearly says that no AI is connected, and it never makes up replies.
- **API keys stay on the server.** Keys are never sent to the browser.
- **Smart AI selection.** *Automatic* mode picks the best available AI for each message (Google Gemini → OpenRouter → Groq → Ollama) and switches if one is busy.
- **Reads images.** Attach screenshots or photos; they're sent to an AI that can see them.
- **Installable.** Add it to your phone's Home Screen and it opens like an app, with the Drone Hive logo.
- **Protected.** Sign-in, server-side usage limits (per minute, hour and day, per user and for everyone) and an emergency stop.

> Developed by Drone Hive Studios | Developer @ndrone40

---

## 🧠 AI modes: Default, Automatic, or pick one

Tap the AI button in the top-right corner of the chat.

| Mode | What it does |
|---|---|
| **Default** | Uses the server's standard provider (`AI_PROVIDER`). If it's busy or down *before* it starts answering, the next provider takes over (turn off with `AI_DEFAULT_FALLBACK=false`). |
| **Automatic** | Looks at each message first — coding? reasoning? images? long? — then uses the first suitable AI in this order: **Google Gemini → OpenRouter → Groq → Ollama** (final fallback). It also picks a fitting model, e.g. Gemini Flash for coding and Flash-Lite for quick chat, or a code model on OpenRouter for code. |
| **Always use …** | One specific provider. If it's unavailable you get a clear message instead of being switched. |

How it stays safe and honest:

- Only **one** provider works on a message at a time. A message is only passed to the next provider if the previous one failed **before writing anything**, so you never get two answers and credits aren't spent twice.
- Providers that just failed (rate limited, down, bad key) are put on a short cooldown and tried last.
- Each reply shows a small chip with the provider that **actually** answered (✨ = picked automatically, ↻ = the first choice was busy). Provider errors and API keys are never shown.

## 🖼️ Images

Click the image button in the message box, paste a screenshot, or drag images onto the chat (up to 4 per message).

- The browser shrinks each image (max 1600px) and re-saves it as a fresh JPEG. That also removes hidden data such as **GPS location** and rejects anything that isn't a real image.
- The server checks every image again: allowed type, **real file signature** (a renamed `.exe` or a script fails), size and count. SVG is never accepted.
- Images are **never stored on the server**. They're kept only in your browser (IndexedDB) and passed straight to the AI for that message.

Which providers can read images (checked November 2026, all on free tiers):

| Provider | Image model used | Notes |
|---|---|---|
| Google Gemini | your Gemini models (`gemini-flash-latest`, …) | All current Gemini chat models are multimodal. |
| OpenRouter | `openrouter/free` | The free router picks a free model that can see images. |
| Groq | `qwen/qwen3.8-27b` | Max 3 images per request. Change with `GROQ_VISION_MODELS` if Groq retires it. |
| Ollama Cloud | `qwen3-vl:235b` | Change with `OLLAMA_VISION_MODELS`. |

If you pick a provider that can't read images, the image button explains why and suggests Automatic. If **no** connected provider can read images, uploads stay switched off.

## 📱 Add to Home Screen

- **iPhone / iPad (Safari):** Share button → **Add to Home Screen**.
- **Android (Chrome):** ⋮ menu → **Add to Home screen** / **Install app**.

It installs as **Drone Hive AI** with the Drone Hive emblem (regular, maskable Android and Apple icons, plus iPhone launch screens), opens full-screen, and shows the app instead of an error page when you're offline. The offline helper (`public/sw.js`) never caches AI requests and always prefers the newest version online.

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

### Google Gemini (recommended, free tier)

1. Create a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
2. Add the environment variable `GEMINI_API_KEY` (mark it as a secret, scope must include Functions), then redeploy.

Already connected Gemini through the `OPENAI_COMPAT_*` variables pointing at `generativelanguage.googleapis.com`? That keeps working — it's detected automatically and shown as **Google Gemini**.

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

### Option C: Groq (free plan)

1. Sign in at [console.groq.com](https://console.groq.com) and create a key under **API Keys** (it starts with `gsk_`). The free plan needs no credit card.
2. Add the environment variable `GROQ_API_KEY` with that key (mark it as a secret on Netlify, scope must include Functions). Use the same Netlify steps as above, or put it in `.env` on your PC.
3. Redeploy. The default model is `openai/gpt-oss-120b`; `llama-3.3-70b-versatile` and `openai/gpt-oss-20b` are also listed. To change them, set `GROQ_MODEL` / `GROQ_MODELS` with exact IDs from [console.groq.com/docs/models](https://console.groq.com/docs/models).

`AI_PROVIDER` chooses the provider for **Default** mode (e.g. `AI_PROVIDER=groq`). With `auto`, the first connected one in the order Gemini → OpenRouter → Groq → Ollama is used.

> The free plan has per-minute and per-day limits. When they're hit, the app shows a "try again shortly" message instead of charging anything.

### Option D: OpenRouter (free models)

1. Sign in at [openrouter.ai](https://openrouter.ai) and create a key under **Keys** (it starts with `sk-or-`). No card is needed for free models.
2. Add the environment variable `OPENROUTER_API_KEY` with that key (mark it as a secret, scope must include Functions), then redeploy.
3. To make it the Default-mode AI, set `AI_PROVIDER=openrouter`.

The default model is `openrouter/free`, which automatically routes each message to a free model that's online, with `openai/gpt-oss-120b:free` as a backup. Change them with `OPENROUTER_MODEL` / `OPENROUTER_MODELS`.

> **Free-only safety lock:** the server only ever sends free models (IDs ending in `:free`, or `openrouter/free`), so it can't spend OpenRouter credits even if some are on the account. Set `OPENROUTER_ALLOW_PAID=true` only if you deliberately want paid models. Free models have per-minute and per-day request limits and change often.

### Option E: any other OpenAI-compatible API

Many AI services, including some with free tiers, use the "OpenAI-compatible" format. Set these variables:

```
OPENAI_COMPAT_NAME=My Provider
OPENAI_COMPAT_BASE_URL=https://provider.example.com/v1
OPENAI_COMPAT_API_KEY=your-key
OPENAI_COMPAT_MODEL=model-id
```

### Netlify AI Gateway is blocked

Netlify automatically adds a Claude connection to every site and bills it to your Netlify credits. Drone Hive AI **ignores it**, so it never spends your credits. To allow it on purpose, set `ALLOW_NETLIFY_AI_GATEWAY=true`.

## 👤 Accounts: sign in with Google or email

Turn this on so only real, signed-in people can use the AI. Bots can't get past it without signing in **and** verifying an email address. It uses **Firebase Authentication on the free Spark plan** — no card needed, and sign-ins with Google or email are free.

Until you finish these steps, the site works exactly like before.

1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Create a project** (name it `drone-hive-ai`). You can turn Google Analytics off. Don't upgrade to the Blaze plan.
2. **Build → Authentication → Get started → Sign-in method**, then enable:
   - **Email/Password** (leave "Email link" off)
   - **Google** (pick your support email, then Save)
3. **Authentication → Settings → Authorized domains → Add domain**: add your Netlify address (for example `drone-hive-ai.netlify.app`) and any custom domain.
4. **Project settings (gear icon) → General → Your apps → Web (`</>`)**. Register an app (no Hosting needed). Copy `apiKey` and `projectId` from the code it shows.
5. In **Netlify → Environment variables**, add:
   ```
   FIREBASE_API_KEY=the apiKey value
   FIREBASE_PROJECT_ID=the projectId value
   ```
   These two are **public** values (Firebase puts them in every website), so they don't need to be marked secret.
6. **Deploys → Trigger deploy.** The site now shows a sign-in screen.

What each part blocks:

| Protection | What it stops |
|---|---|
| Server checks Google's signature on every chat request (`server/auth.js`) | Fake or edited sign-in tokens, scripts calling `/api/chat` directly |
| Email must be verified | Bots making throwaway accounts with fake emails |
| Limits per account **and** per IP (IP gets 3× the account limit) | One person farming extra accounts to multiply their allowance |
| Firebase's own limits (100 new accounts/hour per IP, lockout on password guessing) | Mass sign-ups and password guessing |

To turn sign-in off again without deleting anything, set `AUTH_REQUIRED=false` and redeploy.

## 🔒 Security & usage limits

Built in, no setup needed. **Everything is enforced on the server** — nothing in the browser can switch it off, and refreshing, new sessions, private windows or other browsers don't reset anything.

| Protection | What it stops |
|---|---|
| Netlify rate limit (10 chats/min per IP, enforced by Netlify) | Bots hammering the API |
| Sign-in with a verified email (Firebase) | Scripts and throwaway bot accounts |
| Per-user limits: 6 messages/min, 30/hour, 100/day, 150k tokens/day — per account **and** per IP (3×) | One person draining your AI usage, or farming accounts |
| Global daily limit for everyone (1,500 messages / 3M tokens by default) | A sudden flood using up your free tiers |
| Emergency stop (`AI_EMERGENCY_STOP`, or one switch in Firestore) | Anything unexpected — pauses all AI replies |
| Max 2 replies in progress per user; duplicate submissions refused | Rapid repeat requests built to burn credits |
| Max 2,048 tokens per reply, ~12k tokens per request, 16k characters per message, 4 images, 2-minute reply cap | Single huge or endless requests |
| Same-origin check + no cookies (Bearer token) | Other websites using your AI / CSRF |
| Strict Content-Security-Policy + safe Markdown renderer | Injected scripts (XSS) |
| API keys only on the server; provider errors never sent to browsers; keys scrubbed from logs | Key / info leaks |
| Image checks (type, real file signature, size, count; SVG refused); images never stored | Malicious uploads |
| Local/private Ollama addresses ignored on Netlify | Visitors reaching your computer |
| Access code: constant-time check, 5 wrong tries = 15-minute lockout | Guessing the code |

All limits can be changed with environment variables — see [`.env.example`](.env.example). When someone hits a limit they see a clear message saying when they can send again (in their own time zone).

### Turn on shared usage limits (recommended, free)

Out of the box, usage counters live in memory on each Netlify edge server, so they reset when that server restarts and each server counts separately. To make them **shared and permanent**, store them in Firestore inside the Firebase project you already use for sign-in (free **Spark** plan, no card):

1. [Firebase console](https://console.firebase.google.com) → your **drone-hive-ai** project → **Build → Firestore Database → Create database**. Pick a location near you, start in **production mode**.
2. **Firestore → Rules** — make sure browsers can't touch it (only the server can):
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /{document=**} { allow read, write: if false; }
     }
   }
   ```
3. **Project settings (gear) → Service accounts → Generate new private key.** A JSON file downloads. Keep it private and **never** put it in the project folder or GitHub.
4. In **Netlify → Environment variables** add (both marked **secret**, scope includes Functions):
   ```
   FIREBASE_CLIENT_EMAIL = the "client_email" value from the file
   FIREBASE_PRIVATE_KEY  = the "private_key" value from the file (the whole thing, including -----BEGIN/END-----)
   ```
5. **Deploys → Trigger deploy.** Then delete the downloaded JSON file.

Each message uses about 6 tiny Firestore writes; the free plan allows 20,000 writes a day (~3,000 messages). Counters are stored under hashed IDs — no emails or IP addresses are saved. Optional: add a TTL policy on the `expireAt` field of the `usage` collection to auto-delete old counters.

**Admin controls without redeploying:** create the document `config/limits` in Firestore and add any of these fields. They apply within ~30 seconds:

| Field | Type | Effect |
|---|---|---|
| `emergencyStop` | boolean | `true` pauses all AI replies |
| `globalDailyRequests` / `globalDailyTokens` | number | Daily limit for everyone |
| `dailyRequestsPerUser` / `dailyTokensPerUser` / `hourlyRequestsPerUser` | number | Per-user limits |

### Lock the AI with an access code (strongly recommended)

The limits above slow strangers down; an access code shuts them out completely. In Netlify → Environment variables add (marked as secret):

```
DRONEHIVE_ACCESS_CODE=use-12-or-more-random-characters
```

Then enter the same code in the app under **Settings → AI Configuration → Access code**, and only share it with people you trust.

### Make sure nobody can cost you money

- **Don't put a payment card on your AI provider account** (or set a hard monthly spend limit there). On a free plan, the worst case is hitting the free limit — never a bill.
- **Stay on Netlify's free plan** with no card, so too much traffic pauses the site instead of charging you.
- **Turn on two-factor login** for GitHub, Netlify, Firebase/Google and your AI providers. Those logins are where your keys actually live.
- **Never put keys in `/public` or commit `.env`** (it's already in `.gitignore`). If a key ever leaks, delete it at the provider and make a new one.

### All settings

See [`.env.example`](.env.example) for everything you can configure: model list, max reply length, system prompt and more.

---

## Folder structure

```
Drone-Hive-AI/
├── public/                     ← the website (served as-is)
│   ├── index.html              app shell
│   ├── manifest.webmanifest   Home Screen app settings
│   ├── sw.js                   offline helper (never caches /api)
│   ├── favicon.ico
│   ├── assets/icons/           app icons (from the Drone Hive emblem)
│   ├── assets/splash/          iPhone launch screens
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
│       │   ├── attachments.js          image shrinking + IndexedDB storage
│       │   ├── conversation-store.js   conversation management
│       │   ├── settings-store.js       user preferences
│       │   └── emitter.js
│       ├── services/
│       │   ├── ai-client.js    talks to /api/* (never to providers directly)
│       │   └── connection.js   connection status
│       └── ui/
│           ├── sidebar.js  chat-view.js  composer.js  settings-modal.js
│           ├── model-picker.js  Default / Automatic / provider menu
│           ├── viewport.js     keeps the app above the phone keyboard
│           ├── markdown.js     safe Markdown renderer for replies
│           ├── overlays.js     toasts, dialogs, menus
│           ├── icons.js        inline SVG icons
│           └── dom.js          helpers
├── server/                     ← backend (shared by Netlify + local server)
│   ├── config.js               server settings + built-in personality
│   ├── env.js                  reads environment variables
│   ├── handlers.js             HTTP handlers for /api/status and /api/chat
│   ├── security.js             origin check, access code, headers
│   ├── usage/
│   │   ├── limits.js           all usage limits, global cap, emergency stop
│   │   └── firestore.js        shared counters (free Firebase Spark plan)
│   └── ai/
│       ├── service.js          the AI service (validation → route → stream)
│       ├── router.js           Default / Automatic / manual selection + fallback
│       ├── messages.js         the shared message format
│       ├── errors.js           error codes
│       ├── sse.js              streaming parser
│       └── providers/
│           ├── index.js        provider registry + priority order
│           ├── gemini.js
│           ├── anthropic.js
│           ├── groq.js
│           ├── ollama.js
│           ├── openrouter.js
│           └── openai-compatible.js
├── netlify/edge-functions/     ← Netlify entry points
│   ├── chat.js                 POST /api/chat
│   └── status.js               GET  /api/status
├── scripts/dev-server.mjs      local server (no dependencies)
├── tests/                      backend tests (npm test)
├── docs/ARCHITECTURE.md        how to add future features
├── docs/SECURITY.md            security review, test checklist, known limits
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
  "messages": [{ "role": "user", "content": [
    { "type": "text", "text": "What's in this screenshot?" },
    { "type": "image", "mediaType": "image/jpeg", "data": "<base64>" }
  ] }],
  "provider": "automatic",
  "model": "gemini-flash-latest",
  "options": { "temperature": 0.7, "maxTokens": 2048, "customInstructions": "Be brief." },
  "stream": true
}
```

Stream events, one JSON object per line:

`provider` is `"default"`, `"automatic"` or a provider id (`gemini`, `openrouter`, `groq`, `ollama`, …).

```
{"type":"routing","mode":"automatic"}
{"type":"ping"}                                   (keep-alive while a provider is chosen)
{"type":"start","provider":{"id":"gemini","name":"Google Gemini","shortName":"Gemini"},"model":"...","mode":"automatic","rerouted":false}
{"type":"delta","text":"Hel"}
{"type":"done","stopReason":"stop","usage":{...},"quota":{"requestsUsed":3,"requestsLimit":100,...}}
{"type":"error","error":{"code":"...","message":"..."}}
```

Error codes: `PROVIDER_NOT_CONFIGURED`, `INVALID_REQUEST`, `INVALID_IMAGE`, `VISION_UNSUPPORTED`, `UNAUTHORIZED`, `AUTH_REQUIRED`, `AUTH_EXPIRED`, `EMAIL_NOT_VERIFIED`, `FORBIDDEN`, `INPUT_TOO_LARGE`, `RATE_LIMITED`, `USAGE_LIMIT`, `GLOBAL_LIMIT`, `SERVICE_PAUSED`, `DUPLICATE_REQUEST`, `PROVIDER_AUTH`, `MODEL_NOT_FOUND`, `PROVIDER_BAD_REQUEST`, `PROVIDER_UNAVAILABLE`, `PROVIDER_ERROR`, `ALL_PROVIDERS_FAILED`. Limit errors include `resetAt` (ISO time).

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
- Auto-growing input, Enter to send and Shift + Enter for a new line (configurable; on phones Enter adds a line and the send button sends)
- Clear button, character counter near the limit, and a disabled state for empty messages
- Image attachments: picker, paste and drag-and-drop, previews, remove, up to 4 per message

**Mobile**
- App sized to the visible screen, so the keyboard never covers the message box
- iPhone notch / home-bar safe areas, 16px fields (no zoom-in), 44px touch targets
- Drawer sidebar with swipe-to-close; bottom-sheet menus; options buttons visible on touch screens
- Installable Home Screen app with the Drone Hive icon and launch screens

**Data**
- Saved in browser localStorage, so conversations survive refreshes
- Separate history per conversation, with automatic titles from the first message
- Prevents duplicate sends; replies interrupted by closing the tab are marked "Interrupted"
- Export all chats as JSON, delete individual chats, clear all history and reset settings
- Storage usage stats, plus a warning if browser storage is full

**AI backend**
- Dedicated AI service, separate from the frontend
- Provider registry with Google Gemini, OpenRouter, Groq, Ollama (cloud or local), Anthropic Claude and any OpenAI-compatible API
- Default / Automatic / manual AI selection with request analysis, priority order, fallback and cooldowns
- Image understanding with server-side validation
- Shared message format, streaming and non-streaming modes, and stable error codes
- The server allowlists which models can be requested, caps reply length and enforces message size limits
- Optional access code to protect your key (constant-time check + lockout)
- Rate limits (minute/hour/day), daily token budgets, a global daily cap, an emergency stop and per-request caps — shared through Firestore when configured
- Connection status endpoint and status pill
- Sign in with Google or email + password (Firebase, free), checked on the server for every chat
- 53 automated backend tests (routing, fallback, limits, images, sign-in, secret scanning)

## 🔜 Left for future development

The architecture is ready for these (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)):

- Long-term AI memory
- PDF and document understanding (images are done)
- Web search and tool use
- Advanced code assistance (running code, project context)
- Conversation folders
- Voice input and voice responses
- Custom AI personalities
- Multiple models side by side
- Cross-device conversation sync (accounts are done; chats are still saved per browser)
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
