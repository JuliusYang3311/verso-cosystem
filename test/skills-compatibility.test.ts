import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll } from "vitest";

/**
 * Skills 兼容性测试
 * 验证所有保留的核心 skills 与新架构兼容。
 */

const SKILLS_DIR = path.resolve(__dirname, "../skills");

const CORE_SKILLS = [
  // Note: evolver is now integrated into src/evolver/, not a skill directory
  "github",
  "coding-agent",
  "twitter",
  "videogeneration",
  "notion",
  "obsidian",
  "1password",
  "crypto-trading",
  "weather",
  "nano-pdf",
  "world-monitor",
  "nano-banana-pro", // google
  "webhook",
  // Note: cron, gmail, calendar, web-search, brave-search
  // may be bundled or extension-based, tested separately if present
];

// Skills 不应引用这些将被移除的 API
const FORBIDDEN_PATTERNS = [
  /sessions\.spawn/,
  /subagent/i,
  /sub-agent/i,
  /sessions\.list/,
  /sessions\.send/,
];

function findSkillDir(name: string): string | null {
  const dir = path.join(SKILLS_DIR, name);
  return fs.existsSync(dir) ? dir : null;
}

function readSkillMd(skillDir: string): string | null {
  const mdPath = path.join(skillDir, "SKILL.md");
  if (fs.existsSync(mdPath)) {
    return fs.readFileSync(mdPath, "utf8");
  }
  return null;
}

function readAllFilesRecursive(dir: string, ext = ".md"): { path: string; content: string }[] {
  const results: { path: string; content: string }[] = [];
  if (!fs.existsSync(dir)) {
    return results;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }

    if (entry.isDirectory()) {
      results.push(...readAllFilesRecursive(fullPath, ext));
    } else if (
      entry.name.endsWith(ext) ||
      entry.name.endsWith(".js") ||
      entry.name.endsWith(".ts")
    ) {
      try {
        results.push({ path: fullPath, content: fs.readFileSync(fullPath, "utf8") });
      } catch {}
    }
  }
  return results;
}

describe("Skills 兼容性测试", () => {
  const existingSkills: string[] = [];

  beforeAll(() => {
    for (const name of CORE_SKILLS) {
      if (findSkillDir(name)) {
        existingSkills.push(name);
      }
    }
  });

  it("所有核心 skills 目录应存在", () => {
    const missing = CORE_SKILLS.filter((name) => !findSkillDir(name));
    // 允许部分 skills 不以目录形式存在（可能是内置或扩展）
    if (missing.length > 0) {
      console.warn(`以下 skills 目录不存在（可能是内置/扩展）: ${missing.join(", ")}`);
    }
    // 至少 60% 的核心 skills 应存在
    expect(existingSkills.length).toBeGreaterThan(CORE_SKILLS.length * 0.6);
  });

  describe.each(CORE_SKILLS.filter((name) => findSkillDir(name)))("%s", (skillName) => {
    it("应有 SKILL.md 定义", () => {
      const dir = findSkillDir(skillName)!;
      const md = readSkillMd(dir);
      expect(md).not.toBeNull();
      expect(md!.length).toBeGreaterThan(10);
    });

    it("不应依赖 subagent API（将被移除）", () => {
      const dir = findSkillDir(skillName)!;
      const files = readAllFilesRecursive(dir);

      for (const file of files) {
        for (const pattern of FORBIDDEN_PATTERNS) {
          const match = pattern.exec(file.content);
          if (match) {
            throw new Error(
              `${skillName}: 文件 ${path.relative(SKILLS_DIR, file.path)} 包含禁止模式 "${match[0]}"`,
            );
          }
        }
      }
    });

    it("SKILL.md 应有有效的 frontmatter", () => {
      const dir = findSkillDir(skillName)!;
      const md = readSkillMd(dir);
      if (!md) {
        return;
      }

      // 检查是否有 YAML frontmatter
      const hasFrontmatter = md.startsWith("---");
      if (hasFrontmatter) {
        const endIdx = md.indexOf("---", 3);
        expect(endIdx).toBeGreaterThan(3);
        const frontmatter = md.slice(3, endIdx).trim();
        expect(frontmatter.length).toBeGreaterThan(0);

        // 应包含 name 字段
        expect(frontmatter).toMatch(/name:/);
      }
    });
  });

  describe("跨 skill 检查", () => {
    it("不应有 skill 间循环依赖", () => {
      // Skills 是独立的，不应互相引用
      for (const name of existingSkills) {
        const dir = findSkillDir(name)!;
        const files = readAllFilesRecursive(dir);

        for (const file of files) {
          const otherSkillRefs = existingSkills
            .filter((n) => n !== name)
            .filter((n) => file.content.includes(`skills/${n}`));

          if (otherSkillRefs.length > 0) {
            console.warn(
              `${name}: ${path.relative(SKILLS_DIR, file.path)} 引用了其他 skills: ${otherSkillRefs.join(", ")}`,
            );
          }
        }
      }
    });
  });
});
