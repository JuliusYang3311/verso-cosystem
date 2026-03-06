import { EdgeTTS } from "node-edge-tts";
import { rmSync } from "node:fs";
import { resolveTtsApiKey } from "./tts-config.js";
import {
  isValidVoiceId,
  assertElevenLabsVoiceSettings,
  normalizeElevenLabsBaseUrl,
  normalizeLanguageCode,
  normalizeApplyTextNormalization,
  normalizeSeed,
  isValidOpenAIModel,
  isValidOpenAIVoice,
  getOpenAITtsBaseUrl,
} from "./tts-validators.js";
export { resolveTtsApiKey } from "./tts-config.js";
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const TEMP_FILE_CLEANUP_DELAY_MS = 5 * 60 * 1000; // 5 minutes
export const TELEGRAM_OUTPUT = {
  openai: "opus",
  // ElevenLabs output formats use codec_sample_rate_bitrate naming.
  // Opus @ 48kHz/64kbps is a good voice-note tradeoff for Telegram.
  elevenlabs: "opus_48000_64",
  extension: ".opus",
  voiceCompatible: true,
};
export const DEFAULT_OUTPUT = {
  openai: "mp3",
  elevenlabs: "mp3_44100_128",
  extension: ".mp3",
  voiceCompatible: false,
};
export const TELEPHONY_OUTPUT = {
  openai: { format: "pcm", sampleRate: 24000 },
  elevenlabs: { format: "pcm_22050", sampleRate: 22050 },
};
export const TTS_PROVIDERS = ["openai", "elevenlabs", "edge"];
export const DEFAULT_EDGE_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
// ---------------------------------------------------------------------------
// Output format resolution
// ---------------------------------------------------------------------------
export function resolveOutputFormat(channelId) {
  if (channelId === "telegram") {
    return TELEGRAM_OUTPUT;
  }
  return DEFAULT_OUTPUT;
}
export function resolveEdgeOutputFormat(config) {
  return config.edge.outputFormat;
}
// ---------------------------------------------------------------------------
// Provider order & availability
// ---------------------------------------------------------------------------
export function resolveTtsProviderOrder(primary) {
  return [primary, ...TTS_PROVIDERS.filter((provider) => provider !== primary)];
}
export function isTtsProviderConfigured(config, provider) {
  if (provider === "edge") {
    return config.edge.enabled;
  }
  return Boolean(resolveTtsApiKey(config, provider));
}
// ---------------------------------------------------------------------------
// Temp file helpers
// ---------------------------------------------------------------------------
export function scheduleCleanup(tempDir, delayMs = TEMP_FILE_CLEANUP_DELAY_MS) {
  const timer = setTimeout(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }, delayMs);
  timer.unref();
}
export function inferEdgeExtension(outputFormat) {
  const normalized = outputFormat.toLowerCase();
  if (normalized.includes("webm")) {
    return ".webm";
  }
  if (normalized.includes("ogg")) {
    return ".ogg";
  }
  if (normalized.includes("opus")) {
    return ".opus";
  }
  if (normalized.includes("wav") || normalized.includes("riff") || normalized.includes("pcm")) {
    return ".wav";
  }
  return ".mp3";
}
// ---------------------------------------------------------------------------
// ElevenLabs TTS
// ---------------------------------------------------------------------------
export async function elevenLabsTTS(params) {
  const {
    text,
    apiKey,
    baseUrl,
    voiceId,
    modelId,
    outputFormat,
    seed,
    applyTextNormalization,
    languageCode,
    voiceSettings,
    timeoutMs,
  } = params;
  if (!isValidVoiceId(voiceId)) {
    throw new Error("Invalid voiceId format");
  }
  assertElevenLabsVoiceSettings(voiceSettings);
  const normalizedLanguage = normalizeLanguageCode(languageCode);
  const normalizedNormalization = normalizeApplyTextNormalization(applyTextNormalization);
  const normalizedSeed = normalizeSeed(seed);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(`${normalizeElevenLabsBaseUrl(baseUrl)}/v1/text-to-speech/${voiceId}`);
    if (outputFormat) {
      url.searchParams.set("output_format", outputFormat);
    }
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        seed: normalizedSeed,
        apply_text_normalization: normalizedNormalization,
        language_code: normalizedLanguage,
        voice_settings: {
          stability: voiceSettings.stability,
          similarity_boost: voiceSettings.similarityBoost,
          style: voiceSettings.style,
          use_speaker_boost: voiceSettings.useSpeakerBoost,
          speed: voiceSettings.speed,
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`ElevenLabs API error (${response.status})`);
    }
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}
// ---------------------------------------------------------------------------
// OpenAI TTS
// ---------------------------------------------------------------------------
export async function openaiTTS(params) {
  const { text, apiKey, model, voice, responseFormat, timeoutMs } = params;
  if (!isValidOpenAIModel(model)) {
    throw new Error(`Invalid model: ${model}`);
  }
  if (!isValidOpenAIVoice(voice)) {
    throw new Error(`Invalid voice: ${voice}`);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${getOpenAITtsBaseUrl()}/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: text,
        voice,
        response_format: responseFormat,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`OpenAI TTS API error (${response.status})`);
    }
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}
// ---------------------------------------------------------------------------
// Edge TTS
// ---------------------------------------------------------------------------
export async function edgeTTS(params) {
  const { text, outputPath, config, timeoutMs } = params;
  const tts = new EdgeTTS({
    voice: config.voice,
    lang: config.lang,
    outputFormat: config.outputFormat,
    saveSubtitles: config.saveSubtitles,
    proxy: config.proxy,
    rate: config.rate,
    pitch: config.pitch,
    volume: config.volume,
    timeout: config.timeoutMs ?? timeoutMs,
  });
  await tts.ttsPromise(text, outputPath);
}
