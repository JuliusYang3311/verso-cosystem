import {
  isValidVoiceId,
  isValidOpenAIVoice,
  isValidOpenAIModel,
  requireInRange,
  normalizeLanguageCode,
  normalizeApplyTextNormalization,
  normalizeSeed,
  parseBooleanValue,
  parseNumberValue,
} from "./tts-validators.js";
// ---------------------------------------------------------------------------
// Directive parser
// ---------------------------------------------------------------------------
export function parseTtsDirectives(text, policy) {
  if (!policy.enabled) {
    return { cleanedText: text, overrides: {}, warnings: [], hasDirective: false };
  }
  const overrides = {};
  const warnings = [];
  let cleanedText = text;
  let hasDirective = false;
  const blockRegex = /\[\[tts:text\]\]([\s\S]*?)\[\[\/tts:text\]\]/gi;
  cleanedText = cleanedText.replace(blockRegex, (_match, inner) => {
    hasDirective = true;
    if (policy.allowText && overrides.ttsText == null) {
      overrides.ttsText = inner.trim();
    }
    return "";
  });
  const directiveRegex = /\[\[tts:([^\]]+)\]\]/gi;
  cleanedText = cleanedText.replace(directiveRegex, (_match, body) => {
    hasDirective = true;
    const tokens = body.split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      const eqIndex = token.indexOf("=");
      if (eqIndex === -1) {
        continue;
      }
      const rawKey = token.slice(0, eqIndex).trim();
      const rawValue = token.slice(eqIndex + 1).trim();
      if (!rawKey || !rawValue) {
        continue;
      }
      const key = rawKey.toLowerCase();
      try {
        switch (key) {
          case "provider":
            if (!policy.allowProvider) {
              break;
            }
            if (rawValue === "openai" || rawValue === "elevenlabs" || rawValue === "edge") {
              overrides.provider = rawValue;
            } else {
              warnings.push(`unsupported provider "${rawValue}"`);
            }
            break;
          case "voice":
          case "openai_voice":
          case "openaivoice":
            if (!policy.allowVoice) {
              break;
            }
            if (isValidOpenAIVoice(rawValue)) {
              overrides.openai = { ...overrides.openai, voice: rawValue };
            } else {
              warnings.push(`invalid OpenAI voice "${rawValue}"`);
            }
            break;
          case "voiceid":
          case "voice_id":
          case "elevenlabs_voice":
          case "elevenlabsvoice":
            if (!policy.allowVoice) {
              break;
            }
            if (isValidVoiceId(rawValue)) {
              overrides.elevenlabs = { ...overrides.elevenlabs, voiceId: rawValue };
            } else {
              warnings.push(`invalid ElevenLabs voiceId "${rawValue}"`);
            }
            break;
          case "model":
          case "modelid":
          case "model_id":
          case "elevenlabs_model":
          case "elevenlabsmodel":
          case "openai_model":
          case "openaimodel":
            if (!policy.allowModelId) {
              break;
            }
            if (isValidOpenAIModel(rawValue)) {
              overrides.openai = { ...overrides.openai, model: rawValue };
            } else {
              overrides.elevenlabs = { ...overrides.elevenlabs, modelId: rawValue };
            }
            break;
          case "stability":
            if (!policy.allowVoiceSettings) {
              break;
            }
            {
              const value = parseNumberValue(rawValue);
              if (value == null) {
                warnings.push("invalid stability value");
                break;
              }
              requireInRange(value, 0, 1, "stability");
              overrides.elevenlabs = {
                ...overrides.elevenlabs,
                voiceSettings: { ...overrides.elevenlabs?.voiceSettings, stability: value },
              };
            }
            break;
          case "similarity":
          case "similarityboost":
          case "similarity_boost":
            if (!policy.allowVoiceSettings) {
              break;
            }
            {
              const value = parseNumberValue(rawValue);
              if (value == null) {
                warnings.push("invalid similarityBoost value");
                break;
              }
              requireInRange(value, 0, 1, "similarityBoost");
              overrides.elevenlabs = {
                ...overrides.elevenlabs,
                voiceSettings: { ...overrides.elevenlabs?.voiceSettings, similarityBoost: value },
              };
            }
            break;
          case "style":
            if (!policy.allowVoiceSettings) {
              break;
            }
            {
              const value = parseNumberValue(rawValue);
              if (value == null) {
                warnings.push("invalid style value");
                break;
              }
              requireInRange(value, 0, 1, "style");
              overrides.elevenlabs = {
                ...overrides.elevenlabs,
                voiceSettings: { ...overrides.elevenlabs?.voiceSettings, style: value },
              };
            }
            break;
          case "speed":
            if (!policy.allowVoiceSettings) {
              break;
            }
            {
              const value = parseNumberValue(rawValue);
              if (value == null) {
                warnings.push("invalid speed value");
                break;
              }
              requireInRange(value, 0.5, 2, "speed");
              overrides.elevenlabs = {
                ...overrides.elevenlabs,
                voiceSettings: { ...overrides.elevenlabs?.voiceSettings, speed: value },
              };
            }
            break;
          case "speakerboost":
          case "speaker_boost":
          case "usespeakerboost":
          case "use_speaker_boost":
            if (!policy.allowVoiceSettings) {
              break;
            }
            {
              const value = parseBooleanValue(rawValue);
              if (value == null) {
                warnings.push("invalid useSpeakerBoost value");
                break;
              }
              overrides.elevenlabs = {
                ...overrides.elevenlabs,
                voiceSettings: { ...overrides.elevenlabs?.voiceSettings, useSpeakerBoost: value },
              };
            }
            break;
          case "normalize":
          case "applytextnormalization":
          case "apply_text_normalization":
            if (!policy.allowNormalization) {
              break;
            }
            overrides.elevenlabs = {
              ...overrides.elevenlabs,
              applyTextNormalization: normalizeApplyTextNormalization(rawValue),
            };
            break;
          case "language":
          case "languagecode":
          case "language_code":
            if (!policy.allowNormalization) {
              break;
            }
            overrides.elevenlabs = {
              ...overrides.elevenlabs,
              languageCode: normalizeLanguageCode(rawValue),
            };
            break;
          case "seed":
            if (!policy.allowSeed) {
              break;
            }
            overrides.elevenlabs = {
              ...overrides.elevenlabs,
              seed: normalizeSeed(Number.parseInt(rawValue, 10)),
            };
            break;
          default:
            break;
        }
      } catch (err) {
        warnings.push(err.message);
      }
    }
    return "";
  });
  return {
    cleanedText,
    ttsText: overrides.ttsText,
    hasDirective,
    overrides,
    warnings,
  };
}
