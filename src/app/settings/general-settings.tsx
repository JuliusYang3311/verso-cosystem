// src/app/settings/general-settings.tsx - General application settings

import React, { useState, useEffect } from "react";

export const GeneralSettings: React.FC = () => {
  const [theme, setTheme] = useState<"light" | "dark" | "auto">("auto");
  const [language, setLanguage] = useState("en");
  const [maxFixCycles, setMaxFixCycles] = useState(3);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");

  useEffect(() => {
    void loadCurrentConfig();
  }, []);

  const loadCurrentConfig = async () => {
    try {
      const config = await window.versoAPI.config.read();
      if (config && typeof config === "object") {
        if ("theme" in config) {
          setTheme(config.theme as "light" | "dark" | "auto");
        }
        if ("language" in config) {
          setLanguage(config.language as string);
        }
        if ("orchestration" in config && typeof config.orchestration === "object") {
          const orch = config.orchestration as Record<string, unknown>;
          if ("maxFixCycles" in orch) {
            setMaxFixCycles(Number(orch.maxFixCycles));
          }
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
      // Read existing config
      const existingConfig = await window.versoAPI.config.read();
      const config = existingConfig && typeof existingConfig === "object" ? existingConfig : {};

      // Update general settings
      const updatedConfig = {
        ...config,
        theme,
        language,
        orchestration: {
          ...(typeof config === "object" &&
          "orchestration" in config &&
          typeof config.orchestration === "object"
            ? config.orchestration
            : {}),
          maxFixCycles,
        },
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

  return (
    <div className="general-settings">
      <h2>General Settings</h2>
      <p className="section-description">Configure general application preferences</p>

      <div className="settings-section">
        <h3>Appearance</h3>
        <div className="form-group">
          <label htmlFor="theme">Theme</label>
          <select
            id="theme"
            value={theme}
            onChange={(e) => setTheme(e.target.value as "light" | "dark" | "auto")}
            className="select-field"
          >
            <option value="auto">Auto (System)</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="language">Language</label>
          <select
            id="language"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            className="select-field"
          >
            <option value="en">English</option>
            <option value="zh">中文</option>
          </select>
        </div>
      </div>

      <div className="settings-section">
        <h3>Orchestration</h3>
        <div className="form-group">
          <label htmlFor="maxFixCycles">Max Fix Cycles</label>
          <input
            id="maxFixCycles"
            type="number"
            min="1"
            max="10"
            value={maxFixCycles}
            onChange={(e) => setMaxFixCycles(parseInt(e.target.value))}
            className="input-field"
          />
          <span className="help-text">Maximum number of retry cycles for failed tasks</span>
        </div>
      </div>

      <div className="settings-section">
        <h3>About</h3>
        <div className="about-info">
          <img src="/Verso.png" alt="Verso" className="about-logo" />
          <p className="app-name">Verso</p>
          <p className="app-description">AI-powered personal assistant</p>
          <p className="app-version">Version 1.0.0</p>
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
