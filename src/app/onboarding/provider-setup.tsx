// src/app/onboarding/provider-setup.tsx - Provider selection and configuration

import React, { useState } from "react";

interface ProviderSetupProps {
  onNext: (config: ProviderConfig) => void;
  onBack: () => void;
}

export type ProviderType = "anthropic" | "openai" | "custom-anthropic" | "custom-openai";

export interface ProviderConfig {
  type: ProviderType;
  apiKey?: string;
  baseUrl?: string;
  models?: string[];
}

export const ProviderSetup: React.FC<ProviderSetupProps> = ({ onNext, onBack }) => {
  const [providerType, setProviderType] = useState<ProviderType>("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const handleSubmit = () => {
    const config: ProviderConfig = {
      type: providerType,
      apiKey: apiKey.trim(),
    };

    if (providerType.startsWith("custom-")) {
      config.baseUrl = baseUrl.trim();
    }

    onNext(config);
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
    <div className="onboarding-screen provider-setup">
      <div className="header">
        <h2>Choose Your AI Provider</h2>
        <p>Select and configure your preferred AI service</p>
      </div>

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
                placeholder="claude-opus-4-6, claude-sonnet-4-6"
                className="input-field"
              />
              <span className="help-text">Comma-separated list of model IDs</span>
            </div>
          </div>
        )}
      </div>

      <div className="actions">
        <button className="btn-secondary" onClick={onBack}>
          Back
        </button>
        <button className="btn-primary" onClick={handleSubmit} disabled={!isValid()}>
          Continue
        </button>
      </div>
    </div>
  );
};
