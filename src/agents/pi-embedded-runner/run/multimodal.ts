/**
 * Multimodal content routing strategy.
 *
 * Determines per-modality whether content should be:
 * - Injected natively into the LLM context (e.g., image content blocks)
 * - Processed through MediaUnderstanding (transcription/description → text)
 * - Skipped entirely (model doesn't support that modality)
 *
 * Model input types: "text" | "image" | "video"
 * - text: always present
 * - image: native injection via pi-ai SDK (all providers support image content blocks)
 * - video: MediaUnderstanding processes video → description text; audio → transcription text
 *
 * MediaUnderstanding capabilities: "image" | "audio" | "video"
 * - These are processing capabilities, independent of model input types.
 * - When model supports native image, MediaUnderstanding image description is skipped
 *   (the raw image goes directly to the LLM).
 * - Audio and video always go through MediaUnderstanding regardless of model capabilities.
 */

export type MediaModality = "image" | "video";

export type ModalityAction =
  /** Send as native content block to LLM (pi-ai SDK handles provider-specific conversion) */
  | "native"
  /** Process through MediaUnderstanding pipeline (transcription/description → text) */
  | "media-understanding"
  /** Model doesn't support this modality at all */
  | "skip";

export type MultimodalStrategy = Record<MediaModality, ModalityAction>;

/**
 * Resolves the multimodal content routing strategy based on model capabilities.
 *
 * Rules:
 * - image: "native" if model.input includes "image", otherwise "skip"
 *   (no fallback to MediaUnderstanding — if model can't see images, we don't describe them here;
 *    MediaUnderstanding runs separately in the auto-reply layer if configured)
 * - video: always "media-understanding" if model.input includes "video",
 *   otherwise "skip". Video (and audio) content always goes through
 *   MediaUnderstanding for transcription/description before reaching the agent.
 *
 * Note: Audio is not a model input type. Audio files are processed as part of
 * the MediaUnderstanding pipeline (same as video), producing transcription text.
 */
export function resolveMultimodalStrategy(model: { input?: string[] }): MultimodalStrategy {
  const inputSet = new Set(model.input ?? ["text"]);

  return {
    image: inputSet.has("image") ? "native" : "skip",
    video: inputSet.has("video") ? "media-understanding" : "skip",
  };
}

/**
 * Checks if a model supports native image input.
 * Convenience wrapper used by image detection/loading code.
 */
export function modelSupportsNativeImages(model: { input?: string[] }): boolean {
  return resolveMultimodalStrategy(model).image === "native";
}

/**
 * Checks if a model supports video content (via MediaUnderstanding).
 */
export function modelSupportsVideo(model: { input?: string[] }): boolean {
  return resolveMultimodalStrategy(model).video !== "skip";
}
