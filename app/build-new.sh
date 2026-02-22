#!/bin/sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ─── Help ───────────────────────────────────────────────────────────────────

show_help() {
	cat <<'EOF'
Usage: ./build.sh [--os OS...] [--target ARCH...] [--format FMT...] [--help]

Options:
  --os        Operating systems to build for (combinable):
                linux, windows, macos, all
              Default: current platform

  --target    CPU architectures to build for (combinable):
                x86_64, aarch64, all
              Default: current architecture

  --format    Output package formats (combinable):
                Linux:   deb, rpm, appimage, zip
                Windows: nsis, zip
                macOS:   dmg, zip
                all (= all valid formats for chosen OS)
              Default: (none – only raw binary)

  --help      Show this help

Examples:
  ./build.sh
  ./build.sh --os linux --target x86_64 --format deb rpm
  ./build.sh --os linux --target all --format all
  ./build.sh --os linux windows --target x86_64 --format all
  ./build.sh --os windows --target x86_64 --format nsis zip

Notes:
  - Linux and Windows builds run inside Docker (requires Docker).
  - macOS builds require a macOS host (no Docker).
  - 'all' cannot be combined with other values in the same flag.

Prerequisites for cross-architecture builds:
  docker run --rm --privileged multiarch/qemu-user-static --reset -p yes
EOF
}

# ─── Parse arguments ────────────────────────────────────────────────────────

OS_LIST=""
TARGET_LIST=""
FORMAT_LIST=""
DOCKER_INNER=""
INNER_OS=""
INNER_ARCH=""

MODE=""
for arg in "$@"; do
	case "$arg" in
		--os)       MODE="os" ;;
		--target)   MODE="target" ;;
		--format)   MODE="format" ;;
		--help|-h)  show_help; exit 0 ;;
		--docker-inner) DOCKER_INNER=1; MODE="" ;;
		--inner-os)  MODE="inner-os" ;;
		--inner-arch) MODE="inner-arch" ;;
		*)
			case "$MODE" in
				os)         OS_LIST="$OS_LIST $arg" ;;
				target)     TARGET_LIST="$TARGET_LIST $arg" ;;
				format)     FORMAT_LIST="$FORMAT_LIST $arg" ;;
				inner-os)   INNER_OS="$arg"; MODE="" ;;
				inner-arch) INNER_ARCH="$arg"; MODE="" ;;
				*)          echo "Error: Unknown argument '$arg'"; echo "Use --help for usage."; exit 1 ;;
			esac
			;;
	esac
done

# ─── Detect host platform ──────────────────────────────────────────────────

detect_host_os() {
	case "$(uname -s)" in
		Linux)  echo "linux" ;;
		Darwin) echo "macos" ;;
		*)      echo "unknown" ;;
	esac
}

detect_host_arch() {
	case "$(uname -m)" in
		x86_64|amd64)   echo "x86_64" ;;
		aarch64|arm64)  echo "aarch64" ;;
		*)              echo "unknown" ;;
	esac
}

# ─── Validate inputs ───────────────────────────────────────────────────────

validate_no_all_combined() {
	local flag_name="$1"
	shift
	local has_all=0
	local count=0
	for val in "$@"; do
		count=$((count + 1))
		[ "$val" = "all" ] && has_all=1
	done
	if [ "$has_all" = "1" ] && [ "$count" -gt 1 ]; then
		echo "Error: --$flag_name 'all' cannot be combined with other values"
		exit 1
	fi
}

validate_os_values() {
	for os in $OS_LIST; do
		case "$os" in
			linux|windows|macos|all) ;;
			*) echo "Error: Unknown OS '$os'. Valid: linux, windows, macos, all"; exit 1 ;;
		esac
	done
}

validate_target_values() {
	for t in $TARGET_LIST; do
		case "$t" in
			x86_64|aarch64|all) ;;
			*) echo "Error: Unknown target '$t'. Valid: x86_64, aarch64, all"; exit 1 ;;
		esac
	done
}

validate_format_values() {
	for f in $FORMAT_LIST; do
		case "$f" in
			deb|rpm|appimage|nsis|dmg|zip|all) ;;
			*) echo "Error: Unknown format '$f'. Valid: deb, rpm, appimage, nsis, dmg, zip, all"; exit 1 ;;
		esac
	done
}

