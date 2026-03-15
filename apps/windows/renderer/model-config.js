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
    hint: 'OAuth or API key',
    methods: [
      { value: 'minimax-portal', label: 'OAuth', hint: 'Login via MiniMax portal' },
      { value: 'minimax-api', label: 'API Key' },
      { value: 'minimax-api-highspeed', label: 'API Key (Highspeed)', hint: 'Faster, higher output cost' }
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

/** Parse context window shorthand (e.g. "1M" → 1000000, "128K" → 128000). */
function parseCtx(ctx) {
  if (!ctx) return undefined;
  var m = ctx.match(/^(\d+(?:\.\d+)?)\s*([KMkm])?$/);
  if (!m) return undefined;
  var n = parseFloat(m[1]);
  var unit = (m[2] || '').toUpperCase();
  if (unit === 'M') return n * 1000000;
  if (unit === 'K') return n * 1000;
  return n;
}

// 完整的model catalog
const MODEL_CATALOG = {
  anthropic: [
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', reasoning: true, ctx: '1M', input: ['text', 'image'] },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', reasoning: true, ctx: '1M', input: ['text', 'image'] },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', reasoning: true, ctx: '200K', input: ['text', 'image'] },
    { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', reasoning: true, ctx: '200K', input: ['text', 'image'] },
    { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', reasoning: true, ctx: '200K', input: ['text', 'image'] }
  ],
  openai: [
    { id: 'gpt-5.4', name: 'GPT-5.4', reasoning: true, ctx: '1M', input: ['text', 'image'] },
    { id: 'gpt-5.3', name: 'GPT-5.3', reasoning: true, ctx: '1M', input: ['text', 'image'] },
    { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', reasoning: true, ctx: '1M', input: ['text', 'image'] },
    { id: 'gpt-5.2', name: 'GPT-5.2', reasoning: true, ctx: '1M', input: ['text', 'image'] },
    { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', reasoning: true, ctx: '1M', input: ['text', 'image'] },
    { id: 'gpt-5.1', name: 'GPT-5.1', reasoning: true, ctx: '1M', input: ['text', 'image'] },
    { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex', reasoning: true, ctx: '1M', input: ['text', 'image'] },
    { id: 'gpt-5', name: 'GPT-5', reasoning: true, ctx: '1M', input: ['text', 'image'] },
    { id: 'gpt-5-codex', name: 'GPT-5 Codex', reasoning: true, ctx: '1M', input: ['text', 'image'] },
    { id: 'gpt-4o', name: 'GPT-4o', reasoning: false, ctx: '128K', input: ['text', 'image'] },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini', reasoning: false, ctx: '128K', input: ['text', 'image'] },
    { id: 'o3', name: 'o3', reasoning: true, ctx: '200K', input: ['text', 'image'] },
    { id: 'o3-mini', name: 'o3 Mini', reasoning: true, ctx: '200K', input: ['text'] },
    { id: 'o1', name: 'o1', reasoning: true, ctx: '200K', input: ['text', 'image'] },
    { id: 'o1-mini', name: 'o1 Mini', reasoning: true, ctx: '128K', input: ['text'] }
  ],
  google: [
    { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro (Preview)', reasoning: true, ctx: '1M', input: ['text', 'image', 'video'] },
    { id: 'gemini-3.1-flash-lite-preview', name: 'Gemini 3.1 Flash Lite (Preview)', reasoning: false, ctx: '1M', input: ['text', 'image', 'video'] },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', reasoning: true, ctx: '2M', input: ['text', 'image', 'video'] },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', reasoning: true, ctx: '1M', input: ['text', 'image', 'video'] },
    { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', reasoning: false, ctx: '1M', input: ['text', 'image', 'video'] }
  ],
  minimax: [
    { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', reasoning: true, ctx: '200K', input: ['text'] },
    { id: 'MiniMax-M2.5-highspeed', name: 'MiniMax M2.5 Highspeed', reasoning: true, ctx: '200K', input: ['text'] },
    { id: 'MiniMax-M2.1', name: 'MiniMax M2.1', reasoning: false, ctx: '200K', input: ['text'] },
    { id: 'MiniMax-M2.1-highspeed', name: 'MiniMax M2.1 Highspeed', reasoning: false, ctx: '200K', input: ['text'] },
    { id: 'MiniMax-VL-01', name: 'MiniMax VL 01', reasoning: false, ctx: '200K', input: ['text', 'image'] }
  ],
  'minimax-portal': [
    { id: 'MiniMax-M2.1', name: 'MiniMax M2.1', reasoning: false, ctx: '200K', input: ['text'] },
    { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', reasoning: true, ctx: '200K', input: ['text'] },
    { id: 'MiniMax-M2.5-highspeed', name: 'MiniMax M2.5 Highspeed', reasoning: true, ctx: '200K', input: ['text'] }
  ],
  xiaomi: [
    { id: 'mimo-v2-flash', name: 'Xiaomi MiMo V2 Flash', reasoning: false, ctx: '256K', input: ['text'] }
  ],
  moonshot: [
    { id: 'kimi-k2.5', name: 'Kimi K2.5', reasoning: false, ctx: '256K', input: ['text'] }
  ],
  'qwen-portal': [
    { id: 'coder-model', name: 'Qwen Coder', reasoning: false, ctx: '128K', input: ['text'] },
    { id: 'vision-model', name: 'Qwen Vision', reasoning: false, ctx: '128K', input: ['text', 'image'] }
  ],
  qianfan: [
    { id: 'deepseek-v3.2', name: 'DEEPSEEK V3.2', reasoning: true, ctx: '98K', input: ['text'] },
    { id: 'ernie-5.0-thinking-preview', name: 'ERNIE-5.0-Thinking-Preview', reasoning: true, ctx: '119K', input: ['text'] }
  ]
};

window.AUTH_GROUPS = AUTH_GROUPS;
window.OAUTH_METHODS = OAUTH_METHODS;
window.MODEL_CATALOG = MODEL_CATALOG;
window.parseCtx = parseCtx;
