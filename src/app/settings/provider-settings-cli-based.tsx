// src/app/settings/provider-settings-cli-based.tsx - Provider configuration based on CLI logic

import React, { useState, useEffect } from "react";

// Directly copied from CLI: src/commands/auth-choice-options.ts
type AuthChoice =
  | "token"
  | "apiKey"
  | "openai-codex"
  | "openai-api-key"
  | "gemini-api-key"
  | "google-antigravity"
  | "google-gemini-cli"
  | "github-copilot"
  | "copilot-proxy"
  | "openrouter-api-key"
  | "ai-gateway-api-key"
  | "cloudflare-ai-gateway-api-key"
  | "moonshot-api-key"
  | "moonshot-api-key-cn"
  | "kimi-code-api-key"
  | "zai-api-key"
  | "qianfan-api-key"
  | "xiaomi-api-key"
  | "minimax-portal"
  | "minimax-api"
  | "minimax-api-highspeed"
  | "qwen-portal"
  | "opencode-zen"
  | "synthetic-api-key"
  | "venice-api-key"
  | "xai-api-key"
  | "chutes"
  | "custom-anthropic"
  | "custom-openai"
  | "skip";

type AuthChoiceGroupId =
  | "openai"
  | "anthropic"
  | "google"
  | "copilot"
  | "openrouter"
  | "ai-gateway"
  | "cloudflare-ai-gateway"
  | "moonshot"
  | "zai"
  | "xiaomi"
  | "opencode-zen"
  | "minimax"
  | "synthetic"
  | "venice"
  | "qwen"
  | "qianfan"
  | "xai"
  | "custom";

type AuthChoiceGroup = {
  value: AuthChoiceGroupId;
  label: string;
  hint?: string;
  choices: AuthChoice[];
};

// Directly copied from CLI: src/commands/auth-choice-options.ts
const AUTH_CHOICE_GROUPS: AuthChoiceGroup[] = [
  {
    value: "openai",
    label: "OpenAI",
    hint: "Codex OAuth + API key",
    choices: ["openai-codex", "openai-api-key"],
  },
  {
    value: "anthropic",
    label: "Anthropic",
    hint: "setup-token + API key",
    choices: ["token", "apiKey"],
  },
  {
    value: "minimax",
    label: "MiniMax",
    hint: "M2.1 (recommended)",
    choices: ["minimax-portal", "minimax-api", "minimax-api-highspeed"],
  },
  {
    value: "moonshot",
    label: "Moonshot AI (Kimi K2.5)",
    hint: "Kimi K2.5 + Kimi Coding",
    choices: ["moonshot-api-key", "moonshot-api-key-cn", "kimi-code-api-key"],
  },
  {
    value: "google",
    label: "Google",
    hint: "Gemini API key + OAuth",
    choices: ["gemini-api-key", "google-antigravity", "google-gemini-cli"],
  },
  {
    value: "xai",
    label: "xAI (Grok)",
    hint: "API key",
    choices: ["xai-api-key"],
  },
  {
    value: "openrouter",
    label: "OpenRouter",
    hint: "API key",
    choices: ["openrouter-api-key"],
  },
  {
    value: "qwen",
    label: "Qwen",
    hint: "OAuth",
    choices: ["qwen-portal"],
  },
  {
    value: "zai",
    label: "Z.AI (GLM 4.7)",
    hint: "API key",
    choices: ["zai-api-key"],
  },
  {
    value: "qianfan",
    label: "Qianfan",
    hint: "API key",
    choices: ["qianfan-api-key"],
  },
  {
    value: "copilot",
    label: "Copilot",
    hint: "GitHub + local proxy",
    choices: ["github-copilot", "copilot-proxy"],
  },
  {
    value: "ai-gateway",
    label: "Vercel AI Gateway",
    hint: "API key",
    choices: ["ai-gateway-api-key"],
  },
  {
    value: "opencode-zen",
    label: "OpenCode Zen",
    hint: "API key",
    choices: ["opencode-zen"],
  },
  {
    value: "xiaomi",
    label: "Xiaomi",
    hint: "API key",
    choices: ["xiaomi-api-key"],
  },
  {
    value: "synthetic",
    label: "Synthetic",
    hint: "Anthropic-compatible (multi-model)",
    choices: ["synthetic-api-key"],
  },
  {
    value: "venice",
    label: "Venice AI",
    hint: "Privacy-focused (uncensored models)",
    choices: ["venice-api-key"],
  },
  {
    value: "cloudflare-ai-gateway",
    label: "Cloudflare AI Gateway",
    hint: "Account ID + Gateway ID + API key",
    choices: ["cloudflare-ai-gateway-api-key"],
  },
  {
    value: "custom",
    label: "Custom Providers",
    hint: "Anthropic/OpenAI compatible endpoints",
    choices: ["custom-anthropic", "custom-openai"],
  },
];

