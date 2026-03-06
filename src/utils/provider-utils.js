/**
 * Utility functions for provider-specific logic and capabilities.
 */
/**
 * Returns true if the provider requires reasoning to be wrapped in tags
 * (e.g. <think> and <final>) in the text stream, rather than using native
 * API fields for reasoning/thinking.
 */
export function isReasoningTagProvider(provider, model) {
  if (!provider) {
    return false;
  }
  const normalized = provider.trim().toLowerCase();
  // Handle google-antigravity and its model variations (e.g. google-antigravity/gemini-3)
  if (normalized.includes("google-antigravity")) {
    return true;
  }
  // Handle Minimax (M2.1 is chatty/reasoning-like)
  if (normalized.includes("minimax")) {
    return true;
  }
  // Check if the model name indicates a reasoning model
  if (model) {
    const normalizedModel = String(model).trim().toLowerCase();
    if (
      normalizedModel.includes("deepseek-r1") ||
      normalizedModel.includes("deepseek/deepseek-r1") ||
      /\bo1[-\s]/.test(normalizedModel) ||
      normalizedModel.startsWith("o1") ||
      normalizedModel.includes("thinker") ||
      normalizedModel.includes("thinking") ||
      normalizedModel.includes("reasoning") ||
      normalizedModel.includes("minimax")
    ) {
      return true;
    }
  }
  return false;
}
