import {
  MEMORY_CATEGORIES,
  MEMORY_LIMITS,
  cleanMemoryText,
  explicitRememberRequest,
  normalizeCategory,
  sanitizeMemoryList,
  selectRelevantMemories,
  sensitiveReason,
} from '../../public/js/shared/memory-rules.js';

/**
 * How memory reaches the AI, and how the AI saves new memories.
 *
 * Reading:  the relevant memories are listed in the system prompt with short
 *           ids (m1, m2 …) that only exist for this one request.
 * Saving:   the AI adds hidden lines at the end of its reply, e.g.
 *             [[memory:add|tech|Uses discord.js v14 with TypeScript]]
 *             [[memory:update|m3|Now lives in Chicago]]
 *             [[memory:delete|m2]]
 *           extractMemoryCommands() removes them from the reply before the
 *           user sees it and turns them into operations, which the server
 *           (account storage) or the browser (browser storage) then applies
 *           with the shared rules — so passwords, keys etc. are never saved,
 *           whatever the AI writes.
 */

/** Reads and validates the `memory` part of a chat request. */
export function parseMemoryRequest(raw, { serverItems = null } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const enabled = r.enabled === true;
  if (!enabled) return { enabled: false };
  const items = serverItems ?? sanitizeMemoryList(Array.isArray(r.items) ? r.items.slice(0, MEMORY_LIMITS.maxItems) : []);
  const recent = Array.isArray(r.recent)
    ? r.recent
        .filter((t) => typeof t === 'string')
        .map((t) => cleanMemoryText(t).slice(0, 80))
        .filter(Boolean)
        .slice(0, MEMORY_LIMITS.recentTitles)
    : [];
  return { enabled: true, auto: r.auto !== false, items, recent };
}

/**
 * Builds the memory part of the system prompt. Returns { text, idMap } where
 * idMap turns the short ids shown to the AI back into real memory ids.
 */
export function buildMemoryPrompt(memory, messages) {
  if (!memory?.enabled) return { text: '', idMap: new Map() };
  const context = messages
    .slice(-4)
    .map((m) => m.content)
    .join('\n');
  const picked = selectRelevantMemories(memory.items, context);
  const idMap = new Map();
  const lines = picked.map((m, i) => {
    const short = `m${i + 1}`;
    idMap.set(short, m.id);
    return `[${short}] (${MEMORY_CATEGORIES[m.category] || 'Other'}) ${m.text}`;
  });

  let text = '\n\n# Memory\n';
  if (lines.length) {
    text +=
      'These are notes the user has allowed you to remember from earlier conversations. Use them only when they are relevant to what the user is asking now; ' +
      'don’t list them or mention that you remember things unless asked. Don’t ask for information that is already here. ' +
      'If the user says a note is wrong or out of date, believe the user and update the note.\n' +
      lines.join('\n');
    if (memory.items.length > picked.length) text += `\n(${memory.items.length - picked.length} other saved notes weren’t relevant to this message.)`;
  } else {
    text += 'You have no saved notes about this user yet.';
  }
  text += '\nYou only remember what is listed here. Never claim to remember anything else from earlier conversations, and never invent notes.';
  if (memory.recent?.length) {
    text += `\nTitles of the user’s other recent conversations (for context only): ${memory.recent.map((t) => `“${t}”`).join('; ')}.`;
  }

  text +=
    '\n\n# Saving notes\n' +
    (memory.auto
      ? 'You may save short notes that will genuinely help in future conversations: the user’s name, role or background, preferences and communication style, ongoing projects and their key details, programming languages, frameworks and tools they use, and instructions they want followed from now on. ' +
        'Don’t save one-off requests, small talk, guesses about the user, or anything sensitive (passwords, API keys, tokens, financial, health or other private details).'
      : 'Only save, change or delete notes when the user explicitly asks you to remember, update or forget something.') +
    '\nTo save a note, add a line at the very end of your reply in exactly this format (the user won’t see it):\n' +
    '[[memory:add|CATEGORY|short fact written in the third person]]\n' +
    'To correct a note: [[memory:update|m1|corrected fact]]   To forget a note: [[memory:delete|m1]]\n' +
    `CATEGORY is one of: ${Object.keys(MEMORY_CATEGORIES).join(', ')}. Use at most ${MEMORY_LIMITS.maxOpsPerReply} memory lines per reply, never save something that is already listed, and always answer the user normally as well. ` +
    'If you save or forget something, you may say so briefly in your answer. Never say you saved or forgot something without adding the matching memory line.';
  return { text, idMap };
}

// ── Reply parsing ────────────────────────────────────────────────────────────
const TAG_START = '[[memory:';
const TAG_RE = /^\[\[\s*memory\s*:\s*(add|update|delete|remove|forget)\s*(?:\|([^\]|]*))?(?:\|([^\]]*))?\]\]$/i;
const MAX_TAG = 700;

