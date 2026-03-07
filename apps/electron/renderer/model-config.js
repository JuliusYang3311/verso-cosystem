// 简化的 provider 配置 - 只保留 5 个主要 provider
const AUTH_GROUPS = {
  custom: {
    label: 'Custom Provider',
    hint: 'OpenAI/Anthropic/Google compatible',
    methods: [
      { value: 'custom-api-key', label: 'Custom Provider (API Key)' }
    ]
  },
  openai: {
    label: 'OpenAI',
    hint: 'Codex OAuth + API key',
    methods: [
      { value: 'openai-codex', label: 'OpenAI Codex (ChatGPT OAuth)' },
      { value: 'openai-api-key', label: 'OpenAI API key' }
    ]
  },
  anthropic: {
    label: 'Anthropic',
    hint: 'setup-token + API key',
    methods: [
      { value: 'token', label: 'Anthropic token (paste setup-token)', hint: 'run `claude setup-token` elsewhere, then paste the token here' },
      { value: 'apiKey', label: 'Anthropic API key' }
    ]
  },
  google: {
    label: 'Google Gemini',
    hint: 'API key',
    methods: [
      { value: 'google-api-key', label: 'Google Gemini API key' }
    ]
  },
  minimax: {
    label: 'MiniMax',
    hint: 'M2.1 (recommended)',
    methods: [
      { value: 'minimax-portal', label: 'MiniMax OAuth', hint: 'OAuth plugin for MiniMax' },
      { value: 'minimax-api', label: 'MiniMax M2.1' },
      { value: 'minimax-api-highspeed', label: 'MiniMax M2.1 Highspeed', hint: 'Faster, higher output cost' }
    ]
  }
};

// OAuth方法列表
const OAUTH_METHODS = new Set([
  'openai-codex',
  'token',
  'minimax-portal',
  'google-antigravity',
  'google-gemini-cli',
  'qwen-portal',
  'github-copilot',
  'chutes'
]);

// 完整的model catalog
const MODEL_CATALOG = {
  anthropic: [
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', reasoning: false, ctx: '1M' },
    { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)', reasoning: true, ctx: '1M' },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', reasoning: false, ctx: '1M' },
    { id: 'claude-sonnet-4-6-thinking', name: 'Claude Sonnet 4.6 (Thinking)', reasoning: true, ctx: '1M' },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', reasoning: false, ctx: '200K' },
    { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', reasoning: false, ctx: '200K' },
    { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', reasoning: false, ctx: '200K' }
  ],
  openai: [
    { id: 'gpt-5.4', name: 'GPT-5.4', reasoning: false, ctx: '2M' },
    { id: 'gpt-5.4-codex', name: 'GPT-5.4 Codex', reasoning: false, ctx: '2M' },
    { id: 'gpt-5.3', name: 'GPT-5.3', reasoning: false, ctx: '1M' },
    { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', reasoning: false, ctx: '1M' },
    { id: 'gpt-5.2', name: 'GPT-5.2', reasoning: false, ctx: '1M' },
    { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', reasoning: false, ctx: '1M' },
    { id: 'gpt-5.1', name: 'GPT-5.1', reasoning: false, ctx: '1M' },
    { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex', reasoning: false, ctx: '1M' },
    { id: 'gpt-5', name: 'GPT-5', reasoning: false, ctx: '1M' },
    { id: 'gpt-5-codex', name: 'GPT-5 Codex', reasoning: false, ctx: '1M' },
    { id: 'gpt-4o', name: 'GPT-4o', reasoning: false, ctx: '128K' },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini', reasoning: false, ctx: '128K' },
    { id: 'o3', name: 'o3', reasoning: true, ctx: '200K' },
    { id: 'o3-mini', name: 'o3 Mini', reasoning: true, ctx: '200K' },
    { id: 'o1', name: 'o1', reasoning: true, ctx: '200K' },
    { id: 'o1-mini', name: 'o1 Mini', reasoning: true, ctx: '128K' }
  ],
  google: [
    { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro (Preview)', reasoning: true, ctx: '1M' },
    { id: 'gemini-3.1-flash-lite-preview', name: 'Gemini 3.1 Flash Lite (Preview)', reasoning: false, ctx: '1M' },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', reasoning: false, ctx: '2M' },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', reasoning: false, ctx: '1M' },
    { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', reasoning: false, ctx: '1M' }
  ],
  minimax: [
    { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', reasoning: true, ctx: '200K' },
    { id: 'MiniMax-M2.5-highspeed', name: 'MiniMax M2.5 Highspeed', reasoning: true, ctx: '200K' },
    { id: 'MiniMax-M2.1', name: 'MiniMax M2.1', reasoning: false, ctx: '200K' },
    { id: 'MiniMax-M2.1-highspeed', name: 'MiniMax M2.1 Highspeed', reasoning: false, ctx: '200K' },
    { id: 'MiniMax-VL-01', name: 'MiniMax VL 01', reasoning: false, ctx: '200K' }
  ],
  'minimax-portal': [
    { id: 'MiniMax-M2.1', name: 'MiniMax M2.1', reasoning: false, ctx: '200K' },
    { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', reasoning: true, ctx: '200K' },
    { id: 'MiniMax-M2.5-highspeed', name: 'MiniMax M2.5 Highspeed', reasoning: true, ctx: '200K' }
  ],
  xiaomi: [
    { id: 'mimo-v2-flash', name: 'Xiaomi MiMo V2 Flash', reasoning: false, ctx: '256K' }
  ],
  moonshot: [
    { id: 'kimi-k2.5', name: 'Kimi K2.5', reasoning: false, ctx: '256K' }
  ],
  'qwen-portal': [
    { id: 'coder-model', name: 'Qwen Coder', reasoning: false, ctx: '128K' },
    { id: 'vision-model', name: 'Qwen Vision', reasoning: false, ctx: '128K' }
  ],
  qianfan: [
    { id: 'deepseek-v3.2', name: 'DEEPSEEK V3.2', reasoning: true, ctx: '98K' },
    { id: 'ernie-5.0-thinking-preview', name: 'ERNIE-5.0-Thinking-Preview', reasoning: true, ctx: '119K' }
  ]
};

window.AUTH_GROUPS = AUTH_GROUPS;
window.OAUTH_METHODS = OAUTH_METHODS;
window.MODEL_CATALOG = MODEL_CATALOG;
