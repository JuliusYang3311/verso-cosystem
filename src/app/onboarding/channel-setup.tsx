// src/app/onboarding/channel-setup.tsx - Channel configuration

import React, { useState } from "react";

interface ChannelSetupProps {
  onNext: (channels: ChannelConfig) => void;
  onBack: () => void;
}

export interface ChannelConfig {
  telegram?: { enabled: boolean; botToken?: string };
  wecom?: { enabled: boolean };
}

export const ChannelSetup: React.FC<ChannelSetupProps> = ({ onNext, onBack }) => {
  const [telegramEnabled, setTelegramEnabled] = useState(false);
  const [telegramToken, setTelegramToken] = useState("");
  const [wecomEnabled, setWecomEnabled] = useState(false);

  const handleSubmit = () => {
    const config: ChannelConfig = {};

    if (telegramEnabled) {
      config.telegram = {
        enabled: true,
        botToken: telegramToken.trim() || undefined,
      };
    }

    if (wecomEnabled) {
      config.wecom = { enabled: true };
    }

    onNext(config);
  };

  return (
    <div className="onboarding-screen channel-setup">
      <div className="header">
        <h2>Connect Messaging Channels</h2>
        <p>Choose how you want to interact with Verso (optional)</p>
      </div>

      <div className="channel-options">
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
              <p className="info-text">
                WeChat Work configuration can be completed in Settings after setup
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="skip-note">
        <p>💡 You can skip this step and configure channels later in Settings</p>
      </div>

      <div className="actions">
        <button className="btn-secondary" onClick={onBack}>
          Back
        </button>
        <button className="btn-primary" onClick={handleSubmit}>
          {telegramEnabled || wecomEnabled ? "Continue" : "Skip"}
        </button>
      </div>
    </div>
  );
};
