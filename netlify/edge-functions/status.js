// GET /api/status — reports which AI providers are connected (never exposes keys).
import { handleStatusRequest } from '../../server/handlers.js';

export default (request) => handleStatusRequest(request);

export const config = {
  path: '/api/status',
  rateLimit: {
    windowLimit: 30,
    windowSize: 60,
    aggregateBy: ['ip', 'domain'],
  },
};
