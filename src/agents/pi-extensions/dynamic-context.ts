/**
 * Dynamic Context SDK Extension (Layer 1).
 *
 * Automatically manages context window before each LLM call:
 * - Searches memory via injected MemorySearchManager
 * - Applies dynamic budget allocation (buildDynamicContext)
 * - Injects <memory-context> snippets from retrieval results
 *
 * This only affects the in-memory context for the current request; it does not rewrite session
 * history persisted on disk.
 */

export { default } from "./dynamic-context/extension.js";

export { setDynamicContextRuntime, getDynamicContextRuntime } from "./dynamic-context/runtime.js";
export type { DynamicContextRuntime } from "./dynamic-context/runtime.js";
