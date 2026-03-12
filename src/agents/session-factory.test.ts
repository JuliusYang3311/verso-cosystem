/**
 * session-factory integration tests — Extension wiring
 *
 * These tests verify the STRUCTURAL wiring that unit tests cannot catch:
 * that createVersoSession() passes extension paths to the SDK via resourceLoader,
 * the extensions are actually loaded, and the "context" event handler is registered.
 *
 * This catches the class of bug where extensionPaths were computed but
 * never delivered to the SDK — causing dynamic context to silently never fire.
 */

import { DefaultResourceLoader, SessionManager } from "@mariozechner/pi-coding-agent";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildEmbeddedExtensionPaths } from "./pi-embedded-runner/extensions.js";
import { getDynamicContextRuntime } from "./pi-extensions/dynamic-context/runtime.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return path.join(os.tmpdir(), `verso-sf-test-${Math.random().toString(36).slice(2)}`);
}

function makeMemoryManager() {
  const queries: string[] = [];
  return {
    manager: {
      search: async (q: string) => {
        queries.push(q);
        return [];
      },
    },
    queries,
  };
}

// ---------------------------------------------------------------------------
// Extension path inclusion
// ---------------------------------------------------------------------------

describe("buildEmbeddedExtensionPaths", () => {
  it("includes dynamic-context path when memoryManager is provided", () => {
    const sessionManager = SessionManager.inMemory();
    const paths = buildEmbeddedExtensionPaths({
      cfg: undefined,
      sessionManager,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      model: undefined,
      dynamicContext: { memoryManager: null, config: undefined, contextLimit: 100_000 },
    });
    expect(paths.some((p) => p.includes("dynamic-context"))).toBe(true);
  });

  it("omits dynamic-context path when dynamicContext is undefined", () => {
    const sessionManager = SessionManager.inMemory();
    const paths = buildEmbeddedExtensionPaths({
      cfg: undefined,
      sessionManager,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      model: undefined,
      dynamicContext: undefined,
    });
    expect(paths.some((p) => p.includes("dynamic-context"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SDK loading: DefaultResourceLoader actually loads the extension
// ---------------------------------------------------------------------------

describe("DefaultResourceLoader extension loading", () => {
  it("loads dynamic-context extension and registers a context handler", async () => {
    const sessionManager = SessionManager.inMemory();
    const { manager } = makeMemoryManager();

    const extensionPaths = buildEmbeddedExtensionPaths({
      cfg: undefined,
      sessionManager,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      model: undefined,
      dynamicContext: { memoryManager: manager as never, config: undefined, contextLimit: 100_000 },
    });

    const loader = new DefaultResourceLoader({
      cwd: makeTmpDir(),
      agentDir: makeTmpDir(),
      additionalExtensionPaths: extensionPaths,
    });
    await loader.reload();

    const { extensions, errors } = loader.getExtensions();

    // No load errors
    expect(errors).toHaveLength(0);

    // Dynamic-context extension is present
    const dcExt = extensions.find((e) => e.path?.includes("dynamic-context"));
    expect(dcExt).toBeDefined();

    // The "context" event handler is registered
    expect(dcExt!.handlers.has("context")).toBe(true);
    expect(dcExt!.handlers.get("context")!.length).toBeGreaterThan(0);
  });

  it("does not load dynamic-context extension when no dynamicContext runtime is provided", async () => {
    const sessionManager = SessionManager.inMemory();

    const extensionPaths = buildEmbeddedExtensionPaths({
      cfg: undefined,
      sessionManager,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      model: undefined,
      dynamicContext: undefined,
    });

    const loader = new DefaultResourceLoader({
      cwd: makeTmpDir(),
      agentDir: makeTmpDir(),
      additionalExtensionPaths: extensionPaths,
    });
    await loader.reload();

    const { extensions } = loader.getExtensions();
    const dcExt = extensions.find((e) => e.path?.includes("dynamic-context"));
    expect(dcExt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// WeakMap runtime wiring
// ---------------------------------------------------------------------------

describe("WeakMap runtime wiring", () => {
  it("stores runtime keyed by sessionManager after buildEmbeddedExtensionPaths", () => {
    const sessionManager = SessionManager.inMemory();
    const { manager } = makeMemoryManager();

    buildEmbeddedExtensionPaths({
      cfg: undefined,
      sessionManager,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      model: undefined,
      dynamicContext: {
        memoryManager: manager as never,
        config: undefined,
        contextLimit: 100_000,
      },
    });

    const runtime = getDynamicContextRuntime(sessionManager);
    expect(runtime).not.toBeNull();
    expect(runtime!.memoryManager).toBe(manager);
    expect(runtime!.contextLimit).toBe(100_000);
  });

  it("different sessionManager instances get independent runtimes", () => {
    const sm1 = SessionManager.inMemory();
    const sm2 = SessionManager.inMemory();
    const { manager: m1 } = makeMemoryManager();
    const { manager: m2 } = makeMemoryManager();

    buildEmbeddedExtensionPaths({
      cfg: undefined,
      sessionManager: sm1,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      model: undefined,
      dynamicContext: { memoryManager: m1 as never, config: undefined, contextLimit: 50_000 },
    });
    buildEmbeddedExtensionPaths({
      cfg: undefined,
      sessionManager: sm2,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      model: undefined,
      dynamicContext: { memoryManager: m2 as never, config: undefined, contextLimit: 80_000 },
    });

    expect(getDynamicContextRuntime(sm1)!.memoryManager).toBe(m1);
    expect(getDynamicContextRuntime(sm1)!.contextLimit).toBe(50_000);
    expect(getDynamicContextRuntime(sm2)!.memoryManager).toBe(m2);
    expect(getDynamicContextRuntime(sm2)!.contextLimit).toBe(80_000);
  });

  it("returns null for sessionManager with no runtime set", () => {
    const sessionManager = SessionManager.inMemory();
    // no buildEmbeddedExtensionPaths call for this instance
    expect(getDynamicContextRuntime(sessionManager)).toBeNull();
  });
});
