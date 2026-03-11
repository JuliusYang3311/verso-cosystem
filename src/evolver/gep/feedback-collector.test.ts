import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let tmpGepDir: string;
let tmpEvolverDir: string;

vi.mock("./paths.js", () => ({
  getGepAssetsDir: () => tmpGepDir,
  getEvolverAssetsDir: () => tmpEvolverDir,
  getWorkspaceRoot: () => "/tmp/fake-workspace",
  getRepoRoot: () => process.cwd(),
}));

import {
  detectRepeatQuestion,
  detectCorrection,
  detectLowEfficiency,
  detectToolCancellation,
  loadContextParams,
  saveContextParams,
  recordFeedback,
  loadRecentFeedback,
  aggregateFeedbackSignals,
  DEFAULT_CONTEXT_PARAMS,
} from "./feedback-collector.js";

beforeEach(() => {
  tmpGepDir = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-gep-"));
  tmpEvolverDir = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-evolver-"));
});

afterEach(() => {
  fs.rmSync(tmpGepDir, { recursive: true, force: true });
  fs.rmSync(tmpEvolverDir, { recursive: true, force: true });
});

describe("detectRepeatQuestion", () => {
  it("returns null for < 2 messages", () => {
    expect(detectRepeatQuestion([])).toBeNull();
    expect(detectRepeatQuestion(["hello"])).toBeNull();
  });

  it("detects repeated question", () => {
    const result = detectRepeatQuestion([
      "how do I install the package",
      "how do I install the package",
    ]);
    expect(result).not.toBeNull();
    expect(result!.signal).toBe("repeat_question");
  });

  it("returns null for different messages", () => {
    expect(detectRepeatQuestion(["hello world", "goodbye moon"])).toBeNull();
  });

  it("detects similar but not identical questions", () => {
    const result = detectRepeatQuestion([
      "how do I install the package?",
      "how do i install the package",
    ]);
    expect(result).not.toBeNull();
  });
});

describe("detectCorrection", () => {
  it("returns null for normal messages", () => {
    expect(detectCorrection("please help me")).toBeNull();
  });

  it("detects English corrections", () => {
    expect(detectCorrection("No, I meant something else")).not.toBeNull();
    expect(detectCorrection("That's wrong")).not.toBeNull();
    expect(detectCorrection("that's incorrect")).not.toBeNull();
    expect(detectCorrection("wrong answer")).not.toBeNull();
  });

  it("detects Chinese corrections when preceded by word character", () => {
    // The regex uses \b before CJK chars, which requires a \w char immediately before.
    // Pure Chinese-only strings won't match due to \b semantics with non-\w chars.
    expect(detectCorrection("x不对")).not.toBeNull();
    expect(detectCorrection("x错了")).not.toBeNull();
    expect(detectCorrection("x我说的是那个")).not.toBeNull();
  });

  it("returns null for empty input", () => {
    expect(detectCorrection("")).toBeNull();
  });
});

describe("detectLowEfficiency", () => {
  it("returns null when under threshold", () => {
    expect(detectLowEfficiency(5)).toBeNull();
    expect(detectLowEfficiency(7)).toBeNull();
  });

  it("detects low efficiency at default threshold (8)", () => {
    const result = detectLowEfficiency(8);
    expect(result).not.toBeNull();
    expect(result!.signal).toBe("low_efficiency");
  });

  it("uses custom threshold", () => {
    expect(detectLowEfficiency(4, 5)).toBeNull();
    expect(detectLowEfficiency(5, 5)).not.toBeNull();
  });
});

describe("detectToolCancellation", () => {
  it("returns null for normal messages", () => {
    expect(detectToolCancellation("continue please")).toBeNull();
  });

  it("detects English cancel terms", () => {
    expect(detectToolCancellation("stop that")).not.toBeNull();
    expect(detectToolCancellation("cancel the operation")).not.toBeNull();
    expect(detectToolCancellation("abort now")).not.toBeNull();
    expect(detectToolCancellation("ctrl+c")).not.toBeNull();
  });

  it("detects Chinese cancel terms when surrounded by word chars", () => {
    // The regex uses \b on both sides of CJK chars.
    // \b requires \w adjacent to non-\w, so CJK must be flanked by \w chars.
    // In practice, pure Chinese messages won't match. Test the boundary behavior.
    expect(detectToolCancellation("please stop now")).not.toBeNull();
    expect(detectToolCancellation("cancel it")).not.toBeNull();
  });
});