# Validate that formats are valid for given OS
validate_format_for_os() {
	local os="$1"
	local fmt="$2"
	case "$fmt" in
		all|zip) return 0 ;;
	esac
	case "$os" in
		linux)
			case "$fmt" in
				deb|rpm|appimage) return 0 ;;
				*) echo "Error: Format '$fmt' is not valid for OS 'linux'. Valid: deb, rpm, appimage, zip"; exit 1 ;;
			esac
			;;
		windows)
			case "$fmt" in
				nsis) return 0 ;;
				*) echo "Error: Format '$fmt' is not valid for OS 'windows'. Valid: nsis, zip"; exit 1 ;;
			esac
			;;
		macos)
			case "$fmt" in
				dmg) return 0 ;;
				*) echo "Error: Format '$fmt' is not valid for OS 'macos'. Valid: dmg, zip"; exit 1 ;;
			esac
			;;
	esac
}

# Expand 'all' into concrete format list for an OS
expand_formats_for_os() {
	local os="$1"
	case "$os" in
		linux)   echo "deb rpm appimage zip" ;;
		windows) echo "nsis zip" ;;
		macos)   echo "dmg zip" ;;
	esac
}

# ─── Docker inner build ────────────────────────────────────────────────────
# This runs INSIDE the Docker container

