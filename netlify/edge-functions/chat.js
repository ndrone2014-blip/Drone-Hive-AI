// POST /api/chat — sends a conversation to the configured AI provider and streams the reply.
// Runs as a Netlify Edge Function: edge functions can stream for as long as the
// AI keeps talking (regular Netlify Functions stop streaming after 10 seconds).
import { handleChatRequest } from '../../server/handlers.js';

export default (request) => handleChatRequest(request);

export const config = { path: '/api/chat' };
