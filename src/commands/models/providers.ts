import { cancel, isCancel, confirm, text, select, multiselect } from "@clack/prompts";
import type {
  ModelApi,
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "../../config/types.models.js";
import type { RuntimeEnv } from "../../runtime.js";
import { loadConfig } from "../../config/config.js";
import { logConfigUpdated } from "../../config/logging.js";
import {
  stylePromptHint,
  stylePromptMessage,
  stylePromptTitle,
} from "../../terminal/prompt-style.js";
import { updateConfig } from "./shared.js";

const MODEL_API_OPTIONS: Array<{ label: string; value: ModelApi; hint: string }> = [
  { label: "OpenAI Completions", value: "openai-completions", hint: "Most compatible" },
  { label: "OpenAI Responses", value: "openai-responses", hint: "OpenAI Responses API" },
  { label: "Anthropic Messages", value: "anthropic-messages", hint: "Claude models" },
  { label: "Google Generative AI", value: "google-generative-ai", hint: "Gemini models" },
  { label: "Bedrock Converse", value: "bedrock-converse-stream", hint: "AWS Bedrock" },
  { label: "Ollama", value: "ollama", hint: "Local models" },
  { label: "GitHub Copilot", value: "github-copilot", hint: "Copilot API" },
];

async function promptModel(): Promise<ModelDefinitionConfig | null> {
  const idInput = await text({
    message: stylePromptMessage("Model ID"),
    placeholder: "e.g. llama3, deepseek-coder, gpt-4o",
    validate: (val: string | undefined) => (val?.trim()?.length ? undefined : "Required"),
  });
  if (isCancel(idInput)) {
    return null;
  }
  const id = String(idInput).trim();

  const contextWindowInput = await text({
    message: stylePromptMessage(`Context window for ${id}`),
    initialValue: "128000",
    validate: (val: string | undefined) =>
      !isNaN(Number(val)) && Number(val) > 0 ? undefined : "Must be a positive number",
  });
  if (isCancel(contextWindowInput)) {
    return null;
  }

  const maxTokensInput = await text({
    message: stylePromptMessage(`Max output tokens for ${id}`),
    initialValue: "8192",
    validate: (val: string | undefined) =>
      !isNaN(Number(val)) && Number(val) > 0 ? undefined : "Must be a positive number",
  });
  if (isCancel(maxTokensInput)) {
    return null;
  }

  const reasoning = await confirm({
    message: stylePromptMessage(`Does ${id} support reasoning/thinking?`),
    initialValue: false,
  });
  if (isCancel(reasoning)) {
    return null;
  }

  const inputChoice = await multiselect({
    message: stylePromptMessage(`Supported inputs for ${id}`),
    options: [
      { label: "Text", value: "text" },
      { label: "Image (Vision)", value: "image" },
      { label: "Video", value: "video" },
    ],
    initialValues: ["text"],
  });
  if (isCancel(inputChoice)) {
    return null;
  }

  return {
    id,
    name: id,
    reasoning: Boolean(reasoning),
    input: (inputChoice.length > 0 ? inputChoice : ["text"]) as ModelDefinitionConfig["input"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: Number(contextWindowInput),
    maxTokens: Number(maxTokensInput),
  };
}

export async function modelsProvidersListCommand(opts: { json?: boolean }, runtime: RuntimeEnv) {
  const cfg = loadConfig();
  const providers = cfg.models?.providers ?? {};
  const entries = Object.entries(providers);

  if (opts.json) {
    runtime.log(JSON.stringify(providers, null, 2));
    return;
  }

  if (entries.length === 0) {
    runtime.log("No custom providers configured.");
    runtime.log('Use "verso models providers add" to add a provider.');
    return;
  }

  for (const [id, provider] of entries) {
    const modelCount = provider.models?.length ?? 0;
    const api = provider.api ?? "openai-completions";
    runtime.log(`${id} (${api}, ${modelCount} model${modelCount !== 1 ? "s" : ""})`);
    runtime.log(`  Base URL: ${provider.baseUrl}`);
    if (provider.models && provider.models.length > 0) {
      for (const m of provider.models) {
        const caps = m.input?.join(", ") ?? "text";
        runtime.log(
          `  - ${m.id} (ctx: ${m.contextWindow}, max: ${m.maxTokens}, input: ${caps}${m.reasoning ? ", reasoning" : ""})`,
        );
      }
    }
  }
}

export async function modelsProvidersAddCommand(runtime: RuntimeEnv) {
  const providerIdInput = await text({
    message: stylePromptMessage("Provider ID"),
    placeholder: "e.g. my-openai, deepseek, together",
    validate: (val: string | undefined) => {
      const trimmed = (val ?? "").trim();
      if (trimmed.length === 0) {
        return "Required";
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
        return "Use letters, numbers, dashes, underscores only";
      }
      return undefined;
    },
  });
  if (isCancel(providerIdInput)) {
    cancel(stylePromptTitle("Cancelled.") ?? "Cancelled.");
    return;
  }
  const providerId = String(providerIdInput).trim();

  const baseUrlInput = await text({
    message: stylePromptMessage("Base URL (API endpoint)"),
    placeholder: "https://api.example.com/v1",
    validate: (val: string | undefined) =>
      (val ?? "").trim().startsWith("http") ? undefined : "Must start with http:// or https://",
  });
  if (isCancel(baseUrlInput)) {
    cancel(stylePromptTitle("Cancelled.") ?? "Cancelled.");
    return;
  }
  const baseUrl = String(baseUrlInput).trim();

  const apiChoice = await select({
    message: stylePromptMessage("API format"),
    options: MODEL_API_OPTIONS.map((opt) => ({
      label: opt.label,
      value: opt.value,
      hint: stylePromptHint(opt.hint),
    })),
  });
  if (isCancel(apiChoice)) {
    cancel(stylePromptTitle("Cancelled.") ?? "Cancelled.");
    return;
  }
  const api = apiChoice;

  const apiKeyInput = await text({
    message: stylePromptMessage("API key (or env var name)"),
    placeholder: "sk-... or MY_API_KEY",
  });
  if (isCancel(apiKeyInput)) {
    cancel(stylePromptTitle("Cancelled.") ?? "Cancelled.");
    return;
  }
  const apiKey = String(apiKeyInput).trim() || undefined;

  // Collect models
  const models: ModelDefinitionConfig[] = [];
  let addMore = true;
  while (addMore) {
    const model = await promptModel();
    if (!model) {
      break;
    }
    models.push(model);

    const more = await confirm({
      message: stylePromptMessage("Add another model?"),
      initialValue: false,
    });
    if (isCancel(more)) {
      break;
    }
    addMore = more;
  }

  const provider: ModelProviderConfig = {
    baseUrl,
    api,
    ...(apiKey ? { apiKey, auth: "api-key" as const } : {}),
    models,
  };

  await updateConfig((cfg) => ({
    ...cfg,
    models: {
      ...cfg.models,
      providers: {
        ...cfg.models?.providers,
        [providerId]: provider,
      },
    },
  }));

  logConfigUpdated(runtime);
  runtime.log(`Added provider "${providerId}" with ${models.length} model(s).`);
}

export async function modelsProvidersAddModelCommand(providerIdRaw: string, runtime: RuntimeEnv) {
  const providerId = providerIdRaw.trim();
  const cfg = loadConfig();
  const existing = cfg.models?.providers?.[providerId];
  if (!existing) {
    throw new Error(
      `Provider "${providerId}" not found. Use "verso models providers list" to see providers.`,
    );
  }

  const model = await promptModel();
  if (!model) {
    cancel(stylePromptTitle("Cancelled.") ?? "Cancelled.");
    return;
  }

  await updateConfig((cfg) => {
    const providers = { ...cfg.models?.providers };
    const provider = { ...providers[providerId] };
    const existingModels = [...(provider.models ?? [])];

    // Replace if same ID exists, otherwise append
    const idx = existingModels.findIndex((m) => m.id === model.id);
    if (idx >= 0) {
      existingModels[idx] = model;
    } else {
      existingModels.push(model);
    }
    provider.models = existingModels;
    providers[providerId] = provider;

    return {
      ...cfg,
      models: { ...cfg.models, providers },
    };
  });

  logConfigUpdated(runtime);
  runtime.log(`Added model "${model.id}" to provider "${providerId}".`);
}

export async function modelsProvidersRemoveCommand(providerIdRaw: string, runtime: RuntimeEnv) {
  const providerId = providerIdRaw.trim();
  const cfg = loadConfig();
  if (!cfg.models?.providers?.[providerId]) {
    throw new Error(`Provider "${providerId}" not found.`);
  }

  await updateConfig((cfg) => {
    const providers = { ...cfg.models?.providers };
    delete providers[providerId];
    return {
      ...cfg,
      models: { ...cfg.models, providers },
    };
  });

  logConfigUpdated(runtime);
  runtime.log(`Removed provider "${providerId}".`);
}

export async function modelsProvidersRemoveModelCommand(
  providerIdRaw: string,
  modelIdRaw: string,
  runtime: RuntimeEnv,
) {
  const providerId = providerIdRaw.trim();
  const modelId = modelIdRaw.trim();
  const cfg = loadConfig();
  const existing = cfg.models?.providers?.[providerId];
  if (!existing) {
    throw new Error(`Provider "${providerId}" not found.`);
  }

  await updateConfig((cfg) => {
    const providers = { ...cfg.models?.providers };
    const provider = { ...providers[providerId] };
    provider.models = (provider.models ?? []).filter((m) => m.id !== modelId);
    providers[providerId] = provider;
    return {
      ...cfg,
      models: { ...cfg.models, providers },
    };
  });

  logConfigUpdated(runtime);
  runtime.log(`Removed model "${modelId}" from provider "${providerId}".`);
}