type AuthChoiceOption = {
  value: AuthChoice;
  label: string;
  hint?: string;
};

// Directly copied from CLI: src/commands/auth-choice-options.ts
const AUTH_CHOICE_OPTIONS: AuthChoiceOption[] = [
  {
    value: "token",
    label: "Anthropic token (paste setup-token)",
    hint: "run `claude setup-token` elsewhere, then paste the token here",
  },
  { value: "openai-codex", label: "OpenAI Codex (ChatGPT OAuth)" },
  { value: "chutes", label: "Chutes (OAuth)" },
  { value: "openai-api-key", label: "OpenAI API key" },
  { value: "xai-api-key", label: "xAI (Grok) API key" },
  { value: "qianfan-api-key", label: "Qianfan API key" },
  { value: "openrouter-api-key", label: "OpenRouter API key" },
  { value: "ai-gateway-api-key", label: "Vercel AI Gateway API key" },
  {
    value: "cloudflare-ai-gateway-api-key",
    label: "Cloudflare AI Gateway",
    hint: "Account ID + Gateway ID + API key",
  },
  { value: "moonshot-api-key", label: "Kimi API key (.ai)" },
  { value: "moonshot-api-key-cn", label: "Kimi API key (.cn)" },
  { value: "kimi-code-api-key", label: "Kimi Code API key (subscription)" },
  { value: "synthetic-api-key", label: "Synthetic API key" },
  {
    value: "venice-api-key",
    label: "Venice AI API key",
    hint: "Privacy-focused inference (uncensored models)",
  },
  {
    value: "github-copilot",
    label: "GitHub Copilot (GitHub device login)",
    hint: "Uses GitHub device flow",
  },
  { value: "gemini-api-key", label: "Google Gemini API key" },
  {
    value: "google-antigravity",
    label: "Google Antigravity OAuth",
    hint: "Uses the bundled Antigravity auth plugin",
  },
  {
    value: "google-gemini-cli",
    label: "Google Gemini CLI OAuth",
    hint: "Uses the bundled Gemini CLI auth plugin",
  },
  { value: "zai-api-key", label: "Z.AI (GLM 4.7) API key" },
  { value: "xiaomi-api-key", label: "Xiaomi API key" },
  {
    value: "minimax-portal",
    label: "MiniMax OAuth",
    hint: "OAuth plugin for MiniMax",
  },
  { value: "qwen-portal", label: "Qwen OAuth" },
  {
    value: "copilot-proxy",
    label: "Copilot Proxy (local)",
    hint: "Local proxy for VS Code Copilot models",
  },
  { value: "apiKey", label: "Anthropic API key" },
  {
    value: "opencode-zen",
    label: "OpenCode Zen (multi-model proxy)",
    hint: "Claude, GPT, Gemini via opencode.ai/zen",
  },
  { value: "minimax-api", label: "MiniMax M2.1" },
  {
    value: "minimax-api-highspeed",
    label: "MiniMax M2.1 Highspeed",
    hint: "Faster, higher output cost",
  },
  {
    value: "custom-anthropic",
    label: "Custom Anthropic-compatible API",
    hint: "Any API endpoint that implements Anthropic's protocol",
  },
  {
    value: "custom-openai",
    label: "Custom OpenAI-compatible API",
    hint: "Any API endpoint that implements OpenAI's protocol",
  },
];

