import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import path from "node:path";

export { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";

import type { Api, Model } from "@mariozechner/pi-ai";

export function discoverAuthStorage(agentDir: string): AuthStorage {
  return new AuthStorage(path.join(agentDir, "auth.json"));
}

export function discoverModels(authStorage: AuthStorage, agentDir: string): ModelRegistry {
  const registry = new ModelRegistry(authStorage, path.join(agentDir, "models.json"));
  const allModels = registry.getAll();
  const opus45Templates = allModels.filter(
    (m) => m.id === "claude-opus-4-5" || m.id === "claude-opus-4-5-thinking",
  );
  for (const template of opus45Templates) {
    const opus46Id = template.id.replace("claude-opus-4-5", "claude-opus-4-6");
    const alreadyExists = allModels.some(
      (m) => m.provider === template.provider && m.id === opus46Id,
    );
    if (!alreadyExists) {
      allModels.push({
        ...template,
        id: opus46Id,
        name: (template.name || template.id).replace(/4[.-]?5/g, "4.6"),
        contextWindow: 1048576,
        maxTokens: 128000,
      });
    }
  }
  // Sonnet 4.6: clone from Sonnet 4.5 templates (same pattern as Opus 4.6).
  const sonnet45Templates = allModels.filter(
    (m) => m.id === "claude-sonnet-4-5" || m.id === "claude-sonnet-4-5-thinking",
  );
  for (const template of sonnet45Templates) {
    const sonnet46Id = template.id.replace("claude-sonnet-4-5", "claude-sonnet-4-6");
    const alreadyExists = allModels.some(
      (m) => m.provider === template.provider && m.id === sonnet46Id,
    );
    if (!alreadyExists) {
      allModels.push({
        ...template,
        id: sonnet46Id,
        name: (template.name || template.id).replace(/4[.-]?5/g, "4.6"),
        contextWindow: 1048576,
        maxTokens: 64000,
      });
    }
  }
  const antigravityId = "google-antigravity";
  const requiredOpusModels = [
    { id: "claude-opus-4-6", name: "Claude 4.6 Opus", maxTokens: 128000 },
    {
      id: "claude-opus-4-6-thinking",
      name: "Claude 4.6 Opus (Thinking)",
      reasoning: true,
      maxTokens: 128000,
    },
    { id: "claude-sonnet-4-6", name: "Claude 4.6 Sonnet", maxTokens: 64000 },
    {
      id: "claude-sonnet-4-6-thinking",
      name: "Claude 4.6 Sonnet (Thinking)",
      reasoning: true,
      maxTokens: 64000,
    },
  ];
  for (const modelDef of requiredOpusModels) {
    const exists = allModels.some((m) => m.provider === antigravityId && m.id === modelDef.id);
    if (!exists) {
      allModels.push({
        id: modelDef.id,
        name: modelDef.name,
        provider: antigravityId,
        api: antigravityId as unknown as Api,
        baseUrl: "https://antigravity.google.com",
        reasoning: modelDef.reasoning ?? false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1048576,
        maxTokens: modelDef.maxTokens,
      } as Model<Api>);
    }
  }
  const originalFind = registry.find.bind(registry);
  registry.find = (provider: string, modelId: string): Model<Api> | undefined => {
    const original = originalFind(provider, modelId);
    if (original) {
      if (modelId === "gemini-3.1-flash-lite-preview") {
        return { ...original, contextWindow: 1048576 };
      }
      if (modelId === "gemini-3.1-pro-preview") {
        return { ...original, contextWindow: 1048576, reasoning: true };
      }
      if (modelId === "gpt-5.4") {
        return { ...original, contextWindow: 1_050_000, maxTokens: 128_000 };
      }
      if (modelId === "gpt-5.3" || modelId === "gpt-5.3-codex") {
        return { ...original, contextWindow: 1_048_576 };
      }
      if (modelId === "claude-opus-4-6" || modelId.startsWith("claude-opus-4-6-")) {
        return { ...original, contextWindow: 1048576, maxTokens: 128000 };
      }
      if (modelId === "claude-sonnet-4-6" || modelId.startsWith("claude-sonnet-4-6-")) {
        return { ...original, contextWindow: 1048576, maxTokens: 64000 };
      }
      return original;
    }
    if (modelId === "gemini-3.1-flash-lite-preview" || modelId === "gemini-3.1-pro-preview") {
      const isGoogle = provider === "google";
      return {
        id: modelId,
        name:
          modelId === "gemini-3.1-pro-preview"
            ? "Gemini 3 Pro (Preview)"
            : "Gemini 3 Flash (Preview)",
        provider: provider,
        api: isGoogle ? "google-generative-ai" : "google-gemini-cli",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        reasoning: modelId === "gemini-3.1-pro-preview",
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1048576,
        maxTokens: 65536,
      };
    }
    return undefined;
  };
  return registry;
}
