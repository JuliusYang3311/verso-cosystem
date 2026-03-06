// src/app/settings/provider-settings.tsx - Provider configuration

import React, { useState, useEffect } from "react";
import type { ProviderType, ProviderConfig } from "../onboarding/provider-setup";

export const ProviderSettings: React.FC = () => {
  const [providerType, setProviderType] = useState<ProviderType>("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [models, setModels] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");

  useEffect(() => {
    void loadCurrentConfig();
  }, []);

  const loadCurrentConfig = async () => {
    try {
      const config = await window.versoAPI.config.read();
      if (config && typeof config === "object" && "provider" in config) {
        const provider = config.provider as ProviderConfig;
        setProviderType(provider.type);
        setApiKey(provider.apiKey || "");
        setBaseUrl(provider.baseUrl || "");
        setModels(provider.models?.join(", ") || "");
      }
    } catch (error) {
      console.error("Failed to load config:", error);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    setSaveMessage("");

    try {
      const providerConfig: ProviderConfig = {
        type: providerType,
        apiKey: apiKey.trim(),
      };

      if (providerType.startsWith("custom-")) {
        providerConfig.baseUrl = baseUrl.trim();
      }

      if (models.trim()) {
        providerConfig.models = models.split(",").map((m) => m.trim());
      }

      // Read existing config
      const existingConfig = await window.versoAPI.config.read();
      const config = existingConfig && typeof existingConfig === "object" ? existingConfig : {};

      // Update provider config
      const updatedConfig = {
        ...config,
        provider: providerConfig,
      };

      // Save to config file
      const result = await window.versoAPI.config.write(updatedConfig);

      if (result.success) {
        setSaveMessage("Settings saved successfully");
        setTimeout(() => setSaveMessage(""), 3000);
      } else {
        setSaveMessage(`Error: ${result.error || "Failed to save"}`);
      }
    } catch (error) {
      setSaveMessage(`Error: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setIsSaving(false);
    }
  };

  const isValid = () => {
    if (!apiKey.trim()) {
      return false;
    }
    if (providerType.startsWith("custom-") && !baseUrl.trim()) {
      return false;
    }
    return true;
  };

  return (
    <div className="provider-settings">
      <h2>AI Provider Configuration</h2>
      <p className="section-description">Configure your AI service provider and authentication</p>

      <div className="provider-options">
        <div
          className={`provider-card ${providerType === "anthropic" ? "selected" : ""}`}
          onClick={() => setProviderType("anthropic")}
        >
          <div className="provider-icon">🧠</div>
          <h3>Anthropic</h3>
          <p>Claude models (Opus, Sonnet, Haiku)</p>
          <span className="badge">Official API</span>
        </div>

        <div
          className={`provider-card ${providerType === "openai" ? "selected" : ""}`}
          onClick={() => setProviderType("openai")}
        >
          <div className="provider-icon">⚡</div>
          <h3>OpenAI</h3>
          <p>GPT-4, GPT-5, and more</p>
          <span className="badge">Official API</span>
        </div>

        <div
          className={`provider-card ${providerType === "custom-anthropic" ? "selected" : ""}`}
          onClick={() => setProviderType("custom-anthropic")}
        >
          <div className="provider-icon">🔧</div>
          <h3>Custom (Anthropic)</h3>
          <p>Anthropic-compatible API</p>
          <span className="badge">Custom Endpoint</span>
        </div>

        <div
          className={`provider-card ${providerType === "custom-openai" ? "selected" : ""}`}
          onClick={() => setProviderType("custom-openai")}
        >
          <div className="provider-icon">🔧</div>
          <h3>Custom (OpenAI)</h3>
          <p>OpenAI-compatible API</p>
          <span className="badge">Custom Endpoint</span>
        </div>
      </div>

      <div className="config-form">
        <div className="form-group">
          <label htmlFor="apiKey">API Key *</label>
          <input
            id="apiKey"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
            className="input-field"
          />
          <span className="help-text">Your API key will be stored securely and never shared</span>
        </div>

        {providerType.startsWith("custom-") && (
          <div className="form-group">
            <label htmlFor="baseUrl">Base URL *</label>
            <input
              id="baseUrl"
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com"
              className="input-field"
            />
            <span className="help-text">The base URL for your custom API endpoint</span>
          </div>
        )}

        <button className="btn-link" onClick={() => setShowAdvanced(!showAdvanced)}>
          {showAdvanced ? "▼" : "▶"} Advanced Options
        </button>

        {showAdvanced && (
          <div className="advanced-options">
            <div className="form-group">
              <label htmlFor="models">Custom Models (optional)</label>
              <input
                id="models"
                type="text"
                value={models}
                onChange={(e) => setModels(e.target.value)}
                placeholder="claude-opus-4-6, claude-sonnet-4-6"
                className="input-field"
              />
              <span className="help-text">Comma-separated list of model IDs</span>
            </div>
          </div>
        )}
      </div>

      {saveMessage && (
        <div className={`save-message ${saveMessage.startsWith("Error") ? "error" : "success"}`}>
          {saveMessage}
        </div>
      )}

      <div className="actions">
        <button className="btn-primary" onClick={handleSave} disabled={!isValid() || isSaving}>
          {isSaving ? "Saving..." : "Save Changes"}
        </button>
      </div>
    </div>
  );
};
