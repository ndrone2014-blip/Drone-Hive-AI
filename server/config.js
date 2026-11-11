import { getEnv, getEnvInt } from './env.js';

export const APP = {
  name: 'Drone Hive AI',
  version: '0.1.0',
  studio: 'Drone Hive Studios',
};

/**
 * The base personality of the assistant. Can be replaced entirely with the
 * AI_SYSTEM_PROMPT environment variable. Users can add their own custom
 * instructions on top of this from the Settings screen.
 *
 * FUTURE: custom AI personalities -> pick a different base prompt here based
 * on a `personalityId` sent with the request.
 */
export const DEFAULT_SYSTEM_PROMPT = `You are Drone Hive AI, an AI assistant built by Drone Hive Studios.
You are especially strong at programming help: writing, explaining, reviewing and debugging code.
You also help with brainstorming, explaining complicated topics, writing and organizing ideas.
Be clear, accurate and friendly. Use Markdown for structure and fenced code blocks (with a language tag) for code.
If you are not sure about something, say so instead of guessing.`;

/** Server-side configuration, read fresh on every request (cheap). */
export function getServerConfig() {
  return {
    preferredProvider: getEnv('AI_PROVIDER', 'auto'),
    // Optional: protects your API key from strangers who find your site.
    accessCode: getEnv('DRONEHIVE_ACCESS_CODE', ''),
    systemPrompt: getEnv('AI_SYSTEM_PROMPT', DEFAULT_SYSTEM_PROMPT),
    allowCustomInstructions: getEnv('AI_ALLOW_CUSTOM_INSTRUCTIONS', 'true') !== 'false',
    maxOutputTokens: getEnvInt('AI_MAX_OUTPUT_TOKENS', { min: 256, max: 64000, fallback: 4096 }),
    limits: {
      maxMessages: 100, // most recent messages sent to the model
      maxMessageChars: 32000, // per message
      maxTotalChars: 200000, // whole conversation
      maxCustomInstructionChars: 4000,
    },
  };
}
