// src/app/settings/model-settings.tsx - Complete model configuration interface

import React, { useState, useEffect } from "react";

type Provider = {
  id: string;
  name: string;
  icon: string;
  requiresAuth: boolean;
  supportsCustomEndpoint: boolean;
  defaultBaseUrl?: string;
};

type ModelEntry = {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
  cost?: {
    input: number;
    output: number;
  };
};

type ProviderConfig = {
  id: string;
  apiKey?: string;
  baseUrl?: string;
  models?: string[];
};

type ModelConfig = {
  primary?: string;
  providers: ProviderConfig[];
  models?: Record<
    string,
    {
      id: string;
      name?: string;
      contextWindow?: number;
      maxTokens?: number;
    }
  >;
};

const PROVIDERS: Provider[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    icon: "🧠",
    requiresAuth: true,
    supportsCustomEndpoint: false,
  },
  {
    id: "openai",
    name: "OpenAI",
    icon: "⚡",
    requiresAuth: true,
    supportsCustomEndpoint: false,
  },
  {
    id: "google",
    name: "Google AI",
    icon: "🔍",
    requiresAuth: true,
    supportsCustomEndpoint: false,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    icon: "🌐",
    requiresAuth: true,
    supportsCustomEndpoint: false,
    defaultBaseUrl: "https://openrouter.ai/api/v1",
  },
  {
    id: "minimax",
    name: "MiniMax",
    icon: "🚀",
    requiresAuth: true,
    supportsCustomEndpoint: true,
    defaultBaseUrl: "https://api.minimax.io/v1",
  },
  {
    id: "moonshot",
    name: "Moonshot (Kimi)",
    icon: "🌙",
    requiresAuth: true,
    supportsCustomEndpoint: false,
    defaultBaseUrl: "https://api.moonshot.ai/v1",
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    icon: "🤖",
    requiresAuth: true,
    supportsCustomEndpoint: false,
    defaultBaseUrl: "https://api.x.ai/v1",
  },
  {
    id: "ollama",
    name: "Ollama",
    icon: "🦙",
    requiresAuth: false,
    supportsCustomEndpoint: true,
    defaultBaseUrl: "http://localhost:11434",
  },
  {
    id: "custom",
    name: "Custom Provider",
    icon: "🔧",
    requiresAuth: true,
    supportsCustomEndpoint: true,
  },
];

