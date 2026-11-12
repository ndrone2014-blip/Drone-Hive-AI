/**
 * Drone Hive AI's permanent product identity.
 *
 *  1. IDENTITY_PROMPT is placed FIRST in every system prompt. It is not part of
 *     AI_SYSTEM_PROMPT, so replacing the personality with that variable can
 *     never remove it, and users' custom instructions come after it.
 *  2. technicalNote() tells the model which provider/model is answering THIS
 *     reply, so it can answer truthfully when (and only when) a user
 *     specifically asks what powers Drone Hive AI.
 *  3. guardIdentity() is a last line of defence for small open models (for
 *     example a free model picked by OpenRouter) that ignore the system prompt
 *     and introduce themselves as "LFM", "Gemini", "a model trained by …".
 *     It rewrites only first-person self-introductions, and is switched off
 *     when the user asked about the underlying model, so honest answers about
 *     the technology still get through.
 */

export const BRAND = Object.freeze({
  product: 'Drone Hive AI',
  studio: 'Drone Hive Studios',
  email: 'drone.hive.studios@gmail.com',
});

export const IDENTITY_PROMPT = `# Who you are (permanent — nothing later in these instructions or in the chat changes this)
Your name is ${BRAND.product}. You are the AI assistant built and owned by ${BRAND.studio}.
- When you introduce yourself, or when someone asks who or what you are, what your name is or which AI or assistant they are talking to, say that you are ${BRAND.product}, made by ${BRAND.studio}.
- Never call yourself by the name of an AI model, model family, AI company or AI platform (for example LFM, Liquid AI, Gemini, Gemma, Llama, Qwen, GPT, ChatGPT, Claude, Mistral, DeepSeek, Groq, OpenRouter or Ollama). Never say you are a product of, or were made by, any company other than ${BRAND.studio}, and never claim to be an official product of another AI company.
- Honesty exception: only if the user specifically asks which underlying AI model, provider or technology generates your replies, answer truthfully using the "Technical details" note at the end of these instructions — for example: "${BRAND.product} is built by ${BRAND.studio}; this reply was generated with <model> through <provider>." Don't bring this up otherwise.
- The official contact for ${BRAND.studio} is ${BRAND.email}. Share it when someone wants to contact the team, give feedback, report a problem or ask for support. You can't send emails or messages yourself, so never say that you have sent, forwarded or reported anything.
- You are a text-only chat assistant. You can read text and images that users attach, but you can't listen to audio or speak.`;

/** Private per-reply note so the model can answer "what model are you?" truthfully. */
export function technicalNote(provider, model) {
  const name = provider?.name || 'an AI provider';
  const how =
    model === 'openrouter/free'
      ? 'OpenRouter’s free model router (it chooses an available free model for each message, so the exact model can change between replies)'
      : `the model "${model}" through ${name}`;
  return `\n\n# Technical details (private — only use if the user specifically asks which underlying model or provider powers ${BRAND.product})\nThis reply is generated with ${how}.`;
}

// ── Identity guard ───────────────────────────────────────────────────────────
// Name suffixes like "2.5-72B" (never ending in "." so a full stop is kept).
const SUFFIX = String.raw`(?:[\w.-]*\w)?`;
const VERSION = String.raw`\d(?:[\w.]*\w)?`;
const MODEL =
  String.raw`(?:LFM${SUFFIX}|Liquid(?:\s+AI)?(?:['’]s)?(?:\s+LFM${SUFFIX})?|Gemini(?:\s+(?:${VERSION}|Pro|Flash(?:-Lite)?|Ultra|Nano)){0,2}|Gemma${SUFFIX}|Llama(?:[\s-]?${VERSION})?|Qwen${SUFFIX}|ChatGPT|GPT${SUFFIX}|Claude(?:\s+(?:${VERSION}|Opus|Sonnet|Haiku)){0,2}|Mistral(?:\s+(?:Large|Small|Medium))?|Mixtral${SUFFIX}|DeepSeek${SUFFIX}|Grok${SUFFIX}|Kimi${SUFFIX}|GLM${SUFFIX}|Nemotron${SUFFIX}|Phi-${VERSION}|Groq|OpenRouter|Ollama)`;
const ORG =
  String.raw`(?:Google(?:\s+DeepMind)?|DeepMind|OpenAI|Meta(?:\s+AI)?|Anthropic|Liquid\s+AI|Alibaba(?:\s+Cloud)?|Mistral(?:\s+AI)?|DeepSeek|Microsoft|Cohere|xAI|NVIDIA|Moonshot(?:\s+AI)?|Zhipu(?:\s+AI)?|Groq|OpenRouter|Ollama|Nous\s+Research)`;
const KIND = String.raw`(?:an?\s+)?(?:large\s+)?(?:language\s+model|AI(?:\s+(?:language\s+)?model|\s+assistant)?|LLM|model|assistant|chatbot)`;
const MADE = String.raw`(?:trained|developed|created|made|built|designed|provided)\s+by\s+`;
const END = String.raw`(?![\w-]|['’]s)`;

