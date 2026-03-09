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
const https = require("https");

const SCRIPT_DIR = __dirname;
const WINDOWS_DIR = path.resolve(SCRIPT_DIR, "..");
const VERSO_ROOT = path.resolve(WINDOWS_DIR, "../..");

const NODE_VERSION = "22.14.0";
const PLATFORM = "win";
const ARCH = process.argv[2] || "x64";

console.log("=== Verso Desktop Build Preparation (Windows) ===");
console.log("Verso root:", VERSO_ROOT);
console.log("Windows dir:", WINDOWS_DIR);
console.log("Node version:", NODE_VERSION);
console.log("Arch:", ARCH);

// --- Helpers ---

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (u) => {
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          get(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => { file.close(); resolve(); });
      }).on("error", reject);
    };
    get(url);
  });
}

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

  // 2. Download Node.js binary for Windows
  const buildResources = path.join(WINDOWS_DIR, "build-resources");
  const nodeBin = path.join(buildResources, `node-${ARCH}.exe`);

  if (!fs.existsSync(nodeBin)) {
    console.log(`\n=== Downloading Node.js ${NODE_VERSION} for ${PLATFORM}-${ARCH} ===`);
    fs.mkdirSync(buildResources, { recursive: true });

    const nodeUrl = `https://nodejs.org/dist/v${NODE_VERSION}/win-${ARCH}/node.exe`;
    console.log("Downloading:", nodeUrl);
    await download(nodeUrl, nodeBin);
    console.log("Node.js binary saved to:", nodeBin);
  } else {
    console.log("Node.js binary already exists:", nodeBin);
  }

  // 3. Copy Node.js binary to verso root as node.exe
  const gatewayNode = path.join(VERSO_ROOT, "node.exe");
  fs.copyFileSync(nodeBin, gatewayNode);
  console.log("Copied Node.js binary to:", gatewayNode);

  // 4. Ensure native modules for Windows
  console.log("\n=== Ensuring native modules for Windows ===");
  const pkg = JSON.parse(fs.readFileSync(path.join(VERSO_ROOT, "package.json"), "utf8"));

  const ensureNativePkg = (name, version) => {
    try {
      const pnpmDir = path.join(VERSO_ROOT, "node_modules", ".pnpm");
      const prefix = name.replace("/", "+");
      const matches = fs.existsSync(pnpmDir)
        ? fs.readdirSync(pnpmDir).filter((d) => d.startsWith(`${prefix}@${version}`))
        : [];
      if (matches.length > 0) {
        console.log(`  OK: ${name}@${version}`);
      } else {
        console.log(`  Installing ${name}@${version}...`);
        try {
          execSync(`pnpm add -w ${name}@${version}`, { cwd: VERSO_ROOT, stdio: "pipe" });
        } catch {
          console.warn(`  Warning: Could not install ${name}`);
        }
      }
    } catch {
      console.warn(`  Warning: Could not check ${name}`);
    }
  };

  const sqliteVecVersion = pkg.dependencies?.["sqlite-vec"] || "0.1.7-alpha.2";
  ensureNativePkg(`sqlite-vec-win32-${ARCH}`, sqliteVecVersion);

  const sharpVersion = (pkg.dependencies?.sharp || "0.34.5").replace("^", "");
  ensureNativePkg(`@img/sharp-win32-${ARCH}`, sharpVersion);

  // 5. Create lean production node_modules
  console.log("\n=== Creating lean production node_modules ===");
  const staging = path.join(VERSO_ROOT, "build-node-modules");

  // Use robocopy on Windows CI, rsync locally
  const isWindows = process.platform === "win32";

  if (fs.existsSync(staging)) {
    fs.rmSync(staging, { recursive: true, force: true });
  }

  const excludePatterns = [
    "electron@*", "@electron*",
    "electron-builder@*", "app-builder-bin@*", "app-builder-lib@*",
    "dmg-builder@*", "builder-util@*", "builder-util-runtime@*",
    "typescript@*", "@typescript+native-preview*",
    "tsdown@*", "@rolldown*", "rolldown@*",
    "vitest@*", "@vitest*",
    "oxlint*", "@oxlint*", "oxfmt*",
    "node-llama-cpp@*", "@node-llama-cpp*",
    "openclaw@*", "tsx@*",
    "lit@*", "@lit*", "ollama@*",
    "@types+*", "7zip-bin@*",
    "esbuild@*", "@esbuild*",
    "@cloudflare+workers-types@*",
  ];

  // Exclude non-Windows native binaries
  const archExcludes = ARCH === "x64"
    ? ["*-arm64@*", "*darwin-arm64*"]
    : ["*-x64@*", "*darwin-x64*"];

  const platformExcludes = ["*-darwin-*", "*-linux-*", "*-android-*"];

  if (isWindows) {
    // On Windows: use robocopy with exclude dirs
    const allExcludes = [...excludePatterns, ...archExcludes, ...platformExcludes];
    const excludeArgs = allExcludes.map((p) => `/XD .pnpm\\${p}`).join(" ");
    try {
      execSync(
        `robocopy "${path.join(VERSO_ROOT, "node_modules")}" "${staging}" /E /NFL /NDL /NJH /NJS ${excludeArgs}`,
        { cwd: VERSO_ROOT, stdio: "pipe" },
      );
    } catch {
      // robocopy returns non-zero on success (1 = files copied)
    }
  } else {
    // On macOS/Linux: use rsync (for local testing)
    const rsyncExcludes = [
      ...excludePatterns.map((p) => `--exclude=.pnpm/${p}`),
      ...archExcludes.map((p) => `--exclude=.pnpm/${p}`),
      ...platformExcludes.map((p) => `--exclude=.pnpm/${p}`),
      "--exclude=.bin",
    ];
    execSync(
      `rsync -a ${rsyncExcludes.join(" ")} "${path.join(VERSO_ROOT, "node_modules")}/" "${staging}/"`,
      { cwd: VERSO_ROOT, stdio: "inherit" },
    );
  }

  // Clean broken symlinks (cross-platform)
  console.log("Cleaning broken symlinks...");
  cleanBrokenSymlinks(staging);

  // Strip non-runtime files
  console.log("Stripping non-runtime files...");
  stripNonRuntimeFiles(path.join(staging, ".pnpm"));

  const origSize = dirSizeMB(path.join(VERSO_ROOT, "node_modules"));
  const leanSize = dirSizeMB(staging);
  console.log(`Original node_modules: ~${origSize}MB`);
  console.log(`Lean node_modules:     ~${leanSize}MB`);

  // 6. Copy shared electron files (main.js, preload.js, renderer/, auth/, gateway/)
  console.log("\n=== Copying shared Electron files ===");
  const electronDir = path.join(VERSO_ROOT, "apps", "electron");
  const filesToCopy = ["main.js", "preload.js"];

  for (const f of filesToCopy) {
    const src = path.join(electronDir, f);
    const dest = path.join(WINDOWS_DIR, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      console.log(`  Copied ${f}`);
    }
  }

  const dirsToCopy = ["renderer", "auth", "gateway"];
  for (const d of dirsToCopy) {
    const src = path.join(electronDir, d);
    const dest = path.join(WINDOWS_DIR, d);
    if (fs.existsSync(src)) {
      copyDirSync(src, dest);
      console.log(`  Copied ${d}/`);
    }
  }

  // 7. Clean packaging-incompatible symlinks in extensions
  console.log("\n=== Cleaning packaging-incompatible symlinks ===");
  const extDir = path.join(VERSO_ROOT, "extensions");
  if (fs.existsSync(extDir)) {
    cleanBrokenSymlinks(extDir);
  }

  console.log("\n=== Build preparation complete ===");
  console.log(`You can now run: cd ${WINDOWS_DIR} && npx electron-builder --win --x64`);
}

