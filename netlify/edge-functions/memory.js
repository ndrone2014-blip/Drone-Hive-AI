// /api/memory — view and manage the signed-in account's saved memories.
// Only used when memories are stored in the account (sign-in + Firestore);
// otherwise the browser keeps them itself.
import { handleMemoryRequest } from '../../server/handlers.js';

export default (request) => handleMemoryRequest(request);

export const config = {
  path: '/api/memory',
  rateLimit: {
    windowLimit: 60,
    windowSize: 60,
    aggregateBy: ['ip', 'domain'],
  },
};
