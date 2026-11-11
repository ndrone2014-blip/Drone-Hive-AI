# Drone Hive AI — Architecture & extension guide

## How a message flows

```
Composer ──► App.send()  (public/js/app.js)
               │  saves the user message (ConversationStore → localStorage)
               ▼
           ai-client.sendChat()  ──POST /api/chat──►  handlers.handleChatRequest()
                                                         │ access code check
                                                         ▼
                                                   service.openChat()
                                                         │ validate + normalize messages
                                                         │ pick provider + allowed model
                                                         │ build system prompt
                                                         ▼
                                                   provider.open()  ──►  AI provider API
               ◄──── NDJSON stream: start / delta / done / error ────┘
           App updates the assistant message as deltas arrive
```

The browser never talks to an AI provider directly, and API keys are only read in `server/env.js`.

The same `server/` code runs in two places:

- **Netlify Edge Functions** (`netlify/edge-functions/*.js`, Deno runtime)
- **Local dev server** (`scripts/dev-server.mjs`, Node)

Both use web-standard `Request`/`Response`. Don't import Node-only modules (`fs`, `path`…) inside `server/`.

## Adding features later

| Feature | Where it plugs in |
|---|---|
| **New AI provider** | Copy `server/ai/providers/anthropic.js`, implement `getConfig()` and `open()`, then add it to `providers/index.js`. The settings screen picks it up automatically from `/api/status`. |
| **Multiple models** | Set `ANTHROPIC_MODELS` / `OPENAI_COMPAT_MODELS`. The model is chosen per request (`body.model`), so per-conversation models only need `conversation.model` in the store. |
| **File uploads / images / PDFs** | Set `FEATURES.fileUploads` in `public/js/config.js`. The composer's attach button then opens a picker, and files go into `message.attachments`. Send them as content parts (`{type:'image'}`, `{type:'document'}`), which are already described in `server/ai/messages.js`. Convert the parts inside each provider's `open()`, and set `capabilities.vision` / `documents` on the provider. |
| **Long-term memory** | Inject remembered facts in `service.openChat()` where the system prompt is built (marked `FUTURE`). Store them server-side once accounts exist, or locally with a new store. |
| **Custom personalities** | `conversation.personalityId` already exists. Send it with the request and choose the base prompt in `server/config.js`. |
| **Web search / tools** | Add tool definitions in the provider's `open()` and new event types (`tool_call`, `tool_result`) to the NDJSON stream. `ai-client.js` already passes every event to `onEvent`. |
| **Conversation folders** | `conversation.folderId` already exists. Add folder CRUD to `ConversationStore` and a section in `sidebar.js`. |
| **Voice input / responses** | Add a mic button to the composer (Web Speech API is free in Chromium browsers) behind `FEATURES.voiceInput`. Speech output can use `speechSynthesis`. |
| **User accounts + sync** | Write a new storage adapter with the same methods as `LocalStorageAdapter` (`load`, `save`, `remove`, `usage`) that calls a backend, and pass it to the stores in `app.js`. |

## Data shapes

**Conversation** (`public/js/core/conversation-store.js`)

```js
{ id, title, titleLocked, createdAt, updatedAt, messages: [], folderId: null, personalityId: null }
```

**Message**

```js
{ id, role: 'user'|'assistant'|'notice', content, createdAt,
  status: 'complete'|'streaming'|'stopped'|'interrupted',
  variant, attachments: [], meta: { provider, model, usage } }
```

`notice` messages are app messages, such as "AI not connected". They are shown in the chat but never sent to the AI.

## Storage keys

| Key | Contents |
|---|---|
| `dhai.conversations.v1` | all conversations |
| `dhai.activeConversation.v1` | open conversation id |
| `dhai.settings.v1` | user preferences |

If a format ever changes, bump the `v1` suffix and migrate in the store's constructor.
