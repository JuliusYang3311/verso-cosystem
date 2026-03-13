#!/bin/bash
set -e

# Prepare build: download Node.js binary and build verso dist
# This must run before electron-builder

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSO_ROOT="$(cd "$ELECTRON_DIR/../.." && pwd)"

NODE_VERSION="22.14.0"
PLATFORM="darwin"
ARCH="${1:-arm64}"  # arm64 or x64

echo "=== Verso Desktop Build Preparation ==="
echo "Verso root: $VERSO_ROOT"
echo "Electron dir: $ELECTRON_DIR"
echo "Node version: $NODE_VERSION"
echo "Arch: $ARCH"

# 1. Build verso if dist doesn't exist
if [ ! -f "$VERSO_ROOT/dist/index.js" ]; then
  echo ""
  echo "=== Building verso ==="
  cd "$VERSO_ROOT"
  npm run build 2>/dev/null || pnpm run build 2>/dev/null || echo "Warning: Could not build verso. Make sure dist/ exists."
fi

# 2. Download Node.js binary for the target arch
NODE_DIR="$ELECTRON_DIR/build-resources"
NODE_BIN="$NODE_DIR/node-$ARCH"

if [ ! -f "$NODE_BIN" ]; then
  echo ""
  echo "=== Downloading Node.js $NODE_VERSION for $PLATFORM-$ARCH ==="
  mkdir -p "$NODE_DIR"

  NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${PLATFORM}-${ARCH}.tar.gz"
  TEMP_TAR="$NODE_DIR/node-${ARCH}.tar.gz"

  curl -L -o "$TEMP_TAR" "$NODE_URL"

  # Extract just the node binary
  tar -xzf "$TEMP_TAR" -C "$NODE_DIR" "node-v${NODE_VERSION}-${PLATFORM}-${ARCH}/bin/node"
  mv "$NODE_DIR/node-v${NODE_VERSION}-${PLATFORM}-${ARCH}/bin/node" "$NODE_BIN"
  rm -rf "$NODE_DIR/node-v${NODE_VERSION}-${PLATFORM}-${ARCH}"
  rm -f "$TEMP_TAR"

  chmod +x "$NODE_BIN"
  echo "Node.js binary saved to: $NODE_BIN"
else
  echo "Node.js binary already exists: $NODE_BIN"
fi

# 3. Copy Node.js binary to where extraResources will pick it up
# electron-builder copies from ../../ (verso root) into Resources/gateway/
# We put the node binary there so it ends up at Resources/gateway/node
GATEWAY_NODE="$VERSO_ROOT/node"
cp "$NODE_BIN" "$GATEWAY_NODE"
chmod +x "$GATEWAY_NODE"
echo "Copied Node.js binary to: $GATEWAY_NODE"

# 4. Ensure ALL native modules for the target arch are installed
# System Node may run under Rosetta (x64) while the bundled Node is arm64.
# Platform-specific packages must match the bundled Node's architecture.
echo ""
echo "=== Ensuring native modules for $ARCH ==="
cd "$VERSO_ROOT"

# Helper: install a platform package if missing
ensure_native_pkg() {
  local pkg="$1"
  local version="$2"
  if ! ls -d "$VERSO_ROOT/node_modules/.pnpm/$(echo "$pkg" | tr '/' '+')@${version}"* &>/dev/null; then
    echo "  Installing $pkg@$version..."
    pnpm add -w "${pkg}@${version}" 2>/dev/null || echo "  Warning: Could not install $pkg"
  else
    echo "  OK: $pkg@$version"
  fi
}

# sqlite-vec
SQLITE_VEC_VERSION=$(node -e "const p=require('$VERSO_ROOT/package.json'); console.log(p.dependencies['sqlite-vec'] || '0.1.7-alpha.2')" 2>/dev/null || echo "0.1.7-alpha.2")
ensure_native_pkg "sqlite-vec-${PLATFORM}-${ARCH}" "$SQLITE_VEC_VERSION"

