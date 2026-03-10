import { type VersoConfig, loadConfig } from "../config/config.js";
import { resolveVersoAgentDir } from "./agent-paths.js";
import { ensureVersoModelsJson } from "./models-config.js";

export type ModelCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image" | "video">;
  api?: string;
};

type DiscoveredModel = {
  id: string;
  name?: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image" | "video">;
  api?: string;
};

type PiSdkModule = typeof import("./pi-model-discovery.js");

let modelCatalogPromise: Promise<ModelCatalogEntry[]> | null = null;
let hasLoggedModelCatalogError = false;
const defaultImportPiSdk = () => import("./pi-model-discovery.js");
let importPiSdk = defaultImportPiSdk;

export function resetModelCatalogCacheForTest() {
  modelCatalogPromise = null;
  hasLoggedModelCatalogError = false;
  importPiSdk = defaultImportPiSdk;
}

// Test-only escape hatch: allow mocking the dynamic import to simulate transient failures.
export function __setModelCatalogImportForTest(loader?: () => Promise<PiSdkModule>) {
  importPiSdk = loader ?? defaultImportPiSdk;
}

export async function loadModelCatalog(params?: {
  config?: VersoConfig;
  useCache?: boolean;
}): Promise<ModelCatalogEntry[]> {
  if (params?.useCache === false) {
    modelCatalogPromise = null;
  }
  if (modelCatalogPromise) {
    return modelCatalogPromise;
  }

  modelCatalogPromise = (async () => {
    const models: ModelCatalogEntry[] = [];
    const sortModels = (entries: ModelCatalogEntry[]) =>
      entries.sort((a, b) => {
        const p = a.provider.localeCompare(b.provider);
        if (p !== 0) {
          return p;
        }
        return a.name.localeCompare(b.name);
      });
    try {
      const cfg = params?.config ?? loadConfig();
      await ensureVersoModelsJson(cfg);
      // IMPORTANT: keep the dynamic import *inside* the try/catch.
      // If this fails once (e.g. during a pnpm install that temporarily swaps node_modules),
      // we must not poison the cache with a rejected promise (otherwise all channel handlers
      // will keep failing until restart).
      const piSdk = await importPiSdk();
      const agentDir = resolveVersoAgentDir();
      const authStorage = piSdk.discoverAuthStorage(agentDir);
      const registry = piSdk.discoverModels(authStorage, agentDir) as
        | {
            getAll: () => Array<DiscoveredModel>;
          }
        | Array<DiscoveredModel>;
      const entries = Array.isArray(registry) ? registry : registry.getAll();
      for (const entry of entries) {
        const id = String(entry?.id ?? "").trim();
        if (!id) {
          continue;
        }
        const provider = String(entry?.provider ?? "").trim();
        if (!provider) {
          continue;
        }
        const name = String(entry?.name ?? id).trim() || id;
        const contextWindow =
          typeof entry?.contextWindow === "number" && entry.contextWindow > 0
            ? entry.contextWindow
            : undefined;
        const reasoning = typeof entry?.reasoning === "boolean" ? entry.reasoning : undefined;
        const input = Array.isArray(entry?.input) ? entry.input : undefined;
        // Pass through the API type if discovered
        const api = entry?.api;
        models.push({ id, name, provider, contextWindow, reasoning, input, api });
      }

      // Inject models from Verso Config (custom providers)
      const providers = (cfg.models?.providers ?? {}) as Record<
        string,
        { models?: Array<{ id: string }>; api?: string }
      >;
      for (const [providerId, conf] of Object.entries(providers)) {
        if (!conf?.models || !Array.isArray(conf.models)) {
          continue;
        }
        const normalizedProvider = providerId.trim().toLowerCase();

        for (const modelConf of conf.models) {
          const id = String(modelConf.id ?? "").trim();
          if (!id) {
            continue;
          }

          // Avoid duplicates if SDK already found it
          const existing = models.find(
            (m) => m.provider === normalizedProvider && m.id.toLowerCase() === id.toLowerCase(),
          );

          if (!existing) {
            models.push({
              id,
              name: id, // Custom models usually don't have separate display names unless we add that field
              provider: normalizedProvider,
              // FIX: Must provide an API type, otherwise pi-ai crashes with "Unhandled API".
              // Use configured API or default to "openai-responses" (generic LLM).
              // Since we are forcing custom-openai, this is the correct default.
              // We cast as any because DiscoveredModel usually doesn't expose api in the public type,
              // but it passes through to Model<Api> in the runner.
              api: conf.api ?? "openai-responses",
              contextWindow: undefined, // Could assume default or unknown
              reasoning: undefined,
              input: undefined,
            });
          }
        }
      }

      if (models.length === 0) {
        // If we found nothing, don't cache this result so we can try again.
        modelCatalogPromise = null;
      }

      return sortModels(models);
    } catch (error) {
      if (!hasLoggedModelCatalogError) {
        hasLoggedModelCatalogError = true;
        console.warn(`[model-catalog] Failed to load model catalog: ${String(error)}`);
      }
      // Don't poison the cache on transient dependency/filesystem issues.
      modelCatalogPromise = null;
      if (models.length > 0) {
        return sortModels(models);
      }
      return [];
    }
  })();

  return modelCatalogPromise;
}

/**
 * Check if a model supports image input based on its catalog entry.
 */
export function modelSupportsVision(entry: ModelCatalogEntry | undefined): boolean {
  return entry?.input?.includes("image") ?? false;
}

/**
 * Find a model in the catalog by provider and model ID.
 */
export function findModelInCatalog(
  catalog: ModelCatalogEntry[],
  provider: string,
  modelId: string,
): ModelCatalogEntry | undefined {
  const normalizedProvider = provider.toLowerCase().trim();
  const normalizedModelId = modelId.toLowerCase().trim();
  return catalog.find(
    (entry) =>
      entry.provider.toLowerCase() === normalizedProvider &&
      entry.id.toLowerCase() === normalizedModelId,
  );
}
