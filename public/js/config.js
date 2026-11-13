/**
 * Frontend configuration. No secrets here — this file is public.
 */
export const APP = {
  name: 'Drone Hive AI',
  shortName: 'Drone Hive',
  version: '0.4.0',
  studio: 'Drone Hive Studios',
  credits: 'Developed by Drone Hive Studios | Developer @ndrone40',
  // Official company contact. Shown in Settings → About & contact. Links open
  // the user's own email app — Drone Hive AI never sends email itself.
  email: 'drone.hive.studios@gmail.com',
};

/** mailto: link to Drone Hive Studios with a helpful subject line. */
export function contactLink(subject = 'Drone Hive AI') {
  return `mailto:${APP.email}?subject=${encodeURIComponent(subject)}`;
}

export const API = {
  status: '/api/status',
  chat: '/api/chat',
  memory: '/api/memory',
};

export const STORAGE_KEYS = {
  conversations: 'dhai.conversations.v1',
  activeId: 'dhai.activeConversation.v1',
  settings: 'dhai.settings.v1',
  // + '.<account id>' (or '.guest'): memories kept in this browser, one list per account
  memory: 'dhai.memory.v1',
};

export const LIMITS = {
  maxMessageChars: 16000, // matches the server default (AI_MAX_MESSAGE_CHARS)
  titleLength: 48,
  maxImagesPerMessage: 4,
};

/**
 * Feature flags for things that are planned but not built yet.
 * The UI reads these to show "coming soon" states instead of dead buttons.
 */
export const FEATURES = {
  fileUploads: true, // images only; turned on/off at runtime by /api/status (status.vision)
  imageUnderstanding: true,
  pdfUnderstanding: false,
  webSearch: false,
  longTermMemory: true, // Settings → Memory (account or browser storage, see core/memory-store.js)
  // Drone Hive AI is a text-only chat app: no microphone, speech or audio features.
  voiceInput: false,
  voiceResponses: false,
  folders: false,
  personalities: false,
  accounts: true, // sign in with Google or email (Firebase, turned on from the server)
  cloudSync: false,
};

export const SUGGESTED_PROMPTS = [
  {
    icon: 'lightbulb',
    title: 'Brainstorm a project',
    subtitle: 'Turn a rough idea into a plan',
    prompt: 'Help me brainstorm a new project. Here is my idea: ',
  },
  {
    icon: 'book',
    title: 'Explain something',
    subtitle: 'Break down a complicated topic',
    prompt: 'Explain something complicated to me in simple terms: ',
  },
  {
    icon: 'pen',
    title: 'Help me write',
    subtitle: 'Drafts, messages, docs and more',
    prompt: 'Help me write something. I need: ',
  },
  {
    icon: 'layers',
    title: 'Organize my ideas',
    subtitle: 'Sort notes into clear structure',
    prompt: 'Help me organize my ideas. Here they are: ',
  },
];

export const DEFAULT_SETTINGS = {
  // General
  theme: 'system', // 'system' | 'light' | 'dark'
  fontSize: 'default', // 'small' | 'default' | 'large'
  reduceMotion: false,
  showTimestamps: true,
  sidebarCollapsed: false,
  displayName: '',
  // Chat
  enterToSend: true, // on phones Enter always adds a new line; use the send button
  autoScroll: true,
  // AI
  provider: 'automatic', // 'automatic' (standard) | 'default' | a provider id (manual choice)
  model: '',
  streamResponses: true,
  temperature: null, // null = provider default
  responseLength: 'medium', // 'short' | 'medium' (Medium = the server's Medium Response Tokens, 8,000)
  customInstructions: '',
  accessCode: '',
  showProviderChip: false, // technical: label each reply with the AI provider/model that wrote it
  // Memory
  memoryEnabled: true, // remember useful things between conversations
  memoryAuto: true, // save automatically (off = only when asked to "remember …")
  memoryRecentChats: true, // let the AI see the titles of recent conversations
};

/** Labels for the AI mode picker. */
export const AI_MODES = {
  automatic: { label: 'Automatic', description: 'Picks the best AI for each message (recommended)' },
  default: { label: 'Default', description: 'Uses the server’s standard AI' },
};

/** Settings format version. Bumped when a migration in settings-store.js is needed. */
export const SETTINGS_VERSION = 2;
