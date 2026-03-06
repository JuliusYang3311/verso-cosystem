// src/app/settings/channel-settings.tsx - Enhanced channel configuration

import React, { useState, useEffect } from "react";

type ChannelType = "telegram" | "wecom" | "discord" | "slack" | "whatsapp" | "feishu";

interface ChannelConfig {
  telegram?: {
    enabled: boolean;
    botToken?: string;
    dmPolicy?: string;
    groupPolicy?: string;
    allowFrom?: string[];
  };
  wecom?: {
    enabled: boolean;
    token?: string;
    encodingAesKey?: string;
  };
  discord?: {
    enabled: boolean;
    botToken?: string;
  };
  slack?: {
    enabled: boolean;
    botToken?: string;
  };
  whatsapp?: {
    enabled: boolean;
  };
  feishu?: {
    enabled: boolean;
    appId?: string;
    appSecret?: string;
  };
}

const CHANNEL_INFO: Record<ChannelType, { icon: string; name: string; description: string }> = {
  telegram: {
    icon: "📱",
    name: "Telegram",
    description: "Chat with Verso via Telegram bot",
  },
  wecom: {
    icon: "💼",
    name: "WeChat Work",
    description: "Enterprise messaging integration",
  },
  discord: {
    icon: "🎮",
    name: "Discord",
    description: "Connect via Discord bot",
  },
  slack: {
    icon: "💬",
    name: "Slack",
    description: "Integrate with Slack workspace",
  },
  whatsapp: {
    icon: "📞",
    name: "WhatsApp",
    description: "WhatsApp Business integration",
  },
  feishu: {
    icon: "🚀",
    name: "Feishu/Lark",
    description: "Feishu enterprise messaging",
  },
};

