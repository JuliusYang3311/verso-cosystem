/**
 * Unified Session Factory — single entry point for ALL Verso session creation.
 *
 * Every session (main agent, orchestrator, worker, acceptance) passes through
 * this factory, which structurally registers the 3-layer context pipeline:
 *
 *   Layer 1: Dynamic Context   (context event — memory search + budget allocation)
 *   Layer 2: Compaction Safeguard (session_before_compact event)
 *   Layer 3: Context Pruning   (context event — cache-TTL soft/hard trims)
 *
 * Callers never interact with extension registration directly.
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import {
  type AgentSession,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { VersoConfig } from "../config/types.js";
import type { MemorySearchManager } from "../memory/types.js";
import { buildEmbeddedExtensionPaths } from "./pi-embedded-runner/extensions.js";
import {
  ensurePiCompactionReserveTokens,
  resolveCompactionReserveTokensFloor,
} from "./pi-settings.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CreateVersoSessionParams = {
  /** Working directory. */
  cwd: string;
  /** Agent configuration directory. */
  agentDir: string;

  // --- Auth & model (required for session creation) ---
  authStorage: CreateAgentSessionOptions["authStorage"];
  modelRegistry: CreateAgentSessionOptions["modelRegistry"];
  model: Model<Api>;

  // --- Optional overrides ---
  /** Custom tools to register alongside built-in coding tools. */
  customTools?: CreateAgentSessionOptions["customTools"];
  /** Built-in tool override (default: codingTools). */
  tools?: CreateAgentSessionOptions["tools"];
  /** Thinking level override. */
  thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];

  // --- Session storage ---
  /**
   * Pre-created SessionManager. When omitted, an in-memory session is created.
   * Pass `SessionManager.open(filePath)` for file-backed sessions (main agent).
   */
  sessionManager?: SessionManager;
  /** Pre-created SettingsManager. When omitted, one is created from cwd + agentDir. */
  settingsManager?: SettingsManager;

  // --- 3-Layer context pipeline inputs ---
  /** Verso configuration (drives compaction safeguard + context pruning settings). */
  config?: VersoConfig;
  /** Memory search manager for Layer 1 (Dynamic Context). null = skip memory search. */
  memoryManager?: MemorySearchManager | null;
  /** Context window override for dynamic context budget. */
  contextLimit?: number;

  /** Provider string (e.g. "anthropic") — needed for context pruning eligibility. */
  provider?: string;
  /** Model ID string (e.g. "claude-opus-4-5") — needed for context pruning eligibility. */
  modelId?: string;
};

export type CreateVersoSessionResult = {
  session: AgentSession;
  sessionManager: SessionManager;
  settingsManager: SettingsManager;
  /** Extension paths registered. Informational only. */
  extensionPaths: string[];
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Verso session with the 3-layer context pipeline structurally registered.
 *
 * This is the **only** function that should call `createAgentSession()` in the
 * Verso codebase. All session creation (main agent, orchestrator, workers,
 * acceptance) flows through here.
 */
export async function createVersoSession(
  params: CreateVersoSessionParams,
): Promise<CreateVersoSessionResult> {
  const sessionManager = params.sessionManager ?? SessionManager.create(params.cwd);
  const settingsManager =
    params.settingsManager ?? SettingsManager.create(params.cwd, params.agentDir);

  // Ensure compaction reserve tokens are configured.
  ensurePiCompactionReserveTokens({
    settingsManager,
    minReserveTokens: resolveCompactionReserveTokensFloor(params.config),
  });

  // Register all 3 extension layers (sets WeakMap runtimes + returns extension paths).
  const extensionPaths = buildEmbeddedExtensionPaths({
    cfg: params.config,
    sessionManager,
    provider: params.provider ?? params.model.provider ?? "",
    modelId: params.modelId ?? params.model.id ?? "",
    model: params.model,
    dynamicContext:
      params.memoryManager !== undefined
        ? {
            memoryManager: params.memoryManager ?? null,
            config: params.config,
            contextLimit: params.contextLimit,
            lastInjectedChunks: [],
          }
        : undefined,
  });

  // Build a resource loader that wires the extension paths into the SDK.
  // createAgentSession() only calls reload() on loaders it creates itself —
  // when we supply one, we must call reload() explicitly before passing it in.
  const resourceLoader = new DefaultResourceLoader({
    cwd: params.cwd,
    agentDir: params.agentDir,
    settingsManager,
    additionalExtensionPaths: extensionPaths,
  });
  await resourceLoader.reload();

  const { session }: CreateAgentSessionResult = await createAgentSession({
    cwd: params.cwd,
    agentDir: params.agentDir,
    authStorage: params.authStorage,
    modelRegistry: params.modelRegistry,
    model: params.model,
    thinkingLevel: params.thinkingLevel,
    tools: params.tools,
    customTools: params.customTools,
    sessionManager,
    settingsManager,
    resourceLoader,
  });

  return { session, sessionManager, settingsManager, extensionPaths };
}
