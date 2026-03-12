#!/bin/bash
set -e

# Prepare Windows build: build verso dist, create lean node_modules, copy shared libs.
# Can run on macOS (cross-compile via wine + electron-builder).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WINDOWS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSO_ROOT="$(cd "$WINDOWS_DIR/../.." && pwd)"

NODE_VERSION="22.14.0"
PLATFORM="win"
ARCH="x64"

# ─── fix_pnpm_dep_isolation ──────────────────────────────────────────────────
# Problem: pnpm stores packages in .pnpm/<name>@<ver>/node_modules/<name>/ and
# places isolated sibling deps (different version than hoisted) next to them in
# .pnpm/<name>@<ver>/node_modules/<dep>/. When rsync -aL dereferences top-level
# symlinks (node_modules/X → .pnpm/.../X), the copied dir has no node_modules/,
# so Node.js falls back to the hoisted version instead of the isolated one.
#
# This function injects the correct isolated dep versions into the affected
# package directories. Add new entries to FIXES when a new collision is detected.
fix_pnpm_dep_isolation() {
  local staging="$1"
  echo ""
  echo "=== Fixing pnpm dep isolation (hoisting collisions) ==="

  # Format: "top-level-package : isolated-dep @ version"
  # Each entry means: <package> uses <dep>@<version> (not the hoisted version),
  # so we inject .pnpm/<dep>@<version>/node_modules/<dep> into <package>/node_modules/.
  local -a FIXES=(
    # proper-lockfile calls require('signal-exit') as a function at module top-level.
    # pnpm isolates signal-exit@3.0.7 for it, but the hoisted copy is v4 (object).
    "proper-lockfile : signal-exit @ 3.0.7"
  )

  local fixed=0
  for fix in "${FIXES[@]}"; do
    # Parse "pkg : dep @ ver" (spaces around delimiters are stripped)
    local pkg dep ver
    pkg=$(echo "$fix" | cut -d: -f1 | tr -d ' ')
    dep=$(echo "$fix" | cut -d: -f2 | cut -d@ -f1 | tr -d ' ')
    ver=$(echo "$fix" | cut -d: -f2 | cut -d@ -f2 | tr -d ' ')

    local pkg_dir="$staging/$pkg"
    local dep_src="$staging/.pnpm/${dep}@${ver}/node_modules/${dep}"
    local dep_dst="$pkg_dir/node_modules/${dep}"

    if [ ! -d "$pkg_dir" ]; then
      echo "  SKIP $pkg (not in staging)"
      continue
    fi
    if [ ! -d "$dep_src" ]; then
      echo "  WARN $pkg: source $dep@$ver not found in .pnpm — skipping"
      continue
    fi
    if [ -d "$dep_dst" ]; then
      echo "  OK   $pkg/$dep already present"
      continue
    fi

    mkdir -p "$pkg_dir/node_modules"
    cp -r "$dep_src" "$dep_dst"
    echo "  FIX  $pkg → injected $dep@$ver"
    fixed=$((fixed + 1))
  done

  echo "Hoisting collision fixes: $fixed applied"
}

echo "=== Verso Desktop (Windows) Build Preparation ==="
echo "Verso root: $VERSO_ROOT"
echo "Windows dir: $WINDOWS_DIR"
echo "Node version: $NODE_VERSION"

# 1. Build verso if dist doesn't exist
if [ ! -f "$VERSO_ROOT/dist/index.js" ]; then
  echo ""
  echo "=== Building verso ==="
  cd "$VERSO_ROOT"
  npm run build 2>/dev/null || pnpm run build 2>/dev/null || echo "Warning: Could not build verso. Make sure dist/ exists."
fi

# 2. Download Node.js binary for Windows x64
NODE_DIR="$WINDOWS_DIR/build-resources"
NODE_BIN="$NODE_DIR/node.exe"

if [ ! -f "$NODE_BIN" ]; then
  echo ""
  echo "=== Downloading Node.js $NODE_VERSION for win-$ARCH ==="
  mkdir -p "$NODE_DIR"

  NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/win-${ARCH}/node.exe"
  curl -L -o "$NODE_BIN" "$NODE_URL"
  echo "Node.js binary saved to: $NODE_BIN"
else
  echo "Node.js binary already exists: $NODE_BIN"
fi

