// POST /api/chat — sends a conversation to the configured AI provider and streams the reply.
// Runs as a Netlify Edge Function: edge functions can stream for as long as the
// AI keeps talking (regular Netlify Functions stop streaming after 10 seconds).
import { handleChatRequest } from '../../server/handlers.js';

export default (request, context) => handleChatRequest(request, { ip: context?.ip });

export const config = {
  path: '/api/chat',
  // Enforced by Netlify itself (free on all plans), across every edge server,
  // before this code runs: max 10 chat requests per minute from one IP address.
  rateLimit: {
    windowLimit: 10,
    windowSize: 60,
    aggregateBy: ['ip', 'domain'],
  },
};
