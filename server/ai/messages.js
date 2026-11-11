import { AIError, ERROR_CODES } from './errors.js';

/**
 * The single message format used between the frontend and backend:
 *
 *   { role: 'user' | 'assistant', content: string | ContentPart[] }
 *
 *   ContentPart = { type: 'text', text: string }
 *               | { type: 'image', ... }     // FUTURE: image understanding
 *               | { type: 'document', ... }  // FUTURE: PDF understanding
 *
 * Today only text is passed to providers. When file/image support is added,
 * extend `partToText` / add a parts branch here, and convert the parts inside
 * each provider's open() method.
 */
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
    if (!text) continue;
    if (text.length > limits.maxMessageChars) {
      throw new AIError(ERROR_CODES.INVALID_REQUEST, `A message is too long (max ${limits.maxMessageChars.toLocaleString()} characters).`, 400);
    }
    total += text.length;

    // Providers expect alternating roles; merge back-to-back messages from the same role.
    const prev = out[out.length - 1];
    if (prev && prev.role === raw.role) prev.content += `\n\n${text}`;
    else out.push({ role: raw.role, content: text });
  }

  if (total > limits.maxTotalChars) {
    throw new AIError(ERROR_CODES.INVALID_REQUEST, 'This conversation is too long to send. Start a new chat to continue.', 400);
  }
  // Conversations must start with the user and end with the user.
  while (out.length && out[0].role !== 'user') out.shift();
  if (!out.length || out[out.length - 1].role !== 'user') {
    throw new AIError(ERROR_CODES.INVALID_REQUEST, 'The last message must be from the user.', 400);
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
  return ''; // unsupported part types are ignored for now
}
