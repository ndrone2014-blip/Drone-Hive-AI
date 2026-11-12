/**
 * Memory rules shared by the browser AND the server (the server imports this
 * file directly), so both sides apply exactly the same checks:
 *
 *   - what a memory looks like and how long it may be
 *   - what must NEVER be saved (passwords, API keys, tokens, card numbers…)
 *   - how add / update / delete operations are applied
 *   - which memories are relevant enough to send with a message
 *
 * Pure functions only — no storage, no network, no DOM.
 *
 * Memory item:
 *   { id, text, category, source: 'auto' | 'manual' | 'chat', createdAt, updatedAt }
 */

export const MEMORY_LIMITS = Object.freeze({
  maxItems: 100, // per account
  maxChars: 400, // per memory
  promptItems: 40, // most memories sent with one message
  promptChars: 3200, // most characters of memories sent with one message
  maxOpsPerReply: 3,
  recentTitles: 8,
});

export const MEMORY_CATEGORIES = Object.freeze({
  about: 'About you',
  preference: 'Preferences',
  project: 'Projects',
  tech: 'Coding & tools',
  instruction: 'Instructions',
  other: 'Other',
});

/** Categories that describe the person and how to talk to them: almost always useful. */
const ALWAYS_RELEVANT = new Set(['about', 'preference', 'instruction']);

export function normalizeCategory(value) {
  const v = String(value || '').trim().toLowerCase();
  if (MEMORY_CATEGORIES[v]) return v;
  if (/^(pref|style|tone|format)/.test(v)) return 'preference';
  if (/^(proj|work|app|repo)/.test(v)) return 'project';
  if (/^(tech|code|coding|lang|stack|framework|tool|dev)/.test(v)) return 'tech';
  if (/^(instr|rule|always|never)/.test(v)) return 'instruction';
  if (/^(about|me|user|person|bio|profile|name)/.test(v)) return 'about';
  return 'other';
}

/** Tidies memory text: one paragraph, no markup, trimmed to the length limit. */
export function cleanMemoryText(text) {
  return String(text ?? '')
    .replace(/\[\[|\]\]/g, '')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MEMORY_LIMITS.maxChars)
    .trim();
}

// ── Never-save rules ─────────────────────────────────────────────────────────
const SECRET_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{12,}/, // OpenAI-style / OpenRouter / Anthropic keys
  /\bgsk_[A-Za-z0-9]{12,}/, // Groq
  /\bAIza[0-9A-Za-z_-]{20,}/, // Google
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, // GitHub
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, // AWS
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT / session tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27,}/, // Discord bot token
];
// "password is …", "my api key: …", "token = …"
const CREDENTIAL_VALUE =
  /\b(pass(?:word|code|phrase)|pwd|pin(?:\s*code)?|api[\s_-]?keys?|secret(?:[\s_-]?key)?|access[\s_-]?token|auth(?:entication)?[\s_-]?token|bearer[\s_-]?token|bot[\s_-]?token|token|private[\s_-]?key|client[\s_-]?secret|refresh[\s_-]?token|session[\s_-]?(?:id|token|cookie)|recovery[\s_-]?codes?|backup[\s_-]?codes?|seed[\s_-]?phrase|mnemonic|2fa[\s_-]?code|otp|security[\s_-]?answer)\b[^.\n]{0,24}?(?:\bis\b|\bare\b|[:=]|\bwas\b)\s*\S/i;
// Long random-looking strings (keys, hashes, tokens)
const HIGH_ENTROPY = /\b(?=[A-Za-z0-9_\-+/]{28,}\b)(?=[^\s]*\d)(?=[^\s]*[a-z])(?=[^\s]*[A-Z])[A-Za-z0-9_\-+/]{28,}={0,2}/;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/;

function luhn(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}
function hasCardNumber(text) {
  for (const m of String(text).matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
  }
  return false;
}

/**
 * Returns a short reason if the text must never be stored as a memory,
 * or null if it's fine.
 */
export function sensitiveReason(text) {
  const t = String(text || '');
  if (SECRET_SHAPES.some((re) => re.test(t))) return 'it looks like an API key, token or private key';
  if (CREDENTIAL_VALUE.test(t)) return 'it looks like a password or other login secret';
  if (hasCardNumber(t)) return 'it looks like a payment card number';
  if (SSN.test(t)) return 'it looks like a government ID number';
  if (HIGH_ENTROPY.test(t)) return 'it contains a long code that looks like a secret';
  return null;
}

