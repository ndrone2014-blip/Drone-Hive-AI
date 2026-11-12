import { AIError, ERROR_CODES } from './errors.js';

/**
 * The single message format used between the frontend and backend:
 *
 *   { role: 'user' | 'assistant', content: string | ContentPart[] }
 *
 *   ContentPart = { type: 'text', text: string }
 *               | { type: 'image', mediaType: 'image/jpeg'|'image/png'|'image/webp'|'image/gif', data: <base64> }
 *
 * After normalizing, every message looks like:
 *
 *   { role, content: string, images: [{ mediaType, data, bytes }] }
 *
 * Each provider converts this into its own API format inside open().
 *
 * Images are NEVER written to disk or stored on the server. They are checked
 * here (type, real file signature, size, count) and passed straight to the AI
 * provider for this one request.
 */

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
/** Rough input-token cost of one image, used for budgets (providers charge ~250–2,000). */
export const IMAGE_TOKEN_ESTIMATE = 1500;

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export function normalizeMessages(input, limits) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new AIError(ERROR_CODES.INVALID_REQUEST, 'Request must include at least one message.', 400);
  }

  // Keep only the most recent messages.
  const recent = input.slice(-limits.maxMessages);
  const out = [];
  let total = 0;

  for (const raw of recent) {
    if (!raw || (raw.role !== 'user' && raw.role !== 'assistant')) continue;
    const text = contentToText(raw.content).trim();
    // Only user messages may carry images.
    const images = raw.role === 'user' ? contentToImages(raw.content, limits) : [];
    if (!text && !images.length) continue;
    if (text.length > limits.maxMessageChars) {
      throw new AIError(ERROR_CODES.INVALID_REQUEST, `A message is too long (max ${limits.maxMessageChars.toLocaleString()} characters).`, 400);
    }
    total += text.length;

    // Providers expect alternating roles; merge back-to-back messages from the same role.
    const prev = out[out.length - 1];
    if (prev && prev.role === raw.role) {
      prev.content = [prev.content, text].filter(Boolean).join('\n\n');
      prev.images.push(...images);
    } else out.push({ role: raw.role, content: text, images });
  }

  if (total > limits.maxTotalChars) {
    throw new AIError(ERROR_CODES.INVALID_REQUEST, 'This conversation is too long to send. Start a new chat to continue.', 400);
  }
  // Conversations must start with the user and end with the user.
  while (out.length && out[0].role !== 'user') out.shift();
  if (!out.length || out[out.length - 1].role !== 'user') {
    throw new AIError(ERROR_CODES.INVALID_REQUEST, 'The last message must be from the user.', 400);
  }

  // Only the most recent images are sent (they cost a lot of tokens). Older
  // ones are replaced with a short note so the AI knows something was there.
  let kept = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (!m.images.length) continue;
    const room = Math.max(0, limits.maxImages - kept);
    if (m.images.length > room) {
      const dropped = m.images.length - room;
      m.images = m.images.slice(m.images.length - room);
      m.content = `${m.content}${m.content ? '\n\n' : ''}[${dropped} earlier image${dropped === 1 ? ' was' : 's were'} shared here but not re-sent.]`;
    }
    kept += m.images.length;
  }
  // A message that is only images still needs some text for some providers.
  for (const m of out) if (!m.content && m.images.length) m.content = 'What can you tell me about this image?';
  return out;
}

/** Number of images in a normalized conversation. */
export function countImages(messages) {
  return messages.reduce((n, m) => n + (m.images?.length || 0), 0);
}

/** Removes all images (used when a provider can't see them). */
export function stripImages(messages) {
  return messages.map((m) => ({ ...m, images: [] }));
}

/** Keeps only the newest `max` images. */
export function limitImages(messages, max) {
  let kept = 0;
  const out = messages.map((m) => ({ ...m, images: [...m.images] }));
  for (let i = out.length - 1; i >= 0; i--) {
    const room = Math.max(0, max - kept);
    if (out[i].images.length > room) out[i].images = out[i].images.slice(out[i].images.length - room);
    kept += out[i].images.length;
  }
  return out;
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(partToText).filter(Boolean).join('\n');
  return '';
}

function partToText(part) {
  if (typeof part === 'string') return part;
  if (part?.type === 'text' && typeof part.text === 'string') return part.text;
  return ''; // unknown part types are ignored
}

function contentToImages(content, limits) {
  if (!Array.isArray(content)) return [];
  const images = [];
  for (const part of content) {
    if (part?.type !== 'image') continue;
    if (images.length >= limits.maxImages) {
      throw new AIError(ERROR_CODES.INVALID_REQUEST, `You can attach up to ${limits.maxImages} images per message.`, 400);
    }
    images.push(validateImage(part, limits));
  }
  return images;
}

/**
 * Checks an image part. The declared type must be an allowed image type AND
 * the decoded bytes must start with that format's real file signature, so a
 * script or other file renamed to ".png" is rejected. SVG is never allowed
 * (it can contain scripts).
 */
export function validateImage(part, limits) {
  const bad = (msg = 'That image type isn’t supported. Use PNG, JPEG, WebP or GIF.') => new AIError(ERROR_CODES.INVALID_IMAGE, msg, 400);
  const mediaType = String(part.mediaType || '').toLowerCase();
  if (!IMAGE_TYPES.includes(mediaType)) throw bad();
  const data = typeof part.data === 'string' ? part.data : '';
  if (!data || data.length % 4 !== 0 || !BASE64_RE.test(data)) throw bad('The image data is damaged. Try attaching it again.');
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const bytes = (data.length / 4) * 3 - padding;
  if (bytes > limits.maxImageBytes) {
    throw bad(`That image is too large (max ${(limits.maxImageBytes / 1024 / 1024).toFixed(0)} MB).`);
  }
  if (bytes < 32) throw bad('The image data is damaged. Try attaching it again.');
  let head;
  try {
    head = atob(data.slice(0, 16));
  } catch {
    throw bad('The image data is damaged. Try attaching it again.');
  }
  if (!matchesSignature(mediaType, head)) throw bad('That file isn’t a real image of the type it claims to be.');
  return { mediaType, data, bytes };
}

function matchesSignature(type, s) {
  const b = (i) => s.charCodeAt(i);
  switch (type) {
    case 'image/jpeg':
      return b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff;
    case 'image/png':
      return b(0) === 0x89 && s.slice(1, 4) === 'PNG' && b(4) === 0x0d && b(5) === 0x0a;
    case 'image/gif':
      return s.slice(0, 6) === 'GIF87a' || s.slice(0, 6) === 'GIF89a';
    case 'image/webp':
      return s.slice(0, 4) === 'RIFF' && s.slice(8, 12) === 'WEBP';
    default:
      return false;
  }
}
