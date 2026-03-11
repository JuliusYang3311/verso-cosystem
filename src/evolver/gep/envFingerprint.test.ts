import { describe, it, expect, vi } from "vitest";

// Mock paths.js to avoid reading real workspace config
vi.mock("./paths.js", () => ({
  getRepoRoot: () => process.cwd(),
}));

import {
  captureEnvFingerprint,
  envFingerprintKey,
  isSameEnvClass,
  type EnvFingerprint,
} from "./envFingerprint.js";

describe("captureEnvFingerprint", () => {
  it("returns an object with expected fields", () => {
    const fp = captureEnvFingerprint();
    expect(fp).toHaveProperty("node_version");
    expect(fp).toHaveProperty("platform");
    expect(fp).toHaveProperty("arch");
    expect(fp).toHaveProperty("os_release");
    expect(fp).toHaveProperty("cwd");
    expect(fp).toHaveProperty("captured_at");
    expect(fp.node_version).toBe(process.version);
    expect(fp.platform).toBe(process.platform);
    expect(fp.arch).toBe(process.arch);
  });

  it("captured_at is a valid ISO string", () => {
    const fp = captureEnvFingerprint();
    expect(Date.parse(fp.captured_at)).not.toBeNaN();
  });

  it("evolver_version is a string or null", () => {
    const fp = captureEnvFingerprint();
    expect(fp.evolver_version === null || typeof fp.evolver_version === "string").toBe(true);
  });
});

describe("envFingerprintKey", () => {
  it("returns 'unknown' for null/undefined", () => {
    expect(envFingerprintKey(null)).toBe("unknown");
    expect(envFingerprintKey(undefined)).toBe("unknown");
  });

  it("returns a 16-char hex string for valid fingerprint", () => {
    const fp = captureEnvFingerprint();
    const key = envFingerprintKey(fp);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });

  it("same fingerprint produces same key", () => {
    const fp = captureEnvFingerprint();
    const key1 = envFingerprintKey(fp);
    const key2 = envFingerprintKey(fp);
    expect(key1).toBe(key2);
  });

  it("different platform produces different key", () => {
    const fp1: EnvFingerprint = {
      node_version: "v20.0.0",
      platform: "linux",
      arch: "x64",
      os_release: "5.0",
      evolver_version: "1.0.0",
      cwd: "/tmp",
      captured_at: new Date().toISOString(),
    };
    const fp2: EnvFingerprint = {
      ...fp1,
      platform: "darwin",
    };
    expect(envFingerprintKey(fp1)).not.toBe(envFingerprintKey(fp2));
  });
});

describe("isSameEnvClass", () => {
  it("returns true for identical fingerprints", () => {
    const fp = captureEnvFingerprint();
    expect(isSameEnvClass(fp, fp)).toBe(true);
  });

  it("returns true for fingerprints differing only in non-key fields", () => {
    const fp1: EnvFingerprint = {
      node_version: "v20.0.0",
      platform: "linux",
      arch: "x64",
      os_release: "5.0",
      evolver_version: "1.0.0",
      cwd: "/tmp/a",
      captured_at: "2024-01-01T00:00:00.000Z",
    };
    const fp2: EnvFingerprint = {
      ...fp1,
      cwd: "/tmp/b",
      captured_at: "2025-01-01T00:00:00.000Z",
      os_release: "6.0",
    };
    // cwd, captured_at, os_release are not in the key
    expect(isSameEnvClass(fp1, fp2)).toBe(true);
  });

  it("returns false for different arch", () => {
    const fp1: EnvFingerprint = {
      node_version: "v20.0.0",
      platform: "linux",
      arch: "x64",
      os_release: "5.0",
      evolver_version: "1.0.0",
      cwd: "/tmp",
      captured_at: new Date().toISOString(),
    };
    const fp2: EnvFingerprint = { ...fp1, arch: "arm64" };
    expect(isSameEnvClass(fp1, fp2)).toBe(false);
  });

  it("returns true when both are null", () => {
    expect(isSameEnvClass(null, null)).toBe(true);
  });
});
