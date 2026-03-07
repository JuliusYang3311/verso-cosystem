// Script to copy necessary node_modules for Gateway
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '../..');
const targetDir = path.join(__dirname, 'gateway-deps');

// Core dependencies needed by Gateway
const coreDeps = [
  '@mariozechner/pi-ai',
  '@mariozechner/pi-agent-core',
  '@mariozechner/pi-coding-agent',
  '@mariozechner/pi-tui',
  'ws',
  'express',
  'chalk',
  'commander',
  'dotenv',
  'ajv',
  '@sinclair/typebox',
  'chokidar',
  'proper-lockfile',
  'sqlite-vec',
  'better-sqlite3',
  'sharp',
  'playwright-core',
  'mime-types',
  'file-type',
  'markdown-it',
  'linkedom',
  '@mozilla/readability',
  'pdfjs-dist',
  'croner',
  'hono',
  'jiti',
  'json5'
];

const copiedPackages = new Set();

function copyPackageWithDeps(packageName, depth = 0) {
  const sourcePath = path.join(rootDir, 'node_modules', packageName);
  const targetPath = path.join(targetDir, packageName);

  if (!fs.existsSync(sourcePath)) {
    if (depth === 0) {
      console.warn(`  Warning: ${packageName} not found`);
    }
    return;
  }

  if (copiedPackages.has(packageName)) {
    return;
  }

  if (depth === 0) {
    console.log(`  Copying ${packageName}...`);
  }

  copiedPackages.add(packageName);

  // Resolve symlinks and copy actual files
  const realPath = fs.realpathSync(sourcePath);

  // Create parent directory for scoped packages
  const parentDir = path.dirname(targetPath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  fs.cpSync(realPath, targetPath, {
    recursive: true,
    dereference: true  // Follow symlinks
  });

  // Read package.json to find dependencies
  const pkgJsonPath = path.join(realPath, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      const deps = {
        ...pkgJson.dependencies,
        ...pkgJson.peerDependencies
      };

      // Recursively copy dependencies
      for (const depName in deps) {
        copyPackageWithDeps(depName, depth + 1);
      }
    } catch (err) {
      // Ignore JSON parse errors
    }
  }
}

console.log('Creating gateway-deps directory...');
if (fs.existsSync(targetDir)) {
  fs.rmSync(targetDir, { recursive: true, force: true });
}
fs.mkdirSync(targetDir, { recursive: true });

console.log('Copying core dependencies with their dependencies...');
for (const dep of coreDeps) {
  copyPackageWithDeps(dep, 0);
}

console.log(`Done! ${copiedPackages.size} packages copied to gateway-deps/`);
