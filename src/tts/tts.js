import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeChannelId } from "../channels/plugins/index.js";
import { logVerbose } from "../globals.js";
import { isVoiceCompatibleAudio } from "../media/audio.js";
// ---------------------------------------------------------------------------
// Imports from extracted modules
// ---------------------------------------------------------------------------
import { parseTtsDirectives } from "./directive-parser.js";
import {
  normalizeTtsAutoMode,
  resolveModelOverridePolicy,
  resolveTtsConfig,
  resolveTtsPrefsPath,
  resolveTtsAutoMode,
  isTtsEnabled,
  setTtsAutoMode,
  setTtsEnabled,
  getTtsProvider,
  setTtsProvider,
  getTtsMaxLength,
  setTtsMaxLength,
  isSummarizationEnabled,
  setSummarizationEnabled,
  getLastTtsAttempt,
  setLastTtsAttempt,
  resolveTtsApiKey,
} from "./tts-config.js";
import { DEFAULT_EDGE_OUTPUT_FORMAT } from "./tts-config.js";
import { summarizeText } from "./tts-preprocessor.js";
import {
  TTS_PROVIDERS,
  resolveOutputFormat,
  resolveEdgeOutputFormat,
  resolveTtsProviderOrder,
  isTtsProviderConfigured,
  elevenLabsTTS,
  openaiTTS,
  edgeTTS,
  inferEdgeExtension,
  scheduleCleanup,
  TELEPHONY_OUTPUT,
} from "./tts-providers.js";
import {
  OPENAI_TTS_MODELS,
  OPENAI_TTS_VOICES,
  isValidOpenAIModel,
  isValidOpenAIVoice,
  isValidVoiceId,
} from "./tts-validators.js";
export {
  normalizeTtsAutoMode,
  resolveModelOverridePolicy,
  resolveTtsConfig,
  resolveTtsPrefsPath,
  resolveTtsAutoMode,
  isTtsEnabled,
  setTtsAutoMode,
  setTtsEnabled,
  getTtsProvider,
  setTtsProvider,
  getTtsMaxLength,
  setTtsMaxLength,
  isSummarizationEnabled,
  setSummarizationEnabled,
  getLastTtsAttempt,
  setLastTtsAttempt,
  resolveTtsApiKey,
  TTS_PROVIDERS,
  resolveOutputFormat,
  resolveEdgeOutputFormat,
  resolveTtsProviderOrder,
  isTtsProviderConfigured,
  OPENAI_TTS_MODELS,
  OPENAI_TTS_VOICES,
  isValidOpenAIModel,
  isValidOpenAIVoice,
  parseTtsDirectives,
  summarizeText,
};
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function resolveChannelId(channel) {
  return channel ? normalizeChannelId(channel) : null;
}
// ---------------------------------------------------------------------------
// System prompt hint
// ---------------------------------------------------------------------------
export function buildTtsSystemPromptHint(cfg) {
  const config = resolveTtsConfig(cfg);
  const prefsPath = resolveTtsPrefsPath(config);
  const autoMode = resolveTtsAutoMode({ config, prefsPath });
  if (autoMode === "off") {
    return undefined;
  }
  const maxLength = getTtsMaxLength(prefsPath);
  const summarize = isSummarizationEnabled(prefsPath) ? "on" : "off";
  const autoHint =
    autoMode === "inbound"
      ? "Only use TTS when the user's last message includes audio/voice."
      : autoMode === "tagged"
        ? "Only use TTS when you include [[tts]] or [[tts:text]] tags."
        : undefined;
  return [
    "Voice (TTS) is enabled.",
    autoHint,
    `Keep spoken text \u2264${maxLength} chars to avoid auto-summary (summary ${summarize}).`,
    "Use [[tts:...]] and optional [[tts:text]]...[[/tts:text]] to control voice/expressiveness.",
  ]
    .filter(Boolean)
    .join("\n");
}
// ---------------------------------------------------------------------------
// textToSpeech -- main synthesis orchestrator
// ---------------------------------------------------------------------------
export async function textToSpeech(params) {
  const config = resolveTtsConfig(params.cfg);
  const prefsPath = params.prefsPath ?? resolveTtsPrefsPath(config);
  const channelId = resolveChannelId(params.channel);
  const output = resolveOutputFormat(channelId);
  if (params.text.length > config.maxTextLength) {
    return {
      success: false,
      error: `Text too long (${params.text.length} chars, max ${config.maxTextLength})`,
    };
  }
  const userProvider = getTtsProvider(config, prefsPath);
  const overrideProvider = params.overrides?.provider;
  const provider = overrideProvider ?? userProvider;
  const providers = resolveTtsProviderOrder(provider);
  let lastError;
  for (const currentProvider of providers) {
    const providerStart = Date.now();
    try {
      if (currentProvider === "edge") {
        if (!config.edge.enabled) {
          lastError = "edge: disabled";
          continue;
        }
        const tempDir = mkdtempSync(path.join(tmpdir(), "tts-"));
        let edgeOutputFormat = resolveEdgeOutputFormat(config);
        const fallbackEdgeOutputFormat =
          edgeOutputFormat !== DEFAULT_EDGE_OUTPUT_FORMAT ? DEFAULT_EDGE_OUTPUT_FORMAT : undefined;
        const attemptEdgeTts = async (outputFormat) => {
          const extension = inferEdgeExtension(outputFormat);
          const audioPath = path.join(tempDir, `voice-${Date.now()}${extension}`);
          await edgeTTS({
            text: params.text,
            outputPath: audioPath,
            config: {
              ...config.edge,
              outputFormat,
            },
            timeoutMs: config.timeoutMs,
          });
          return { audioPath, outputFormat };
        };
        let edgeResult;
        try {
          edgeResult = await attemptEdgeTts(edgeOutputFormat);
        } catch (err) {
          if (fallbackEdgeOutputFormat && fallbackEdgeOutputFormat !== edgeOutputFormat) {
            logVerbose(
              `TTS: Edge output ${edgeOutputFormat} failed; retrying with ${fallbackEdgeOutputFormat}.`,
            );
            edgeOutputFormat = fallbackEdgeOutputFormat;
            try {
              edgeResult = await attemptEdgeTts(edgeOutputFormat);
            } catch (fallbackErr) {
              try {
                rmSync(tempDir, { recursive: true, force: true });
              } catch {
                // ignore cleanup errors
              }
              throw fallbackErr;
            }
          } else {
            try {
              rmSync(tempDir, { recursive: true, force: true });
            } catch {
              // ignore cleanup errors
            }
            throw err;
          }
        }
        scheduleCleanup(tempDir);
        const voiceCompatible = isVoiceCompatibleAudio({ fileName: edgeResult.audioPath });
        return {
          success: true,
          audioPath: edgeResult.audioPath,
          latencyMs: Date.now() - providerStart,
          provider: currentProvider,
          outputFormat: edgeResult.outputFormat,
          voiceCompatible,
        };
      }
      const apiKey = resolveTtsApiKey(config, currentProvider);
      if (!apiKey) {
        lastError = `No API key for ${currentProvider}`;
        continue;
      }
      let audioBuffer;
      if (currentProvider === "elevenlabs") {
        const voiceIdOverride = params.overrides?.elevenlabs?.voiceId;
        const modelIdOverride = params.overrides?.elevenlabs?.modelId;
        const voiceSettings = {
          ...config.elevenlabs.voiceSettings,
          ...params.overrides?.elevenlabs?.voiceSettings,
        };
        const seedOverride = params.overrides?.elevenlabs?.seed;
        const normalizationOverride = params.overrides?.elevenlabs?.applyTextNormalization;
        const languageOverride = params.overrides?.elevenlabs?.languageCode;
        audioBuffer = await elevenLabsTTS({
          text: params.text,
          apiKey,
          baseUrl: config.elevenlabs.baseUrl,
          voiceId: voiceIdOverride ?? config.elevenlabs.voiceId,
          modelId: modelIdOverride ?? config.elevenlabs.modelId,
          outputFormat: output.elevenlabs,
          seed: seedOverride ?? config.elevenlabs.seed,
          applyTextNormalization: normalizationOverride ?? config.elevenlabs.applyTextNormalization,
          languageCode: languageOverride ?? config.elevenlabs.languageCode,
          voiceSettings,
          timeoutMs: config.timeoutMs,
        });
      } else {
        const openaiModelOverride = params.overrides?.openai?.model;
        const openaiVoiceOverride = params.overrides?.openai?.voice;
        audioBuffer = await openaiTTS({
          text: params.text,
          apiKey,
          model: openaiModelOverride ?? config.openai.model,
          voice: openaiVoiceOverride ?? config.openai.voice,
          responseFormat: output.openai,
          timeoutMs: config.timeoutMs,
        });
      }
      const latencyMs = Date.now() - providerStart;
      const tempDir = mkdtempSync(path.join(tmpdir(), "tts-"));
      const audioPath = path.join(tempDir, `voice-${Date.now()}${output.extension}`);
      writeFileSync(audioPath, audioBuffer);
      scheduleCleanup(tempDir);
      return {
        success: true,
        audioPath,
        latencyMs,
        provider: currentProvider,
        outputFormat: currentProvider === "openai" ? output.openai : output.elevenlabs,
        voiceCompatible: output.voiceCompatible,
      };
    } catch (err) {
      const error = err;
      if (error.name === "AbortError") {
        lastError = `${currentProvider}: request timed out`;
      } else {
        lastError = `${currentProvider}: ${error.message}`;
      }
    }
  }
  return {
    success: false,
    error: `TTS conversion failed: ${lastError || "no providers available"}`,
  };
}
// ---------------------------------------------------------------------------
// textToSpeechTelephony -- PCM output for phone calls
// ---------------------------------------------------------------------------
export async function textToSpeechTelephony(params) {
  const config = resolveTtsConfig(params.cfg);
  const prefsPath = params.prefsPath ?? resolveTtsPrefsPath(config);
  if (params.text.length > config.maxTextLength) {
    return {
      success: false,
      error: `Text too long (${params.text.length} chars, max ${config.maxTextLength})`,
    };
  }
  const userProvider = getTtsProvider(config, prefsPath);
  const providers = resolveTtsProviderOrder(userProvider);
  let lastError;
  for (const currentProvider of providers) {
    const providerStart = Date.now();
    try {
      if (currentProvider === "edge") {
        lastError = "edge: unsupported for telephony";
        continue;
      }
      const apiKey = resolveTtsApiKey(config, currentProvider);
      if (!apiKey) {
        lastError = `No API key for ${currentProvider}`;
        continue;
      }
      if (currentProvider === "elevenlabs") {
        const output = TELEPHONY_OUTPUT.elevenlabs;
        const audioBuffer = await elevenLabsTTS({
          text: params.text,
          apiKey,
          baseUrl: config.elevenlabs.baseUrl,
          voiceId: config.elevenlabs.voiceId,
          modelId: config.elevenlabs.modelId,
          outputFormat: output.format,
          seed: config.elevenlabs.seed,
          applyTextNormalization: config.elevenlabs.applyTextNormalization,
          languageCode: config.elevenlabs.languageCode,
          voiceSettings: config.elevenlabs.voiceSettings,
          timeoutMs: config.timeoutMs,
        });
        return {
          success: true,
          audioBuffer,
          latencyMs: Date.now() - providerStart,
          provider: currentProvider,
          outputFormat: output.format,
          sampleRate: output.sampleRate,
        };
      }
      const output = TELEPHONY_OUTPUT.openai;
      const audioBuffer = await openaiTTS({
        text: params.text,
        apiKey,
        model: config.openai.model,
        voice: config.openai.voice,
        responseFormat: output.format,
        timeoutMs: config.timeoutMs,
      });
      return {
        success: true,
        audioBuffer,
        latencyMs: Date.now() - providerStart,
        provider: currentProvider,
        outputFormat: output.format,
        sampleRate: output.sampleRate,
      };
    } catch (err) {
      const error = err;
      if (error.name === "AbortError") {
        lastError = `${currentProvider}: request timed out`;
      } else {
        lastError = `${currentProvider}: ${error.message}`;
      }
    }
  }
  return {
    success: false,
    error: `TTS conversion failed: ${lastError || "no providers available"}`,
  };
}
// ---------------------------------------------------------------------------
// maybeApplyTtsToPayload -- auto-TTS pipeline
// ---------------------------------------------------------------------------
export async function maybeApplyTtsToPayload(params) {
  const config = resolveTtsConfig(params.cfg);
  const prefsPath = resolveTtsPrefsPath(config);
  const autoMode = resolveTtsAutoMode({
    config,
    prefsPath,
    sessionAuto: params.ttsAuto,
  });
  if (autoMode === "off") {
    return params.payload;
  }
  const text = params.payload.text ?? "";
  const directives = parseTtsDirectives(text, config.modelOverrides);
  if (directives.warnings.length > 0) {
    logVerbose(`TTS: ignored directive overrides (${directives.warnings.join("; ")})`);
  }
  const cleanedText = directives.cleanedText;
  const trimmedCleaned = cleanedText.trim();
  const visibleText = trimmedCleaned.length > 0 ? trimmedCleaned : "";
  const ttsText = directives.ttsText?.trim() || visibleText;
  const nextPayload =
    visibleText === text.trim()
      ? params.payload
      : {
          ...params.payload,
          text: visibleText.length > 0 ? visibleText : undefined,
        };
  if (autoMode === "tagged" && !directives.hasDirective) {
    return nextPayload;
  }
  if (autoMode === "inbound" && params.inboundAudio !== true) {
    return nextPayload;
  }
  const mode = config.mode ?? "final";
  if (mode === "final" && params.kind && params.kind !== "final") {
    return nextPayload;
  }
  if (!ttsText.trim()) {
    return nextPayload;
  }
  if (params.payload.mediaUrl || (params.payload.mediaUrls?.length ?? 0) > 0) {
    return nextPayload;
  }
  if (text.includes("MEDIA:")) {
    return nextPayload;
  }
  if (ttsText.trim().length < 10) {
    return nextPayload;
  }
  const maxLength = getTtsMaxLength(prefsPath);
  let textForAudio = ttsText.trim();
  let wasSummarized = false;
  if (textForAudio.length > maxLength) {
    if (!isSummarizationEnabled(prefsPath)) {
      // Truncate text when summarization is disabled
      logVerbose(
        `TTS: truncating long text (${textForAudio.length} > ${maxLength}), summarization disabled.`,
      );
      textForAudio = `${textForAudio.slice(0, maxLength - 3)}...`;
    } else {
      // Summarize text when enabled
      try {
        const summary = await summarizeText({
          text: textForAudio,
          targetLength: maxLength,
          cfg: params.cfg,
          config,
          timeoutMs: config.timeoutMs,
        });
        textForAudio = summary.summary;
        wasSummarized = true;
        if (textForAudio.length > config.maxTextLength) {
          logVerbose(
            `TTS: summary exceeded hard limit (${textForAudio.length} > ${config.maxTextLength}); truncating.`,
          );
          textForAudio = `${textForAudio.slice(0, config.maxTextLength - 3)}...`;
        }
      } catch (err) {
        const error = err;
        logVerbose(`TTS: summarization failed, truncating instead: ${error.message}`);
        textForAudio = `${textForAudio.slice(0, maxLength - 3)}...`;
      }
    }
  }
  const ttsStart = Date.now();
  const result = await textToSpeech({
    text: textForAudio,
    cfg: params.cfg,
    prefsPath,
    channel: params.channel,
    overrides: directives.overrides,
  });
  if (result.success && result.audioPath) {
    setLastTtsAttempt({
      timestamp: Date.now(),
      success: true,
      textLength: text.length,
      summarized: wasSummarized,
      provider: result.provider,
      latencyMs: result.latencyMs,
    });
    const channelId = resolveChannelId(params.channel);
    const shouldVoice = channelId === "telegram" && result.voiceCompatible === true;
    const finalPayload = {
      ...nextPayload,
      mediaUrl: result.audioPath,
      audioAsVoice: shouldVoice || params.payload.audioAsVoice,
    };
    return finalPayload;
  }
  setLastTtsAttempt({
    timestamp: Date.now(),
    success: false,
    textLength: text.length,
    summarized: wasSummarized,
    error: result.error,
  });
  const latency = Date.now() - ttsStart;
  logVerbose(`TTS: conversion failed after ${latency}ms (${result.error ?? "unknown"}).`);
  return nextPayload;
}
// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------
export const _test = {
  isValidVoiceId,
  isValidOpenAIVoice,
  isValidOpenAIModel,
  OPENAI_TTS_MODELS,
  OPENAI_TTS_VOICES,
  parseTtsDirectives,
  resolveModelOverridePolicy,
  summarizeText,
  resolveOutputFormat,
  resolveEdgeOutputFormat,
};