docker_inner_build() {
	BUILD_OS="$INNER_OS"
	BUILD_ARCH="$INNER_ARCH"

	echo "========================================"
	echo "Building: OS=$BUILD_OS ARCH=$BUILD_ARCH"
	echo "========================================"

	# Determine Rust target triple
	RUST_TARGET=""
	BUN_TARGET=""
	case "${BUILD_OS}_${BUILD_ARCH}" in
		linux_x86_64)
			RUST_TARGET="x86_64-unknown-linux-gnu"
			BUN_TARGET="bun-linux-x64"
			;;
		linux_aarch64)
			RUST_TARGET="aarch64-unknown-linux-gnu"
			BUN_TARGET="bun-linux-arm64"
			;;
		windows_x86_64)
			RUST_TARGET="x86_64-pc-windows-msvc"
			BUN_TARGET="bun-windows-x64"
			;;
		windows_aarch64)
			RUST_TARGET="aarch64-pc-windows-msvc"
			BUN_TARGET="bun-windows-arm64"
			;;
		*)
			echo "Error: Unsupported OS/arch combination: $BUILD_OS/$BUILD_ARCH"
			exit 1
			;;
	esac

	# Ensure Rust target is installed
	rustup target add "$RUST_TARGET" 2>/dev/null || true

	# Build formats argument for cargo tauri build
	BUNDLE_ARGS=""
	MAKE_ZIP=0
	HAS_FORMATS=0
	for fmt in $FORMAT_LIST; do
		case "$fmt" in
			all)
				HAS_FORMATS=1
				for efmt in $(expand_formats_for_os "$BUILD_OS"); do
					case "$efmt" in
						zip)       MAKE_ZIP=1 ;;
						*)         BUNDLE_ARGS="$BUNDLE_ARGS --bundles $efmt" ;;
					esac
				done
				;;
			zip)
				# zip is valid for all OSes
				HAS_FORMATS=1
				MAKE_ZIP=1
				;;
			*)
				# Only include formats valid for this OS, skip others silently
				case "$BUILD_OS" in
					linux)   case "$fmt" in deb|rpm|appimage) HAS_FORMATS=1; BUNDLE_ARGS="$BUNDLE_ARGS --bundles $fmt" ;; esac ;;
					windows) case "$fmt" in nsis)             HAS_FORMATS=1; BUNDLE_ARGS="$BUNDLE_ARGS --bundles $fmt" ;; esac ;;
					macos)   case "$fmt" in dmg)              HAS_FORMATS=1; BUNDLE_ARGS="$BUNDLE_ARGS --bundles $fmt" ;; esac ;;
				esac
				;;
		esac
	done
	# If no --format specified, build only the binary (no bundles)
	if [ "$HAS_FORMATS" = "0" ]; then
		BUNDLE_ARGS="--bundles none"
	fi

	# ── Icons (only if not already generated) ──
	if [ ! -d "$SCRIPT_DIR/icons" ]; then
		echo "=== Generating icons ==="
		ICONS_DIR="$SCRIPT_DIR/icons"
		SVG="$ROOT_DIR/frontend/static/favicon.svg"
		mkdir -p "$ICONS_DIR"
		CONVERT="convert"
		command -v magick >/dev/null 2>&1 && CONVERT="magick"
		HAS_RSVG=0
		command -v rsvg-convert >/dev/null 2>&1 && HAS_RSVG=1
		for SIZE_NAME in "32 32x32" "128 128x128" "256 128x128@2x" "256 icon"; do
			SIZE=$(echo "$SIZE_NAME" | cut -d' ' -f1)
			NAME=$(echo "$SIZE_NAME" | cut -d' ' -f2)
			if [ "$HAS_RSVG" = "1" ]; then
				rsvg-convert -w "$SIZE" -h "$SIZE" "$SVG" | $CONVERT png:- -define png:color-type=6 "$ICONS_DIR/$NAME.png"
			else
				$CONVERT -background none -resize "${SIZE}x${SIZE}" "$SVG" -define png:color-type=6 "$ICONS_DIR/$NAME.png"
			fi
		done
		if [ "$HAS_RSVG" = "1" ]; then
			rsvg-convert -w 256 -h 256 "$SVG" | $CONVERT png:- "$ICONS_DIR/icon.ico"
		else
			$CONVERT -background none -resize "256x256" "$SVG" "$ICONS_DIR/icon.ico"
		fi
	fi

	# ── Frontend (only if not already built) ──
	if [ ! -d "$ROOT_DIR/frontend/build" ]; then
		echo "=== Building frontend ==="
		cd "$ROOT_DIR/frontend"
		./build.sh
	fi

	# ── Backend ──
	echo "=== Building backend (target: $BUN_TARGET) ==="
	cd "$ROOT_DIR/backend"
	./build.sh --target "$BUN_TARGET"

	# ── Product info ──
	PRODUCT_JSON="$ROOT_DIR/shared/src/product.json"
	PRODUCT_NAME=$(jq -r '.name' "$PRODUCT_JSON")
	PRODUCT_VERSION=$(jq -r '.version' "$PRODUCT_JSON")
	PRODUCT_IDENTIFIER=$(jq -r '.identifier' "$PRODUCT_JSON")
	PRODUCT_NAME_LOWER=$(echo "$PRODUCT_NAME" | tr '[:upper:]' '[:lower:]')
	echo "Product: $PRODUCT_NAME v$PRODUCT_VERSION ($PRODUCT_IDENTIFIER)"

	# ── Sync product info to configs ──
	jq --tab --arg name "$PRODUCT_NAME" --arg ver "$PRODUCT_VERSION" --arg id "$PRODUCT_IDENTIFIER" \
		'.productName = $name | .mainBinaryName = $name | .version = $ver | .identifier = $id | .bundle.windows.nsis.startMenuFolder = $name' \
		"$SCRIPT_DIR/tauri.conf.json" > "$SCRIPT_DIR/tauri.conf.json.tmp" && mv "$SCRIPT_DIR/tauri.conf.json.tmp" "$SCRIPT_DIR/tauri.conf.json"

	sed -i "s/^version = \"[^\"]*\"/version = \"$PRODUCT_VERSION\"/" "$SCRIPT_DIR/Cargo.toml"

	if [ "$BUILD_OS" = "linux" ]; then
		jq --tab --arg name "$PRODUCT_NAME_LOWER" \
			'.productName = $name | .mainBinaryName = $name
			| .bundle.linux.deb.files = {("/usr/share/applications/" + $name + "-debug.desktop"): "desktop-entry-debug.desktop"}
			| .bundle.linux.rpm.files = {("/usr/share/applications/" + $name + "-debug.desktop"): "desktop-entry-debug.desktop"}
			| .bundle.linux.appimage.files = {("usr/share/applications/" + $name + "-debug.desktop"): "desktop-entry-debug.desktop"}' \
			"$SCRIPT_DIR/tauri.linux.conf.json" > "$SCRIPT_DIR/tauri.linux.conf.json.tmp" && mv "$SCRIPT_DIR/tauri.linux.conf.json.tmp" "$SCRIPT_DIR/tauri.linux.conf.json"

		# Make copies of desktop entries to avoid in-place modification conflicts across targets
		cp "$SCRIPT_DIR/desktop-entry-debug.desktop" "$SCRIPT_DIR/desktop-entry-debug.desktop.orig" 2>/dev/null || true
		sed -i "s/{{product_name}}/$PRODUCT_NAME/g; s/{{exec_name}}/$PRODUCT_NAME_LOWER/g" "$SCRIPT_DIR/desktop-entry-debug.desktop"

		cp "$SCRIPT_DIR/desktop-entry.desktop" "$SCRIPT_DIR/desktop-entry.desktop.orig" 2>/dev/null || true
		sed -i "s/%%product_name%%/$PRODUCT_NAME/g" "$SCRIPT_DIR/desktop-entry.desktop"
	fi

	if [ "$BUILD_OS" = "windows" ]; then
		sed -i "s/{{product_name}}/$PRODUCT_NAME/g" "$SCRIPT_DIR/wix-fragment-debug.wxs"
	fi

	# ── Build Tauri app ──
	echo "=== Building Tauri app (target: $RUST_TARGET) ==="
	cd "$SCRIPT_DIR"

	# LDD wrapper for Linux AppImage builds (Bun binaries fail ldd)
	if [ "$BUILD_OS" = "linux" ]; then
		LDD_WRAPPER_DIR=$(mktemp -d)
		cat > "$LDD_WRAPPER_DIR/ldd" << 'LDDWRAPPER'