# sharp (image processing)
SHARP_VERSION=$(node -e "const p=require('$VERSO_ROOT/package.json'); console.log(p.dependencies['sharp']?.replace('^','') || '0.34.5')" 2>/dev/null || echo "0.34.5")
ensure_native_pkg "@img/sharp-${PLATFORM}-${ARCH}" "$SHARP_VERSION"
# sharp also needs libvips
LIBVIPS_VERSION=$(node -e "try{const p=require('@img/sharp-${PLATFORM}-x64/package.json');const v=Object.keys(p.optionalDependencies||{})[0];console.log(p.optionalDependencies[v]?.replace('^',''))}catch{console.log('1.2.4')}" 2>/dev/null || echo "1.2.4")
ensure_native_pkg "@img/sharp-libvips-${PLATFORM}-${ARCH}" "$LIBVIPS_VERSION"

echo "Done"

# 5. Create lean production node_modules
#    Full node_modules is ~2.6GB (pnpm symlinks cause double-counting by electron-builder).
#    We rsync only production packages, excluding dev tools (~1GB savings).
echo ""
echo "=== Creating lean production node_modules ==="

STAGING="$VERSO_ROOT/build-node-modules"
rm -rf "$STAGING"
mkdir -p "$STAGING"

# Patterns for dev-only packages.
# NOTE: With --config.node-linker=hoisted, top-level dirs are real copies
# (not symlinks into .pnpm), so we must exclude BOTH .pnpm/ AND top-level paths.
EXCLUDE_ARGS=(
  # Electron shell (provided by electron-builder itself) — ~234MB
  --exclude='.pnpm/electron@*'
  --exclude='.pnpm/@electron*'
  --exclude='electron'
  # Build tools (electron-builder, app-builder-bin) — ~328MB
  --exclude='.pnpm/electron-builder@*'
  --exclude='.pnpm/app-builder-bin@*'
  --exclude='.pnpm/app-builder-lib@*'
  --exclude='.pnpm/dmg-builder@*'
  --exclude='.pnpm/builder-util@*'
  --exclude='.pnpm/builder-util-runtime@*'
  --exclude='electron-builder'
  --exclude='app-builder-bin'
  --exclude='app-builder-lib'
  --exclude='dmg-builder'
  --exclude='builder-util'
  --exclude='builder-util-runtime'
  # TypeScript compiler + native preview — ~47MB
  --exclude='.pnpm/typescript@*'
  --exclude='.pnpm/@typescript+native-preview*'
  --exclude='typescript'
  --exclude='@typescript'
  # Bundler (tsdown + rolldown) — ~18MB
  --exclude='.pnpm/tsdown@*'
  --exclude='.pnpm/@rolldown*'
  --exclude='.pnpm/rolldown@*'
  --exclude='tsdown'
  --exclude='@rolldown'
  --exclude='rolldown'
  # Test framework (vitest) — ~4MB
  --exclude='.pnpm/vitest@*'
  --exclude='.pnpm/@vitest*'
  --exclude='vitest'
  --exclude='@vitest'
  # Linter + formatter (oxlint, oxfmt) — ~50MB
  --exclude='.pnpm/oxlint*'
  --exclude='.pnpm/@oxlint*'
  --exclude='.pnpm/oxfmt*'
  --exclude='oxlint'
  --exclude='@oxlint-tsgolint'
  --exclude='oxfmt'
  # Local LLM (optional, large) — ~57MB
  --exclude='.pnpm/node-llama-cpp@*'
  --exclude='.pnpm/@node-llama-cpp*'
  --exclude='node-llama-cpp'
  --exclude='@node-llama-cpp'
  # Self-reference copies — ~95MB
  --exclude='.pnpm/openclaw@*'
  --exclude='openclaw'
  # TSX dev runner
  --exclude='.pnpm/tsx@*'
  --exclude='tsx'
  # Lit (devDependency only)
  --exclude='.pnpm/lit@*'
  --exclude='.pnpm/@lit*'
  --exclude='lit'
  --exclude='@lit'
  # Ollama (devDependency)
  --exclude='.pnpm/ollama@*'
  --exclude='ollama'
  # Type declarations (not needed at runtime)
  --exclude='.pnpm/@types+*'
  --exclude='@types'
  # Build tool transitive deps still in .pnpm
  --exclude='.pnpm/7zip-bin@*'
  --exclude='.pnpm/esbuild@*'
  --exclude='.pnpm/@esbuild*'
  --exclude='.pnpm/@cloudflare+workers-types@*'
  --exclude='7zip-bin'
  --exclude='esbuild'
  --exclude='@esbuild'
  # .bin scripts (gateway uses direct imports)
  --exclude='.bin'
  # .ignored_ prefixed dirs (pnpm hoisted dedupes)
  --exclude='.ignored_*'
)