// ── Operations ───────────────────────────────────────────────────────────────
const newId = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
const norm = (t) => cleanMemoryText(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Validates and tidies a stored list (drops anything broken or sensitive). */
export function sanitizeMemoryList(list, { now = Date.now() } = {}) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const text = cleanMemoryText(raw.text);
    if (!text || sensitiveReason(text)) continue;
    const key = norm(text);
    if (seen.has(key)) continue;
    seen.add(key);
    const id = typeof raw.id === 'string' && /^[\w-]{1,64}$/.test(raw.id) ? raw.id : newId();
    const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : now;
    out.push({
      id,
      text,
      category: normalizeCategory(raw.category),
      source: ['auto', 'manual', 'chat'].includes(raw.source) ? raw.source : 'manual',
      createdAt,
      updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt,
    });
    if (out.length >= MEMORY_LIMITS.maxItems) break;
  }
  return out;
}

/**
 * Applies operations to a list and returns { items, applied, rejected }.
 *   ops: [{ op: 'add', text, category, source }, { op: 'update', id, text?, category? },
 *         { op: 'delete', id }, { op: 'clear' }]
 * Never mutates the input list.
 */
export function applyMemoryOps(list, ops, { now = Date.now() } = {}) {
  let items = list.map((m) => ({ ...m }));
  const applied = [];
  const rejected = [];
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!op || typeof op !== 'object') continue;
    if (op.op === 'clear') {
      items = [];
      applied.push({ op: 'clear' });
      continue;
    }
    if (op.op === 'delete') {
      const i = items.findIndex((m) => m.id === op.id);
      if (i === -1) {
        rejected.push({ op: 'delete', reason: 'not found' });
        continue;
      }
      const [gone] = items.splice(i, 1);
      applied.push({ op: 'delete', id: gone.id, text: gone.text, category: gone.category });
      continue;
    }
    if (op.op === 'update') {
      const m = items.find((x) => x.id === op.id);
      if (!m) {
        rejected.push({ op: 'update', reason: 'not found' });
        continue;
      }
      const text = op.text === undefined ? m.text : cleanMemoryText(op.text);
      if (!text) {
        rejected.push({ op: 'update', reason: 'empty' });
        continue;
      }
      const why = sensitiveReason(text);
      if (why) {
        rejected.push({ op: 'update', reason: why, sensitive: true });
        continue;
      }
      if (items.some((x) => x.id !== m.id && norm(x.text) === norm(text))) {
        rejected.push({ op: 'update', reason: 'duplicate' });
        continue;
      }
      m.text = text;
      if (op.category !== undefined) m.category = normalizeCategory(op.category);
      m.updatedAt = now;
      applied.push({ op: 'update', id: m.id, text: m.text, category: m.category });
      continue;
    }
    if (op.op === 'add') {
      const text = cleanMemoryText(op.text);
      if (text.length < 3) {
        rejected.push({ op: 'add', reason: 'empty' });
        continue;
      }
      const why = sensitiveReason(text);
      if (why) {
        rejected.push({ op: 'add', reason: why, sensitive: true });
        continue;
      }
      if (items.some((x) => norm(x.text) === norm(text))) {
        rejected.push({ op: 'add', reason: 'duplicate' });
        continue;
      }
      if (items.length >= MEMORY_LIMITS.maxItems) {
        rejected.push({ op: 'add', reason: 'full' });
        continue;
      }
      const m = {
        id: newId(),
        text,
        category: normalizeCategory(op.category),
        source: ['auto', 'manual', 'chat'].includes(op.source) ? op.source : 'auto',
        createdAt: now,
        updatedAt: now,
      };
      items.push(m);
      applied.push({ op: 'add', id: m.id, text: m.text, category: m.category });
    }
  }
  return { items, applied, rejected };
}

