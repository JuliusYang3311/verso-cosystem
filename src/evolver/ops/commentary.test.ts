import { describe, it, expect } from "vitest";
import { getComment, PERSONAS } from "./commentary.js";

// ── PERSONAS constant ───────────────────────────────────────────────────────

describe("PERSONAS", () => {
  it("has standard, greentea, and maddog persona entries", () => {
    expect(PERSONAS).toHaveProperty("standard");
    expect(PERSONAS).toHaveProperty("greentea");
    expect(PERSONAS).toHaveProperty("maddog");
  });

  it("each persona has non-empty success and failure pools", () => {
    for (const [_name, pool] of Object.entries(PERSONAS)) {
      expect(Array.isArray(pool.success), `${_name} success should be array`).toBe(true);
      expect(pool.success.length, `${_name} success pool should be non-empty`).toBeGreaterThan(0);
      expect(Array.isArray(pool.failure), `${_name} failure should be array`).toBe(true);
      expect(pool.failure.length, `${_name} failure pool should be non-empty`).toBeGreaterThan(0);
    }
  });

  it("all pool entries are non-empty strings", () => {
    for (const [_name, pool] of Object.entries(PERSONAS)) {
      for (const s of pool.success) {
        expect(typeof s).toBe("string");
        expect(s.length).toBeGreaterThan(0);
      }
      for (const f of pool.failure) {
        expect(typeof f).toBe("string");
        expect(f.length).toBeGreaterThan(0);
      }
    }
  });
});

// ── getComment ──────────────────────────────────────────────────────────────

describe("getComment", () => {
  it("returns a string", () => {
    const comment = getComment();
    expect(typeof comment).toBe("string");
    expect(comment.length).toBeGreaterThan(0);
  });

  it("defaults to standard persona on success", () => {
    // Run multiple times to increase confidence
    for (let i = 0; i < 10; i++) {
      const comment = getComment();
      expect(PERSONAS.standard.success).toContain(comment);
    }
  });

  it("returns success comment for standard persona when success=true", () => {
    for (let i = 0; i < 10; i++) {
      const comment = getComment({ persona: "standard", success: true });
      expect(PERSONAS.standard.success).toContain(comment);
    }
  });

  it("returns failure comment for standard persona when success=false", () => {
    for (let i = 0; i < 10; i++) {
      const comment = getComment({ persona: "standard", success: false });
      expect(PERSONAS.standard.failure).toContain(comment);
    }
  });

  it("returns greentea success comments", () => {
    for (let i = 0; i < 10; i++) {
      const comment = getComment({ persona: "greentea", success: true });
      expect(PERSONAS.greentea.success).toContain(comment);
    }
  });

  it("returns greentea failure comments", () => {
    for (let i = 0; i < 10; i++) {
      const comment = getComment({ persona: "greentea", success: false });
      expect(PERSONAS.greentea.failure).toContain(comment);
    }
  });

  it("returns maddog success comments", () => {
    for (let i = 0; i < 10; i++) {
      const comment = getComment({ persona: "maddog", success: true });
      expect(PERSONAS.maddog.success).toContain(comment);
    }
  });

  it("returns maddog failure comments", () => {
    for (let i = 0; i < 10; i++) {
      const comment = getComment({ persona: "maddog", success: false });
      expect(PERSONAS.maddog.failure).toContain(comment);
    }
  });

  it("falls back to standard persona for unknown persona name", () => {
    for (let i = 0; i < 10; i++) {
      const comment = getComment({ persona: "unknown_persona", success: true });
      expect(PERSONAS.standard.success).toContain(comment);
    }
  });

  it("treats missing success option as true (default success)", () => {
    for (let i = 0; i < 10; i++) {
      const comment = getComment({ persona: "maddog" });
      expect(PERSONAS.maddog.success).toContain(comment);
    }
  });

  it("returns success when options is undefined", () => {
    for (let i = 0; i < 10; i++) {
      const comment = getComment(undefined);
      expect(PERSONAS.standard.success).toContain(comment);
    }
  });

  it("duration option does not affect output (accepted but unused)", () => {
    const comment = getComment({ persona: "standard", success: true, duration: 5000 });
    expect(typeof comment).toBe("string");
    expect(PERSONAS.standard.success).toContain(comment);
  });
});
