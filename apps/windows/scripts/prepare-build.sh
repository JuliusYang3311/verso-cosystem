#!/bin/bash
set -e

# Prepare Windows build: build verso dist, create lean node_modules, copy shared libs.
# Can run on macOS (cross-compile via wine + electron-builder).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WINDOWS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSO_ROOT="$(cd "$WINDOWS_DIR/../.." && pwd)"

echo "=== Verso Desktop (Windows) Build Preparation ==="
echo "Verso root: $VERSO_ROOT"
echo "Windows dir: $WINDOWS_DIR"

# 1. Build verso if dist doesn't exist
if [ ! -f "$VERSO_ROOT/dist/index.js" ]; then
  echo ""
  echo "=== Building verso ==="
  cd "$VERSO_ROOT"
  npm run build 2>/dev/null || pnpm run build 2>/dev/null || echo "Warning: Could not build verso. Make sure dist/ exists."
fi

# 2. Create lean production node_modules (same as electron build)
STAGING="$VERSO_ROOT/build-node-modules"
if [ ! -d "$STAGING/.pnpm" ]; then
  echo ""
  echo "=== Creating lean production node_modules ==="
  rm -rf "$STAGING"
  mkdir -p "$STAGING"

  EXCLUDE_ARGS=(
    --exclude='.pnpm/electron@*'
    --exclude='.pnpm/@electron*'
    --exclude='.pnpm/electron-builder@*'
    --exclude='.pnpm/app-builder-bin@*'
    --exclude='.pnpm/app-builder-lib@*'
    --exclude='.pnpm/dmg-builder@*'
    --exclude='.pnpm/builder-util@*'
    --exclude='.pnpm/builder-util-runtime@*'
    --exclude='.pnpm/typescript@*'
    --exclude='.pnpm/@typescript+native-preview*'
    --exclude='.pnpm/tsdown@*'
    --exclude='.pnpm/@rolldown*'
    --exclude='.pnpm/rolldown@*'
    --exclude='.pnpm/vitest@*'
    --exclude='.pnpm/@vitest*'
    --exclude='.pnpm/oxlint*'
    --exclude='.pnpm/@oxlint*'
    --exclude='.pnpm/oxfmt*'
    --exclude='.pnpm/node-llama-cpp@*'
    --exclude='.pnpm/@node-llama-cpp*'
    --exclude='.pnpm/openclaw@*'
    --exclude='.pnpm/tsx@*'
    --exclude='.pnpm/lit@*'
    --exclude='.pnpm/@lit*'
    --exclude='.pnpm/ollama@*'
    --exclude='.pnpm/@types+*'
    --exclude='.pnpm/7zip-bin@*'
    --exclude='.pnpm/esbuild@*'
    --exclude='.pnpm/@esbuild*'
    --exclude='.pnpm/@cloudflare+workers-types@*'
    --exclude='.bin'
    # Exclude non-Windows native binaries
    --exclude='.pnpm/*darwin-arm64@*'
    --exclude='.pnpm/*darwin-x64@*'
    --exclude='.pnpm/*-linux-*'
    --exclude='.pnpm/*-android-*'
  )

  echo "Copying production node_modules (excluding dev packages)..."
  rsync -a "${EXCLUDE_ARGS[@]}" "$VERSO_ROOT/node_modules/" "$STAGING/"

  echo "Cleaning broken symlinks..."
  while true; do
    BROKEN=$(find "$STAGING" -type l ! -exec test -e {} \; -print 2>/dev/null | head -1)
    [ -z "$BROKEN" ] && break
    find "$STAGING" -type l ! -exec test -e {} \; -delete 2>/dev/null || true
  done
  echo "Cleaning workspace-escaping symlinks..."
  find "$STAGING" -type l -exec sh -c '
    for link; do
      target=$(readlink "$link" 2>/dev/null)
      case "$target" in ../../../*) rm -f "$link" ;; esac
    done
  ' _ {} +

  echo "Stripping non-runtime files..."
  find "$STAGING/.pnpm" -name "*.map" -type f -delete 2>/dev/null || true
  find "$STAGING/.pnpm" -name "*.d.ts" -type f -delete 2>/dev/null || true
  find "$STAGING/.pnpm" -name "*.d.mts" -type f -delete 2>/dev/null || true
  find "$STAGING/.pnpm" -name "*.d.cts" -type f -delete 2>/dev/null || true
  find "$STAGING/.pnpm" \( -iname "README.md" -o -iname "CHANGELOG.md" -o -iname "HISTORY.md" -o -iname "AUTHORS" -o -iname "AUTHORS.md" -o -iname "CONTRIBUTING.md" \) -type f -delete 2>/dev/null || true
  find "$STAGING/.pnpm" -type d \( -name "test" -o -name "tests" -o -name "__tests__" -o -name "spec" -o -name "example" -o -name "examples" -o -name "demo" -o -name "fixture" -o -name "fixtures" \) -exec rm -rf {} + 2>/dev/null || true
  find "$STAGING/.pnpm" -name "*.ts" ! -name "*.d.ts" ! -name "*.d.mts" -type f -delete 2>/dev/null || true

  echo "Final broken-symlink sweep..."
  while true; do
    BROKEN=$(find "$STAGING" -type l ! -exec test -e {} \; -print 2>/dev/null | head -1)
    [ -z "$BROKEN" ] && break
    find "$STAGING" -type l ! -exec test -e {} \; -delete 2>/dev/null || true
  done
  find "$STAGING/.pnpm" -type d -empty -delete 2>/dev/null || true

  ORIG_SIZE=$(du -sh "$VERSO_ROOT/node_modules" | awk '{print $1}')
  LEAN_SIZE=$(du -sh "$STAGING" | awk '{print $1}')
  echo "Original node_modules: $ORIG_SIZE"
  echo "Lean node_modules:     $LEAN_SIZE"
else
  echo "build-node-modules already exists, skipping."
fi

# 3. Copy shared JS libs into app's lib/ directory
echo ""
echo "=== Copying shared JS libs ==="
SHARED_LIB="$WINDOWS_DIR/../shared/js/lib"
APP_LIB="$WINDOWS_DIR/lib"
rm -rf "$APP_LIB"
mkdir -p "$APP_LIB"
cp "$SHARED_LIB/deep-merge.cjs" "$APP_LIB/"
cp "$SHARED_LIB/gateway-config.cjs" "$APP_LIB/"
cp "$SHARED_LIB/provider-utils.iife.js" "$APP_LIB/"
echo "Copied shared libs to: $APP_LIB"

# 4. Clean packaging-incompatible symlinks in extensions
echo ""
echo "=== Cleaning packaging-incompatible symlinks in extensions ==="
find "$VERSO_ROOT/extensions" -type l \( -name "openclaw" -o -name "verso" \) -delete 2>/dev/null || true
find "$VERSO_ROOT/extensions" -type l ! -exec test -e {} \; -delete 2>/dev/null || true
echo "Done"

echo ""
echo "=== Build preparation complete ==="
echo "You can now run: cd $WINDOWS_DIR && npx electron-builder --win --x64"
