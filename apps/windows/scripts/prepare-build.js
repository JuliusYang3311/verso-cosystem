#!/usr/bin/env node
/**
 * Prepare build: download Node.js binary and build verso dist for Windows.
 * This must run before electron-builder.
 *
 * Usage: node scripts/prepare-build.js [arch]
 *   arch: x64 (default) or arm64
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const SCRIPT_DIR = __dirname;
const WINDOWS_DIR = path.resolve(SCRIPT_DIR, "..");
const VERSO_ROOT = path.resolve(WINDOWS_DIR, "../..");

const ARCH = process.argv[2] || "x64";

console.log("=== Verso Desktop Build Preparation (Windows) ===");
console.log("Verso root:", VERSO_ROOT);
console.log("Windows dir:", WINDOWS_DIR);
console.log("Arch:", ARCH);

async function main() {
  // 1. Build verso if dist doesn't exist
  if (!fs.existsSync(path.join(VERSO_ROOT, "dist", "index.js"))) {
    console.log("\n=== Building verso ===");
    try {
      execSync("pnpm run build", { cwd: VERSO_ROOT, stdio: "inherit" });
    } catch {
      try {
        execSync("npm run build", { cwd: VERSO_ROOT, stdio: "inherit" });
      } catch {
        console.warn("Warning: Could not build verso. Make sure dist/ exists.");
      }
    }
  }

  // 2. Create lean production node_modules
  // (No standalone node.exe needed — Electron's own Node.js is used via ELECTRON_RUN_AS_NODE=1)
  // Use pure Node.js copying — robocopy doesn't support glob excludes,
  // and rsync isn't available on Windows.
  console.log("\n=== Creating lean production node_modules ===");
  const staging = path.join(VERSO_ROOT, "build-node-modules");

  if (fs.existsSync(staging)) {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  fs.mkdirSync(staging, { recursive: true });

  const sourceNM = path.join(VERSO_ROOT, "node_modules");
  if (!fs.existsSync(sourceNM)) {
    console.error("ERROR: node_modules not found at", sourceNM);
    process.exit(1);
  }

  // Patterns to exclude from .pnpm/ store (matched against directory names)
  const excludePrefixes = [
    "electron@", "@electron",
    "electron-builder@", "app-builder-bin@", "app-builder-lib@",
    "dmg-builder@", "builder-util@", "builder-util-runtime@",
    "typescript@", "@typescript+native-preview",
    "tsdown@", "@rolldown", "rolldown@",
    "vitest@", "@vitest",
    "oxlint", "@oxlint", "oxfmt",
    "node-llama-cpp@", "@node-llama-cpp",
    "openclaw@", "tsx@",
    "lit@", "@lit",
    "ollama@", "@types+",
    "7zip-bin@", "esbuild@", "@esbuild",
    "@cloudflare+workers-types@",
  ];

  // Exclude non-Windows and wrong-arch native binaries
  const platformExcludes = ["-darwin-", "-linux-", "-android-"];
  const archExcludes = ARCH === "x64"
    ? ["-arm64@", "darwin-arm64"]
    : ["-x64@", "darwin-x64"];

  function shouldExcludePnpmDir(name) {
    for (const prefix of excludePrefixes) {
      if (name.startsWith(prefix)) return true;
    }
    for (const pat of platformExcludes) {
      if (name.includes(pat)) return true;
    }
    for (const pat of archExcludes) {
      if (name.includes(pat)) return true;
    }
    return false;
  }

  // Copy node_modules, filtering .pnpm/ contents and skipping .bin/
  console.log("Copying production node_modules (filtering dev packages)...");
  copyNodeModules(sourceNM, staging, shouldExcludePnpmDir);

  // Clean broken symlinks
  console.log("Cleaning broken symlinks...");
  cleanBrokenSymlinks(staging);

  // Strip non-runtime files
  console.log("Stripping non-runtime files...");
  stripNonRuntimeFiles(path.join(staging, ".pnpm"));

  // Final broken-symlink sweep
  console.log("Final broken-symlink sweep...");
  cleanBrokenSymlinks(staging);

  // Remove empty directories
  removeEmptyDirs(staging);

  console.log("Lean node_modules created at:", staging);

  // 5. Clean packaging-incompatible symlinks in extensions
  console.log("\n=== Cleaning packaging-incompatible symlinks ===");
  const extDir = path.join(VERSO_ROOT, "extensions");
  if (fs.existsSync(extDir)) {
    cleanBrokenSymlinks(extDir);
  }

  console.log("\n=== Build preparation complete ===");
  console.log(`You can now run: cd ${WINDOWS_DIR} && npx electron-builder --win --x64`);
}

// --- Copy node_modules with .pnpm filtering ---

function copyNodeModules(src, dest, shouldExclude) {
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    // Skip .bin directory
    if (entry.name === ".bin") continue;

    if (entry.isSymbolicLink()) {
      // Copy symlinks as-is (pnpm structure)
      try {
        const target = fs.readlinkSync(srcPath);
        // Skip workspace-escaping symlinks
        if (target.startsWith("../../../")) continue;
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.symlinkSync(target, destPath, entry.isDirectory() ? "junction" : "file");
      } catch { /* skip broken symlinks */ }
      continue;
    }

    if (entry.isDirectory()) {
      if (entry.name === ".pnpm") {
        // Filter .pnpm contents
        fs.mkdirSync(destPath, { recursive: true });
        const pnpmEntries = fs.readdirSync(srcPath, { withFileTypes: true });
        for (const pe of pnpmEntries) {
          if (pe.isDirectory() && shouldExclude(pe.name)) continue;
          const peSrc = path.join(srcPath, pe.name);
          const peDest = path.join(destPath, pe.name);
          if (pe.isSymbolicLink()) {
            try {
              const target = fs.readlinkSync(peSrc);
              fs.symlinkSync(target, peDest, "junction");
            } catch { /* skip */ }
          } else if (pe.isDirectory()) {
            copyDirSync(peSrc, peDest);
          } else {
            fs.copyFileSync(peSrc, peDest);
          }
        }
      } else {
        copyDirSync(srcPath, destPath);
      }
    } else {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// --- Utility functions ---

function cleanBrokenSymlinks(dir) {
  if (!fs.existsSync(dir)) return;
  let found = true;
  let passes = 0;
  while (found && passes < 10) {
    found = false;
    passes++;
    walkLinks(dir, (filePath) => {
      try {
        const stat = fs.lstatSync(filePath);
        if (stat.isSymbolicLink()) {
          try {
            fs.statSync(filePath); // resolves symlink — throws if broken
          } catch {
            fs.unlinkSync(filePath);
            found = true;
          }
        }
      } catch { /* ignore */ }
    });
  }
}

function walkLinks(dir, callback) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        callback(fullPath);
      } else if (entry.isDirectory()) {
        walkLinks(fullPath, callback);
      }
    }
  } catch { /* ignore permission errors */ }
}

