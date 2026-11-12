import { getEnv } from '../env.js';
import { getAuthConfig } from '../auth.js';
import { FirestoreConflict, getDocument, getFirestoreConfig, writeDocument } from '../usage/firestore.js';
import { applyMemoryOps, sanitizeMemoryList, MEMORY_LIMITS } from '../../public/js/shared/memory-rules.js';

/**
 * Where memories live.
 *
 *   'account'  Saved on the server in Firestore, under the signed-in account.
 *              Used when sign-in is on AND a Firestore service account is set
 *              (the same free Firebase project as the usage limits). Memories
 *              then follow the user to every device and browser.
 *   'browser'  Saved in this browser only (localStorage), separately for each
 *              signed-in account. The browser sends them with each message and
 *              the server never stores them. Used when the above isn't set up.
 *
 * Force browser storage with MEMORY_STORE=browser.
 *
 * Firestore layout: one document per account at memories/{sha256(uid)} with
 *   items      JSON text of the memory list (max 100 × 400 characters)
 *   updatedAt  timestamp
 * The document id is a hash, so account ids never appear in the database.
 * Only the server can read it (Firestore rules deny all browser access).
 */

export function memoryStoreMode() {
  if (getEnv('MEMORY_STORE', '') === 'browser') return 'browser';
  if (!getAuthConfig().enabled) return 'browser';
  return getFirestoreConfig({ forUsage: false }) ? 'account' : 'browser';
}

async function docPath(uid) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`dhai-memory:${uid}`));
  return `memories/${[...new Uint8Array(d).slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function decode(doc) {
  if (!doc) return [];
  try {
    return sanitizeMemoryList(JSON.parse(doc.fields?.items?.stringValue || '[]'));
  } catch {
    return [];
  }
}

/** The account's memories (sanitized). Throws if the database can't be reached. */
export async function loadMemories(uid, { signal } = {}) {
  const cfg = getFirestoreConfig({ forUsage: false });
  if (!cfg || !uid) return [];
  return decode(await getDocument(cfg, await docPath(uid), { signal }));
}

/**
 * Applies operations to the account's memories with a safe read-modify-write
 * (retried if two tabs change memories at the same moment).
 * Returns { items, applied, rejected }.
 */
export async function updateMemories(uid, ops, { now = Date.now() } = {}) {
  const cfg = getFirestoreConfig({ forUsage: false });
  if (!cfg || !uid) throw new Error('Account memory storage is not configured');
  const path = await docPath(uid);
  for (let attempt = 0; attempt < 3; attempt++) {
    const doc = await getDocument(cfg, path);
    const result = applyMemoryOps(decode(doc), ops, { now });
    if (!result.applied.length) return result;
    try {
      if (!result.items.length) {
        if (doc) await writeDocument(cfg, path, null, { remove: true, updateTime: doc.updateTime });
      } else {
        await writeDocument(
          cfg,
          path,
          {
            items: { stringValue: JSON.stringify(result.items.slice(0, MEMORY_LIMITS.maxItems)) },
            updatedAt: { timestampValue: new Date(now).toISOString() },
          },
          { updateTime: doc ? doc.updateTime : null },
        );
      }
      return result;
    } catch (err) {
      if (!(err instanceof FirestoreConflict) || attempt === 2) throw err;
    }
  }
  throw new Error('Memory update failed');
}
