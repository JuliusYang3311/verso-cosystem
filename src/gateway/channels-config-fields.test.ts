/**
 * Unit tests for the frontend `saveChannelField` logic extracted from
 * apps/electron/renderer/channels-config.js.
 *
 * Validates that each field type (text, password, select, checkbox, number,
 * allowFrom) writes values correctly AND that clearing a field deletes the
 * key from the target object.
 *
 * Uses a minimal DOM stub (no jsdom needed).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// ── Minimal DOM stub ────────────────────────────────────────────────────────

const elements = new Map<string, { value: string; checked: boolean }>();

function mockGetElementById(id: string) {
  return elements.get(id) ?? null;
}

// Patch global document just enough for saveChannelField
if (typeof globalThis.document === "undefined") {
  (globalThis as unknown as { document: unknown }).document = {
    getElementById: mockGetElementById,
  };
} else {
  vi.spyOn(document, "getElementById").mockImplementation(
    mockGetElementById as typeof document.getElementById,
  );
}

afterEach(() => {
  elements.clear();
});

function addInput(id: string, value: string): void {
  elements.set(id, { value, checked: false });
}

function addCheckbox(id: string, checked: boolean): void {
  elements.set(id, { value: "", checked });
}

// ── Inline the pure logic from channels-config.js ───────────────────────────

type Field = { key: string; type?: string };

function saveChannelField(
  target: Record<string, unknown>,
  channelName: string,
  field: Field,
  targetKey?: string,
): void {
  const elId = `channel-${channelName}-${field.key.replace(".", "-")}`;
  const el = (
    globalThis as unknown as { document: { getElementById: typeof mockGetElementById } }
  ).document.getElementById(elId) as { value: string; checked: boolean } | null;
  if (!el) return;
  const key = targetKey || field.key;

  if (field.type === "checkbox") {
    target[key] = el.checked;
  } else if (field.type === "number") {
    const val = el.value.trim();
    if (val) target[key] = parseInt(val);
    else delete target[key];
  } else if (key === "allowFrom") {
    const val = el.value.trim();
    if (val) {
      target[key] = val
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      delete target[key];
    }
  } else {
    const val = el.value.trim();
    if (val) {
      target[key] = val;
    } else {
      delete target[key];
    }
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("saveChannelField", () => {
  // ── Text fields ───────────────────────────────────────────────────────
  describe("text fields", () => {
    it("saves a text value", () => {
      addInput("channel-telegram-proxy", "socks5://127.0.0.1:1080");
      const target: Record<string, unknown> = {};
      saveChannelField(target, "telegram", { key: "proxy", type: "text" });
      expect(target.proxy).toBe("socks5://127.0.0.1:1080");
    });

    it("clears a text value when input is empty", () => {
      addInput("channel-telegram-proxy", "");
      const target: Record<string, unknown> = { proxy: "old-value" };
      saveChannelField(target, "telegram", { key: "proxy", type: "text" });
      expect(target).not.toHaveProperty("proxy");
    });

    it("clears a text value when input is whitespace-only", () => {
      addInput("channel-telegram-proxy", "   ");
      const target: Record<string, unknown> = { proxy: "old-value" };
      saveChannelField(target, "telegram", { key: "proxy", type: "text" });
      expect(target).not.toHaveProperty("proxy");
    });
  });

  // ── Password fields (same as text) ────────────────────────────────────
  describe("password fields", () => {
    it("saves a password value", () => {
      addInput("channel-telegram-botToken", "123:ABC");
      const target: Record<string, unknown> = {};
      saveChannelField(target, "telegram", { key: "botToken", type: "password" });
      expect(target.botToken).toBe("123:ABC");
    });

    it("clears a password value when empty", () => {
      addInput("channel-telegram-botToken", "");
      const target: Record<string, unknown> = { botToken: "old" };
      saveChannelField(target, "telegram", { key: "botToken", type: "password" });
      expect(target).not.toHaveProperty("botToken");
    });
  });

  // ── Select fields (use same code path as text) ────────────────────────
  describe("select fields", () => {
    it("saves a select value", () => {
      addInput("channel-discord-groupPolicy", "open");
      const target: Record<string, unknown> = {};
      saveChannelField(target, "discord", { key: "groupPolicy", type: "select" });
      expect(target.groupPolicy).toBe("open");
    });

    it("saves each groupPolicy option correctly", () => {
      for (const val of ["open", "allowlist", "disabled"]) {
        elements.clear();
        addInput("channel-slack-groupPolicy", val);
        const target: Record<string, unknown> = {};
        saveChannelField(target, "slack", { key: "groupPolicy", type: "select" });
        expect(target.groupPolicy).toBe(val);
      }
    });
  });

  // ── Checkbox fields ───────────────────────────────────────────────────
  describe("checkbox fields", () => {
    it("saves checked = true", () => {
      addCheckbox("channel-discord-enabled", true);
      const target: Record<string, unknown> = {};
      saveChannelField(target, "discord", { key: "enabled", type: "checkbox" });
      expect(target.enabled).toBe(true);
    });

    it("saves checked = false", () => {
      addCheckbox("channel-discord-enabled", false);
      const target: Record<string, unknown> = {};
      saveChannelField(target, "discord", { key: "enabled", type: "checkbox" });
      expect(target.enabled).toBe(false);
    });
  });

  // ── Number fields ─────────────────────────────────────────────────────
  describe("number fields", () => {
    it("saves a number value", () => {
      addInput("channel-whatsapp-debounceMs", "1500");
      const target: Record<string, unknown> = {};
      saveChannelField(target, "whatsapp", { key: "debounceMs", type: "number" });
      expect(target.debounceMs).toBe(1500);
    });

    it("clears a number value when input is empty", () => {
      addInput("channel-whatsapp-debounceMs", "");
      const target: Record<string, unknown> = { debounceMs: 1500 };
      saveChannelField(target, "whatsapp", { key: "debounceMs", type: "number" });
      expect(target).not.toHaveProperty("debounceMs");
    });
  });

  // ── allowFrom fields ──────────────────────────────────────────────────
  describe("allowFrom fields", () => {
    it("saves comma-separated allowFrom as array", () => {
      addInput("channel-telegram-allowFrom", "123, @user, *");
      const target: Record<string, unknown> = {};
      saveChannelField(target, "telegram", { key: "allowFrom", type: "text" });
      expect(target.allowFrom).toEqual(["123", "@user", "*"]);
    });

    it("clears allowFrom when input is empty", () => {
      addInput("channel-telegram-allowFrom", "");
      const target: Record<string, unknown> = { allowFrom: ["old"] };
      saveChannelField(target, "telegram", { key: "allowFrom", type: "text" });
      expect(target).not.toHaveProperty("allowFrom");
    });

    it("handles dm.allowFrom with targetKey override", () => {
      addInput("channel-discord-dm-allowFrom", "111, 222");
      const target: Record<string, unknown> = {};
      saveChannelField(target, "discord", { key: "dm.allowFrom", type: "text" }, "allowFrom");
      expect(target.allowFrom).toEqual(["111", "222"]);
    });

    it("clears dm.allowFrom when empty", () => {
      addInput("channel-discord-dm-allowFrom", "");
      const target: Record<string, unknown> = { allowFrom: ["old"] };
      saveChannelField(target, "discord", { key: "dm.allowFrom", type: "text" }, "allowFrom");
      expect(target).not.toHaveProperty("allowFrom");
    });
  });

  // ── Cross-channel field matrix ────────────────────────────────────────
  describe("cross-channel field matrix", () => {
    const channelFields = [
      {
        channel: "telegram",
        key: "proxy",
        type: "text",
        setVal: "socks5://1.2.3.4:1080",
        expected: "socks5://1.2.3.4:1080",
      },
      { channel: "telegram", key: "groupPolicy", type: "select", setVal: "open", expected: "open" },
      {
        channel: "discord",
        key: "groupPolicy",
        type: "select",
        setVal: "disabled",
        expected: "disabled",
      },
      {
        channel: "slack",
        key: "groupPolicy",
        type: "select",
        setVal: "allowlist",
        expected: "allowlist",
      },
      { channel: "whatsapp", key: "groupPolicy", type: "select", setVal: "open", expected: "open" },
      { channel: "whatsapp", key: "debounceMs", type: "number", setVal: "2000", expected: 2000 },
    ] as const;

    for (const { channel, key, type, setVal, expected } of channelFields) {
      it(`${channel}.${key} (${type}) saves correctly`, () => {
        addInput(`channel-${channel}-${key}`, setVal);
        const target: Record<string, unknown> = {};
        saveChannelField(target, channel, { key, type });
        expect(target[key]).toEqual(expected);
      });

      // Only test clearing for non-select, non-checkbox types
      if (type !== "select" && type !== "checkbox") {
        it(`${channel}.${key} (${type}) clears when empty`, () => {
          addInput(`channel-${channel}-${key}`, "");
          const target: Record<string, unknown> = { [key]: "old-value" };
          saveChannelField(target, channel, { key, type });
          expect(target).not.toHaveProperty(key);
        });
      }
    }
  });

  // ── Group/guild sub-fields (written to guilds["*"] or groups["*"]) ───
  describe("group fields (guilds/groups wildcard)", () => {
    it("saves Discord requireMention to guilds['*'] via targetKey", () => {
      addCheckbox("channel-discord-guilds-requireMention", true);
      const target: Record<string, unknown> = {};
      saveChannelField(
        target,
        "discord",
        { key: "guilds.requireMention", type: "checkbox" },
        "requireMention",
      );
      expect(target.requireMention).toBe(true);
    });

    it("saves Telegram requireMention to groups['*'] via targetKey", () => {
      addCheckbox("channel-telegram-groups-requireMention", true);
      const target: Record<string, unknown> = {};
      saveChannelField(
        target,
        "telegram",
        { key: "groups.requireMention", type: "checkbox" },
        "requireMention",
      );
      expect(target.requireMention).toBe(true);
    });

    it("saves WhatsApp requireMention to groups['*'] via targetKey", () => {
      addCheckbox("channel-whatsapp-groups-requireMention", false);
      const target: Record<string, unknown> = {};
      saveChannelField(
        target,
        "whatsapp",
        { key: "groups.requireMention", type: "checkbox" },
        "requireMention",
      );
      expect(target.requireMention).toBe(false);
    });
  });

  // ── Missing element is a no-op ────────────────────────────────────────
  it("does nothing when element is missing", () => {
    const target: Record<string, unknown> = { proxy: "existing" };
    saveChannelField(target, "telegram", { key: "proxy", type: "text" });
    expect(target.proxy).toBe("existing");
  });
});

// ── Schema consistency: every frontend field key must be valid in Zod schema ──

import type { ZodObject, ZodRawShape } from "zod";
import {
  TelegramConfigSchema,
  DiscordConfigSchema,
  SlackConfigSchema,
  DiscordDmSchema,
  DiscordGuildSchema,
  SlackDmSchema,
  TelegramGroupSchema,
} from "../config/zod-schema.providers-core.js";
import { WhatsAppConfigSchema } from "../config/zod-schema.providers-whatsapp.js";

/**
 * Extract the set of top-level keys from a Zod .object().strict() schema.
 * Works with ZodObject, ZodEffects (from .superRefine / .refine), and
 * .extend() results.
 */