// ── Relevance ────────────────────────────────────────────────────────────────
const STOP = new Set(
  'the and for are but not you your yours with this that these those from have has had was were will would could should can about into than then them they their there what when where which who whom how why its it’s i’m i’ve i’d i’ll one two use using used just like make made want need help please thanks thank user users also very more most some any all each other such only own same out over under again further once here both few nor too does did doing done get got via per'.split(
    ' ',
  ),
);
export function keywords(text) {
  const out = new Set();
  for (const w of String(text || '').toLowerCase().match(/[\p{L}\p{N}#+.]{3,}/gu) || []) {
    const word = w.replace(/^[.]+|[.]+$/g, '');
    if (word.length >= 3 && !STOP.has(word)) out.add(word.endsWith('s') && word.length > 4 ? word.slice(0, -1) : word);
  }
  return out;
}

/**
 * Picks the memories worth sending with this message: everything that
 * describes the person (about / preferences / instructions), plus the
 * memories that share words with the recent conversation, best matches
 * first, within the size limits.
 */
export function selectRelevantMemories(list, contextText, { maxItems = MEMORY_LIMITS.promptItems, maxChars = MEMORY_LIMITS.promptChars } = {}) {
  const ctx = keywords(contextText);
  const scored = list.map((m, i) => {
    const words = keywords(m.text);
    let overlap = 0;
    for (const w of words) if (ctx.has(w)) overlap += 1;
    const base = ALWAYS_RELEVANT.has(m.category) ? 2 : 0;
    // Small bonus for recently updated memories so ties favour fresh information.
    const recency = (m.updatedAt || 0) / 1e14 + i / 1e6;
    return { m, score: overlap * 3 + base + recency, overlap, base };
  });
  scored.sort((a, b) => b.score - a.score);
  const picked = [];
  let chars = 0;
  for (const s of scored) {
    if (picked.length >= maxItems) break;
    // Project/tech/other memories are only sent when they relate to the chat,
    // unless there are only a few memories in total.
    if (!s.base && !s.overlap && list.length > 12) continue;
    const cost = s.m.text.length + 24;
    if (chars + cost > maxChars) continue;
    picked.push(s.m);
    chars += cost;
  }
  return picked;
}

/**
 * Turns a direct request like "remember that I use Tailwind" into a memory,
 * for AIs that don't follow the memory instructions. Returns null if the
 * message isn't a "remember …" request.
 */
export function explicitRememberRequest(text) {
  const m = String(text || '')
    .trim()
    .match(/^(?:hey[,!]?\s+)?(?:please\s+)?(?:can you\s+|could you\s+)?(?:remember|don['’]?t forget|do not forget|keep in mind|note|save(?: to memory)?)\s*(?:that|this)?[:,]?\s+(?!(?:to|when|what|how|if|why|where|who|whether|the time)\b)([\s\S]{3,400}?)[\s.!?]*$/i);
  if (!m) return null;
  let fact = m[1].trim().replace(/\s+/g, ' ');
  if (/^(it|this|that|what i said)$/i.test(fact)) return null;
  // First person -> third person, for the common simple cases.
  fact = fact
    .replace(/^i am\b/i, 'User is')
    .replace(/^i['’]m\b/i, 'User is')
    .replace(/^i['’]ve\b/i, 'User has')
    .replace(/^i\s+(?:(always|never|usually|often|mostly|really|also|only|still)\s+)?([a-z’']+)/i, (_, adv, verb) => `User ${adv ? `${adv} ` : ''}${thirdPerson(verb)}`)
    .replace(/^my\b/i, 'User’s')
    .replace(/\bmy\b/gi, 'their')
    .replace(/\bI['’]m\b/g, 'they are')
    .replace(/\bI\b/g, 'they')
    .replace(/\bme\b/gi, 'them');
  return fact.charAt(0).toUpperCase() + fact.slice(1);
}

const KEEP_VERB = new Set(['can', 'could', 'will', 'would', 'should', 'must', 'might', 'may', 'shall', 'was']);
const IRREGULAR = { have: 'has', do: 'does', go: 'goes', am: 'is', "don't": "doesn't", 'don’t': 'doesn’t', "haven't": "hasn't", 'haven’t': 'hasn’t' };
function thirdPerson(verb) {
  const v = verb.toLowerCase();
  if (KEEP_VERB.has(v) || /['’]/.test(v) && !IRREGULAR[v]) return verb;
  if (IRREGULAR[v]) return IRREGULAR[v];
  if (/(s|sh|ch|x|z|o)$/.test(v)) return `${verb}es`;
  if (/[^aeiou]y$/.test(v)) return `${verb.slice(0, -1)}ies`;
  return `${verb}s`;
}