# Exclude wrong-arch native binaries
if [ "$ARCH" = "arm64" ]; then
  EXCLUDE_ARGS+=(--exclude='.pnpm/*darwin-x64@*' --exclude='.pnpm/*-x64@*')
else
  EXCLUDE_ARGS+=(--exclude='.pnpm/*darwin-arm64@*' --exclude='.pnpm/*-arm64@*')
fi
# Always exclude non-macOS binaries
EXCLUDE_ARGS+=(
  --exclude='.pnpm/*-linux-*'
  --exclude='.pnpm/*-win32-*'
  --exclude='.pnpm/*-windows-*'
  --exclude='.pnpm/*-android-*'
)

echo "Copying production node_modules (excluding dev packages)..."
rsync -a "${EXCLUDE_ARGS[@]}" "$VERSO_ROOT/node_modules/" "$STAGING/"

# Remove broken symlinks recursively (each pass may expose new broken links)
echo "Cleaning broken symlinks..."
while true; do
  BROKEN=$(find "$STAGING" -type l ! -exec test -e {} \; -print 2>/dev/null | head -1)
  [ -z "$BROKEN" ] && break
  find "$STAGING" -type l ! -exec test -e {} \; -delete 2>/dev/null || true
done
# Remove symlinks that escape the staging dir (pnpm workspace refs like
# ../../../packages/moltbot — valid in source tree but broken after packaging)
echo "Cleaning workspace-escaping symlinks..."
find "$STAGING" -type l -exec sh -c '
  for link; do
    target=$(readlink "$link" 2>/dev/null)
    case "$target" in ../../../*) rm -f "$link" ;; esac
  done
' _ {} +

# 5b. Deep clean: strip files not needed at runtime
echo "Stripping non-runtime files..."
# Source maps (~21MB)
find "$STAGING/.pnpm" -name "*.map" -type f -delete 2>/dev/null || true
# TypeScript declarations (~191MB) — not needed by Node.js runtime
find "$STAGING/.pnpm" -name "*.d.ts" -type f -delete 2>/dev/null || true
find "$STAGING/.pnpm" -name "*.d.mts" -type f -delete 2>/dev/null || true
find "$STAGING/.pnpm" -name "*.d.cts" -type f -delete 2>/dev/null || true
# Docs & metadata (only .md/.txt/.rst — avoid deleting code files like changelog.js)
find "$STAGING/.pnpm" \( -iname "README.md" -o -iname "README.txt" -o -iname "README" -o -iname "CHANGELOG.md" -o -iname "CHANGELOG.txt" -o -iname "HISTORY.md" -o -iname "AUTHORS" -o -iname "AUTHORS.md" -o -iname "CONTRIBUTING.md" \) -type f -delete 2>/dev/null || true
# Test/example directories
find "$STAGING/.pnpm" -type d \( -name "test" -o -name "tests" -o -name "__tests__" -o -name "spec" -o -name "example" -o -name "examples" -o -name "demo" -o -name "fixture" -o -name "fixtures" \) -exec rm -rf {} + 2>/dev/null || true
# TypeScript source files (compiled JS is what we need)
find "$STAGING/.pnpm" -name "*.ts" ! -name "*.d.ts" ! -name "*.d.mts" -type f -delete 2>/dev/null || true

# 5c. Trim pdfjs-dist: remove legacy/ build (Node uses modern build) (~18MB)
echo "Trimming pdfjs-dist legacy..."
find "$STAGING/.pnpm" -path "*/pdfjs-dist/legacy" -type d -exec rm -rf {} + 2>/dev/null || true

