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

  // ── Missing element is a no-op ────────────────────────────────────────
  it("does nothing when element is missing", () => {
    const target: Record<string, unknown> = { proxy: "existing" };
    saveChannelField(target, "telegram", { key: "proxy", type: "text" });
    expect(target.proxy).toBe("existing");
  });
});
