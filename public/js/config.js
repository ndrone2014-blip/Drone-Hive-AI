/**
 * Frontend configuration. No secrets here — this file is public.
 */
export const APP = {
  name: 'Drone Hive AI',
  shortName: 'Drone Hive',
  version: '0.2.0',
  studio: 'Drone Hive Studios',
  credits: 'Developed by Drone Hive Studios | Developer @ndrone40',
};

export const API = {
  status: '/api/status',
  chat: '/api/chat',
};

export const STORAGE_KEYS = {
  conversations: 'dhai.conversations.v1',
  activeId: 'dhai.activeConversation.v1',
  settings: 'dhai.settings.v1',
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
  longTermMemory: false,
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
  provider: 'default', // 'default' | 'automatic' | a provider id (manual choice)
  model: '',
  streamResponses: true,
  temperature: null, // null = provider default
  maxTokens: null, // null = server default
  customInstructions: '',
  accessCode: '',
};

/** Labels for the AI mode picker. */
export const AI_MODES = {
  default: { label: 'Default', description: 'Drone Hive AI’s standard setup' },
  automatic: { label: 'Automatic', description: 'Picks the best AI for each message' },
};