function stripNonRuntimeFiles(dir) {
  if (!fs.existsSync(dir)) return;
  const deleteExts = [".map", ".d.ts", ".d.mts", ".d.cts"];
  const deleteNames = new Set([
    "readme.md", "readme.txt", "readme", "changelog.md", "changelog.txt",
    "history.md", "authors", "authors.md", "contributing.md",
  ]);
  const deleteDirs = new Set([
    "test", "tests", "__tests__", "spec", "example", "examples",
    "demo", "fixture", "fixtures",
  ]);

  walkDir(dir, (filePath, isDir) => {
    const basename = path.basename(filePath);
    try {
      if (isDir) {
        if (deleteDirs.has(basename)) {
          fs.rmSync(filePath, { recursive: true, force: true });
        }
        return;
      }
      if (deleteExts.some((ext) => filePath.endsWith(ext))) {
        fs.unlinkSync(filePath);
      } else if (deleteNames.has(basename.toLowerCase())) {
        fs.unlinkSync(filePath);
      } else if (filePath.endsWith(".ts") && !filePath.endsWith(".d.ts")) {
        fs.unlinkSync(filePath);
      }
    } catch { /* ignore */ }
  });
}

function walkDir(dir, callback) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      callback(fullPath, entry.isDirectory());
      if (entry.isDirectory()) {
        walkDir(fullPath, callback);
      }
    }
  } catch { /* ignore permission errors */ }
}

function removeEmptyDirs(dir) {
  try {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          removeEmptyDirs(fullPath);
          // Re-check if now empty
          if (fs.readdirSync(fullPath).length === 0) {
            fs.rmdirSync(fullPath);
          }
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        const target = fs.readlinkSync(srcPath);
        fs.symlinkSync(target, destPath, entry.isDirectory() ? "junction" : "file");
      } catch { /* skip broken */ }
    } else if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

main().catch((err) => {
  console.error("Build preparation failed:", err);
  process.exit(1);
});
