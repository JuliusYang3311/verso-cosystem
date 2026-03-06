import type { ChannelOnboardingAdapter, WizardPrompter } from "verso/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "verso/plugin-sdk";
import type { WecomConfig } from "./types.js";
import { WecomCrypto } from "./crypto.js";

const channel = "wecom" as const;

export const wecomOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,

  getStatus: async ({ cfg }) => {
    const wecom = cfg.channels?.wecom as WecomConfig | undefined;
    const hasToken = Boolean(wecom?.token?.trim());
    const hasKey = Boolean(wecom?.encodingAesKey?.trim());
    const configured = hasToken && hasKey;

    const statusLines: string[] = [];
    if (!configured) {
      statusLines.push("WeCom: needs Token and EncodingAESKey");
    } else {
      statusLines.push("WeCom: configured");
    }

    return {
      channel,
      configured,
      statusLines,
      selectionHint: configured ? "configured" : "needs credentials",
      quickstartScore: configured ? 2 : 0,
    };
  },

  configure: async ({ cfg, prompter }) => {
    const wecom = cfg.channels?.wecom as WecomConfig | undefined;
    const hasExisting = Boolean(wecom?.token?.trim() && wecom?.encodingAesKey?.trim());

    let next = cfg;
    let token: string | null = null;
    let encodingAesKey: string | null = null;
    let webhookPath: string | undefined;

    if (hasExisting) {
      const keep = await prompter.confirm({
        message: "WeCom credentials already configured. Keep them?",
        initialValue: true,
      });
      if (!keep) {
        ({ token, encodingAesKey, webhookPath } = await promptWecomCredentials(prompter));
      }
    } else {
      await prompter.note(
        [
          "Enterprise WeChat (WeCom) AI Bot channel.",
          "You need a Token and EncodingAESKey from the WeCom admin console.",
          "Create an AI Bot application and copy the credentials.",
        ].join("\n"),
        "WeCom setup",
      );
      ({ token, encodingAesKey, webhookPath } = await promptWecomCredentials(prompter));
    }

    if (token && encodingAesKey) {
      next = {
        ...next,
        channels: {
          ...next.channels,
          wecom: {
            ...next.channels?.wecom,
            enabled: true,
            token,
            encodingAesKey,
            ...(webhookPath ? { webhookPath } : {}),
          },
        },
      };

      // Validate credentials
      try {
        const crypto = new WecomCrypto(token, encodingAesKey);
        // Basic validation: encrypt/decrypt round-trip
        const testMsg = "test";
        const encrypted = crypto.encrypt(testMsg);
        const decrypted = crypto.decrypt(encrypted);
        if (decrypted.message === testMsg) {
          await prompter.note(
            "Credentials validated successfully. Encryption round-trip OK.",
            "WeCom connection test",
          );
        } else {
          await prompter.note("Warning: encryption round-trip mismatch.", "WeCom connection test");
        }
      } catch (err) {
        await prompter.note(
          `Credential validation failed: ${String(err)}`,
          "WeCom connection test",
        );
      }
    } else if (!hasExisting) {
      next = {
        ...next,
        channels: {
          ...next.channels,
          wecom: { ...next.channels?.wecom, enabled: true },
        },
      };
    }

    return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
  },

  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      wecom: { ...cfg.channels?.wecom, enabled: false },
    },
  }),
};

async function promptWecomCredentials(prompter: WizardPrompter) {
  const token = String(
    await prompter.text({
      message: "Enter WeCom Bot Token",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    }),
  ).trim();

  const encodingAesKey = String(
    await prompter.text({
      message: "Enter EncodingAESKey (43 characters from WeCom admin console)",
      validate: (value) => {
        if (!value?.trim()) return "Required";
        if (value.trim().length !== 43) return "Must be exactly 43 characters";
        return undefined;
      },
    }),
  ).trim();

  const webhookPathRaw = String(
    (await prompter.text({
      message: "Webhook path (leave empty for default /webhooks/wecom)",
      placeholder: "/webhooks/wecom",
    })) ?? "",
  ).trim();

  return {
    token,
    encodingAesKey,
    webhookPath: webhookPathRaw || undefined,
  };
}