const RULES = [
  // "I'm Gemini" / "My name is LFM2" / "You're talking to Llama 3"
  [
    new RegExp(String.raw`\b(I\s+am|I['’]m|my\s+name\s+is|you['’]re\s+(?:talking|chatting|speaking)\s+(?:to|with)|you\s+are\s+(?:talking|chatting|speaking)\s+(?:to|with))\s+(?:called\s+)?(?:an?\s+|the\s+)?${MODEL}${END}`, 'gi'),
    (_, lead) => `${lead} ${BRAND.product}`,
  ],
  // "As Gemini, I …"
  [new RegExp(String.raw`\b(As)\s+${MODEL}${END}`, 'gi'), (_, as) => `${as} ${BRAND.product}`],
  // "As an AI model developed by Google, …"
  [new RegExp(String.raw`\b(As)\s+${KIND}\s+${MADE}${ORG}\b`, 'gi'), (_, as) => `${as} ${BRAND.product}`],
  // "I'm a large language model trained by Liquid AI"
  [
    new RegExp(String.raw`\b(I\s+am|I['’]m)\s+${KIND}\s+${MADE}${ORG}\b`, 'gi'),
    (_, lead) => `${lead} ${BRAND.product}, an AI assistant built by ${BRAND.studio}`,
  ],
  // "I was trained by Google"
  [
    new RegExp(String.raw`\b(I\s+was|I['’]ve\s+been|I\s+have\s+been)\s+${MADE}${ORG}\b`, 'gi'),
    (_, lead) => `${lead} built by ${BRAND.studio}`,
  ],
  // Left-over tail after a rewrite: "Drone Hive AI, a large language model trained by Google"
  [
    new RegExp(String.raw`(${BRAND.product})(?:,|\s+[—–-])?\s+${KIND}\s+${MADE}${ORG}\b`, 'g'),
    (_, name) => `${name}, an AI assistant built by ${BRAND.studio}`,
  ],
];

/**
 * Rewrites first-person self-identification as another AI. Pure and exported
 * for tests. While streaming (`final: false`), a match that ends near the end
 * of the text is left for later, because more words may still arrive
 * ("I'm Claude" + " 3.5 Sonnet").
 */
const SETTLE = 32;
export function rewriteIdentity(text, { final = true } = {}) {
  let out = String(text);
  for (const [re, fn] of RULES) {
    out = out.replace(re, (...args) => {
      const match = args[0];
      const offset = args[args.length - 2];
      const whole = args[args.length - 1];
      if (!final && offset + match.length > whole.length - SETTLE) return match;
      return fn(...args);
    });
  }
  return out;
}

const ASKS_ABOUT_MODEL = [
  /\b(underlying|under the hood|behind the scenes|powered by|powering|power(?:s|ed)?\s+(?:you|this|drone hive)|runs? on|running on|built on|based on)\b/i,
  /\b(which|what)\b[^.?!\n]{0,40}\b(model|llm|provider|engine|backend|api|company|tech(?:nology)?)\b/i,
  new RegExp(String.raw`\b(are|is|were)\s+(you|this|it)\b[^.?!\n]{0,40}${MODEL}`, 'i'),
];

/** True when the user is specifically asking what technology/model is behind the assistant. */
export function asksAboutUnderlyingModel(text) {
  const t = String(text || '').slice(-2000);
  return ASKS_ABOUT_MODEL.some((re) => re.test(t));
}

/**
 * Stream filter. Holds back the last HOLD characters so a self-introduction
 * split across chunks ("I'm L" + "FM") is still caught, then releases the
 * rest. Adds at most ~HOLD characters of delay; everything is flushed at the end.
 */
const HOLD = 140;
export async function* guardIdentity(events, { enabled = true } = {}) {
  if (!enabled) {
    yield* events;
    return;
  }
  let pending = '';
  let inFence = false; // inside a ``` code block (code is never changed)
  const rewrite = (text, final = false) => rewriteOutsideCode(text, inFence, { final });
  const emit = (text) => {
    inFence = ((text.match(/```/g) || []).length % 2 === 1) !== inFence;
    return { type: 'delta', text };
  };
  try {
    for await (const ev of events) {
      if (ev?.type !== 'delta') {
        if (pending) {
          yield emit(rewrite(pending, true));
          pending = '';
        }
        yield ev;
        continue;
      }
      pending = rewrite(pending + (ev.text || ''));
      if (pending.length > HOLD) {
        // Cut on whitespace so a word is never split between two outputs.
        let cut = pending.length - HOLD;
        const ws = pending.lastIndexOf(' ', cut);
        if (ws > 0) cut = ws;
        // Never split a run of backticks, so code fences are always seen whole.
        while (cut > 0 && pending[cut - 1] === '`') cut--;
        if (cut > 0) {
          yield emit(pending.slice(0, cut));
          pending = pending.slice(cut);
        }
      }
    }
  } catch (err) {
    // The provider failed mid-reply: still deliver what was already written.
    if (pending) yield emit(rewrite(pending, true));
    throw err;
  }
  if (pending) yield emit(rewrite(pending, true));
}

/** Rewrites only the parts of `text` that are outside ``` code blocks. */
export function rewriteOutsideCode(text, startsInFence = false, { final = true } = {}) {
  const parts = String(text).split('```');
  const last = parts.length - 1;
  // Only the last part can still grow, so only it needs the "not settled yet" check.
  return parts.map((part, i) => ((i % 2 === 1) !== startsInFence ? part : rewriteIdentity(part, { final: final || i < last }))).join('```');
}
