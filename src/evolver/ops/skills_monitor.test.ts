import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpSkillsDir: string;
let tmpWorkspaceDir: string;

const mockExecSync = vi.fn();

vi.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

vi.mock("../gep/paths.js", () => ({
  getSkillsDir: () => tmpSkillsDir,
  getWorkspaceRoot: () => tmpWorkspaceDir,
}));

const { checkSkill, autoHeal, run } = await import("./skills_monitor.js");

describe("skills_monitor", () => {
  beforeEach(() => {
    tmpWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-ws-"));
    tmpSkillsDir = path.join(tmpWorkspaceDir, "skills");
    fs.mkdirSync(tmpSkillsDir, { recursive: true });
    mockExecSync.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpWorkspaceDir, { recursive: true, force: true });
  });

  describe("checkSkill", () => {
    it("returns null for ignored skills", () => {
      // "common" is in the built-in IGNORE_LIST
      const skillDir = path.join(tmpSkillsDir, "common");
      fs.mkdirSync(skillDir, { recursive: true });
      expect(checkSkill("common")).toBeNull();
    });

    it("returns null for non-existent skill", () => {
      expect(checkSkill("nonexistent")).toBeNull();
    });

    it("returns null for skill that is not a directory", () => {
      fs.writeFileSync(path.join(tmpSkillsDir, "not-a-dir"), "file");
      expect(checkSkill("not-a-dir")).toBeNull();
    });

    it("returns null for healthy skill (no issues)", () => {
      const skillDir = path.join(tmpSkillsDir, "my-skill");
      fs.mkdirSync(skillDir, { recursive: true });
      // No package.json, no JS entry — nothing to check
      expect(checkSkill("my-skill")).toBeNull();
    });

    it("reports missing SKILL.md when package.json exists", () => {
      const skillDir = path.join(tmpSkillsDir, "test-skill");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "package.json"),
        JSON.stringify({ name: "test-skill", main: "index.js" }),
      );
      fs.writeFileSync(path.join(skillDir, "index.js"), "module.exports = {};");
      // node -c syntax check
      mockExecSync.mockImplementation(() => "");

      const result = checkSkill("test-skill");
      expect(result).not.toBeNull();
      expect(result!.issues).toContain("Missing SKILL.md");
    });

    it("reports missing node_modules when deps exist and require fails", () => {
      const skillDir = path.join(tmpSkillsDir, "dep-skill");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "package.json"),
        JSON.stringify({
          name: "dep-skill",
          main: "index.js",
          dependencies: { lodash: "^4.0.0" },
        }),
      );
      fs.writeFileSync(path.join(skillDir, "index.js"), "require('lodash');");
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# dep-skill");

      // Both node -e require(...) and node -c fail
      mockExecSync.mockImplementation(() => {
        throw new Error("Cannot find module");
      });

      const result = checkSkill("dep-skill");
      expect(result).not.toBeNull();
      expect(result!.issues).toContain("Missing node_modules (needs npm install)");
    });

    it("reports syntax error when node -c fails", () => {
      const skillDir = path.join(tmpSkillsDir, "syntax-skill");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "index.js"), "function bad( {");

      mockExecSync.mockImplementation(() => {
        throw new Error("SyntaxError");
      });

      const result = checkSkill("syntax-skill");
      expect(result).not.toBeNull();
      expect(result!.issues).toContain("Syntax Error in index.js");
    });
  });

  describe("autoHeal", () => {
    it("heals missing node_modules by running npm install", () => {
      const skillDir = path.join(tmpSkillsDir, "heal-skill");
      fs.mkdirSync(skillDir, { recursive: true });
      mockExecSync.mockImplementation(() => "");

      const healed = autoHeal("heal-skill", ["Missing node_modules (needs npm install)"]);
      expect(healed).toContain("Missing node_modules (needs npm install)");
      expect(mockExecSync).toHaveBeenCalledWith(
        "npm install --production --no-audit --no-fund",
        expect.objectContaining({ cwd: skillDir }),
      );
    });

    it("heals missing SKILL.md by creating stub", () => {
      const skillDir = path.join(tmpSkillsDir, "md-skill");
      fs.mkdirSync(skillDir, { recursive: true });

      const healed = autoHeal("md-skill", ["Missing SKILL.md"]);
      expect(healed).toContain("Missing SKILL.md");
      const skillMd = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
      expect(skillMd).toContain("# md-skill");
    });

    it("does not heal unknown issues", () => {
      const skillDir = path.join(tmpSkillsDir, "unknown-skill");
      fs.mkdirSync(skillDir, { recursive: true });

      const healed = autoHeal("unknown-skill", ["Syntax Error in index.js"]);
      expect(healed).toEqual([]);
    });
  });

  describe("run", () => {
    it("returns empty array when no skills have issues", () => {
      const skillDir = path.join(tmpSkillsDir, "good-skill");
      fs.mkdirSync(skillDir, { recursive: true });

      const report = run();
      expect(report).toEqual([]);
    });

    it("skips dotfiles", () => {
      fs.mkdirSync(path.join(tmpSkillsDir, ".hidden"), { recursive: true });
      const report = run();
      expect(report).toEqual([]);
    });

    it("auto-heals by default and removes healed issues", () => {
      const skillDir = path.join(tmpSkillsDir, "healable-skill");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "package.json"),
        JSON.stringify({ name: "healable-skill" }),
      );
      // Missing SKILL.md will be auto-healed

      mockExecSync.mockImplementation(() => "");

      const report = run();
      // SKILL.md should have been auto-healed, so no remaining issues
      expect(report).toEqual([]);
      expect(fs.existsSync(path.join(skillDir, "SKILL.md"))).toBe(true);
    });

    it("reports unhealed issues when autoHeal is false", () => {
      const skillDir = path.join(tmpSkillsDir, "sick-skill");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "package.json"), JSON.stringify({ name: "sick-skill" }));

      mockExecSync.mockImplementation(() => "");

      const report = run({ autoHeal: false });
      // Missing SKILL.md should be reported (not healed)
      expect(report.length).toBeGreaterThan(0);
      expect(report[0].name).toBe("sick-skill");
      expect(report[0].issues).toContain("Missing SKILL.md");
    });
  });
});
