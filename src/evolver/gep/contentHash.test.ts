import { describe, it, expect } from "vitest";
import { canonicalize, computeAssetId, verifyAssetId, SCHEMA_VERSION } from "./contentHash.js";

// ── SCHEMA_VERSION ──────────────────────────────────────────────────────────

describe("SCHEMA_VERSION", () => {
  it("is a semver string", () => {
    expect(typeof SCHEMA_VERSION).toBe("string");
    expect(SCHEMA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

// ── canonicalize ────────────────────────────────────────────────────────────

describe("canonicalize", () => {
  it("canonicalizes null/undefined to 'null'", () => {
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize(undefined)).toBe("null");
  });

  it("canonicalizes booleans", () => {
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize(false)).toBe("false");
  });

  it("canonicalizes numbers", () => {
    expect(canonicalize(42)).toBe("42");
    expect(canonicalize(3.14)).toBe("3.14");
    expect(canonicalize(0)).toBe("0");
  });

  it("canonicalizes non-finite numbers to 'null'", () => {
    expect(canonicalize(NaN)).toBe("null");
    expect(canonicalize(Infinity)).toBe("null");
    expect(canonicalize(-Infinity)).toBe("null");
  });

  it("canonicalizes strings with JSON quoting", () => {
    expect(canonicalize("hello")).toBe('"hello"');
    expect(canonicalize("")).toBe('""');
    expect(canonicalize('a"b')).toBe('"a\\"b"');
  });

  it("canonicalizes arrays recursively", () => {
    expect(canonicalize([1, "a", null])).toBe('[1,"a",null]');
    expect(canonicalize([])).toBe("[]");
  });

  it("canonicalizes objects with sorted keys", () => {
    expect(canonicalize({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(canonicalize({})).toBe("{}");
  });

  it("handles nested structures", () => {
    const obj = { z: [1, { b: "x", a: true }], a: null };
    const result = canonicalize(obj);
    expect(result).toBe('{"a":null,"z":[1,{"a":true,"b":"x"}]}');
  });

  it("is deterministic (key order independent)", () => {
    const a = canonicalize({ x: 1, y: 2, z: 3 });
    const b = canonicalize({ z: 3, x: 1, y: 2 });
    expect(a).toBe(b);
  });
});

// ── computeAssetId ──────────────────────────────────────────────────────────

describe("computeAssetId", () => {
  it("returns null for null/undefined/non-object", () => {
    expect(computeAssetId(null)).toBeNull();
    expect(computeAssetId(undefined)).toBeNull();
    expect(computeAssetId("string" as any)).toBeNull();
  });

  it("returns a sha256-prefixed hash string", () => {
    const id = computeAssetId({ foo: "bar" });
    expect(id).not.toBeNull();
    expect(id!.startsWith("sha256:")).toBe(true);
    expect(id!.length).toBe(7 + 64); // "sha256:" + 64 hex chars
  });

  it("excludes asset_id field by default", () => {
    const a = computeAssetId({ foo: "bar" });
    const b = computeAssetId({ foo: "bar", asset_id: "anything" });
    expect(a).toBe(b);
  });

  it("can exclude custom fields", () => {
    const a = computeAssetId({ foo: "bar", baz: 1 }, ["baz"]);
    const b = computeAssetId({ foo: "bar" });
    expect(a).toBe(b);
  });

  it("is deterministic", () => {
    const obj = { x: 1, y: [2, 3], z: { a: "b" } };
    expect(computeAssetId(obj)).toBe(computeAssetId(obj));
  });

  it("different content produces different hash", () => {
    const a = computeAssetId({ foo: "bar" });
    const b = computeAssetId({ foo: "baz" });
    expect(a).not.toBe(b);
  });
});

// ── verifyAssetId ───────────────────────────────────────────────────────────

describe("verifyAssetId", () => {
  it("returns false for null/undefined/non-object", () => {
    expect(verifyAssetId(null)).toBe(false);
    expect(verifyAssetId(undefined)).toBe(false);
  });

  it("returns false when asset_id is missing", () => {
    expect(verifyAssetId({ foo: "bar" })).toBe(false);
  });

  it("returns false when asset_id is wrong", () => {
    expect(verifyAssetId({ foo: "bar", asset_id: "sha256:0000" })).toBe(false);
  });

  it("returns true when asset_id matches computed hash", () => {
    const obj: Record<string, unknown> = { foo: "bar" };
    obj.asset_id = computeAssetId(obj);
    expect(verifyAssetId(obj)).toBe(true);
  });

  it("detects tampering", () => {
    const obj: Record<string, unknown> = { foo: "bar" };
    obj.asset_id = computeAssetId(obj);
    obj.foo = "tampered";
    expect(verifyAssetId(obj)).toBe(false);
  });
});
