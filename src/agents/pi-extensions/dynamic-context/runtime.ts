import type { VersoConfig } from "../../../config/types.js";
import type { MemorySearchManager } from "../../../memory/types.js";

export type DynamicContextRuntime = {
  memoryManager: MemorySearchManager | null;
  config?: VersoConfig;
  contextLimit?: number;
};

// Session-scoped runtime registry keyed by object identity.
// Same pattern as context-pruning/runtime.ts — relies on Pi passing
// the same SessionManager object instance into ExtensionContext.
const REGISTRY = new WeakMap<object, DynamicContextRuntime>();

export function setDynamicContextRuntime(
  sessionManager: unknown,
  value: DynamicContextRuntime | null,
): void {
  if (!sessionManager || typeof sessionManager !== "object") {
    return;
  }
  if (value === null) {
    REGISTRY.delete(sessionManager);
    return;
  }
  REGISTRY.set(sessionManager, value);
}

export function getDynamicContextRuntime(sessionManager: unknown): DynamicContextRuntime | null {
  if (!sessionManager || typeof sessionManager !== "object") {
    return null;
  }
  return REGISTRY.get(sessionManager) ?? null;
}
