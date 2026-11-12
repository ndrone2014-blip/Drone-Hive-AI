# Drone Hive AI — Architecture & extension guide

## How a message flows

```
Composer ──► App.send(text, images)            (public/js/app.js; + memory settings/notes from MemoryStore)
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

### System prompt (`server/ai/service.js` → `prepareChat`)

Built in this order, every request:

1. **Identity** (`server/identity.js` → `IDENTITY_PROMPT`) — always first, can't be replaced by `AI_SYSTEM_PROMPT` or overridden by custom instructions.
2. **Personality** — `AI_SYSTEM_PROMPT` or `DEFAULT_SYSTEM_PROMPT` (`server/config.js`).
3. **User custom instructions** (Settings → AI Configuration).
4. **Memory** (`server/memory/prompt.js` → `buildMemoryPrompt`) — relevant notes as `[m1] (Category) text`, recent chat titles, and how to save notes.
5. **Technical note** — added per attempt in `router.js` (`technicalNote`) with the provider and model actually used, for honest "what powers you?" answers.

### Reply post-processing (`startChat`)

`provider stream → stripThinking → extractMemoryCommands → guardIdentity → handler`

- `extractMemoryCommands` removes hidden `[[memory:add|category|text]]`, `[[memory:update|m1|text]]` and `[[memory:delete|m1]]` lines and emits one `memory_ops` event before `done`. Tags are always removed, even with memory off.
- `guardIdentity` rewrites first-person self-introductions as another AI ("I'm LFM2…") to Drone Hive AI. It holds back ~140 characters so names split across chunks are caught, never touches ``` code blocks, and is switched off when the user asks what model/provider powers the reply.
- The handler turns `memory_ops` into a `memory` event: `resolveMemoryOps` maps the short ids back to real ids, refuses secrets and adds a "remember …" request the AI ignored; then it's saved to Firestore (account storage) or sent to the browser to save (browser storage).

### Memory storage

| Store | When | Read | Write |
|---|---|---|---|
| `account` | sign-in **and** a Firestore service account are configured (and `MEMORY_STORE` isn't `browser`) | server loads `memories/{sha256(uid)}` per chat | server applies ops with an `updateTime` precondition (retries on conflict); `/api/memory` for the settings screen |
| `browser` | otherwise | browser sends its notes (`memory.items`) with each chat; server sanitizes them | browser applies the ops from the `memory` event to `localStorage` key `dhai.memory.v1.<uid or guest>` |

Both sides use the same pure rules in `public/js/shared/memory-rules.js` (`sensitiveReason`, `applyMemoryOps`, `selectRelevantMemories`, `explicitRememberRequest`). The server imports that file directly.

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
| **Long-term memory** | Done — see *Memory storage* above. To add semantic search later, replace `selectRelevantMemories()` in `shared/memory-rules.js`; nothing else needs to change. |
| **Custom personalities** | `conversation.personalityId` already exists. Send it with the request and choose the base prompt in `server/config.js`. |
| **Web search / tools** | Add tool definitions in the provider's `open()` and new event types (`tool_call`, `tool_result`) to the NDJSON stream. `ai-client.js` already passes every event to `onEvent`. |
| **Conversation folders** | `conversation.folderId` already exists. Add folder CRUD to `ConversationStore` and a section in `sidebar.js`. |
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
  meta: { provider, providerName, model, mode, rerouted, usage,
          memory: { applied: [{ op, text }], rejected: [{ reason }], error } } }
```

**Memory** (`public/js/shared/memory-rules.js`)

```js
{ id, text /* ≤ 400 chars */, category: 'about'|'preference'|'project'|'tech'|'instruction'|'other',
  source: 'auto'|'manual'|'chat', createdAt, updatedAt }
```

`notice` messages are app messages, such as "AI not connected". They are shown in the chat but never sent to the AI.

## Storage keys

| Key | Contents |
|---|---|
| `dhai.conversations.v1` | all conversations |
| `dhai.activeConversation.v1` | open conversation id |
| `dhai.settings.v1` | user preferences (`provider`: `default` / `automatic` / provider id; `memoryEnabled`, `memoryAuto`, `memoryRecentChats`, `showProviderChip`) |
| `dhai.memory.v1.<uid>` / `dhai.memory.v1.guest` | memories, browser storage only (one list per account) |
| IndexedDB `dhai-attachments` | attached images (Blobs), keyed by attachment id |

If a format ever changes, bump the `v1` suffix and migrate in the store's constructor.