// --- Utility functions ---

function cleanBrokenSymlinks(dir) {
  if (!fs.existsSync(dir)) return;
  let found = true;
  while (found) {
    found = false;
    walkDir(dir, (filePath) => {
      try {
        const stat = fs.lstatSync(filePath);
        if (stat.isSymbolicLink()) {
          try {
            fs.statSync(filePath); // resolves symlink
          } catch {
            fs.unlinkSync(filePath);
            found = true;
          }
        }
      } catch { /* ignore */ }
    });
  }
}

function stripNonRuntimeFiles(dir) {
  if (!fs.existsSync(dir)) return;
  const deletePatterns = [".map", ".d.ts", ".d.mts", ".d.cts"];
  const deleteNames = [
    "README.md", "README.txt", "README", "CHANGELOG.md", "CHANGELOG.txt",
    "HISTORY.md", "AUTHORS", "AUTHORS.md", "CONTRIBUTING.md",
  ];
  const deleteDirs = ["test", "tests", "__tests__", "spec", "example", "examples", "demo", "fixture", "fixtures"];

  walkDir(dir, (filePath) => {
    const basename = path.basename(filePath);
    const ext = path.extname(filePath);

    try {
      const stat = fs.lstatSync(filePath);
      if (stat.isDirectory()) {
        if (deleteDirs.includes(basename)) {
          fs.rmSync(filePath, { recursive: true, force: true });
        }
        return;
      }
      if (deletePatterns.some((p) => filePath.endsWith(p))) {
        fs.unlinkSync(filePath);
      } else if (deleteNames.some((n) => basename.toLowerCase() === n.toLowerCase())) {
        fs.unlinkSync(filePath);
      } else if (ext === ".ts" && !filePath.endsWith(".d.ts")) {
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
      callback(fullPath);
      if (entry.isDirectory()) {
        walkDir(fullPath, callback);
      }
    }
  } catch { /* ignore permission errors */ }
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function dirSizeMB(dir) {
  try {
    const result = execSync(`du -sm "${dir}" 2>/dev/null || echo "0"`, { encoding: "utf8" });
    return parseInt(result.split("\t")[0]) || 0;
  } catch {
    return 0;
  }
}

main().catch((err) => {
  console.error("Build preparation failed:", err);
  process.exit(1);
});