function zodKeys(schema: unknown): Set<string> {
  // Unwrap ZodEffects (.superRefine, .refine, .transform)
  let s = schema as { _def?: { schema?: unknown; typeName?: string }; shape?: ZodRawShape };
  while (s?._def?.typeName === "ZodEffects" && s._def.schema) {
    s = s._def.schema as typeof s;
  }
  // ZodObject — has .shape or ._def.shape()
  if (typeof s?.shape === "object") {
    return new Set(Object.keys(s.shape as Record<string, unknown>));
  }
  if (
    typeof (s as { _def?: { shape?: () => Record<string, unknown> } })?._def?.shape === "function"
  ) {
    return new Set(
      Object.keys((s as { _def: { shape: () => Record<string, unknown> } })._def.shape()),
    );
  }
  throw new Error("Cannot extract keys from schema");
}

/**
 * Frontend field definitions — must stay in sync with
 * apps/electron/renderer/channels-config.js CHANNEL_CONFIG_FIELDS.
 *
 * This is the authoritative snapshot the test compares against the Zod schemas.
 * When you add/remove a frontend field, update this list AND the schema.
 */
const FRONTEND_FIELDS: Record<
  string,
  {
    fields: string[];
    dmFields?: string[];
    groupFields?: string[];
    groupKey?: string;
  }
