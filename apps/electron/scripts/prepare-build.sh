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

# 4. Remove broken symlinks in node_modules (pnpm workspace links that won't resolve in packaged app)
echo ""
echo "=== Cleaning broken symlinks in node_modules ==="
find "$VERSO_ROOT/node_modules/.pnpm/node_modules" -maxdepth 1 -type l ! -exec test -e {} \; -delete 2>/dev/null || true
find "$VERSO_ROOT/node_modules/.bin" -maxdepth 1 -type l ! -exec test -e {} \; -delete 2>/dev/null || true
echo "Done"

echo ""
echo "=== Build preparation complete ==="
echo "You can now run: cd $ELECTRON_DIR && npm run build:mac"