/** Turns one tag into an operation (ids still short, e.g. "m3"). */
export function parseTag(tag) {
  const m = String(tag).trim().match(TAG_RE);
  if (!m) return null;
  const verb = m[1].toLowerCase();
  const a = (m[2] || '').trim();
  const b = (m[3] || '').trim();
  if (verb === 'add') {
    // [[memory:add|category|text]] — or [[memory:add|text]] without a category
    return b ? { op: 'add', category: normalizeCategory(a), text: b } : a ? { op: 'add', category: 'other', text: a } : null;
  }
  if (verb === 'update') return a && b ? { op: 'update', id: a, text: b } : null;
  return a ? { op: 'delete', id: a } : null;
}

/** Length of the longest end of `s` that could be the start of a memory tag. */
function partialTagLength(s) {
  const lower = s.slice(-TAG_START.length).toLowerCase();
  for (let n = Math.min(lower.length, TAG_START.length - 1); n > 0; n--) {
    if (TAG_START.startsWith(lower.slice(-n))) return n;
  }
  return 0;
}

/**
 * Stream filter: removes memory tags from the reply and, just before the
 * final "done" event, emits { type: 'memory_ops', ops } with what the AI asked
 * to save. Tags are always removed (even with memory off) so they can never
 * show up in a reply.
 */
export async function* extractMemoryCommands(events) {
  let pending = ''; // text not yet sent (may contain the start of a tag)
  let trailingWs = ''; // whitespace held back in case only tags follow it
  let sentText = false;
  const ops = [];

  function* emit(text) {
    if (!text) return;
    const full = trailingWs + text;
    const m = full.match(/\s+$/);
    const body = m ? full.slice(0, m.index) : full;
    trailingWs = m ? m[0] : '';
    if (body) {
      sentText = true;
      yield { type: 'delta', text: body };
    }
  }

  function* drain(final) {
    while (pending) {
      const start = pending.toLowerCase().search(/\[\[\s*memory\s*:/);
      if (start === -1) {
        const keep = final ? 0 : partialTagLength(pending);
        yield* emit(pending.slice(0, pending.length - keep));
        pending = pending.slice(pending.length - keep);
        return;
      }
      yield* emit(pending.slice(0, start));
      pending = pending.slice(start);
      const end = pending.indexOf(']]');
      if (end === -1) {
        if (!final && pending.length < MAX_TAG) return; // wait for the rest of the tag
        // Not a real tag after all: show it as normal text.
        yield* emit(pending);
        pending = '';
        return;
      }
      const tag = pending.slice(0, end + 2);
      pending = pending.slice(end + 2);
      const op = parseTag(tag);
      if (op) {
        ops.push(op);
        // Drop the whitespace that separated the tag from the answer.
        if (!sentText) trailingWs = '';
      } else yield* emit(tag);
    }
  }

  function* finish() {
    yield* drain(true);
    if (!sentText && ops.length) {
      const text = ops.every((o) => o.op === 'delete') ? 'Done — I’ve forgotten that.' : 'Got it — I’ll remember that.';
      sentText = true;
      yield { type: 'delta', text };
    }
    trailingWs = '';
    if (ops.length) yield { type: 'memory_ops', ops: ops.slice(0, MEMORY_LIMITS.maxOpsPerReply * 2) };
  }

  let finished = false;
  try {
    for await (const ev of events) {
      if (ev?.type === 'delta') {
        pending += ev.text || '';
        yield* drain(false);
        continue;
      }
      if (ev?.type === 'done' && !finished) {
        finished = true;
        yield* finish();
      }
      yield ev;
    }
  } catch (err) {
    // The provider failed mid-reply: deliver the visible text, drop any half tag.
    const start = pending.toLowerCase().search(/\[\[\s*memory\s*:/);
    yield* emit(start === -1 ? pending : pending.slice(0, start));
    throw err;
  }
  if (!finished) yield* finish();
}

/**
 * Turns the AI's operations into real ones: maps short ids back to memory ids,
 * caps how many may happen per reply, and adds a "remember …" request the AI
 * ignored. Returns operations ready for applyMemoryOps().
 */
export function resolveMemoryOps(ops, { idMap, memory, lastUserText }) {
  if (!memory?.enabled) return [];
  const out = [];
  let adds = 0;
  for (const op of ops || []) {
    if (op.op === 'add') {
      if (adds >= MEMORY_LIMITS.maxOpsPerReply) continue;
      adds += 1;
      out.push({ op: 'add', text: op.text, category: op.category, source: 'chat' });
    } else {
      const id = idMap?.get(String(op.id).trim().toLowerCase());
      if (id) out.push({ ...op, op: op.op === 'update' ? 'update' : 'delete', id });
    }
  }
  if (!out.some((o) => o.op === 'add')) {
    const fact = explicitRememberRequest(lastUserText);
    if (fact) out.push({ op: 'add', text: fact, category: 'other', source: 'chat' });
  }
  // Secrets never leave this function, whatever the AI wrote. (They're
  // reported so the user can be told why nothing was saved.)
  return out.map((o) => (o.text !== undefined && sensitiveReason(o.text) ? { op: o.op, blocked: sensitiveReason(o.text) } : o));
}
