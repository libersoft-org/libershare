#!/bin/sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Build frontend
echo "=== Building frontend ==="
cd "$ROOT_DIR/frontend"
./build.sh

# Build backend
echo "=== Building backend ==="
cd "$ROOT_DIR/backend"
./build.sh

# Copy backend binary with target triple
echo "=== Preparing sidecar ==="
TARGET=$(rustc --print host-tuple)
BINARIES_DIR="$SCRIPT_DIR/binaries"
mkdir -p "$BINARIES_DIR"
cp "$ROOT_DIR/backend/build/lish-backend" "$BINARIES_DIR/lish-backend-$TARGET"
echo "Copied lish-backend as lish-backend-$TARGET"

# Build Tauri app
echo "=== Building Tauri app ==="
cd "$SCRIPT_DIR"
cargo tauri build

echo "=== Build complete ==="
echo "Output: $SCRIPT_DIR/build/release/bundle/"
