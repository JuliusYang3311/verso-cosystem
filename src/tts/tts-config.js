import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { CONFIG_DIR, resolveUserPath } from "../utils.js";
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_TTS_MAX_LENGTH = 1500;
export const DEFAULT_TTS_SUMMARIZE = true;
const DEFAULT_MAX_TEXT_LENGTH = 4096;
const DEFAULT_ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";
const DEFAULT_ELEVENLABS_VOICE_ID = "pMsXgVXv3BLzUgSXRplE";
const DEFAULT_ELEVENLABS_MODEL_ID = "eleven_multilingual_v2";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini-tts";
const DEFAULT_OPENAI_VOICE = "alloy";
const DEFAULT_EDGE_VOICE = "en-US-MichelleNeural";
const DEFAULT_EDGE_LANG = "en-US";
export const DEFAULT_EDGE_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
const DEFAULT_ELEVENLABS_VOICE_SETTINGS = {
  stability: 0.5,
  similarityBoost: 0.75,
  style: 0.0,
  useSpeakerBoost: true,
  speed: 1.0,
};
const TTS_AUTO_MODES = new Set(["off", "always", "inbound", "tagged"]);
// ---------------------------------------------------------------------------
// Status tracking
// ---------------------------------------------------------------------------
let lastTtsAttempt;
export function getLastTtsAttempt() {
  return lastTtsAttempt;
}
export function setLastTtsAttempt(entry) {
  lastTtsAttempt = entry;
}
// ---------------------------------------------------------------------------
// Auto-mode normalization
// ---------------------------------------------------------------------------
export function normalizeTtsAutoMode(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (TTS_AUTO_MODES.has(normalized)) {
    return normalized;
  }
  return undefined;
}
// ---------------------------------------------------------------------------
// Model override policy
// ---------------------------------------------------------------------------
export function resolveModelOverridePolicy(overrides) {
  const enabled = overrides?.enabled ?? true;
  if (!enabled) {
    return {
      enabled: false,
      allowText: false,
      allowProvider: false,
      allowVoice: false,
      allowModelId: false,
      allowVoiceSettings: false,
      allowNormalization: false,
      allowSeed: false,
    };
  }
  const allow = (value) => value ?? true;
  return {
    enabled: true,
    allowText: allow(overrides?.allowText),
    allowProvider: allow(overrides?.allowProvider),
    allowVoice: allow(overrides?.allowVoice),
    allowModelId: allow(overrides?.allowModelId),
    allowVoiceSettings: allow(overrides?.allowVoiceSettings),
    allowNormalization: allow(overrides?.allowNormalization),
    allowSeed: allow(overrides?.allowSeed),
  };
}
// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------
export function resolveTtsConfig(cfg) {
  const raw = cfg.messages?.tts ?? {};
  const providerSource = raw.provider ? "config" : "default";
  const edgeOutputFormat = raw.edge?.outputFormat?.trim();
  const auto = normalizeTtsAutoMode(raw.auto) ?? (raw.enabled ? "always" : "off");
  return {
    auto,
    mode: raw.mode ?? "final",
    provider: raw.provider ?? "edge",
    providerSource,
    summaryModel: raw.summaryModel?.trim() || undefined,
    modelOverrides: resolveModelOverridePolicy(raw.modelOverrides),
    elevenlabs: {
      apiKey: raw.elevenlabs?.apiKey,
      baseUrl: raw.elevenlabs?.baseUrl?.trim() || DEFAULT_ELEVENLABS_BASE_URL,
      voiceId: raw.elevenlabs?.voiceId ?? DEFAULT_ELEVENLABS_VOICE_ID,
      modelId: raw.elevenlabs?.modelId ?? DEFAULT_ELEVENLABS_MODEL_ID,
      seed: raw.elevenlabs?.seed,
      applyTextNormalization: raw.elevenlabs?.applyTextNormalization,
      languageCode: raw.elevenlabs?.languageCode,
      voiceSettings: {
        stability:
          raw.elevenlabs?.voiceSettings?.stability ?? DEFAULT_ELEVENLABS_VOICE_SETTINGS.stability,
        similarityBoost:
          raw.elevenlabs?.voiceSettings?.similarityBoost ??
          DEFAULT_ELEVENLABS_VOICE_SETTINGS.similarityBoost,
        style: raw.elevenlabs?.voiceSettings?.style ?? DEFAULT_ELEVENLABS_VOICE_SETTINGS.style,
        useSpeakerBoost:
          raw.elevenlabs?.voiceSettings?.useSpeakerBoost ??
          DEFAULT_ELEVENLABS_VOICE_SETTINGS.useSpeakerBoost,
        speed: raw.elevenlabs?.voiceSettings?.speed ?? DEFAULT_ELEVENLABS_VOICE_SETTINGS.speed,
      },
    },
    openai: {
      apiKey: raw.openai?.apiKey,
      model: raw.openai?.model ?? DEFAULT_OPENAI_MODEL,
      voice: raw.openai?.voice ?? DEFAULT_OPENAI_VOICE,
    },
    edge: {
      enabled: raw.edge?.enabled ?? true,
      voice: raw.edge?.voice?.trim() || DEFAULT_EDGE_VOICE,
      lang: raw.edge?.lang?.trim() || DEFAULT_EDGE_LANG,
      outputFormat: edgeOutputFormat || DEFAULT_EDGE_OUTPUT_FORMAT,
      outputFormatConfigured: Boolean(edgeOutputFormat),
      pitch: raw.edge?.pitch?.trim() || undefined,
      rate: raw.edge?.rate?.trim() || undefined,
      volume: raw.edge?.volume?.trim() || undefined,
      saveSubtitles: raw.edge?.saveSubtitles ?? false,
      proxy: raw.edge?.proxy?.trim() || undefined,
      timeoutMs: raw.edge?.timeoutMs,
    },
    prefsPath: raw.prefsPath,
    maxTextLength: raw.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH,
    timeoutMs: raw.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}
// ---------------------------------------------------------------------------
// Prefs path resolution
// ---------------------------------------------------------------------------
export function resolveTtsPrefsPath(config) {
  if (config.prefsPath?.trim()) {
    return resolveUserPath(config.prefsPath.trim());
  }
  const envPath = process.env.VERSO_TTS_PREFS?.trim();
  if (envPath) {
    return resolveUserPath(envPath);
  }
  return path.join(CONFIG_DIR, "settings", "tts.json");
}
// ---------------------------------------------------------------------------
// Prefs I/O
// ---------------------------------------------------------------------------
export function readPrefs(prefsPath) {
  try {
    if (!existsSync(prefsPath)) {
      return {};
    }
    return JSON.parse(readFileSync(prefsPath, "utf8"));
  } catch {
    return {};
  }
}
function atomicWriteFileSync(filePath, content) {
  const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmpPath, content);
  try {
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
}
function updatePrefs(prefsPath, update) {
  const prefs = readPrefs(prefsPath);
  update(prefs);
  mkdirSync(path.dirname(prefsPath), { recursive: true });
  atomicWriteFileSync(prefsPath, JSON.stringify(prefs, null, 2));
}
// ---------------------------------------------------------------------------
// Auto-mode resolution
// ---------------------------------------------------------------------------
function resolveTtsAutoModeFromPrefs(prefs) {
  const auto = normalizeTtsAutoMode(prefs.tts?.auto);
  if (auto) {
    return auto;
  }
  if (typeof prefs.tts?.enabled === "boolean") {
    return prefs.tts.enabled ? "always" : "off";
  }
  return undefined;
}
export function resolveTtsAutoMode(params) {
  const sessionAuto = normalizeTtsAutoMode(params.sessionAuto);
  if (sessionAuto) {
    return sessionAuto;
  }
  const prefsAuto = resolveTtsAutoModeFromPrefs(readPrefs(params.prefsPath));
  if (prefsAuto) {
    return prefsAuto;
  }
  return params.config.auto;
}
// ---------------------------------------------------------------------------
// Prefs getters / setters
// ---------------------------------------------------------------------------
export function isTtsEnabled(config, prefsPath, sessionAuto) {
  return resolveTtsAutoMode({ config, prefsPath, sessionAuto }) !== "off";
}
export function setTtsAutoMode(prefsPath, mode) {
  updatePrefs(prefsPath, (prefs) => {
    const next = { ...prefs.tts };
    delete next.enabled;
    next.auto = mode;
    prefs.tts = next;
  });
}
export function setTtsEnabled(prefsPath, enabled) {
  setTtsAutoMode(prefsPath, enabled ? "always" : "off");
}
export function getTtsProvider(config, prefsPath) {
  const prefs = readPrefs(prefsPath);
  if (prefs.tts?.provider) {
    return prefs.tts.provider;
  }
  if (config.providerSource === "config") {
    return config.provider;
  }
  if (resolveTtsApiKey(config, "openai")) {
    return "openai";
  }
  if (resolveTtsApiKey(config, "elevenlabs")) {
    return "elevenlabs";
  }
  return "edge";
}
export function setTtsProvider(prefsPath, provider) {
  updatePrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, provider };
  });
}
export function getTtsMaxLength(prefsPath) {
  const prefs = readPrefs(prefsPath);
  return prefs.tts?.maxLength ?? DEFAULT_TTS_MAX_LENGTH;
}
export function setTtsMaxLength(prefsPath, maxLength) {
  updatePrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, maxLength };
  });
}
export function isSummarizationEnabled(prefsPath) {
  const prefs = readPrefs(prefsPath);
  return prefs.tts?.summarize ?? DEFAULT_TTS_SUMMARIZE;
}
export function setSummarizationEnabled(prefsPath, enabled) {
  updatePrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, summarize: enabled };
  });
}
// ---------------------------------------------------------------------------
// API key resolution (needed by getTtsProvider above)
// ---------------------------------------------------------------------------
export function resolveTtsApiKey(config, provider) {
  if (provider === "elevenlabs") {
    return config.elevenlabs.apiKey || process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY;
  }
  if (provider === "openai") {
    return config.openai.apiKey || process.env.OPENAI_API_KEY;
  }
  return undefined;
}