> = {
  telegram: {
    fields: [
      "botToken",
      "enabled",
      "dmPolicy",
      "groupPolicy",
      "allowFrom",
      "historyLimit",
      "textChunkLimit",
      "replyToMode",
      "streamMode",
      "proxy",
      "webhookUrl",
      "webhookSecret",
    ],
    groupFields: ["requireMention"],
    groupKey: "groups",
  },
  whatsapp: {
    fields: [
      "dmPolicy",
      "allowFrom",
      "groupPolicy",
      "selfChatMode",
      "historyLimit",
      "textChunkLimit",
      "debounceMs",
      "sendReadReceipts",
      "blockStreaming",
      "messagePrefix",
      "responsePrefix",
    ],
    groupFields: ["requireMention"],
    groupKey: "groups",
  },
  discord: {
    fields: [
      "token",
      "groupPolicy",
      "allowBots",
      "historyLimit",
      "textChunkLimit",
      "replyToMode",
      "blockStreaming",
      "enabled",
    ],
    dmFields: ["allowFrom", "policy"],
    groupFields: ["requireMention"],
    groupKey: "guilds",
  },
  slack: {
    fields: [
      "botToken",
      "appToken",
      "groupPolicy",
      "requireMention",
      "allowBots",
      "historyLimit",
      "textChunkLimit",
      "replyToMode",
      "blockStreaming",
      "enabled",
    ],
    dmFields: ["allowFrom", "policy", "enabled", "groupEnabled"],
  },
};

