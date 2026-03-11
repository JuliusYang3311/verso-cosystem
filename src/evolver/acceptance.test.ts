import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------- Mocks ----------

const mockExecSync = vi.fn();
vi.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { runEvolverAcceptance } = await import("./acceptance.js");

// ---------- Helpers ----------

function makeMockSession(overrides: { promptResults?: string[] } = {}) {
  const promptResults = overrides.promptResults ?? [
    '{"verifyCmd":"echo ok"}',
    '{"passed":true,"confidence":90,"reasoning":"looks good"}',
  ];
  let callCount = 0;

  const session = {
    prompt: vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve(undefined);
    }),
    getLastAssistantText: vi.fn().mockImplementation(() => {
      return promptResults[callCount - 1] ?? "";
    }),
    abort: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  };
  return session;
}

// ---------- Tests ----------

describe("acceptance", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "accept-"));
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", scripts: { lint: "echo lint", build: "echo build" } }),
    );
    mockExecSync.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("Phase 1: LLM proposes verifyCmd", () => {
    it("extracts verifyCmd from LLM JSON response", async () => {
      const session = makeMockSession({
        promptResults: [
          '{"verifyCmd":"pnpm lint && pnpm build"}',
          '{"passed":true,"confidence":95,"reasoning":"all good"}',
        ],
      });
      mockExecSync.mockReturnValue("OK");

      const result = await runEvolverAcceptance({
        workspaceDir: tmpDir,
        filesChanged: ["src/a.ts"],
        session: session as any,
      });

      expect(result.verifyCmd).toBe("pnpm lint && pnpm build");
      expect(session.prompt).toHaveBeenCalledTimes(2);
    });

    it("returns failure when LLM provides no verifyCmd", async () => {
      const session = makeMockSession({
        promptResults: ['{"reasoning":"I dunno"}', ""],
      });

      const result = await runEvolverAcceptance({
        workspaceDir: tmpDir,
        filesChanged: ["src/a.ts"],
        session: session as any,
      });

      expect(result.passed).toBe(false);
      expect(result.reasoning).toContain("failed to propose a verifyCmd");
      // Session NOT disposed (owned by runner)
      expect(session.dispose).not.toHaveBeenCalled();
    });
  });

  describe("Phase 2: Mechanical verify", () => {
    it("passes when execSync succeeds", async () => {
      const session = makeMockSession({
        promptResults: [
          '{"verifyCmd":"echo ok"}',
          '{"passed":true,"confidence":90,"reasoning":"good"}',
        ],
      });
      mockExecSync.mockReturnValue("all pass");

      const result = await runEvolverAcceptance({
        workspaceDir: tmpDir,
        filesChanged: ["x.ts"],
        session: session as any,
      });

      expect(result.passed).toBe(true);
      expect(result.verifyPassed).toBe(true);
    });

    it("continues to phase 3 when execSync fails", async () => {
      const session = makeMockSession({
        promptResults: [
          '{"verifyCmd":"pnpm lint"}',
          '{"passed":false,"confidence":85,"reasoning":"lint errors found"}',
        ],
      });
      mockExecSync.mockImplementation(() => {
        const err: any = new Error("lint failed");
        err.stdout = "some output";
        err.stderr = "Error: no-unused-vars";
        throw err;
      });

      const result = await runEvolverAcceptance({
        workspaceDir: tmpDir,
        filesChanged: ["x.ts"],
        session: session as any,
      });

      expect(result.passed).toBe(false);
      expect(result.verifyPassed).toBe(false);
      expect(session.prompt).toHaveBeenCalledTimes(2);
    });
  });

  describe("Phase 3: LLM evaluation verdict", () => {
    it("returns pass verdict from LLM", async () => {
      const session = makeMockSession({
        promptResults: [
          '{"verifyCmd":"echo ok"}',
          '{"passed":true,"confidence":92,"reasoning":"changes look great","issues":[]}',
        ],
      });
      mockExecSync.mockReturnValue("ok");

      const result = await runEvolverAcceptance({
        workspaceDir: tmpDir,
        filesChanged: ["a.ts"],
        session: session as any,
      });

      expect(result.passed).toBe(true);
      expect(result.confidence).toBe(92);
      expect(result.reasoning).toBe("changes look great");
    });

    it("returns fail verdict from LLM", async () => {
      const session = makeMockSession({
        promptResults: [
          '{"verifyCmd":"echo ok"}',
          '{"passed":false,"confidence":80,"reasoning":"critical bug found","issues":[{"severity":"critical","confidence":90,"description":"null pointer"}]}',
        ],
      });
      mockExecSync.mockReturnValue("ok");

      const result = await runEvolverAcceptance({
        workspaceDir: tmpDir,
        filesChanged: ["a.ts"],
        session: session as any,
      });

      expect(result.passed).toBe(false);
      expect(result.confidence).toBe(80);
      expect(result.issues).toHaveLength(1);
      expect(result.issues![0].severity).toBe("critical");
    });

    it("uses heuristic fallback when JSON parsing fails", async () => {
      const session = makeMockSession({
        promptResults: [
          '{"verifyCmd":"echo ok"}',
          "I think the changes are fine, but I cannot format JSON properly...",
        ],
      });
      mockExecSync.mockReturnValue("ok");

      const result = await runEvolverAcceptance({
        workspaceDir: tmpDir,
        filesChanged: ["a.ts"],
        session: session as any,
      });

      expect(result.passed).toBe(false);
      expect(result.confidence).toBe(40);
    });

    it("heuristic detects passed=true in malformed text", async () => {
      const session = makeMockSession({
        promptResults: [
          '{"verifyCmd":"echo ok"}',
          'Based on my review, "passed" should be true. The changes are correct.',
        ],
      });
      mockExecSync.mockReturnValue("ok");

      const result = await runEvolverAcceptance({
        workspaceDir: tmpDir,
        filesChanged: ["a.ts"],
        session: session as any,
      });

      expect(result.passed).toBe(true);
      expect(result.confidence).toBe(40);
    });

    it("returns failure when phase 3 text is empty", async () => {
      const session = makeMockSession({
        promptResults: ['{"verifyCmd":"echo ok"}', ""],
      });
      mockExecSync.mockReturnValue("ok");

      const result = await runEvolverAcceptance({
        workspaceDir: tmpDir,
        filesChanged: ["a.ts"],
        session: session as any,
      });

      expect(result.passed).toBe(false);
      expect(result.reasoning).toContain("returned no result");
    });
  });

  describe("corrected verifyCmd", () => {
    it("re-runs verify with suggested command and accepts on success", async () => {
      const session = makeMockSession({
        promptResults: [
          '{"verifyCmd":"pnpm lint"}',
          '{"passed":true,"confidence":85,"reasoning":"wrong cmd","suggestedVerifyCmd":"npm run lint"}',
        ],
      });

      let callIdx = 0;
      mockExecSync.mockImplementation(() => {
        callIdx++;
        if (callIdx === 1) {
          const err: any = new Error("fail");
          err.stdout = "";
          err.stderr = "pnpm not found";
          throw err;
        }
        return "ok";
      });

      const result = await runEvolverAcceptance({
        workspaceDir: tmpDir,
        filesChanged: ["a.ts"],
        session: session as any,
      });

      expect(result.passed).toBe(true);
      expect(result.verifyCmd).toBe("npm run lint");
      expect(result.verifyPassed).toBe(true);
    });

    it("rejects when corrected command also fails", async () => {
      const session = makeMockSession({
        promptResults: [
          '{"verifyCmd":"pnpm lint"}',
          '{"passed":true,"confidence":70,"reasoning":"wrong cmd","suggestedVerifyCmd":"npm run lint"}',
        ],
      });

      mockExecSync.mockImplementation(() => {
        const err: any = new Error("fail");
        err.stdout = "";
        err.stderr = "command not found";
        throw err;
      });

      const result = await runEvolverAcceptance({
        workspaceDir: tmpDir,
        filesChanged: ["a.ts"],
        session: session as any,
      });

      expect(result.passed).toBe(false);
      expect(result.confidence).toBe(90);
      expect(result.verifyCmd).toBe("npm run lint");
      expect(result.verifyPassed).toBe(false);
    });
  });

  describe("end-to-end flows", () => {
    it("full acceptance pass", async () => {
      const session = makeMockSession({
        promptResults: [
          '{"verifyCmd":"pnpm lint && pnpm build"}',
          '{"passed":true,"confidence":95,"reasoning":"all checks pass, changes are minimal and correct"}',
        ],
      });
      mockExecSync.mockReturnValue("ok");

      fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "src/foo.ts"), "export const x = 1;\n");

      const result = await runEvolverAcceptance({
        workspaceDir: tmpDir,
        filesChanged: ["src/foo.ts"],
        session: session as any,
        gepPrompt: "Add a constant x to foo.ts",
      });

      expect(result.passed).toBe(true);
      expect(result.confidence).toBe(95);
      expect(result.verifyCmd).toBe("pnpm lint && pnpm build");
      expect(result.verifyPassed).toBe(true);
    });

    it("full acceptance fail", async () => {
      const session = makeMockSession({
        promptResults: [
          '{"verifyCmd":"pnpm lint"}',
          '{"passed":false,"confidence":88,"reasoning":"critical security issue found","issues":[{"severity":"critical","confidence":95,"description":"SQL injection","file":"src/db.ts"}]}',
        ],
      });
      mockExecSync.mockReturnValue("ok");

      const result = await runEvolverAcceptance({
        workspaceDir: tmpDir,
        filesChanged: ["src/db.ts"],
        session: session as any,
      });

      expect(result.passed).toBe(false);
      expect(result.confidence).toBe(88);
      expect(result.issues).toHaveLength(1);
      expect(result.issues![0].file).toBe("src/db.ts");
    });
  });

  describe("edge cases", () => {
    it("handles empty filesChanged array", async () => {
      const session = makeMockSession({
        promptResults: [
          '{"verifyCmd":"echo ok"}',
          '{"passed":true,"confidence":50,"reasoning":"no changes to evaluate"}',
        ],
      });
      mockExecSync.mockReturnValue("ok");

      const result = await runEvolverAcceptance({
        workspaceDir: tmpDir,
        filesChanged: [],
        session: session as any,
      });

      expect(result.passed).toBe(true);
    });

    it("handles workspace without package.json", async () => {
      fs.unlinkSync(path.join(tmpDir, "package.json"));
      const session = makeMockSession({
        promptResults: [
          '{"verifyCmd":"echo ok"}',
          '{"passed":true,"confidence":70,"reasoning":"ok"}',
        ],
      });
      mockExecSync.mockReturnValue("ok");

      const result = await runEvolverAcceptance({
        workspaceDir: tmpDir,
        filesChanged: ["a.ts"],
        session: session as any,
      });

      expect(result.passed).toBe(true);
    });

    it("handles empty verifyCmd (whitespace only)", async () => {
      const session = makeMockSession({
        promptResults: ['{"verifyCmd":"   "}', ""],
      });

      const result = await runEvolverAcceptance({
        workspaceDir: tmpDir,
        filesChanged: ["a.ts"],
        session: session as any,
      });

      expect(result.passed).toBe(false);
      expect(result.reasoning).toContain("failed to propose a verifyCmd");
    });

    it("parses issues with missing fields gracefully", async () => {
      const session = makeMockSession({
        promptResults: [
          '{"verifyCmd":"echo ok"}',
          '{"passed":false,"confidence":60,"reasoning":"some issues","issues":[{"description":"missing type"},{}]}',
        ],
      });
      mockExecSync.mockReturnValue("ok");

      const result = await runEvolverAcceptance({
        workspaceDir: tmpDir,
        filesChanged: ["a.ts"],
        session: session as any,
      });

      expect(result.passed).toBe(false);
      expect(result.issues).toHaveLength(2);
      expect(result.issues![0].severity).toBe("major"); // default
      expect(result.issues![0].description).toBe("missing type");
      expect(result.issues![1].description).toBe("Unknown issue"); // default
    });

    it("includes WORKSPACE DIRECTORY in phase 1 prompt", async () => {
      const session = makeMockSession({
        promptResults: [
          '{"verifyCmd":"echo ok"}',
          '{"passed":true,"confidence":90,"reasoning":"ok"}',
        ],
      });
      mockExecSync.mockReturnValue("ok");

      await runEvolverAcceptance({
        workspaceDir: tmpDir,
        filesChanged: ["a.ts"],
        session: session as any,
      });

      const promptArg = session.prompt.mock.calls[0]![0] as string;
      expect(promptArg).toContain(`WORKSPACE DIRECTORY: ${tmpDir}`);
    });
  });
});
