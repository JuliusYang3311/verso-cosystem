// src/app/settings/provider-settings-enhanced.tsx - Multi-provider configuration with primary model

import React, { useState, useEffect } from "react";

export type ProviderType =
  | "anthropic"
  | "openai"
  | "google"
  | "openrouter"
  | "minimax"
  | "moonshot"
  | "xai"
  | "ollama"
  | "custom-anthropic"
  | "custom-openai";

type ProviderInfo = {
  id: ProviderType;
  name: string;
  icon: string;
  requiresAuth: boolean;
  supportsCustomEndpoint: boolean;
  defaultBaseUrl?: string;
  description: string;
};

type ConfiguredProvider = {
  id: string;
  type: ProviderType;
  apiKey?: string;
  baseUrl?: string;
  models?: string[];
};

const PROVIDERS: ProviderInfo[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    icon: "🧠",
    requiresAuth: true,
    supportsCustomEndpoint: false,
    description: "Claude models (Opus, Sonnet, Haiku)",
  },
  {
    id: "openai",
    name: "OpenAI",
    icon: "⚡",
    requiresAuth: true,
    supportsCustomEndpoint: false,
    description: "GPT-4, GPT-5, and more",
  },
  {
    id: "google",
    name: "Google AI",
    icon: "🔍",
    requiresAuth: true,
    supportsCustomEndpoint: false,
    description: "Gemini models",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    icon: "🌐",
    requiresAuth: true,
    supportsCustomEndpoint: false,
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    description: "Access multiple AI models",
  },
  {
    id: "minimax",
    name: "MiniMax",
    icon: "🚀",
    requiresAuth: true,
    supportsCustomEndpoint: true,
    defaultBaseUrl: "https://api.minimax.io/v1",
    description: "MiniMax M2.1, M2.5 models",
  },
  {
    id: "moonshot",
    name: "Moonshot (Kimi)",
    icon: "🌙",
    requiresAuth: true,
    supportsCustomEndpoint: false,
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    description: "Kimi K2.5 models",
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    icon: "🤖",
    requiresAuth: true,
    supportsCustomEndpoint: false,
    defaultBaseUrl: "https://api.x.ai/v1",
    description: "Grok models",
  },
  {
    id: "ollama",
    name: "Ollama",
    icon: "🦙",
    requiresAuth: false,
    supportsCustomEndpoint: true,
    defaultBaseUrl: "http://localhost:11434",
    description: "Local models",
  },
  {
    id: "custom-anthropic",
    name: "Custom (Anthropic Protocol)",
    icon: "🔧",
    requiresAuth: true,
    supportsCustomEndpoint: true,
    description: "Anthropic-compatible API endpoint",
  },
  {
    id: "custom-openai",
    name: "Custom (OpenAI Protocol)",
    icon: "🔧",
    requiresAuth: true,
    supportsCustomEndpoint: true,
    description: "OpenAI-compatible API endpoint",
  },
];

