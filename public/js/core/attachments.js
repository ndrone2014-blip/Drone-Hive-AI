/**
 * Image attachments.
 *
 *  - Picked/pasted/dropped images are decoded and re-drawn onto a canvas, then
 *    saved as a new JPEG (max 1600px). This shrinks big photos, converts HEIC
 *    and other formats, and removes hidden metadata (GPS location, camera
 *    info, anything embedded in the file). Only real, decodable images survive.
 *  - The processed image is stored in this browser's IndexedDB (not
 *    localStorage, which is too small). It is never uploaded to the Drone
 *    Hive server for storage — only sent along with the message to the AI.
 *  - Conversations keep a small reference: { id, kind: 'image', name, mime, width, height, size }.
 */

const DB_NAME = 'dhai-attachments';
const STORE = 'files';
const MAX_EDGE = 1600;
const QUALITY = 0.86;
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024; // refuse absurd originals before decoding
export const MAX_OUTPUT_BYTES = 1.4 * 1024 * 1024; // 4 images (base64) stay well under the 8 MB request limit

let dbPromise = null;
const memoryFallback = new Map(); // private mode / IndexedDB blocked

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await openDB();
  if (!db) return fn(null);
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(store)).then((r) => (result = r));
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const reqToPromise = (req) => new Promise((res, rej) => ((req.onsuccess = () => res(req.result)), (req.onerror = () => rej(req.error))));

export async function putAttachment(id, blob) {
  try {
    await tx('readwrite', (s) => (s ? s.put(blob, id) : memoryFallback.set(id, blob)));
  } catch {
    memoryFallback.set(id, blob);
  }
}

export async function getAttachment(id) {
  if (memoryFallback.has(id)) return memoryFallback.get(id);
  try {
    const db = await openDB();
    if (!db) return null;
    return (await reqToPromise(db.transaction(STORE).objectStore(STORE).get(id))) || null;
  } catch {
    return null;
  }
}

export async function deleteAttachments(ids) {
  if (!ids?.length) return;
  ids.forEach((id) => {
    memoryFallback.delete(id);
    revokeUrl(id);
  });
  try {
    await tx('readwrite', (s) => s && ids.forEach((id) => s.delete(id)));
  } catch {
    /* ignore */
  }
}

export async function clearAttachments() {
  memoryFallback.clear();
  for (const id of [...urlCache.keys()]) revokeUrl(id);
  try {
    await tx('readwrite', (s) => s && s.clear());
  } catch {
    /* ignore */
  }
}

/** Deletes stored images that no conversation uses any more (e.g. after a crash). */
export async function pruneAttachments(keepIds) {
  const keep = new Set(keepIds);
  try {
    const db = await openDB();
    if (!db) return 0;
    const keys = await reqToPromise(db.transaction(STORE).objectStore(STORE).getAllKeys());
    const orphans = keys.filter((k) => !keep.has(k));
    if (orphans.length) await deleteAttachments(orphans);
    return orphans.length;
  } catch {
    return 0;
  }
}

// ── Object URLs for display (cached) ─────────────────────────────────────────
const urlCache = new Map();
export async function attachmentUrl(id) {
  if (urlCache.has(id)) return urlCache.get(id);
  const blob = await getAttachment(id);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urlCache.set(id, url);
  return url;
}
function revokeUrl(id) {
  const url = urlCache.get(id);
  if (url) URL.revokeObjectURL(url);
  urlCache.delete(id);
}

/** Base64 (no data: prefix) for sending to the server. */
export async function attachmentBase64(id) {
  const blob = await getAttachment(id);
  if (!blob) return null;
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { mediaType: blob.type || 'image/jpeg', data: btoa(bin) };
}

// ── Processing ───────────────────────────────────────────────────────────────
export class AttachmentError extends Error {}

function safeName(name) {
  const base = String(name || 'image').replace(/\.[^.]*$/, '').replace(/[^\w\- ]+/g, '').trim().slice(0, 60);
  return `${base || 'image'}.jpg`;
}

async function decode(file) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* fall through to <img> decoding */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Turns a user-picked File into a safe, compressed JPEG Blob.
 * Throws AttachmentError with a friendly message on failure.
 */
export async function processImage(file) {
  if (!file || !/^image\//i.test(file.type || '') && !/\.(png|jpe?g|webp|gif|heic|heif|bmp|avif)$/i.test(file.name || '')) {
    throw new AttachmentError(`“${file?.name || 'That file'}” isn’t an image. You can attach PNG, JPEG, WebP or GIF images.`);
  }
  if (/svg/i.test(file.type) || /\.svg$/i.test(file.name || '')) {
    throw new AttachmentError('SVG files aren’t supported. Export it as PNG or JPEG first.');
  }
  if (file.size > MAX_SOURCE_BYTES) throw new AttachmentError(`“${file.name}” is too large (max 25 MB).`);

  let bitmap;
  try {
    bitmap = await decode(file);
  } catch {
    throw new AttachmentError(`“${file.name || 'That image'}” couldn’t be opened. Try a PNG or JPEG.`);
  }
  const w0 = bitmap.width || bitmap.naturalWidth;
  const h0 = bitmap.height || bitmap.naturalHeight;
  if (!w0 || !h0) throw new AttachmentError('That image appears to be empty.');

  let scale = Math.min(1, MAX_EDGE / Math.max(w0, h0));
  let blob = null;
  let w;
  let h;
  for (let attempt = 0; attempt < 4; attempt++) {
    w = Math.max(1, Math.round(w0 * scale));
    h = Math.max(1, Math.round(h0 * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; // transparent areas become white, not black
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    blob = await canvasToBlob(canvas, 'image/jpeg', QUALITY - attempt * 0.08);
    if (blob && blob.size <= MAX_OUTPUT_BYTES) break;
    scale *= 0.75;
  }
  bitmap.close?.();
  if (!blob || blob.size > MAX_OUTPUT_BYTES) throw new AttachmentError('That image couldn’t be compressed enough to send.');
  return { blob, meta: { kind: 'image', name: safeName(file.name), mime: 'image/jpeg', width: w, height: h, size: blob.size } };
}