export const ModelSettings: React.FC = () => {
  const [config, setConfig] = useState<ModelConfig>({
    providers: [],
  });
  const [availableModels, setAvailableModels] = useState<ModelEntry[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [editingProvider, setEditingProvider] = useState<ProviderConfig | null>(null);
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [isLoadingModels, setIsLoadingModels] = useState(false);

  useEffect(() => {
    void loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      const rawConfig = await window.versoAPI.config.read();
      if (rawConfig && typeof rawConfig === "object") {
        const modelConfig: ModelConfig = {
          primary: rawConfig.agents?.defaults?.model?.primary || rawConfig.agents?.defaults?.model,
          providers: [],
          models: rawConfig.agents?.defaults?.models || {},
        };

        // Extract providers from config
        const providers = rawConfig.agents?.defaults?.providers || {};
        for (const [id, providerData] of Object.entries(providers)) {
          if (typeof providerData === "object" && providerData !== null) {
            modelConfig.providers.push({
              id,
              apiKey: providerData.apiKey,
              baseUrl: providerData.baseUrl,
              models: providerData.models,
            });
          }
        }

        setConfig(modelConfig);
      }
    } catch (error) {
      console.error("Failed to load config:", error);
    }
  };

  const loadAvailableModels = async () => {
    setIsLoadingModels(true);
    try {
      // Call gateway to get model catalog
      const response = await fetch("http://localhost:3000/api/models/catalog");
      if (response.ok) {
        const catalog = await response.json();
        setAvailableModels(catalog);
      }
    } catch (error) {
      console.error("Failed to load model catalog:", error);
    } finally {
      setIsLoadingModels(false);
    }
  };

  const handleAddProvider = (providerId: string) => {
    const provider = PROVIDERS.find((p) => p.id === providerId);
    if (!provider) return;

    setEditingProvider({
      id: providerId,
      apiKey: "",
      baseUrl: provider.defaultBaseUrl || "",
      models: [],
    });
    setShowAddProvider(false);
  };

  const handleSaveProvider = () => {
    if (!editingProvider) return;

    const existingIndex = config.providers.findIndex((p) => p.id === editingProvider.id);
    const newProviders = [...config.providers];

    if (existingIndex >= 0) {
      newProviders[existingIndex] = editingProvider;
    } else {
      newProviders.push(editingProvider);
    }

    setConfig({ ...config, providers: newProviders });
    setEditingProvider(null);
  };

  const handleRemoveProvider = (providerId: string) => {
    setConfig({
      ...config,
      providers: config.providers.filter((p) => p.id !== providerId),
    });
  };

  const handleSetPrimary = (modelRef: string) => {
    setConfig({ ...config, primary: modelRef });
  };

  const handleSaveConfig = async () => {
    setIsSaving(true);
    setSaveMessage("");

    try {
      const rawConfig = await window.versoAPI.config.read();
      const existingConfig = rawConfig && typeof rawConfig === "object" ? rawConfig : {};

      // Build providers object
      const providers: Record<string, any> = {};
      for (const provider of config.providers) {
        providers[provider.id] = {
          apiKey: provider.apiKey,
          ...(provider.baseUrl && { baseUrl: provider.baseUrl }),
          ...(provider.models && provider.models.length > 0 && { models: provider.models }),
        };
      }

      const updatedConfig = {
        ...existingConfig,
        agents: {
          ...existingConfig.agents,
          defaults: {
            ...existingConfig.agents?.defaults,
            model: config.primary
              ? { primary: config.primary }
              : existingConfig.agents?.defaults?.model,
            providers,
            models: config.models || {},
          },
        },
      };

      const result = await window.versoAPI.config.write(updatedConfig);

      if (result.success) {
        setSaveMessage("✓ Settings saved successfully");
        setTimeout(() => setSaveMessage(""), 3000);
      } else {
        setSaveMessage(`✗ Error: ${result.error || "Failed to save"}`);
      }
    } catch (error) {
      setSaveMessage(`✗ Error: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setIsSaving(false);
    }
  };

  const getProviderInfo = (providerId: string) => {
    return PROVIDERS.find((p) => p.id === providerId);
  };

  const formatModelRef = (provider: string, modelId: string) => {
    return `${provider}/${modelId}`;
  };

  const formatContextWindow = (tokens?: number) => {
    if (!tokens) return "";
    if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(0)}K`;
    return `${tokens}`;
  };

  return (
    <div className="model-settings">
      <div className="settings-header">
        <h2>Model Configuration</h2>
        <p className="section-description">
          Configure AI providers, models, and set your primary model
        </p>
      </div>

      {/* Primary Model Selection */}
      <div className="section">
        <h3>Primary Model</h3>
        <div className="primary-model-selector">
          {config.primary ? (
            <div className="current-primary">
              <span className="model-badge primary">{config.primary}</span>
              <button
                className="btn-link"
                onClick={() => {
                  void loadAvailableModels();
                  setSelectedProvider("select-primary");
                }}
              >
                Change
              </button>
            </div>
          ) : (
            <div className="no-primary">
              <p>No primary model set</p>
              <button
                className="btn-secondary"
                onClick={() => {
                  void loadAvailableModels();
                  setSelectedProvider("select-primary");
                }}
              >
                Select Primary Model
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Configured Providers */}
      <div className="section">
        <div className="section-header">
          <h3>Configured Providers</h3>
          <button className="btn-secondary" onClick={() => setShowAddProvider(true)}>
            + Add Provider
          </button>
        </div>

        {config.providers.length === 0 ? (
          <div className="empty-state">
            <p>No providers configured yet</p>
            <p className="help-text">Add a provider to start using AI models</p>
          </div>
        ) : (
          <div className="provider-list">
            {config.providers.map((provider) => {
              const info = getProviderInfo(provider.id);
              return (
                <div key={provider.id} className="provider-item">
                  <div className="provider-info">
                    <span className="provider-icon">{info?.icon || "🔧"}</span>
                    <div className="provider-details">
                      <h4>{info?.name || provider.id}</h4>
                      {provider.baseUrl && <span className="provider-url">{provider.baseUrl}</span>}
                      {provider.models && provider.models.length > 0 && (
                        <span className="provider-models">
                          {provider.models.length} model{provider.models.length !== 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="provider-actions">
                    <button className="btn-link" onClick={() => setEditingProvider(provider)}>
                      Edit
                    </button>
                    <button
                      className="btn-link danger"
                      onClick={() => handleRemoveProvider(provider.id)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Add Provider Modal */}
      {showAddProvider && (
        <div className="modal-overlay" onClick={() => setShowAddProvider(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Add Provider</h3>
              <button className="btn-close" onClick={() => setShowAddProvider(false)}>
                ×
              </button>
            </div>
            <div className="modal-body">
              <div className="provider-grid">
                {PROVIDERS.map((provider) => (
                  <div
                    key={provider.id}
                    className="provider-card"
                    onClick={() => handleAddProvider(provider.id)}
                  >
                    <div className="provider-icon">{provider.icon}</div>
                    <h4>{provider.name}</h4>
                    {provider.requiresAuth && <span className="badge">Requires API Key</span>}
                    {provider.supportsCustomEndpoint && (
                      <span className="badge">Custom Endpoint</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit Provider Modal */}
      {editingProvider && (
        <div className="modal-overlay" onClick={() => setEditingProvider(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>
                {config.providers.find((p) => p.id === editingProvider.id) ? "Edit" : "Add"}{" "}
                {getProviderInfo(editingProvider.id)?.name || editingProvider.id}
              </h3>
              <button className="btn-close" onClick={() => setEditingProvider(null)}>
                ×
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>API Key</label>
                <input
                  type="password"
                  value={editingProvider.apiKey || ""}
                  onChange={(e) =>
                    setEditingProvider({ ...editingProvider, apiKey: e.target.value })
                  }
                  placeholder="sk-..."
                  className="input-field"
                />
              </div>

              {getProviderInfo(editingProvider.id)?.supportsCustomEndpoint && (
                <div className="form-group">
                  <label>Base URL</label>
                  <input
                    type="url"
                    value={editingProvider.baseUrl || ""}
                    onChange={(e) =>
                      setEditingProvider({ ...editingProvider, baseUrl: e.target.value })
                    }
                    placeholder="https://api.example.com"
                    className="input-field"
                  />
                </div>
              )}

              <div className="form-group">
                <label>Custom Models (optional)</label>
                <input
                  type="text"
                  value={editingProvider.models?.join(", ") || ""}
                  onChange={(e) =>
                    setEditingProvider({
                      ...editingProvider,
                      models: e.target.value
                        .split(",")
                        .map((m) => m.trim())
                        .filter(Boolean),
                    })
                  }
                  placeholder="model-1, model-2"
                  className="input-field"
                />
                <span className="help-text">Comma-separated list of model IDs</span>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setEditingProvider(null)}>
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={handleSaveProvider}
                disabled={!editingProvider.apiKey?.trim()}
              >
                Save Provider
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Model Selection Modal */}
      {selectedProvider === "select-primary" && (
        <div className="modal-overlay" onClick={() => setSelectedProvider(null)}>
          <div className="modal large" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Select Primary Model</h3>
              <button className="btn-close" onClick={() => setSelectedProvider(null)}>
                ×
              </button>
            </div>
            <div className="modal-body">
              {isLoadingModels ? (
                <div className="loading">Loading models...</div>
              ) : availableModels.length === 0 ? (
                <div className="empty-state">
                  <p>No models available</p>
                  <p className="help-text">Configure providers first to see available models</p>
                </div>
              ) : (
                <div className="model-list">
                  {availableModels.map((model) => {
                    const modelRef = formatModelRef(model.provider, model.id);
                    const isPrimary = config.primary === modelRef;
                    return (
                      <div
                        key={modelRef}
                        className={`model-item ${isPrimary ? "primary" : ""}`}
                        onClick={() => {
                          handleSetPrimary(modelRef);
                          setSelectedProvider(null);
                        }}
                      >
                        <div className="model-info">
                          <h4>{model.name || model.id}</h4>
                          <span className="model-ref">{modelRef}</span>
                        </div>
                        <div className="model-meta">
                          {model.contextWindow && (
                            <span className="badge">
                              {formatContextWindow(model.contextWindow)} ctx
                            </span>
                          )}
                          {model.reasoning && <span className="badge">reasoning</span>}
                          {isPrimary && <span className="badge primary">PRIMARY</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Save Message */}
      {saveMessage && (
        <div className={`save-message ${saveMessage.startsWith("✗") ? "error" : "success"}`}>
          {saveMessage}
        </div>
      )}

      {/* Actions */}
      <div className="actions">
        <button className="btn-primary" onClick={handleSaveConfig} disabled={isSaving}>
          {isSaving ? "Saving..." : "Save Changes"}
        </button>
      </div>
    </div>
  );
};