# 5d. Deduplicate googleapis (pnpm may store 2 copies with different peer dep keys)
echo "Deduplicating googleapis..."
GAPI_DIRS=("$STAGING"/.pnpm/googleapis@*)
if [ "${#GAPI_DIRS[@]}" -gt 1 ]; then
  # Keep the first, replace others with symlinks
  KEEP="${GAPI_DIRS[0]}"
  for ((i=1; i<${#GAPI_DIRS[@]}; i++)); do
    DUPE="${GAPI_DIRS[$i]}"
    DUPE_NAME=$(basename "$DUPE")
    KEEP_NAME=$(basename "$KEEP")
    rm -rf "$DUPE"
    ln -s "$KEEP_NAME" "$DUPE"
    echo "  Deduped: $DUPE_NAME -> $KEEP_NAME"
  done
fi

# 5e. Final broken-symlink sweep (deep clean may orphan symlinks, e.g. type-only packages)
echo "Final broken-symlink sweep..."
while true; do
  BROKEN=$(find "$STAGING" -type l ! -exec test -e {} \; -print 2>/dev/null | head -1)
  [ -z "$BROKEN" ] && break
  find "$STAGING" -type l ! -exec test -e {} \; -delete 2>/dev/null || true
done
# Remove empty directories left behind
find "$STAGING/.pnpm" -type d -empty -delete 2>/dev/null || true

ORIG_SIZE=$(du -sh "$VERSO_ROOT/node_modules" | awk '{print $1}')
LEAN_SIZE=$(du -sh "$STAGING" | awk '{print $1}')
PNPM_SIZE=$(du -sh "$STAGING/.pnpm" | awk '{print $1}')
echo "Original node_modules: $ORIG_SIZE"
echo "Lean node_modules:     $LEAN_SIZE (actual .pnpm store: $PNPM_SIZE)"
echo "Done"

# 6. Clean symlinks in extensions that will break after packaging
#    (.bin/openclaw and .bin/verso point to ../verso-custom/ which won't exist in .app)
echo ""
echo "=== Cleaning packaging-incompatible symlinks in extensions ==="
find "$VERSO_ROOT/extensions" -type l \( -name "openclaw" -o -name "verso" \) -delete 2>/dev/null || true
find "$VERSO_ROOT/extensions" -type l ! -exec test -e {} \; -delete 2>/dev/null || true
echo "Done"

# 7. Copy shared JS libs into app's lib/ directory
#    main.js requires ./lib/deep-merge.cjs and ./lib/gateway-config.cjs
#    renderer HTML loads ../lib/provider-utils.iife.js
echo ""
echo "=== Copying shared JS libs ==="
SHARED_LIB="$ELECTRON_DIR/../shared/js/lib"
APP_LIB="$ELECTRON_DIR/lib"
rm -rf "$APP_LIB"
mkdir -p "$APP_LIB"
cp "$SHARED_LIB/deep-merge.cjs" "$APP_LIB/"
cp "$SHARED_LIB/gateway-config.cjs" "$APP_LIB/"
cp "$SHARED_LIB/provider-utils.iife.js" "$APP_LIB/"
echo "Copied shared libs to: $APP_LIB"

echo ""
echo "=== Build preparation complete ==="
echo "You can now run: cd $ELECTRON_DIR && npm run build:mac"
