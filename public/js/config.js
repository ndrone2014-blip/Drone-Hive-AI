/**
 * Frontend configuration. No secrets here — this file is public.
 */
export const APP = {
  name: 'Drone Hive AI',
  shortName: 'Drone Hive',
  version: '0.1.0',
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
  maxMessageChars: 32000,
  titleLength: 48,
};

/**
 * Feature flags for things that are planned but not built yet.
 * The UI reads these to show "coming soon" states instead of dead buttons.
 */
export const FEATURES = {
  fileUploads: false, // FUTURE: attachments in composer -> content parts
  imageUnderstanding: false,
  pdfUnderstanding: false,
  webSearch: false,
  longTermMemory: false,
  voiceInput: false,
  voiceResponses: false,
  folders: false,
  personalities: false,
  accounts: false,
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
  enterToSend: true,
  autoScroll: true,
  // AI
  provider: 'auto',
  model: '',
  streamResponses: true,
  temperature: null, // null = provider default
  maxTokens: null, // null = server default
  customInstructions: '',
  accessCode: '',
};
