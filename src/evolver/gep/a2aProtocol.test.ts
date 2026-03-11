import { describe, it, expect, vi, afterEach } from "vitest";

// Mock paths and envFingerprint to avoid file I/O
vi.mock("./paths.js", () => ({
  getGepAssetsDir: () => "/tmp/fake-gep",
  getEvolverAssetsDir: () => "/tmp/fake-evolver",
  getWorkspaceRoot: () => "/tmp/fake-workspace",
  getRepoRoot: () => process.cwd(),
}));

vi.mock("./envFingerprint.js", () => ({
  captureEnvFingerprint: () => ({
    node_version: "v20.0.0",
    platform: "linux",
    arch: "x64",
    os_release: "5.0",
    evolver_version: "1.0.0",
    cwd: "/tmp",
    captured_at: new Date().toISOString(),
  }),
}));

import {
  getNodeId,
  isValidProtocolMessage,
  unwrapAssetFromMessage,
  buildHello,
  buildPublish,
  buildFetch,
  buildReport,
  buildDecision,
  buildRevoke,
  buildMessage,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
} from "./a2aProtocol.js";

describe("getNodeId", () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("uses A2A_NODE_ID env var when set", () => {
    process.env.A2A_NODE_ID = "my-node";
    expect(getNodeId()).toBe("my-node");
  });

  it("generates node_ prefixed hash when no env var", () => {
    delete process.env.A2A_NODE_ID;
    const id = getNodeId();
    expect(id).toMatch(/^node_[0-9a-f]{12}$/);
  });

  it("is deterministic for same cwd and AGENT_NAME", () => {
    delete process.env.A2A_NODE_ID;
    const id1 = getNodeId();
    const id2 = getNodeId();
    expect(id1).toBe(id2);
  });
});

describe("isValidProtocolMessage", () => {
  it("returns false for null/non-object", () => {
    expect(isValidProtocolMessage(null)).toBe(false);
    expect(isValidProtocolMessage("string")).toBe(false);
    expect(isValidProtocolMessage(42)).toBe(false);
  });

  it("returns false when protocol is wrong", () => {
    expect(
      isValidProtocolMessage({
        protocol: "wrong",
        message_type: "hello",
        message_id: "m1",
        timestamp: new Date().toISOString(),
      }),
    ).toBe(false);
  });

  it("returns false for invalid message_type", () => {
    expect(
      isValidProtocolMessage({
        protocol: PROTOCOL_NAME,
        message_type: "invalid",
        message_id: "m1",
        timestamp: new Date().toISOString(),
      }),
    ).toBe(false);
  });

  it("returns false when message_id is missing", () => {
    expect(
      isValidProtocolMessage({
        protocol: PROTOCOL_NAME,
        message_type: "hello",
        timestamp: new Date().toISOString(),
      }),
    ).toBe(false);
  });

  it("returns true for valid message", () => {
    const msg = buildHello();
    expect(isValidProtocolMessage(msg)).toBe(true);
  });
});

describe("unwrapAssetFromMessage", () => {
  it("returns null for null/non-object", () => {
    expect(unwrapAssetFromMessage(null)).toBeNull();
    expect(unwrapAssetFromMessage("string")).toBeNull();
  });

  it("extracts asset from publish message", () => {
    const msg = buildPublish({ asset: { type: "Gene", id: "g1" } });
    const asset = unwrapAssetFromMessage(msg);
    expect(asset).not.toBeNull();
    expect(asset!.type).toBe("Gene");
    expect(asset!.id).toBe("g1");
  });

  it("returns null for non-publish protocol message", () => {
    const msg = buildHello();
    expect(unwrapAssetFromMessage(msg)).toBeNull();
  });

  it("returns plain Gene/Capsule/EvolutionEvent as-is", () => {
    const gene = { type: "Gene", id: "g1" };
    expect(unwrapAssetFromMessage(gene)).toBe(gene);

    const capsule = { type: "Capsule", id: "c1" };
    expect(unwrapAssetFromMessage(capsule)).toBe(capsule);

    const ev = { type: "EvolutionEvent", id: "e1" };
    expect(unwrapAssetFromMessage(ev)).toBe(ev);
  });

  it("returns null for unknown object types", () => {
    expect(unwrapAssetFromMessage({ type: "Other" })).toBeNull();
    expect(unwrapAssetFromMessage({ foo: "bar" })).toBeNull();
  });
});

describe("buildHello", () => {
  it("creates a valid hello message", () => {
    const msg = buildHello({ geneCount: 5, capsuleCount: 3 });
    expect(msg.protocol).toBe(PROTOCOL_NAME);
    expect(msg.protocol_version).toBe(PROTOCOL_VERSION);
    expect(msg.message_type).toBe("hello");
    expect(msg.message_id).toMatch(/^msg_/);
    expect(msg.payload.gene_count).toBe(5);
    expect(msg.payload.capsule_count).toBe(3);
  });
});

describe("buildPublish", () => {
  it("creates a valid publish message", () => {
    const msg = buildPublish({ asset: { type: "Gene", id: "g1" } });
    expect(msg.message_type).toBe("publish");
    expect(msg.payload.asset_type).toBe("Gene");
    expect(msg.payload.local_id).toBe("g1");
    expect(msg.payload.asset).toBeTruthy();
  });

  it("throws when asset has no type or id", () => {
    expect(() => buildPublish({ asset: { type: "", id: "g1" } })).toThrow();
    expect(() => buildPublish({ asset: { type: "Gene", id: "" } })).toThrow();
  });
});

describe("buildFetch", () => {
  it("creates a valid fetch message", () => {
    const msg = buildFetch({ assetType: "Capsule", localId: "c1" });
    expect(msg.message_type).toBe("fetch");
    expect(msg.payload.asset_type).toBe("Capsule");
    expect(msg.payload.local_id).toBe("c1");
  });

  it("works with no arguments", () => {
    const msg = buildFetch();
    expect(msg.message_type).toBe("fetch");
  });
});

describe("buildReport", () => {
  it("creates a valid report message", () => {
    const msg = buildReport({ assetId: "sha256:abc", validationReport: { ok: true } });
    expect(msg.message_type).toBe("report");
    expect(msg.payload.target_asset_id).toBe("sha256:abc");
    expect(msg.payload.validation_report).toEqual({ ok: true });
  });
});

describe("buildDecision", () => {
  it("creates accept/reject/quarantine messages", () => {
    for (const decision of ["accept", "reject", "quarantine"] as const) {
      const msg = buildDecision({ decision, assetId: "sha256:abc", reason: "test" });
      expect(msg.message_type).toBe("decision");
      expect(msg.payload.decision).toBe(decision);
    }
  });

  it("throws for invalid decision", () => {
    expect(() => buildDecision({ decision: "invalid" as any })).toThrow();
  });
});

describe("buildRevoke", () => {
  it("creates a valid revoke message", () => {
    const msg = buildRevoke({ assetId: "sha256:abc", reason: "deprecated" });
    expect(msg.message_type).toBe("revoke");
    expect(msg.payload.target_asset_id).toBe("sha256:abc");
    expect(msg.payload.reason).toBe("deprecated");
  });
});

describe("buildMessage", () => {
  it("throws for invalid message type", () => {
    expect(() => buildMessage({ messageType: "invalid" })).toThrow("Invalid message type");
  });
});
