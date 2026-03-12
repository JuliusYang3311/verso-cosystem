import { validateApiKeyInput } from "./auth-choice.api-key.js";
import { applyDefaultModelChoice } from "./auth-choice.default-model.js";
import { applyAuthProfileConfig } from "./onboard-auth.js";
function applyCustomProviderConfig(params) {
    const { config, providerId, baseUrl, apiKey, models } = params;
    const providers = { ...config.models?.providers };
    // Create or update the provider entry
    providers[providerId] = {
        ...providers[providerId],
        auth: "api-key",
        apiKey,
        baseUrl,
        ...(models && models.length > 0 ? { models } : {}),
    };
    return {
        ...config,
        models: {
            ...config.models,
            providers,
        },
    };
}
async function promptModelList(prompter) {
    const models = [];
    let addMore = true;
    // Initial prompt
    while (addMore) {
        const idInput = await prompter.text({
            message: "Chat Model Name/ID (Generative)",
            placeholder: "e.g. llama3, deepseek-coder",
            validate: (val) => (val.trim().length > 0 ? undefined : "Required"),
        });
        if (typeof idInput === "symbol") {
            break; // Cancelled
        }
        const id = idInput.trim();
        const contextWindowInput = await prompter.text({
            message: `Context Window for ${id}`,
            initialValue: "128000",
            validate: (val) => (!isNaN(Number(val)) ? undefined : "Must be a number"),
        });
        if (typeof contextWindowInput === "symbol") {
            break;
        }
        const contextWindow = Number(contextWindowInput);
        const maxTokensInput = await prompter.text({
            message: `Max Output Tokens for ${id}`,
            initialValue: "4096",
            validate: (val) => (!isNaN(Number(val)) ? undefined : "Must be a number"),
        });
        if (typeof maxTokensInput === "symbol") {
            break;
        }
        const maxTokens = Number(maxTokensInput);
        const reasoning = await prompter.confirm({
            message: `Does ${id} support reasoning/thinking?`,
            initialValue: false,
        });
        if (typeof reasoning === "symbol") {
            break;
        }
        const inputChoice = await prompter.multiselect({
            message: `Supported inputs for ${id}`,
            options: [
                { label: "Text", value: "text" },
                { label: "Image (Vision)", value: "image" },
                { label: "Video", value: "video" },
            ],
            initialValues: ["text"],
        });
        if (typeof inputChoice === "symbol") {
            break;
        }
        const input = inputChoice;
        models.push({
            id,
            name: id,
            reasoning: Boolean(reasoning),
            input: (input.length > 0 ? input : ["text"]),
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow,
            maxTokens,
        });
        const more = await prompter.confirm({
            message: "Add another model?",
            initialValue: false,
        });
        if (typeof more === "symbol") {
            break;
        }
        addMore = more;
    }
    return models;
}
export async function applyAuthChoiceCustom(params) {
    const { authChoice, prompter } = params;
    let nextConfig = params.config;
    let agentModelOverride;
    // Cast to string to avoid type errors until onboard-types.ts is updated
    const choice = authChoice;
    if (choice === "ollama") {
        const baseUrl = await prompter.text({
            message: "Ollama Base URL",
            initialValue: "http://127.0.0.1:11434/v1",
            placeholder: "http://127.0.0.1:11434/v1",
        });
        // Ollama typically doesn't enforce API key, but client libraries might require a non-empty string
        const apiKey = "ollama";
        // Prompt for models in a loop
        const models = await promptModelList(prompter);
        nextConfig = applyCustomProviderConfig({
            config: nextConfig,
            providerId: "ollama",
            baseUrl: String(baseUrl),
            apiKey,
            models,
        });
        // Register auth profile
        nextConfig = applyAuthProfileConfig(nextConfig, {
            profileId: "ollama:default",
            provider: "ollama",
            mode: "api_key",
        });
        // Default model handling
        let defaultModelId = "llama3";
        if (models.length > 0) {
            if (models.length === 1) {
                defaultModelId = models[0].id;
            }
            else {
                const selected = await prompter.select({
                    message: "Select Default Model",
                    options: models.map((m) => ({ label: m.id, value: m.id })),
                });
                defaultModelId = String(selected);
            }
        }
        else {
            // Fallback if no models added
            const fallback = await prompter.text({
                message: "Default Model Name",
                initialValue: "llama3",
            });
            defaultModelId = String(fallback);
        }
        const defaultModelRef = `ollama/${defaultModelId}`;
        const applied = await applyDefaultModelChoice({
            config: nextConfig,
            setDefaultModel: params.setDefaultModel,
            defaultModel: defaultModelRef,
            applyDefaultConfig: (cfg) => cfg,
            applyProviderConfig: (cfg) => cfg,
            noteDefault: defaultModelRef,
            noteAgentModel: async (model) => {
                if (!params.agentId) {
                    return;
                }
                await prompter.note(`Default model set to ${model}`, "Model configured");
            },
            prompter,
        });
        nextConfig = applied.config;
        agentModelOverride = applied.agentModelOverride;
        return { config: nextConfig, agentModelOverride };
    }
    if (choice === "custom-openai") {
        // ... (existing code: providerId, baseUrl, apiKey inputs) ...
        // Enforce "custom-openai" as the provider ID to ensure consistent behavior
        // and safe runtime prefix stripping.
        const providerId = "custom-openai";
        const baseUrl = await prompter.text({
            message: "Base URL (API Endpoint)",
            placeholder: "https://api.example.com/v1",
            validate: (val) => (val.trim().startsWith("http") ? undefined : "Must start with http/https"),
        });
        const apiKey = await prompter.text({
            message: "API Key",
            validate: validateApiKeyInput,
        });
        // Prompt for models in a loop
        const models = await promptModelList(prompter);
        nextConfig = applyCustomProviderConfig({
            config: nextConfig,
            providerId,
            baseUrl: String(baseUrl).trim(),
            apiKey: String(apiKey).trim(),
            models,
        });
        nextConfig = applyAuthProfileConfig(nextConfig, {
            profileId: `${providerId}:default`,
            provider: providerId,
            mode: "api_key",
        });
        // Prompt for default model
        let modelId = "";
        if (models.length > 0) {
            if (models.length === 1) {
                modelId = models[0].id;
            }
            else {
                const selected = await prompter.select({
                    message: "Select Default Model",
                    options: models.map((m) => ({ label: m.id, value: m.id })),
                });
                modelId = String(selected);
            }
        }
        else {
            const fallback = await prompter.text({
                message: "Default Model Name (e.g. deepseek-chat)",
                validate: (val) => (val.trim().length > 0 ? undefined : "Required"),
            });
            modelId = String(fallback);
        }
        const fullModelRef = `${providerId}/${modelId}`;
        const applied = await applyDefaultModelChoice({
            config: nextConfig,
            setDefaultModel: params.setDefaultModel,
            defaultModel: fullModelRef,
            applyDefaultConfig: (cfg) => cfg,
            applyProviderConfig: (cfg) => cfg,
            noteDefault: fullModelRef,
            noteAgentModel: async (model) => {
                if (!params.agentId) {
                    return;
                }
                await prompter.note(`Default model set to ${model}`, "Model configured");
            },
            prompter,
        });
        nextConfig = applied.config;
        agentModelOverride = applied.agentModelOverride;
        // --- Embeddings Configuration ---
        const useForEmbeddings = await prompter.confirm({
            message: "Use this provider for Memory Search embeddings?",
            initialValue: true,
        });
        if (useForEmbeddings) {
            const embeddingModel = await prompter.text({
                message: "Embedding Model ID",
                placeholder: "e.g. text-embedding-3-small",
                validate: (val) => (val.trim().length > 0 ? undefined : "Required"),
            });
            if (typeof embeddingModel !== "symbol") {
                nextConfig = {
                    ...nextConfig,
                    agents: {
                        ...nextConfig.agents,
                        defaults: {
                            ...nextConfig.agents?.defaults,
                            memorySearch: {
                                ...nextConfig.agents?.defaults?.memorySearch,
                                enabled: true,
                                provider: "openai", // Custom providers use OpenAI-compatible API
                                model: String(embeddingModel).trim(),
                                remote: {
                                    ...nextConfig.agents?.defaults?.memorySearch?.remote,
                                    baseUrl: String(baseUrl).trim(),
                                    apiKey: String(apiKey).trim(),
                                },
                            },
                        },
                    },
                };
                await prompter.note("Memory search configured to use custom provider.", "Embeddings");
            }
        }
        return { config: nextConfig, agentModelOverride };
    }
    return null;
}
