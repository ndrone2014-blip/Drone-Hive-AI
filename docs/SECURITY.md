# Drone Hive AI — security review & test checklist (v0.3.0, November 2026)

This is an honest record of what protects the site, what was tested, and what risks remain. **No website is completely secure**; the goal is to make abuse hard, limited and visible.

## How it's protected

| Area | Protection | Where |
|---|---|---|
| API keys | Read only on the server from environment variables. Never in `/public`, never in `/api/status`, never in error messages. Provider error text stays in server logs, and logs are scrubbed of anything key-shaped. A test fails if a key-like string is ever committed. | `server/env.js`, `server/ai/errors.js` (`redact`), `tests/upgrade.test.js` |
| Who can use the AI | Firebase sign-in (Google or verified email). Every chat request's ID token is signature-checked on the server (issuer, audience, expiry, verified email, not anonymous). | `server/auth.js` |
| Usage / credits | Per minute, hour and day per account **and** per IP (3×), daily token budget, global daily cap for everyone, max 2 replies in flight per user, in-flight duplicates refused, emergency stop. All server-side; refresh/new session/new browser doesn't reset. Shared across servers via Firestore when configured. | `server/usage/limits.js` |
| Request size | 8 MB body cap (enforced while reading, even if `content-length` lies), 16k characters per message, ~12k input tokens (oldest messages dropped), 2,048 output tokens, 4 images, 2-minute reply cap. | `server/handlers.js`, `server/config.js`, `server/ai/service.js` |
| Paid usage | OpenRouter is locked to free models unless `OPENROUTER_ALLOW_PAID=true`. Netlify's AI Gateway (bills Netlify credits) is blocked unless `ALLOW_NETLIFY_AI_GATEWAY=true`. No paid services were added. | `providers/openrouter.js`, `providers/anthropic.js` |
| Uploads | Browser re-encodes images (strips EXIF/GPS, rejects non-images). Server checks MIME allow-list **and** real file signature, size and count; SVG refused. Images are never written to disk or stored on the server, never executed, and never served back publicly. | `public/js/core/attachments.js`, `server/ai/messages.js` |
| XSS | Strict CSP (no inline scripts or inline style attributes, only own scripts + Google sign-in). All AI and user text is HTML-escaped; the Markdown renderer only re-creates a safe subset and only allows `http(s)`/`mailto` links. | `netlify.toml`, `public/js/ui/markdown.js` |
| CSRF | No cookies are used for auth (Bearer token added by the page), plus an Origin / `Sec-Fetch-Site` check on `/api/chat`. | `server/security.js` |
| SQL injection | There is no SQL database. Firestore is only written by the server, at document IDs made from SHA-256 hashes; user text never becomes part of a query. | `server/usage/firestore.js` |
| Your computer | The site runs entirely on Netlify. There is no file access, shell or code execution for visitors. A local/private Ollama address is ignored on the public site; the local dev server only listens on 127.0.0.1. | `providers/ollama.js`, `scripts/dev-server.mjs` |
| Server info | API responses carry `no-store`, `nosniff`, `DENY` framing, CSP `default-src 'none'`, `noindex`. Errors are generic and never include stack traces or provider output. `/.env*` paths return 404. | `server/security.js`, `netlify.toml` |
| Memory privacy | Account memories are read and written only for the account whose sign-in token the server verified, at `memories/{sha256(uid)}`; anything a browser sends is ignored in account mode, so one account can't read, inject or delete another's notes. Browser memories are kept in a separate localStorage list per account. Saves use an `updateTime` precondition so two tabs can't overwrite each other. | `server/memory/store.js`, `server/handlers.js`, `public/js/core/memory-store.js` |
| Secrets in memory | Passwords, API keys, tokens, private keys, card numbers (Luhn-checked), SSNs and long random strings are refused by `sensitiveReason()` in the browser **and** on the server, for notes the user adds and for anything the AI tries to save. Memory notes sent by a browser are re-checked on the server before they reach the AI. | `public/js/shared/memory-rules.js`, `server/memory/prompt.js` |
| AI identity | The identity section is always first in the prompt and can't be replaced by `AI_SYSTEM_PROMPT` or custom instructions; a streaming filter rewrites self-introductions as another AI (never inside code). Memory and identity markup can never reach the user. | `server/identity.js` |
| Brute force / bots | Netlify platform rate limit (10/min per IP), Firebase's own sign-in throttling, access-code lockout (5 tries → 15 min). | `netlify/edge-functions/*.js`, `server/security.js` |

## Issues found and fixed in this review

1. **Usage limits only lived in memory** on each Netlify edge server, so they reset on restart and weren't shared — there was no real daily cap. → Firestore-backed shared counters, hourly limits, a global daily cap and an emergency stop.
2. **Provider error text reached the browser** for "bad request" errors (`… rejected the request: <provider message>`), and mid-stream provider errors were echoed too. → Generic messages only; details go to the (redacted) server log.
3. **Possible key fragments in logs** when a provider echoes part of a key. → `redact()` on every log line.
4. **No protection against duplicate or parallel submissions** on the server. → In-flight duplicate refusal and a per-user concurrency limit.
5. **Invalid requests counted against nobody but still reached limits logic.** → Requests are fully validated before any usage is recorded, so broken requests can't burn anyone's allowance.

## Test checklist

Automated: `npm test` → **75 passing** (no network or keys needed). Browser checks were run in headless Chrome with a local mock AI at 320×568, 360×740, 390×844, 768×1024 and 1280×800, light and dark.

