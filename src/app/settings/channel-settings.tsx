// src/app/settings/channel-settings.tsx - Channel configuration

import React, { useState, useEffect } from "react";
import type { ChannelConfig } from "../onboarding/channel-setup";

export const ChannelSettings: React.FC = () => {
  const [telegramEnabled, setTelegramEnabled] = useState(false);
  const [telegramToken, setTelegramToken] = useState("");
  const [wecomEnabled, setWecomEnabled] = useState(false);
  const [wecomCorpId, setWecomCorpId] = useState("");
  const [wecomAgentId, setWecomAgentId] = useState("");
  const [wecomSecret, setWecomSecret] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");

  useEffect(() => {
    void loadCurrentConfig();
  }, []);

  const loadCurrentConfig = async () => {
    try {
      const config = await window.versoAPI.config.read();
      if (config && typeof config === "object" && "channels" in config) {
        const channels = config.channels as ChannelConfig;

        if (channels.telegram) {
          setTelegramEnabled(channels.telegram.enabled || false);
          setTelegramToken(channels.telegram.botToken || "");
        }

        if (channels.wecom) {
          setWecomEnabled(channels.wecom.enabled || false);
        }
      }
    } catch (error) {
      console.error("Failed to load config:", error);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    setSaveMessage("");

    try {
      const channelConfig: ChannelConfig = {};

      if (telegramEnabled) {
        channelConfig.telegram = {
          enabled: true,
          botToken: telegramToken.trim() || undefined,
        };
      }

      if (wecomEnabled) {
        channelConfig.wecom = { enabled: true };
      }

      // Read existing config
      const existingConfig = await window.versoAPI.config.read();
      const config = existingConfig && typeof existingConfig === "object" ? existingConfig : {};

      // Update channel config
      const updatedConfig = {
        ...config,
        channels: channelConfig,
      };

      // Save to config file
      const result = await window.versoAPI.config.write(updatedConfig);

      if (result.success) {
        setSaveMessage("Settings saved successfully. Restart gateway to apply changes.");
        setTimeout(() => setSaveMessage(""), 5000);
      } else {
        setSaveMessage(`Error: ${result.error || "Failed to save"}`);
      }
    } catch (error) {
      setSaveMessage(`Error: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="channel-settings">
      <h2>Messaging Channels</h2>
      <p className="section-description">
        Configure how you interact with Verso through different messaging platforms
      </p>

      <div className="channel-list">
        <div className={`channel-card ${telegramEnabled ? "enabled" : ""}`}>
          <div className="channel-header">
            <div className="channel-icon">📱</div>
            <div className="channel-info">
              <h3>Telegram</h3>
              <p>Chat with Verso via Telegram bot</p>
            </div>
            <label className="toggle">
              <input
                type="checkbox"
                checked={telegramEnabled}
                onChange={(e) => setTelegramEnabled(e.target.checked)}
              />
              <span className="slider"></span>
            </label>
          </div>

          {telegramEnabled && (
            <div className="channel-config">
              <div className="form-group">
                <label htmlFor="telegramToken">Bot Token</label>
                <input
                  id="telegramToken"
                  type="password"
                  value={telegramToken}
                  onChange={(e) => setTelegramToken(e.target.value)}
                  placeholder="1234567890:ABCdefGHIjklMNOpqrsTUVwxyz"
                  className="input-field"
                />
                <span className="help-text">
                  Get your bot token from{" "}
                  <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">
                    @BotFather
                  </a>
                </span>
              </div>
            </div>
          )}
        </div>

        <div className={`channel-card ${wecomEnabled ? "enabled" : ""}`}>
          <div className="channel-header">
            <div className="channel-icon">💼</div>
            <div className="channel-info">
              <h3>WeChat Work</h3>
              <p>Enterprise messaging integration</p>
            </div>
            <label className="toggle">
              <input
                type="checkbox"
                checked={wecomEnabled}
                onChange={(e) => setWecomEnabled(e.target.checked)}
              />
              <span className="slider"></span>
            </label>
          </div>

          {wecomEnabled && (
            <div className="channel-config">
              <div className="form-group">
                <label htmlFor="wecomCorpId">Corp ID</label>
                <input
                  id="wecomCorpId"
                  type="text"
                  value={wecomCorpId}
                  onChange={(e) => setWecomCorpId(e.target.value)}
                  placeholder="ww1234567890abcdef"
                  className="input-field"
                />
              </div>

              <div className="form-group">
                <label htmlFor="wecomAgentId">Agent ID</label>
                <input
                  id="wecomAgentId"
                  type="text"
                  value={wecomAgentId}
                  onChange={(e) => setWecomAgentId(e.target.value)}
                  placeholder="1000001"
                  className="input-field"
                />
              </div>

              <div className="form-group">
                <label htmlFor="wecomSecret">Secret</label>
                <input
                  id="wecomSecret"
                  type="password"
                  value={wecomSecret}
                  onChange={(e) => setWecomSecret(e.target.value)}
                  placeholder="Secret key"
                  className="input-field"
                />
              </div>

              <span className="help-text">
                Configure your WeChat Work application in the{" "}
                <a href="https://work.weixin.qq.com" target="_blank" rel="noopener noreferrer">
                  admin console
                </a>
              </span>
            </div>
          )}
        </div>
      </div>

      {saveMessage && (
        <div className={`save-message ${saveMessage.startsWith("Error") ? "error" : "success"}`}>
          {saveMessage}
        </div>
      )}

      <div className="actions">
        <button className="btn-primary" onClick={handleSave} disabled={isSaving}>
          {isSaving ? "Saving..." : "Save Changes"}
        </button>
      </div>
    </div>
  );
};
