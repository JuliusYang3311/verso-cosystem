import fs from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveConfigPath, resolveConfigSnapshotHash } from "../config/config.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let server: Awaited<ReturnType<typeof startServerWithClient>>["server"];
let ws: Awaited<ReturnType<typeof startServerWithClient>>["ws"];

beforeAll(async () => {
  const started = await startServerWithClient();
  server = started.server;
  ws = started.ws;
  await connectOk(ws);
});

afterAll(async () => {
  ws.close();
  await server.close();
});

/** Helper: get current config hash (undefined if no config file yet). */
async function getCurrentHash(): Promise<string | undefined> {
  try {
    const getRes = await rpcReq<{ hash?: string; raw?: string }>(ws, "config.get", {});
    if (!getRes.ok) return undefined;
    return resolveConfigSnapshotHash({
      hash: getRes.payload?.hash,
      raw: getRes.payload?.raw,
    });
  } catch {
    return undefined;
  }
}

/** Helper: set full config (with base hash if config already exists), then return new hash. */
async function setConfigAndGetHash(config: Record<string, unknown>) {
  const baseHash = await getCurrentHash();
  const setRes = await rpcReq(ws, "config.set", {
    raw: JSON.stringify(config),
    ...(baseHash ? { baseHash } : {}),
  });
  expect(setRes.ok).toBe(true);

  const getRes = await rpcReq<{ hash?: string; raw?: string }>(ws, "config.get", {});
  expect(getRes.ok).toBe(true);
  const hash = resolveConfigSnapshotHash({
    hash: getRes.payload?.hash,
    raw: getRes.payload?.raw,
  });
  return { hash, raw: getRes.payload?.raw };
}

async function readStoredConfig(): Promise<Record<string, unknown>> {
  const configPath = resolveConfigPath();
  return JSON.parse(await fs.readFile(configPath, "utf-8"));
}

