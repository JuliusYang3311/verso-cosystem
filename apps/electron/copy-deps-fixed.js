// Script to copy necessary node_modules for Gateway
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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

console.log('Creating gateway-deps directory...');
if (fs.existsSync(targetDir)) {
  fs.rmSync(targetDir, { recursive: true, force: true });
}
fs.mkdirSync(targetDir, { recursive: true });

// Find the actual package location in pnpm store
function findPackageInPnpm(packageName) {
  const pnpmDir = path.join(rootDir, 'node_modules/.pnpm');
  if (!fs.existsSync(pnpmDir)) {
    return null;
  }

  const entries = fs.readdirSync(pnpmDir);
  for (const entry of entries) {
    if (entry.startsWith(packageName.replace('/', '+') + '@')) {
      const pkgPath = path.join(pnpmDir, entry, 'node_modules', packageName);
      if (fs.existsSync(pkgPath)) {
        return pkgPath;
      }
    }
  }
  return null;
}

console.log('Copying core dependencies...');
for (const dep of coreDeps) {
  const sourcePath = findPackageInPnpm(dep);
  const targetPath = path.join(targetDir, dep);

  if (sourcePath && fs.existsSync(sourcePath)) {
    console.log(`  Copying ${dep}...`);

    // Create parent directory for scoped packages
    const parentDir = path.dirname(targetPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    // Copy the actual package directory
    fs.cpSync(sourcePath, targetPath, {
      recursive: true,
      dereference: false,  // Don't follow symlinks
      filter: (src) => {
        // Skip node_modules inside packages to avoid bloat
        const rel = path.relative(sourcePath, src);
        return !rel.includes('node_modules');
      }
    });
  } else {
    console.warn(`  Warning: ${dep} not found`);
  }
}

console.log('Done! Dependencies copied to gateway-deps/');