| Check | Result |
|---|---|
| Default AI mode works (uses `AI_PROVIDER`, falls back if it fails before answering) | ✅ automated + browser |
| Automatic mode works and picks models by task (code → stronger/code model, chat → fast model) | ✅ automated + browser |
| Provider priority respected (Gemini → OpenRouter → Groq → Ollama) | ✅ automated |
| Fallback works; only one provider called when the first succeeds; half-finished replies never re-sent | ✅ automated |
| Busy providers cool down and are tried last | ✅ automated |
| API keys not exposed (`/api/status`, errors, streamed events, logs, committed files) | ✅ automated |
| Token limits (per request output cap, input trimming, daily token budget) | ✅ automated |
| Rate limits (minute / hour / day, per account and per IP) | ✅ automated |
| Global daily limit and emergency stop | ✅ automated (env and Firestore admin switch) |
| Limits survive a "new server" when Firestore is configured | ✅ automated (stubbed Firestore) |
| Duplicate submissions refused; failed messages refunded, cancelled ones not | ✅ automated |
| Image upload: previews, remove, max 4, non-image rejected, text-only AI disables uploads with a reason | ✅ browser |
| Image validation on server (fake/renamed/SVG/oversized/too many) | ✅ automated |
| Image analysis reaches a vision model as a data URL | ✅ automated + browser (mock AI) |
| Home Screen: manifest valid, all icons + 9 iPhone launch screens load, service worker activates | ✅ browser |
| Mobile: drawer, swipe-close, bottom-sheet menus, safe areas, 16px fields, 44px targets, toasts don't cover the composer | ✅ browser |
| Chat history: saved, reloaded, images restored from IndexedDB, deleted with the conversation | ✅ browser |
| Unauthorized access (no token, expired, wrong project, forged, `alg:none`, unverified email) refused | ✅ automated |
| v0.3.0: the AI always introduces itself as Drone Hive AI ("I'm LFM2…" from a free model is rewritten, even split across stream chunks; code blocks untouched; honest answer when asked what model powers it) | ✅ automated + browser (mock AI) |
| v0.3.0: logo tile in sidebar, header (collapsed sidebar / phones), AI replies, loading screen and sign-in screen; no stretching; light + dark | ✅ browser (1280×800, 390×844 dark, 320×568) |
| v0.3.0: contact email in About & Contact and on the sign-in screen; `mailto:` link with subject; copy button | ✅ browser |
| v0.3.0: memories created (chat + manual), edited, deleted, cleared; persist after reload; used in a new conversation; not used when memory is off | ✅ browser (browser storage) + automated (account storage with stubbed Firestore) |
| v0.3.0: accounts can't see or change each other's memories (account storage and per-account browser lists); browser-sent notes ignored in account mode | ✅ automated |
| v0.3.0: secrets refused as memories (typed in Settings, said in chat, or written by the AI) | ✅ automated + browser |
| v0.3.0: existing providers, Default/Automatic selection and fallback unchanged; no voice/audio features added | ✅ automated (all 53 earlier tests still pass) |
| Live site (Netlify edge): new code running, all 4 providers detected, Gemini found from existing settings, sign-in screen shown to visitors, manifest served, Netlify secret scan clean | ✅ checked after deploy (Nov 12, 2026) |
| A real signed-in chat (text + image) on the live site | ⏳ needs the owner to sign in and try — not possible without an account |

Things that could not be tested here: a real phone's on-screen keyboard (logic uses the standard `visualViewport` API and was reviewed, not run on a device), real Gemini/Groq/OpenRouter/Ollama calls (no keys in the test environment), and Netlify's edge runtime itself before deploy.

## Remaining risks & limits (please read)

0. **Netlify "Team Login" visitor protection was turned off** on Nov 12, 2026 at the owner's request so the site is public. The app's own sign-in, usage limits and global cap now guard it.
1. **Until Firestore is set up, daily/hourly/global limits are per edge server.** A determined person hitting different Netlify locations could exceed them. Netlify's own 10/min per IP limit still applies everywhere. → Follow "Turn on shared usage limits" in the README (free, ~5 minutes).
2. **People can still make several real accounts.** Each needs a real, verified email; the per-IP limit (3×) and the global daily cap bound the total damage.
3. **Shared networks** (schools, offices) share one IP, so they share the per-IP limits and Netlify's 10/min limit.
4. **Free AI tiers have their own limits and terms.** Some free models (especially on OpenRouter) may log prompts. Don't send passwords or private data to the AI.
5. **Model IDs change.** If a provider retires a model (e.g. Groq's vision model), Automatic mode skips it and uses the next provider, but update the `*_MODELS` variables when you notice.
6. **Chats and images are stored in the user's browser.** Anyone using the same browser profile can see them.
7. **The Firebase web API key is public by design.** Restrict it in Google Cloud Console → Credentials to your site's domain(s) for extra safety.
8. **Prompt injection** (users trying to make the AI misbehave) can't be fully prevented; the AI has no tools, files or secrets to leak, so the impact is limited to what it writes.
9. **Memory without accounts lives in the browser.** Until sign-in and Firestore are both set up, memories are stored in each browser (per account) and don't sync between devices. Anyone with access to that browser profile could read them.
10. **Relevant memories are sent to the AI provider** with each message, like the conversation itself. Memories are short notes and secrets are refused, but treat them like chat content.
11. **The identity safety net is pattern-based.** It catches the usual self-introductions ("I'm …", "As an AI model trained by …"); an unusual wording from a weak model could still slip through. The locked identity prompt is the main protection.
12. **Account security matters most.** Your keys live in Netlify, GitHub, Firebase and the AI providers' dashboards — use two-factor login on all of them, and never put a payment card on a provider account you don't want billed.