describe("channel config fields persist via config.set", () => {
  it("persists discord groupPolicy and guilds wildcard", async () => {
    await setConfigAndGetHash({
      channels: {
        discord: {
          token: "test-token",
          groupPolicy: "open",
          guilds: { "*": { requireMention: true } },
        },
      },
    });

    const stored = (await readStoredConfig()) as {
      channels?: {
        discord?: {
          token?: string;
          groupPolicy?: string;
          guilds?: Record<string, { requireMention?: boolean }>;
        };
      };
    };
    expect(stored.channels?.discord?.groupPolicy).toBe("open");
    expect(stored.channels?.discord?.guilds?.["*"]?.requireMention).toBe(true);
    expect(stored.channels?.discord?.token).toBe("test-token");
  });

  it("persists slack groupPolicy", async () => {
    await setConfigAndGetHash({
      channels: {
        slack: {
          botToken: "xoxb-test",
          appToken: "xapp-test",
          groupPolicy: "open",
        },
      },
    });

    const stored = (await readStoredConfig()) as {
      channels?: { slack?: { groupPolicy?: string; botToken?: string } };
    };
    expect(stored.channels?.slack?.groupPolicy).toBe("open");
    expect(stored.channels?.slack?.botToken).toBe("xoxb-test");
  });

  it("persists whatsapp groupPolicy", async () => {
    await setConfigAndGetHash({
      channels: {
        whatsapp: {
          groupPolicy: "disabled",
          selfChatMode: true,
          debounceMs: 1500,
        },
      },
    });

    const stored = (await readStoredConfig()) as {
      channels?: {
        whatsapp?: { groupPolicy?: string; selfChatMode?: boolean; debounceMs?: number };
      };
    };
    expect(stored.channels?.whatsapp?.groupPolicy).toBe("disabled");
    expect(stored.channels?.whatsapp?.selfChatMode).toBe(true);
    expect(stored.channels?.whatsapp?.debounceMs).toBe(1500);
  });

  it("persists telegram proxy and groupPolicy", async () => {
    await setConfigAndGetHash({
      channels: {
        telegram: {
          botToken: "123:ABC",
          proxy: "socks5://127.0.0.1:1080",
          groupPolicy: "open",
        },
      },
    });

    const stored = (await readStoredConfig()) as {
      channels?: {
        telegram?: { proxy?: string; groupPolicy?: string; botToken?: string };
      };
    };
    expect(stored.channels?.telegram?.proxy).toBe("socks5://127.0.0.1:1080");
    expect(stored.channels?.telegram?.groupPolicy).toBe("open");
    expect(stored.channels?.telegram?.botToken).toBe("123:ABC");
  });

  it("clearing a field via config.set removes it from stored config", async () => {
    // First set proxy
    await setConfigAndGetHash({
      channels: {
        telegram: {
          botToken: "123:ABC",
          proxy: "socks5://127.0.0.1:1080",
        },
      },
    });

    let stored = (await readStoredConfig()) as {
      channels?: { telegram?: { proxy?: string; botToken?: string } };
    };
    expect(stored.channels?.telegram?.proxy).toBe("socks5://127.0.0.1:1080");

    // Now set config without proxy — it should be removed
    await setConfigAndGetHash({
      channels: {
        telegram: {
          botToken: "123:ABC",
        },
      },
    });

    stored = (await readStoredConfig()) as {
      channels?: { telegram?: { proxy?: string; botToken?: string } };
    };
    expect(stored.channels?.telegram?.proxy).toBeUndefined();
    expect(stored.channels?.telegram?.botToken).toBe("123:ABC");
  });

  it("config.patch preserves existing channel fields while adding new ones", async () => {
    // Set initial config
    const { hash } = await setConfigAndGetHash({
      channels: {
        telegram: {
          botToken: "123:ABC",
          groupPolicy: "open",
        },
      },
    });

    // Patch to add proxy without clobbering groupPolicy
    const patchRes = await rpcReq(ws, "config.patch", {
      raw: JSON.stringify({
        channels: {
          telegram: {
            proxy: "socks5://127.0.0.1:1080",
          },
        },
      }),
      baseHash: hash,
    });
    expect(patchRes.ok).toBe(true);

    const stored = (await readStoredConfig()) as {
      channels?: {
        telegram?: { proxy?: string; groupPolicy?: string; botToken?: string };
      };
    };
    expect(stored.channels?.telegram?.proxy).toBe("socks5://127.0.0.1:1080");
    expect(stored.channels?.telegram?.groupPolicy).toBe("open");
    expect(stored.channels?.telegram?.botToken).toBe("123:ABC");
  });

  it("persists discord dm sub-fields via config.patch", async () => {
    const { hash } = await setConfigAndGetHash({
      channels: {
        discord: {
          token: "test-token",
        },
      },
    });

    const patchRes = await rpcReq(ws, "config.patch", {
      raw: JSON.stringify({
        channels: {
          discord: {
            dm: {
              policy: "allowlist",
              allowFrom: ["123456789", "987654321"],
            },
          },
        },
      }),
      baseHash: hash,
    });
    expect(patchRes.ok).toBe(true);

    const stored = (await readStoredConfig()) as {
      channels?: {
        discord?: {
          token?: string;
          dm?: { policy?: string; allowFrom?: Array<string | number> };
        };
      };
    };
    expect(stored.channels?.discord?.token).toBe("test-token");
    expect(stored.channels?.discord?.dm?.policy).toBe("allowlist");
    expect(stored.channels?.discord?.dm?.allowFrom).toEqual(["123456789", "987654321"]);
  });

  it("persists all four channel configs simultaneously", async () => {
    await setConfigAndGetHash({
      channels: {
        telegram: { botToken: "tg-tok", groupPolicy: "open", proxy: "http://proxy:8080" },
        whatsapp: { groupPolicy: "allowlist", debounceMs: 2000 },
        discord: { token: "dc-tok", groupPolicy: "disabled" },
        slack: { botToken: "xoxb-1", appToken: "xapp-1", groupPolicy: "open" },
      },
    });

    const stored = (await readStoredConfig()) as {
      channels?: {
        telegram?: { groupPolicy?: string; proxy?: string };
        whatsapp?: { groupPolicy?: string; debounceMs?: number };
        discord?: { groupPolicy?: string };
        slack?: { groupPolicy?: string };
      };
    };
    expect(stored.channels?.telegram?.groupPolicy).toBe("open");
    expect(stored.channels?.telegram?.proxy).toBe("http://proxy:8080");
    expect(stored.channels?.whatsapp?.groupPolicy).toBe("allowlist");
    expect(stored.channels?.whatsapp?.debounceMs).toBe(2000);
    expect(stored.channels?.discord?.groupPolicy).toBe("disabled");
    expect(stored.channels?.slack?.groupPolicy).toBe("open");
  });
});