export const ProviderSettingsEnhanced: React.FC = () => {
  const [providers, setProviders] = useState<ConfiguredProvider[]>([]);
  const [primaryModel, setPrimaryModel] = useState<string>("");
  const [editingProvider, setEditingProvider] = useState<ConfiguredProvider | null>(null);
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");

  useEffect(() => {
    void loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      const config = await window.versoAPI.config.read();
      if (config && typeof config === "object") {
        // Load primary model
        const model = config.agents?.defaults?.model;
        if (typeof model === "string") {
          setPrimaryModel(model);
        } else if (model && typeof model === "object" && "primary" in model) {
          setPrimaryModel(model.primary || "");
        }

        // Load providers
        const providersConfig = config.agents?.defaults?.providers || {};
        const loadedProviders: ConfiguredProvider[] = [];

        for (const [id, providerData] of Object.entries(providersConfig)) {
          if (typeof providerData === "object" && providerData !== null) {
            const providerInfo = PROVIDERS.find((p) => p.id === id);
            loadedProviders.push({
              id,
              type: (providerInfo?.id || id) as ProviderType,
              apiKey: providerData.apiKey,
              baseUrl: providerData.baseUrl,
              models: providerData.models,
            });
          }
        }

        setProviders(loadedProviders);
      }
    } catch (error) {
      console.error("Failed to load config:", error);
    }
  };

  const getProviderInfo = (type: ProviderType): ProviderInfo | undefined => {
    return PROVIDERS.find((p) => p.id === type);
  };

  const handleAddProvider = (type: ProviderType) => {
    const info = getProviderInfo(type);
    if (!info) return;

    setEditingProvider({
      id: type,
      type,
      apiKey: "",
      baseUrl: info.defaultBaseUrl || "",
      models: [],
    });
    setShowAddProvider(false);
  };

  const handleSaveProvider = () => {
    if (!editingProvider) return;

    const existingIndex = providers.findIndex((p) => p.id === editingProvider.id);
    const newProviders = [...providers];

    if (existingIndex >= 0) {
      newProviders[existingIndex] = editingProvider;
    } else {
      newProviders.push(editingProvider);
    }

    setProviders(newProviders);
    setEditingProvider(null);
  };

  const handleRemoveProvider = (id: string) => {
    setProviders(providers.filter((p) => p.id !== id));
  };

  const handleSaveConfig = async () => {
    setIsSaving(true);
    setSaveMessage("");

    try {
      const existingConfig = await window.versoAPI.config.read();
      const config = existingConfig && typeof existingConfig === "object" ? existingConfig : {};

      // Build providers object
      const providersConfig: Record<string, any> = {};
      for (const provider of providers) {
        providersConfig[provider.id] = {
          ...(provider.apiKey && { apiKey: provider.apiKey }),
          ...(provider.baseUrl && { baseUrl: provider.baseUrl }),
          ...(provider.models && provider.models.length > 0 && { models: provider.models }),
        };
      }

      const updatedConfig = {
        ...config,
        agents: {
          ...config.agents,
          defaults: {
            ...config.agents?.defaults,
            model: primaryModel ? { primary: primaryModel } : config.agents?.defaults?.model,
            providers: providersConfig,
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

  const isProviderValid = (provider: ConfiguredProvider): boolean => {
    const info = getProviderInfo(provider.type);
    if (!info) return false;

    if (info.requiresAuth && !provider.apiKey?.trim()) {
      return false;
    }

    if (
      info.supportsCustomEndpoint &&
      provider.type.startsWith("custom-") &&
      !provider.baseUrl?.trim()
    ) {
      return false;
    }

    return true;
  };

  return (
    <div className="provider-settings-enhanced">
      <div className="settings-header">
        <h2>AI Providers & Models</h2>
        <p className="section-description">
          Configure multiple AI providers and set your primary model
        </p>
      </div>

      {/* Primary Model */}
      <div className="section">
        <h3>Primary Model</h3>
        <div className="form-group">
          <input
            type="text"
            value={primaryModel}
            onChange={(e) => setPrimaryModel(e.target.value)}
            placeholder="provider/model-id (e.g., anthropic/claude-opus-4-6)"
            className="input-field"
          />
          <span className="help-text">
            Format: provider/model-id. This model will be used by default.
          </span>
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

        {providers.length === 0 ? (
          <div className="empty-state">
            <p>No providers configured yet</p>
            <p className="help-text">Add a provider to start using AI models</p>
          </div>
        ) : (
          <div className="provider-list">
            {providers.map((provider) => {
              const info = getProviderInfo(provider.type);
              return (
                <div key={provider.id} className="provider-item">
                  <div className="provider-info">
                    <span className="provider-icon">{info?.icon || "🔧"}</span>
                    <div className="provider-details">
                      <h4>{info?.name || provider.id}</h4>
                      {provider.baseUrl && <span className="provider-url">{provider.baseUrl}</span>}
                      {provider.models && provider.models.length > 0 && (
                        <span className="provider-models">
                          {provider.models.length} custom model
                          {provider.models.length !== 1 ? "s" : ""}
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
                    <p>{provider.description}</p>
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
                {providers.find((p) => p.id === editingProvider.id) ? "Edit" : "Add"}{" "}
                {getProviderInfo(editingProvider.type)?.name || editingProvider.id}
              </h3>
              <button className="btn-close" onClick={() => setEditingProvider(null)}>
                ×
              </button>
            </div>
            <div className="modal-body">
              {getProviderInfo(editingProvider.type)?.requiresAuth && (
                <div className="form-group">
                  <label>API Key *</label>
                  <input
                    type="password"
                    value={editingProvider.apiKey || ""}
                    onChange={(e) =>
                      setEditingProvider({ ...editingProvider, apiKey: e.target.value })
                    }
                    placeholder="sk-..."
                    className="input-field"
                  />
                  <span className="help-text">Your API key will be stored securely</span>
                </div>
              )}

              {getProviderInfo(editingProvider.type)?.supportsCustomEndpoint && (
                <div className="form-group">
                  <label>
                    Base URL {editingProvider.type.startsWith("custom-") ? "*" : "(optional)"}
                  </label>
                  <input
                    type="url"
                    value={editingProvider.baseUrl || ""}
                    onChange={(e) =>
                      setEditingProvider({ ...editingProvider, baseUrl: e.target.value })
                    }
                    placeholder={
                      getProviderInfo(editingProvider.type)?.defaultBaseUrl ||
                      "https://api.example.com"
                    }
                    className="input-field"
                  />
                  <span className="help-text">The base URL for the API endpoint</span>
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
                disabled={!isProviderValid(editingProvider)}
              >
                Save Provider
              </button>
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
