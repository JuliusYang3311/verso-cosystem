import type { VersoConfig } from "../../../config/types.js";
import type { MemorySearchManager } from "../../../memory/types.js";

export type DynamicContextRuntime = {
  memoryManager: MemorySearchManager | null;
  config?: VersoConfig;
  contextLimit?: number;
};

// Session-scoped runtime stored directly on the sessionManager object via a
// well-known Symbol. Symbol.for() uses the global symbol registry, so the same
// key is resolved even across separate bundle instances (main chunk vs jiti-loaded
// extension file), which a module-local WeakMap cannot guarantee.
const RUNTIME_KEY = Symbol.for("verso.dynamicContextRuntime");

export function setDynamicContextRuntime(
  sessionManager: unknown,
  value: DynamicContextRuntime | null,
): void {
  if (!sessionManager || typeof sessionManager !== "object") {
    return;
  }
  if (value === null) {
    delete (sessionManager as Record<symbol, unknown>)[RUNTIME_KEY];
    return;
  }
  (sessionManager as Record<symbol, unknown>)[RUNTIME_KEY] = value;
}

export function getDynamicContextRuntime(sessionManager: unknown): DynamicContextRuntime | null {
  if (!sessionManager || typeof sessionManager !== "object") {
    return null;
  }
  return (
    ((sessionManager as Record<symbol, unknown>)[RUNTIME_KEY] as DynamicContextRuntime) ?? null
  );
}
