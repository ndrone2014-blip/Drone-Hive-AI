# Drone Hive AI — Architecture & extension guide

## How a message flows

```
Composer ──► App.send(text, images)            (public/js/app.js)
               │  images → shrunk JPEG → IndexedDB (core/attachments.js)
               │  message saved (ConversationStore → localStorage)
               ▼
           ai-client.sendChat()  ──POST /api/chat──►  handlers.handleChatRequest()
                                                         │ origin check, sign-in (server/auth.js)
                                                         │ access code
                                                         │ prepareChat(): validate text + images,
                                                         │   trim to token budget, plan route (router.js)
                                                         │ beginUsage(): minute/hour/day/global limits,
                                                         │   emergency stop (usage/limits.js, Firestore)
                                                         ▼
                                     response starts streaming right away ("routing", "ping")
                                                         │ startChat() → runRoute(): try providers in order
                                                         │   until one produces its first words
                                                         ▼
                                                   provider.open()  ──►  AI provider API
               ◄──── NDJSON: routing / start / delta / done(+quota) / error ────┘
           App updates the assistant message as deltas arrive
```

The browser never talks to an AI provider directly, and API keys are only read on the server.

### Provider selection (`server/ai/router.js`)

- `planRoute()` (no network) turns the user's mode into an ordered list of `{ provider, models }`:
  - **default** → `AI_PROVIDER` first (its configured model), then the automatic order as backup.
  - **automatic** → `AUTO_ORDER` = Gemini, OpenRouter, Groq, Ollama. Providers on cooldown move to the back. `analyzeRequest()` decides the model order inside each provider (code model / big model / fast model; image-capable models only when the message has images).
  - **manual** → just that provider.
- `runRoute()` opens one provider at a time and waits for the first text (`AI_FIRST_TOKEN_SECONDS`). Failure before any text → next model/provider. Failure after text → the error is reported; nothing is re-sent.
- `<think>…</think>` reasoning some open models emit is stripped.

### Usage limits (`server/usage/limits.js`)

`beginUsage(keys)` runs before any provider call; `ticket.finish(tokens)` after. Keys are `user:<uid>` (scale 1) and `ip:<address>` (scale 3), or just the IP when sign-in is off. Counters live in Firestore (`usage/{YYYY-MM-DD}__{sha256}` and `usage/{date}__global`, atomic increments) when a service account is configured, otherwise in memory. `config/limits` holds live admin overrides.

## Adding features later

| Feature | Where it plugs in |
|---|---|
| **New AI provider** | Copy `server/ai/providers/groq.js`, implement `getConfig()` (with `visionModels`) and `open()`, then add it to `providers/index.js`. To include it in Automatic mode, add its id to `AUTO_ORDER` in `router.js`. The menus pick it up from `/api/status`. |
| **Multiple models** | Set `ANTHROPIC_MODELS` / `OPENAI_COMPAT_MODELS`. The model is chosen per request (`body.model`), so per-conversation models only need `conversation.model` in the store. |
| **Images** | Done. A provider can read images when its `getConfig()` returns `visionModels`; `toOpenAIMessage()` converts them for OpenAI-format APIs. To add images to Anthropic, convert `m.images` to `{type:'image', source:{type:'base64', …}}` blocks in `anthropic.js` and set `visionModels`. |
| **PDFs / documents** | Add a `{type:'document'}` part in `server/ai/messages.js` with the same validate-on-server approach as `validateImage()`, then convert it per provider. |
| **Long-term memory** | Inject remembered facts in `service.openChat()` where the system prompt is built (marked `FUTURE`). Store them server-side once accounts exist, or locally with a new store. |
| **Custom personalities** | `conversation.personalityId` already exists. Send it with the request and choose the base prompt in `server/config.js`. |
| **Web search / tools** | Add tool definitions in the provider's `open()` and new event types (`tool_call`, `tool_result`) to the NDJSON stream. `ai-client.js` already passes every event to `onEvent`. |
| **Conversation folders** | `conversation.folderId` already exists. Add folder CRUD to `ConversationStore` and a section in `sidebar.js`. |
| **Voice input / responses** | Add a mic button to the composer (Web Speech API is free in Chromium browsers) behind `FEATURES.voiceInput`. Speech output can use `speechSynthesis`. |
| **Cross-device sync** | Accounts already exist (`AuthService` in `public/js/services/auth.js`; the server knows the user's `uid` in `handlers.js`). Write a new storage adapter with the same methods as `LocalStorageAdapter` (`load`, `save`, `remove`, `usage`) that calls a backend, and pass it to the stores in `app.js`. |

## Data shapes

**Conversation** (`public/js/core/conversation-store.js`)

```js
{ id, title, titleLocked, createdAt, updatedAt, messages: [], folderId: null, personalityId: null }
```

**Message**

```js
{ id, role: 'user'|'assistant'|'notice', content, createdAt,
  status: 'complete'|'streaming'|'stopped'|'interrupted',
  variant, attachments: [{ id, kind: 'image', name, mime, width, height, size }],
  meta: { provider, providerName, model, mode, rerouted, usage } }
```

`notice` messages are app messages, such as "AI not connected". They are shown in the chat but never sent to the AI.

## Storage keys

| Key | Contents |
|---|---|
| `dhai.conversations.v1` | all conversations |
| `dhai.activeConversation.v1` | open conversation id |
| `dhai.settings.v1` | user preferences (`provider`: `default` / `automatic` / provider id) |
| IndexedDB `dhai-attachments` | attached images (Blobs), keyed by attachment id |

If a format ever changes, bump the `v1` suffix and migrate in the store's constructor.