export const ChannelSettings: React.FC = () => {
  const [channels, setChannels] = useState<ChannelConfig>({});
  const [expandedChannel, setExpandedChannel] = useState<ChannelType | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");

  // Form states for each channel
  const [telegramToken, setTelegramToken] = useState("");
  const [telegramAllowFrom, setTelegramAllowFrom] = useState("");
  const [wecomToken, setWecomToken] = useState("");
  const [wecomAesKey, setWecomAesKey] = useState("");
  const [discordToken, setDiscordToken] = useState("");
  const [slackToken, setSlackToken] = useState("");
  const [feishuAppId, setFeishuAppId] = useState("");
  const [feishuAppSecret, setFeishuAppSecret] = useState("");

  useEffect(() => {
    void loadCurrentConfig();
  }, []);

  const loadCurrentConfig = async () => {
    try {
      const config = await window.versoAPI.config.read();
      if (config && typeof config === "object" && "channels" in config) {
        const channelConfig = config.channels as ChannelConfig;
        setChannels(channelConfig);

        // Load individual channel configs
        if (channelConfig.telegram) {
          setTelegramToken(channelConfig.telegram.botToken || "");
          setTelegramAllowFrom(channelConfig.telegram.allowFrom?.join(", ") || "");
        }
        if (channelConfig.wecom) {
          setWecomToken(channelConfig.wecom.token || "");
          setWecomAesKey(channelConfig.wecom.encodingAesKey || "");
        }
        if (channelConfig.discord) {
          setDiscordToken(channelConfig.discord.botToken || "");
        }
        if (channelConfig.slack) {
          setSlackToken(channelConfig.slack.botToken || "");
        }
        if (channelConfig.feishu) {
          setFeishuAppId(channelConfig.feishu.appId || "");
          setFeishuAppSecret(channelConfig.feishu.appSecret || "");
        }
      }
    } catch (error) {
      console.error("Failed to load config:", error);
    }
  };

  const toggleChannel = (channel: ChannelType) => {
    setChannels((prev) => ({
      ...prev,
      [channel]: {
        ...prev[channel],
        enabled: !prev[channel]?.enabled,
      },
    }));
  };

  const handleSave = async () => {
    setIsSaving(true);
    setSaveMessage("");

    try {
      const channelConfig: ChannelConfig = {};

      // Telegram
      if (channels.telegram?.enabled) {
        channelConfig.telegram = {
          enabled: true,
          botToken: telegramToken.trim() || undefined,
          dmPolicy: "pairing",
          groupPolicy: "allowlist",
          allowFrom: telegramAllowFrom
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean),
        };
      }

      // WeChat Work
      if (channels.wecom?.enabled) {
        channelConfig.wecom = {
          enabled: true,
          token: wecomToken.trim() || undefined,
          encodingAesKey: wecomAesKey.trim() || undefined,
        };
      }

      // Discord
      if (channels.discord?.enabled) {
        channelConfig.discord = {
          enabled: true,
          botToken: discordToken.trim() || undefined,
        };
      }

      // Slack
      if (channels.slack?.enabled) {
        channelConfig.slack = {
          enabled: true,
          botToken: slackToken.trim() || undefined,
        };
      }

      // WhatsApp
      if (channels.whatsapp?.enabled) {
        channelConfig.whatsapp = {
          enabled: true,
        };
      }

      // Feishu
      if (channels.feishu?.enabled) {
        channelConfig.feishu = {
          enabled: true,
          appId: feishuAppId.trim() || undefined,
          appSecret: feishuAppSecret.trim() || undefined,
        };
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

  const renderChannelConfig = (channel: ChannelType) => {
    if (!channels[channel]?.enabled) {
      return null;
    }

    switch (channel) {
      case "telegram":
        return (
          <div className="channel-config">
            <div className="form-group">
              <label htmlFor="telegramToken">Bot Token *</label>
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
            <div className="form-group">
              <label htmlFor="telegramAllowFrom">Allowed User IDs (optional)</label>
              <input
                id="telegramAllowFrom"
                type="text"
                value={telegramAllowFrom}
                onChange={(e) => setTelegramAllowFrom(e.target.value)}
                placeholder="123456789, 987654321"
                className="input-field"
              />
              <span className="help-text">Comma-separated list of Telegram user IDs</span>
            </div>
          </div>
        );

      case "wecom":
        return (
          <div className="channel-config">
            <div className="form-group">
              <label htmlFor="wecomToken">Token *</label>
              <input
                id="wecomToken"
                type="password"
                value={wecomToken}
                onChange={(e) => setWecomToken(e.target.value)}
                placeholder="Token"
                className="input-field"
              />
            </div>
            <div className="form-group">
              <label htmlFor="wecomAesKey">Encoding AES Key *</label>
              <input
                id="wecomAesKey"
                type="password"
                value={wecomAesKey}
                onChange={(e) => setWecomAesKey(e.target.value)}
                placeholder="AES Key"
                className="input-field"
              />
            </div>
            <span className="help-text">
              Configure in{" "}
              <a href="https://work.weixin.qq.com" target="_blank" rel="noopener noreferrer">
                WeChat Work Admin Console
              </a>
            </span>
          </div>
        );

      case "discord":
        return (
          <div className="channel-config">
            <div className="form-group">
              <label htmlFor="discordToken">Bot Token *</label>
              <input
                id="discordToken"
                type="password"
                value={discordToken}
                onChange={(e) => setDiscordToken(e.target.value)}
                placeholder="Bot Token"
                className="input-field"
              />
              <span className="help-text">
                Get your bot token from{" "}
                <a
                  href="https://discord.com/developers/applications"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Discord Developer Portal
                </a>
              </span>
            </div>
          </div>
        );

      case "slack":
        return (
          <div className="channel-config">
            <div className="form-group">
              <label htmlFor="slackToken">Bot Token *</label>
              <input
                id="slackToken"
                type="password"
                value={slackToken}
                onChange={(e) => setSlackToken(e.target.value)}
                placeholder="xoxb-..."
                className="input-field"
              />
              <span className="help-text">
                Get your bot token from{" "}
                <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer">
                  Slack API
                </a>
              </span>
            </div>
          </div>
        );

      case "feishu":
        return (
          <div className="channel-config">
            <div className="form-group">
              <label htmlFor="feishuAppId">App ID *</label>
              <input
                id="feishuAppId"
                type="text"
                value={feishuAppId}
                onChange={(e) => setFeishuAppId(e.target.value)}
                placeholder="cli_..."
                className="input-field"
              />
            </div>
            <div className="form-group">
              <label htmlFor="feishuAppSecret">App Secret *</label>
              <input
                id="feishuAppSecret"
                type="password"
                value={feishuAppSecret}
                onChange={(e) => setFeishuAppSecret(e.target.value)}
                placeholder="App Secret"
                className="input-field"
              />
            </div>
            <span className="help-text">
              Configure in{" "}
              <a href="https://open.feishu.cn" target="_blank" rel="noopener noreferrer">
                Feishu Open Platform
              </a>
            </span>
          </div>
        );

      case "whatsapp":
        return (
          <div className="channel-config">
            <p className="help-text">
              WhatsApp Business API integration. Contact support for setup instructions.
            </p>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="channel-settings">
      <h2>Messaging Channels</h2>
      <p className="section-description">
        Configure how you interact with Verso through different messaging platforms
      </p>

      <div className="channel-list">
        {(Object.keys(CHANNEL_INFO) as ChannelType[]).map((channel) => {
          const info = CHANNEL_INFO[channel];
          const isEnabled = channels[channel]?.enabled || false;

          return (
            <div key={channel} className={`channel-card ${isEnabled ? "enabled" : ""}`}>
              <div className="channel-header">
                <div className="channel-icon">{info.icon}</div>
                <div className="channel-info">
                  <h3>{info.name}</h3>
                  <p>{info.description}</p>
                </div>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={isEnabled}
                    onChange={() => toggleChannel(channel)}
                  />
                  <span className="slider"></span>
                </label>
              </div>

              {isEnabled && renderChannelConfig(channel)}
            </div>
          );
        })}
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