export const ProviderSettingsCliBased: React.FC = () => {
  const [selectedGroup, setSelectedGroup] = useState<AuthChoiceGroupId | null>(null);
  const [selectedChoice, setSelectedChoice] = useState<AuthChoice | null>(null);
  const [primaryModel, setPrimaryModel] = useState<string>("");
  const [configuredProviders, setConfiguredProviders] = useState<string[]>([]);
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

        // Load configured providers
        const providers = config.agents?.defaults?.providers || {};
        setConfiguredProviders(Object.keys(providers));
      }
    } catch (error) {
      console.error("Failed to load config:", error);
    }
  };

  const handleSelectGroup = (groupId: AuthChoiceGroupId) => {
    setSelectedGroup(groupId);
    setSelectedChoice(null);
  };

  const handleSelectChoice = (choice: AuthChoice) => {
    setSelectedChoice(choice);
    // TODO: Implement auth flow based on choice
    // This would call the corresponding CLI function from src/commands/onboard-auth.ts
  };

  const handleSaveConfig = async () => {
    setIsSaving(true);
    setSaveMessage("");

    try {
      const existingConfig = await window.versoAPI.config.read();
      const config = existingConfig && typeof existingConfig === "object" ? existingConfig : {};

      const updatedConfig = {
        ...config,
        agents: {
          ...config.agents,
          defaults: {
            ...config.agents?.defaults,
            model: primaryModel ? { primary: primaryModel } : config.agents?.defaults?.model,
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

  const getGroupOptions = (groupId: AuthChoiceGroupId): AuthChoiceOption[] => {
    const group = AUTH_CHOICE_GROUPS.find((g) => g.value === groupId);
    if (!group) return [];

    return group.choices
      .map((choice) => AUTH_CHOICE_OPTIONS.find((opt) => opt.value === choice))
      .filter((opt): opt is AuthChoiceOption => Boolean(opt));
  };

  return (
    <div className="provider-settings-cli-based">
      <div className="settings-header">
        <h2>AI Providers & Models</h2>
        <p className="section-description">
          Configure AI providers using the same options as CLI onboarding
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
        <h3>Configured Providers</h3>
        {configuredProviders.length === 0 ? (
          <div className="empty-state">
            <p>No providers configured yet</p>
          </div>
        ) : (
          <div className="provider-list">
            {configuredProviders.map((providerId) => (
              <div key={providerId} className="provider-item">
                <span>{providerId}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add Provider - Step 1: Select Group */}
      {!selectedGroup && (
        <div className="section">
          <h3>Add Provider</h3>
          <div className="provider-grid">
            {AUTH_CHOICE_GROUPS.map((group) => (
              <div
                key={group.value}
                className="provider-card"
                onClick={() => handleSelectGroup(group.value)}
              >
                <h4>{group.label}</h4>
                {group.hint && <p className="hint">{group.hint}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add Provider - Step 2: Select Auth Method */}
      {selectedGroup && !selectedChoice && (
        <div className="section">
          <div className="section-header">
            <h3>
              {AUTH_CHOICE_GROUPS.find((g) => g.value === selectedGroup)?.label} - Select Auth
              Method
            </h3>
            <button className="btn-link" onClick={() => setSelectedGroup(null)}>
              ← Back
            </button>
          </div>
          <div className="auth-method-list">
            {getGroupOptions(selectedGroup).map((option) => (
              <div
                key={option.value}
                className="auth-method-item"
                onClick={() => handleSelectChoice(option.value)}
              >
                <h4>{option.label}</h4>
                {option.hint && <p className="hint">{option.hint}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add Provider - Step 3: Configure (TODO) */}
      {selectedChoice && (
        <div className="section">
          <div className="section-header">
            <h3>Configure {selectedChoice}</h3>
            <button
              className="btn-link"
              onClick={() => {
                setSelectedChoice(null);
                setSelectedGroup(null);
              }}
            >
              ← Cancel
            </button>
          </div>
          <p>TODO: Implement auth flow for {selectedChoice}</p>
          <p className="help-text">
            This will call the corresponding function from src/commands/onboard-auth.ts
          </p>
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