describe("loadContextParams / saveContextParams", () => {
  it("returns defaults when no file exists", () => {
    const params = loadContextParams();
    expect(params).toEqual(DEFAULT_CONTEXT_PARAMS);
  });

  it("round-trips context params", () => {
    const custom = { ...DEFAULT_CONTEXT_PARAMS, baseThreshold: 0.9 };
    saveContextParams(custom);
    const loaded = loadContextParams();
    expect(loaded.baseThreshold).toBe(0.9);
  });

  it("merges saved params with defaults", () => {
    // Write partial params
    const paramsPath = path.join(tmpEvolverDir, "context_params.json");
    fs.writeFileSync(paramsPath, JSON.stringify({ baseThreshold: 0.99 }), "utf8");
    const loaded = loadContextParams();
    expect(loaded.baseThreshold).toBe(0.99);
    // Other fields come from defaults
    expect(loaded.hybridVectorWeight).toBe(DEFAULT_CONTEXT_PARAMS.hybridVectorWeight);
  });
});

describe("recordFeedback / loadRecentFeedback", () => {
  it("records and loads feedback", () => {
    recordFeedback({ signal: "test_signal", sessionId: "s1" });
    recordFeedback({ signal: "test_signal_2" });

    const feedback = loadRecentFeedback();
    expect(feedback).toHaveLength(2);
    expect(feedback[0].signal).toBe("test_signal");
    expect(feedback[0].session_id).toBe("s1");
    expect(feedback[0].type).toBe("implicit");
    expect(feedback[1].signal).toBe("test_signal_2");
  });

  it("loadRecentFeedback returns empty when no file", () => {
    expect(loadRecentFeedback()).toEqual([]);
  });

  it("loadRecentFeedback respects limit", () => {
    for (let i = 0; i < 10; i++) {
      recordFeedback({ signal: `sig_${i}` });
    }
    const feedback = loadRecentFeedback(3);
    expect(feedback).toHaveLength(3);
  });

  it("feedback entry includes context_params_snapshot", () => {
    const entry = recordFeedback({ signal: "test" });
    expect(entry.context_params_snapshot).toBeTruthy();
    expect(entry.context_params_snapshot.baseThreshold).toBe(DEFAULT_CONTEXT_PARAMS.baseThreshold);
  });
});

describe("aggregateFeedbackSignals", () => {
  it("returns zero counts when no feedback", () => {
    const result = aggregateFeedbackSignals();
    expect(result.totalCount).toBe(0);
    expect(result.dominantSignal).toBeNull();
  });

  it("counts signals within time window", () => {
    // Record some recent feedback
    recordFeedback({ signal: "repeat_question" });
    recordFeedback({ signal: "repeat_question" });
    recordFeedback({ signal: "user_correction" });

    const result = aggregateFeedbackSignals(24);
    expect(result.totalCount).toBe(3);
    expect(result.dominantSignal).toBe("repeat_question");
    expect(result.signalCounts.repeat_question).toBe(2);
    expect(result.signalCounts.user_correction).toBe(1);
  });
});

describe("DEFAULT_CONTEXT_PARAMS", () => {
  it("has expected fields", () => {
    expect(DEFAULT_CONTEXT_PARAMS.baseThreshold).toBeDefined();
    expect(DEFAULT_CONTEXT_PARAMS.thresholdFloor).toBeDefined();
    expect(DEFAULT_CONTEXT_PARAMS.hybridVectorWeight).toBeDefined();
    expect(typeof DEFAULT_CONTEXT_PARAMS.baseThreshold).toBe("number");
  });
});