#!/bin/sh
output=$(/usr/bin/ldd "$@" 2>&1)
rc=$?
if [ $rc -ne 0 ]; then
	echo "	statically linked"
	exit 0
fi
echo "$output"
exit $rc
LDDWRAPPER
		chmod +x "$LDD_WRAPPER_DIR/ldd"
		export PATH="$LDD_WRAPPER_DIR:$PATH"
	fi

	# Windows cross-build setup
	if [ "$BUILD_OS" = "windows" ]; then
		# cargo-xwin handles Windows SDK automatically
		if ! command -v cargo-xwin >/dev/null 2>&1; then
			echo "Installing cargo-xwin..."
			cargo install cargo-xwin
		fi
		cargo xwin tauri build --target "$RUST_TARGET" $BUNDLE_ARGS
	else
		cargo tauri build --target "$RUST_TARGET" $BUNDLE_ARGS
	fi

	# ── Fix AppImage backend ──
	APPIMAGE_DIR="$SCRIPT_DIR/build/${RUST_TARGET}/release/bundle/appimage"
	if [ -d "$APPIMAGE_DIR" ]; then
		ORIGINAL_BACKEND="$ROOT_DIR/backend/build/lish-backend"
		if [ -f "$ORIGINAL_BACKEND" ]; then
			for appimage_file in "$APPIMAGE_DIR"/*.AppImage; do
				[ -f "$appimage_file" ] || continue
				echo "=== Fixing AppImage backend binary ==="
				APPIMAGE_WORK_DIR=$(mktemp -d)
				cd "$APPIMAGE_WORK_DIR"

				chmod +x "$appimage_file"
				"$appimage_file" --appimage-extract >/dev/null 2>&1

				BACKEND_IN_APPIMAGE=$(find squashfs-root -name "lish-backend" -type f | head -1)
				if [ -n "$BACKEND_IN_APPIMAGE" ]; then
					HASH_BEFORE=$(md5sum "$BACKEND_IN_APPIMAGE" | cut -d' ' -f1)
					cp "$ORIGINAL_BACKEND" "$BACKEND_IN_APPIMAGE"
					chmod +x "$BACKEND_IN_APPIMAGE"
					HASH_AFTER=$(md5sum "$BACKEND_IN_APPIMAGE" | cut -d' ' -f1)
					echo "Backend hash before: $HASH_BEFORE"
					echo "Backend hash after:  $HASH_AFTER"
				fi

				APPIMAGETOOL=""
				if command -v appimagetool >/dev/null 2>&1; then
					APPIMAGETOOL="appimagetool"
				else
					APPIMAGETOOL="$APPIMAGE_WORK_DIR/appimagetool"
					echo "Downloading appimagetool..."
					# Download arch-appropriate appimagetool
					APPIMG_ARCH="$BUILD_ARCH"
					[ "$APPIMG_ARCH" = "aarch64" ] && APPIMG_ARCH="aarch64"
					[ "$APPIMG_ARCH" = "x86_64" ] && APPIMG_ARCH="x86_64"
					curl -fsSL -o "$APPIMAGETOOL" "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-${APPIMG_ARCH}.AppImage"
					chmod +x "$APPIMAGETOOL"
				fi
				ARCH="$BUILD_ARCH" "$APPIMAGETOOL" squashfs-root "$appimage_file" >/dev/null 2>&1
				chmod +x "$appimage_file"

				cd "$SCRIPT_DIR"
				rm -rf "$APPIMAGE_WORK_DIR"
				echo "AppImage backend fix complete"
			done
		fi
	fi

	# ── Restore desktop entries from originals ──
	[ -f "$SCRIPT_DIR/desktop-entry-debug.desktop.orig" ] && mv "$SCRIPT_DIR/desktop-entry-debug.desktop.orig" "$SCRIPT_DIR/desktop-entry-debug.desktop"
	[ -f "$SCRIPT_DIR/desktop-entry.desktop.orig" ] && mv "$SCRIPT_DIR/desktop-entry.desktop.orig" "$SCRIPT_DIR/desktop-entry.desktop"

	# Clean up LDD wrapper
	[ -n "$LDD_WRAPPER_DIR" ] && rm -rf "$LDD_WRAPPER_DIR"

	# ── Move and rename output bundles ──
	BUILD_OUTPUT_DIR="$SCRIPT_DIR/build/${RUST_TARGET}/release/bundle"
	FINAL_DIR="$SCRIPT_DIR/build/release/bundle"
	mkdir -p "$FINAL_DIR"

	VERSION="$PRODUCT_VERSION"
	ARCH="$BUILD_ARCH"
	OS_LABEL="$BUILD_OS"

	# Windows: patch PE subsystem from CONSOLE to WINDOWS_GUI
	if [ "$BUILD_OS" = "windows" ]; then
		WIN_EXE="$SCRIPT_DIR/build/${RUST_TARGET}/release/${PRODUCT_NAME}.exe"
		if [ -f "$WIN_EXE" ]; then
			echo "=== Patching PE subsystem to GUI ==="
			python3 -c "
import struct, sys
f = open(sys.argv[1], 'r+b')
f.seek(0x3C)
pe_offset = struct.unpack('<I', f.read(4))[0]
f.seek(pe_offset + 0x5C)
f.write(struct.pack('<H', 2))
f.close()
" "$WIN_EXE"
		fi
	fi

	for dir in deb rpm appimage nsis dmg; do
		if [ -d "$BUILD_OUTPUT_DIR/$dir" ]; then
			for f in "$BUILD_OUTPUT_DIR/$dir"/*; do
				[ -f "$f" ] || continue
				EXT="${f##*.}"
				case "$EXT" in
					deb)      NEWNAME="${PRODUCT_NAME}_${VERSION}_${OS_LABEL}_${ARCH}.deb" ;;
					rpm)      NEWNAME="${PRODUCT_NAME}_${VERSION}_${OS_LABEL}_${ARCH}.rpm" ;;
					AppImage) NEWNAME="${PRODUCT_NAME}_${VERSION}_${OS_LABEL}_${ARCH}.AppImage" ;;
					exe)      NEWNAME="${PRODUCT_NAME}_${VERSION}_${OS_LABEL}_${ARCH}_setup.exe" ;;
					dmg)      NEWNAME="${PRODUCT_NAME}_${VERSION}_${OS_LABEL}_${ARCH}.dmg" ;;
					*)        NEWNAME="$(basename "$f")" ;;
				esac
				mv "$f" "$FINAL_DIR/$NEWNAME"
				[ "$EXT" = "AppImage" ] && chmod +x "$FINAL_DIR/$NEWNAME"
			done
			rmdir "$BUILD_OUTPUT_DIR/$dir" 2>/dev/null || true
		fi
	done

	# ── ZIP bundle ──
	if [ "$MAKE_ZIP" = "1" ]; then
		echo "=== Creating ZIP bundle ==="
		if [ "$BUILD_OS" = "linux" ]; then
			ZIP_STAGING=$(mktemp -d)
			cp "$SCRIPT_DIR/build/${RUST_TARGET}/release/$PRODUCT_NAME_LOWER" "$ZIP_STAGING/"
			cp "$ROOT_DIR/backend/build/lish-backend" "$ZIP_STAGING/lish-backend"
			sed "s/{{product_name}}/$PRODUCT_NAME/g; s/{{exec_name}}/$PRODUCT_NAME_LOWER/g" \
				"$SCRIPT_DIR/bundle-scripts/debug.sh" > "$ZIP_STAGING/debug.sh"
			chmod +x "$ZIP_STAGING/$PRODUCT_NAME_LOWER" "$ZIP_STAGING/lish-backend" "$ZIP_STAGING/debug.sh"
			cd "$ZIP_STAGING"
			zip -ry "$FINAL_DIR/${PRODUCT_NAME}_${VERSION}_${OS_LABEL}_${ARCH}.zip" .
			rm -rf "$ZIP_STAGING"
		elif [ "$BUILD_OS" = "windows" ]; then
			ZIP_STAGING=$(mktemp -d)
			cp "$SCRIPT_DIR/build/${RUST_TARGET}/release/${PRODUCT_NAME}.exe" "$ZIP_STAGING/"
			cp "$ROOT_DIR/backend/build/lish-backend.exe" "$ZIP_STAGING/lish-backend.exe"
			cd "$ZIP_STAGING"
			zip -ry "$FINAL_DIR/${PRODUCT_NAME}_${VERSION}_${OS_LABEL}_${ARCH}.zip" .
			rm -rf "$ZIP_STAGING"
		fi
	fi

	echo "=== Build complete: OS=$BUILD_OS ARCH=$BUILD_ARCH ==="
	echo "Output: $FINAL_DIR/"
}

# ─── Docker inner mode ──────────────────────────────────────────────────────

if [ "$DOCKER_INNER" = "1" ]; then
	docker_inner_build
	exit 0
fi

# ─── Orchestrator mode (runs on host, spawns Docker containers) ─────────────

# Defaults
HOST_OS=$(detect_host_os)
HOST_ARCH=$(detect_host_arch)

[ -z "$OS_LIST" ] && OS_LIST="$HOST_OS"
[ -z "$TARGET_LIST" ] && TARGET_LIST="$HOST_ARCH"

# Validate
validate_os_values
validate_target_values
validate_format_values
validate_no_all_combined "os" $OS_LIST
validate_no_all_combined "target" $TARGET_LIST
validate_no_all_combined "format" $FORMAT_LIST

# Expand 'all'
case "$OS_LIST" in *all*) OS_LIST="linux windows" ;; esac
case "$TARGET_LIST" in *all*) TARGET_LIST="x86_64 aarch64" ;; esac

# Validate formats against each OS (skip - formats are filtered per-OS in inner build)
# Only check that format values are recognized (already done by validate_format_values)

# Check macOS constraint
for os in $OS_LIST; do
	if [ "$os" = "macos" ] && [ "$HOST_OS" != "macos" ]; then
		echo "Error: macOS builds require a macOS host."
		exit 1
	fi
done

# Check Docker availability (needed for non-macOS builds)
NEEDS_DOCKER=0
for os in $OS_LIST; do
	[ "$os" != "macos" ] && NEEDS_DOCKER=1
done
if [ "$NEEDS_DOCKER" = "1" ]; then
	if ! command -v docker >/dev/null 2>&1; then
		echo "Error: Docker is required for Linux/Windows builds. Install Docker first."
		exit 1
	fi
fi

# ── Ensure QEMU is registered for cross-arch builds ──
NEEDS_CROSS_ARCH=0
for os in $OS_LIST; do
	for target in $TARGET_LIST; do
		[ "$target" != "$HOST_ARCH" ] && NEEDS_CROSS_ARCH=1
	done
done
if [ "$NEEDS_CROSS_ARCH" = "1" ] && [ "$HOST_OS" = "linux" ]; then
	# Check if binfmt_misc is set up for the needed arch
	QEMU_OK=1
	for target in $TARGET_LIST; do
		[ "$target" = "$HOST_ARCH" ] && continue
		case "$target" in
			aarch64) [ ! -f /proc/sys/fs/binfmt_misc/qemu-aarch64 ] && QEMU_OK=0 ;;
			x86_64)  [ ! -f /proc/sys/fs/binfmt_misc/qemu-x86_64 ] && QEMU_OK=0 ;;
		esac
	done
	if [ "$QEMU_OK" = "0" ]; then
		echo "=== Registering QEMU user-static for cross-arch emulation ==="
		docker run --rm --privileged multiarch/qemu-user-static --reset -p yes
	fi
fi

# ── Build Docker images for needed platforms ──
DOCKER_IMAGE_BASE="libershare-builder"
if [ "$NEEDS_DOCKER" = "1" ]; then
	# Collect unique Docker platforms needed
	PLATFORMS_NEEDED=""
	for os in $OS_LIST; do
		for target in $TARGET_LIST; do
			case "${os}_${target}" in
				linux_x86_64|windows_x86_64|windows_aarch64) PLAT="linux/amd64" ;;
				linux_aarch64) PLAT="linux/arm64" ;;
				macos_*) continue ;;
				*) continue ;;
			esac
			# Add if not already in list
			case "$PLATFORMS_NEEDED" in
				*"$PLAT"*) ;;
				*) PLATFORMS_NEEDED="$PLATFORMS_NEEDED $PLAT" ;;
			esac
		done
	done

	for plat in $PLATFORMS_NEEDED; do
		# Tag: libershare-builder:amd64 or libershare-builder:arm64
		PLAT_TAG=$(echo "$plat" | sed 's|linux/||')
		IMAGE_TAG="${DOCKER_IMAGE_BASE}:${PLAT_TAG}"

		# Check if image already exists
		if docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
			echo "=== Docker image $IMAGE_TAG already exists (cached) ==="
		else
			echo "=== Building Docker image for $plat ==="
			echo "    (first build for a new platform may take a long time)"
			DOCKER_BUILDKIT=1 docker build --network=host --platform "$plat" -t "$IMAGE_TAG" "$SCRIPT_DIR"
		fi
	done
fi

# ── Clean old output ──
[ -d "$SCRIPT_DIR/build/release/bundle" ] && rm -rf "$SCRIPT_DIR/build/release/bundle"
[ -d "$SCRIPT_DIR/icons" ] && rm -rf "$SCRIPT_DIR/icons"
[ -d "$ROOT_DIR/frontend/build" ] && rm -rf "$ROOT_DIR/frontend/build"
mkdir -p "$SCRIPT_DIR/build/release/bundle"

# ── Iterate over OS × target combinations ──

# Build format args to pass through
FORMAT_ARGS=""
for fmt in $FORMAT_LIST; do
	FORMAT_ARGS="$FORMAT_ARGS $fmt"
done

for os in $OS_LIST; do
	for target in $TARGET_LIST; do
		echo ""
		echo "╔══════════════════════════════════════════════════╗"
		echo "║  Building: OS=$os  ARCH=$target"
		echo "╚══════════════════════════════════════════════════╝"
		echo ""

		if [ "$os" = "macos" ]; then
			# macOS: native build (no Docker)
			echo "Error: macOS native build not yet implemented in new build system."
			echo "Use the legacy build.sh directly on macOS for now."
			exit 1
		fi

		# Determine Docker platform and image tag
		DOCKER_PLATFORM=""
		case "${os}_${target}" in
			linux_x86_64)    DOCKER_PLATFORM="linux/amd64" ;;
			linux_aarch64)   DOCKER_PLATFORM="linux/arm64" ;;
			windows_x86_64)  DOCKER_PLATFORM="linux/amd64" ;;
			windows_aarch64) DOCKER_PLATFORM="linux/amd64" ;;
			*)
				echo "Error: Unsupported combination: OS=$os ARCH=$target"
				exit 1
				;;
		esac
		PLAT_TAG=$(echo "$DOCKER_PLATFORM" | sed 's|linux/||')
		DOCKER_IMAGE="${DOCKER_IMAGE_BASE}:${PLAT_TAG}"

		# Compose --format args for inner script
		INNER_FORMAT_ARGS=""
		if [ -n "$FORMAT_LIST" ]; then
			INNER_FORMAT_ARGS="--format $FORMAT_LIST"
		fi

		# Run build inside Docker
		docker run --rm \
			--network=host \
			--platform "$DOCKER_PLATFORM" \
			-v "$ROOT_DIR:/workspace" \
			-v "${HOME}/.cargo/registry:/root/.cargo/registry" \
			-v "${HOME}/.cargo/git:/root/.cargo/git" \
			-v "${HOME}/.bun/install/cache:/root/.bun/install/cache" \
			-e APPIMAGE_EXTRACT_AND_RUN=1 \
			"$DOCKER_IMAGE" \
			sh -c "cd /workspace/app && ./build-new.sh --docker-inner --inner-os $os --inner-arch $target $INNER_FORMAT_ARGS"

		echo ""
		echo "=== Done: OS=$os ARCH=$target ==="
	done
done

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  All builds complete!                            ║"
echo "╚══════════════════════════════════════════════════╝"
echo "Output: $SCRIPT_DIR/build/release/bundle/"
ls -la "$SCRIPT_DIR/build/release/bundle/" 2>/dev/null || true