# Copy node.exe to verso root so extraResources picks it up as gateway/node.exe
GATEWAY_NODE="$VERSO_ROOT/node.exe"
cp "$NODE_BIN" "$GATEWAY_NODE"
echo "Copied Node.js binary to: $GATEWAY_NODE"

# 3. Ensure Windows-specific native modules are installed
#    Building on macOS means only darwin binaries exist; we need win32-x64 variants.
echo ""
echo "=== Ensuring native modules for win-$ARCH ==="
cd "$VERSO_ROOT"

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

# sharp (image processing)
SHARP_VERSION=$(node -e "const p=require('$VERSO_ROOT/package.json'); console.log(p.dependencies['sharp']?.replace('^','') || '0.34.5')" 2>/dev/null || echo "0.34.5")
ensure_native_pkg "@img/sharp-win32-x64" "$SHARP_VERSION"
ensure_native_pkg "@img/sharp-libvips-win32-x64" "$(node -e "try{const p=require('@img/sharp-darwin-x64/package.json');const v=Object.keys(p.optionalDependencies||{})[0];console.log(p.optionalDependencies[v]?.replace('^',''))}catch{console.log('1.2.4')}" 2>/dev/null || echo "1.2.4")"

# sqlite-vec (vector search)
SQLITE_VEC_VERSION=$(node -e "const p=require('$VERSO_ROOT/package.json'); console.log(p.dependencies['sqlite-vec'] || '0.1.7-alpha.2')" 2>/dev/null || echo "0.1.7-alpha.2")
ensure_native_pkg "sqlite-vec-windows-x64" "$SQLITE_VEC_VERSION"

echo "Done"

# 4. Create lean production node_modules (Windows-specific: symlinks dereferenced)
#    Uses a separate dir from macOS build to avoid conflicts when building in parallel.
STAGING="$VERSO_ROOT/build-node-modules-win"
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
    --exclude='.pnpm/@openclaw*'
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
    # Exclude workspace self-references (circular symlinks: verso-custom → node_modules → .pnpm → ...)
    --exclude='verso-custom'
    --exclude='@openclaw'
    --exclude='openclaw'
    # macOS-only packages (crash on Windows)
    --exclude='.pnpm/fsevents@*'
    --exclude='fsevents'
    --exclude='.pnpm/iconv-corefoundation@*'
    --exclude='iconv-corefoundation'
    --exclude='.pnpm/dmg-license@*'
    --exclude='.pnpm/playwright@*'
    # Exclude non-Windows native binaries (at .pnpm top level)
    --exclude='.pnpm/*darwin-arm64@*'
    --exclude='.pnpm/*darwin-x64@*'
    --exclude='.pnpm/*-linux-*'
    --exclude='.pnpm/*-android-*'
    # Exclude macOS native binaries at any nesting depth (rsync -aL dereferences)
    --exclude='*-darwin-arm64'
    --exclude='*-darwin-x64'
    --exclude='*darwin-universal'
    --exclude='*.darwin-*.node'
    --exclude='*mac-arm64*'
    --exclude='*mac-x64*'
  )

  echo "Copying production node_modules (excluding dev packages)..."
  # -aL (not -a): dereference/follow symlinks so Windows gets real files.
  # pnpm uses symlinks extensively; Windows NSIS extraction can't handle them.
  # Workspace self-references (verso-custom, @openclaw) are excluded above to prevent
  # infinite recursion when following symlinks.
  rsync -aL "${EXCLUDE_ARGS[@]}" "$VERSO_ROOT/node_modules/" "$STAGING/"

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
  echo "build-node-modules-win already exists, skipping rsync."
fi

# Always run dep isolation fixes (idempotent — safe to run on existing staging dir).
fix_pnpm_dep_isolation "$STAGING"

# 5. Copy shared JS libs into app's lib/ directory
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

# 6. Clean packaging-incompatible symlinks in extensions
echo ""
echo "=== Cleaning packaging-incompatible symlinks in extensions ==="
find "$VERSO_ROOT/extensions" -type l \( -name "openclaw" -o -name "verso" \) -delete 2>/dev/null || true
find "$VERSO_ROOT/extensions" -type l ! -exec test -e {} \; -delete 2>/dev/null || true
echo "Done"

echo ""
echo "=== Build preparation complete ==="
echo "You can now run: cd $WINDOWS_DIR && npx electron-builder --win --x64"