const CHANNEL_SCHEMAS: Record<string, unknown> = {
  telegram: TelegramConfigSchema,
  whatsapp: WhatsAppConfigSchema,
  discord: DiscordConfigSchema,
  slack: SlackConfigSchema,
};

const DM_SCHEMAS: Record<string, unknown> = {
  discord: DiscordDmSchema,
  slack: SlackDmSchema,
};

const GROUP_SCHEMAS: Record<string, unknown> = {
  telegram: TelegramGroupSchema,
  discord: DiscordGuildSchema,
  // WhatsApp group schema is inline — extract from WhatsAppConfigSchema
};

describe("frontend fields vs Zod schema consistency", () => {
  for (const [channel, def] of Object.entries(FRONTEND_FIELDS)) {
    describe(channel, () => {
      it("all top-level field keys exist in the channel Zod schema", () => {
        const keys = zodKeys(CHANNEL_SCHEMAS[channel]);
        const missing = def.fields.filter((k) => !keys.has(k));
        expect(missing, `fields not in ${channel} schema: ${missing.join(", ")}`).toEqual([]);
      });

      if (def.dmFields) {
        it("all DM field keys exist in the DM Zod schema", () => {
          const keys = zodKeys(DM_SCHEMAS[channel]);
          const missing = def.dmFields!.filter((k) => !keys.has(k));
          expect(missing, `DM fields not in ${channel} DM schema: ${missing.join(", ")}`).toEqual(
            [],
          );
        });
      }

      if (def.groupFields) {
        it(`all group field keys exist in the ${def.groupKey || "groups"} Zod schema`, () => {
          let schema = GROUP_SCHEMAS[channel];
          if (!schema) {
            // Extract inline group schema from the config schema
            const configKeys = zodKeys(CHANNEL_SCHEMAS[channel]);
            expect(configKeys.has(def.groupKey || "groups")).toBe(true);
            // For WhatsApp, parse a valid value and check the key is accepted
            // Fallback: just verify the field is accepted by the full config schema
            const testObj: Record<string, unknown> = {};
            for (const f of def.fields) testObj[f] = undefined;
            testObj[def.groupKey || "groups"] = {
              "*": Object.fromEntries(def.groupFields!.map((k) => [k, true])),
            };
            const result = (CHANNEL_SCHEMAS[channel] as ZodObject<ZodRawShape>).safeParse(testObj);
            if (!result.success) {
              const groupErrors = result.error.issues.filter(
                (i) => i.path.length >= 2 && String(i.path[0]) === (def.groupKey || "groups"),
              );
              expect(
                groupErrors,
                `group field validation errors: ${JSON.stringify(groupErrors)}`,
              ).toEqual([]);
            }
            return;
          }
          const keys = zodKeys(schema);
          const missing = def.groupFields!.filter((k) => !keys.has(k));
          expect(
            missing,
            `group fields not in ${channel} group schema: ${missing.join(", ")}`,
          ).toEqual([]);
        });
      }
    });
  }
});
