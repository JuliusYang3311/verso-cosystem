// src/app/settings/index.tsx - Settings interface

import React, { useState } from "react";
import { ChannelSettings } from "./channel-settings";
import { GeneralSettings } from "./general-settings";
import { ProviderSettings } from "./provider-settings";

type SettingsTab = "general" | "provider" | "channels";

export const SettingsPanel: React.FC = () => {
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");

  return (
    <div className="settings-panel">
      <div className="settings-header">
        <h1>Settings</h1>
      </div>

      <div className="settings-layout">
        <nav className="settings-nav">
          <button
            className={`nav-item ${activeTab === "general" ? "active" : ""}`}
            onClick={() => setActiveTab("general")}
          >
            <span className="icon">⚙️</span>
            General
          </button>
          <button
            className={`nav-item ${activeTab === "provider" ? "active" : ""}`}
            onClick={() => setActiveTab("provider")}
          >
            <span className="icon">🤖</span>
            AI Provider
          </button>
          <button
            className={`nav-item ${activeTab === "channels" ? "active" : ""}`}
            onClick={() => setActiveTab("channels")}
          >
            <span className="icon">💬</span>
            Channels
          </button>
        </nav>

        <div className="settings-content">
          {activeTab === "general" && <GeneralSettings />}
          {activeTab === "provider" && <ProviderSettings />}
          {activeTab === "channels" && <ChannelSettings />}
        </div>
      </div>
    </div>
  );
};
