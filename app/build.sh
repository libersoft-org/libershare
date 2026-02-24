#!/bin/sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Clean up on exit/crash/interrupt
_INTERRUPTED=0
cleanup() {
	trap '' INT TERM EXIT # Prevent re-entry
	if [ "$_INTERRUPTED" = "1" ]; then
		kill 0 2>/dev/null || true # Signal the entire process group
		wait 2>/dev/null || true
	fi
	[ -n "$LDD_WRAPPER_DIR" ] && rm -rf "$LDD_WRAPPER_DIR" 2>/dev/null
	# Restore modified files if originals exist
	[ -f "$SCRIPT_DIR/desktop-entry-debug.desktop.orig" ] && mv "$SCRIPT_DIR/desktop-entry-debug.desktop.orig" "$SCRIPT_DIR/desktop-entry-debug.desktop" 2>/dev/null
	[ -f "$SCRIPT_DIR/desktop-entry.desktop.orig" ] && mv "$SCRIPT_DIR/desktop-entry.desktop.orig" "$SCRIPT_DIR/desktop-entry.desktop" 2>/dev/null
	[ -f "$SCRIPT_DIR/wix-fragment-debug.wxs.orig" ] && mv "$SCRIPT_DIR/wix-fragment-debug.wxs.orig" "$SCRIPT_DIR/wix-fragment-debug.wxs" 2>/dev/null
	[ -f "$SCRIPT_DIR/tauri.conf.json.orig" ] && mv "$SCRIPT_DIR/tauri.conf.json.orig" "$SCRIPT_DIR/tauri.conf.json" 2>/dev/null
	[ -f "$SCRIPT_DIR/Cargo.toml.orig" ] && mv "$SCRIPT_DIR/Cargo.toml.orig" "$SCRIPT_DIR/Cargo.toml" 2>/dev/null
	[ -f "$SCRIPT_DIR/tauri.linux.conf.json.orig" ] && mv "$SCRIPT_DIR/tauri.linux.conf.json.orig" "$SCRIPT_DIR/tauri.linux.conf.json" 2>/dev/null
	true
}
trap cleanup EXIT
trap '_INTERRUPTED=1; echo ""; echo "Interrupted."; exit 130' INT TERM

# Print a box around a message
print_box() {
	_pb_msg="$1"
	_pb_len=${#_pb_msg}
	_pb_border=""
	_pb_i=0
	while [ "$_pb_i" -lt "$_pb_len" ]; do
		_pb_border="${_pb_border}═"
		_pb_i=$((_pb_i + 1))
	done
	echo "╔═${_pb_border}═╗"
	echo "║ ${_pb_msg} ║"
	echo "╚═${_pb_border}═╝"
}
elapsed_since() {
	_el=$(($(date +%s) - $1))
	if [ "$_el" -ge 60 ]; then
		printf '%dm %ds' $((_el / 60)) $((_el % 60))
	else
		printf '%ds' "$_el"
	fi
}

# ─── Help ───────────────────────────────────────────────────────────────────

show_help() {
	_help_name="$(basename "$0")"
	cat <<EOF
Usage: ./$_help_name [--os OS...] [--target ARCH...] [--format FMT...] [--compress LEVEL] [--help]

Options:
  --os        Operating systems to build for (combinable):
                linux, windows, macos, all
              Default: all

  --target    CPU architectures to build for (combinable):
                x86_64, aarch64, universal (macOS only), all
              Default: all
              'all' on macOS = x86_64 + aarch64 + universal
              'all' on Linux/Windows = x86_64 + aarch64

  --format    Output package formats (combinable):
                Linux:   deb, rpm, pacman, appimage, zip
                Windows: nsis, msi, zip
                macOS:   dmg, zip
                all (= all valid formats for chosen OS)
              Default: all (= all valid formats for chosen OS)

  --compress  Compression level for packages (default: mid):
                min  = xz -1e -T0  (fastest)
                mid  = xz -6e -T0  (balanced)
                max  = xz -9e -T0  (smallest - high RAM usage!)
              AppImage always uses squashfs xz with BCJ filter (not affected).
              RPM uses rpmbuild native xz (without -e).

  --docker-rebuild  Force rebuild of the Docker image (e.g. after Dockerfile changes)

  --help      Show this help

Examples:
  ./$_help_name
  ./$_help_name --os linux --target x86_64 --format deb rpm
  ./$_help_name --os linux --target all --format all
  ./$_help_name --os linux windows --target x86_64 --format all
  ./$_help_name --os windows --target x86_64 --format nsis zip
  ./$_help_name --os macos --target universal --format dmg zip

Notes:
  - Linux and Windows builds run inside Docker (requires Docker).
  - macOS builds require a macOS host (no Docker).
  - 'all' cannot be combined with other values in the same flag.
  - Cross-arch Linux builds use cross-linkers (no QEMU needed).
  - 'universal' target creates a fat binary (macOS only, via lipo).
EOF
}

# ─── Parse arguments ────────────────────────────────────────────────────────

OS_LIST=""
TARGET_LIST=""
FORMAT_LIST=""
COMPRESS_LEVEL="mid"
DOCKER_INNER=""
DOCKER_REBUILD=""
INNER_OS=""
INNER_ARCH=""

MODE=""
for arg in "$@"; do
	case "$arg" in
	--os) MODE="os" ;;
	--target) MODE="target" ;;
	--format) MODE="format" ;;
	--help | -h)
		show_help
		exit 0
		;;
	--compress) MODE="compress" ;;
	--docker-inner)
		DOCKER_INNER=1
		MODE=""
		;;
	--docker-rebuild)
		DOCKER_REBUILD=1
		MODE=""
		;;
	--inner-os) MODE="inner-os" ;;
	--inner-arch) MODE="inner-arch" ;;
	*)
		case "$MODE" in
		os) OS_LIST="$OS_LIST $arg" ;;
		target) TARGET_LIST="$TARGET_LIST $arg" ;;
		format) FORMAT_LIST="$FORMAT_LIST $arg" ;;
		compress)
			COMPRESS_LEVEL="$arg"
			MODE=""
			;;
		inner-os)
			INNER_OS="$arg"
			MODE=""
			;;
		inner-arch)
			INNER_ARCH="$arg"
			MODE=""
			;;
		*)
			echo "Error: Unknown argument '$arg'"
			echo "Use --help for usage."
			exit 1
			;;
		esac
		;;
	esac
done

# ─── Resolve compression level ──────────────────────────────────────────────

case "$COMPRESS_LEVEL" in
min)
	XZ_FLAGS="-1e -T0 --memlimit-compress=75%"
	RPM_PAYLOAD="w1.xzdio"
	ZIP_LEVEL="-1"
	;;
mid)
	XZ_FLAGS="-6e -T0 --memlimit-compress=75%"
	RPM_PAYLOAD="w6.xzdio"
	ZIP_LEVEL="-6"
	;;
max)
	XZ_FLAGS="-9e -T0 --memlimit-compress=75%"
	RPM_PAYLOAD="w9.xzdio"
	ZIP_LEVEL="-9"
	;;
*)
	echo "Error: Invalid --compress value '$COMPRESS_LEVEL' (use: min, mid, max)"
	exit 1
	;;
esac

# ─── Detect host platform ──────────────────────────────────────────────────

detect_host_os() {
	case "$(uname -s)" in
	Linux) echo "linux" ;;
	Darwin) echo "macos" ;;
	*) echo "unknown" ;;
	esac
}

detect_host_arch() {
	case "$(uname -m)" in
	x86_64 | amd64) echo "x86_64" ;;
	aarch64 | arm64) echo "aarch64" ;;
	*) echo "unknown" ;;
	esac
}

# ─── Validate inputs ───────────────────────────────────────────────────────

validate_no_all_combined() {
	_vanc_flag_name="$1"
	shift
	_vanc_has_all=0
	_vanc_count=0
	for val in "$@"; do
		_vanc_count=$((_vanc_count + 1))
		[ "$val" = "all" ] && _vanc_has_all=1
	done
	if [ "$_vanc_has_all" = "1" ] && [ "$_vanc_count" -gt 1 ]; then
		echo "Error: --$_vanc_flag_name 'all' cannot be combined with other values"
		exit 1
	fi
}

validate_os_values() {
	for os in $OS_LIST; do
		case "$os" in
		linux | windows | macos | all) ;;
		*)
			echo "Error: Unknown OS '$os'. Valid: linux, windows, macos, all"
			exit 1
			;;
		esac
	done
}

validate_target_values() {
	for t in $TARGET_LIST; do
		case "$t" in
		x86_64 | aarch64 | universal | all) ;;
		*)
			echo "Error: Unknown target '$t'. Valid: x86_64, aarch64, universal, all"
			exit 1
			;;
		esac
	done
}

validate_format_values() {
	for f in $FORMAT_LIST; do
		case "$f" in
		deb | rpm | pacman | appimage | nsis | msi | dmg | zip | all) ;;
		*)
			echo "Error: Unknown format '$f'. Valid: deb, rpm, pacman, appimage, nsis, msi, dmg, zip, all"
			exit 1
			;;
		esac
	done
}

# Expand 'all' into concrete format list for an OS
expand_formats_for_os() {
	_effo_os="$1"
	case "$_effo_os" in
	linux) echo "deb rpm pacman appimage zip" ;;
	windows) echo "nsis msi zip" ;;
	macos) echo "dmg zip" ;;
	esac
}

# Resolve a format list for a specific OS (expand 'all', filter invalid formats)
resolve_formats_for_os() {
	_rffo_os="$1"
	_rffo_list="$2"
	case "$_rffo_list" in
	*all*)
		expand_formats_for_os "$_rffo_os"
		return
		;;
	esac
	_rffo_valid=$(expand_formats_for_os "$_rffo_os")
	_rffo_result=""
	for _f in $_rffo_list; do
		for _v in $_rffo_valid; do
			[ "$_f" = "$_v" ] && _rffo_result="$_rffo_result $_f"
		done
	done
	echo $_rffo_result
}

# ─── Build step functions ───────────────────────────────────────────────────
# Each function operates on globals set by docker_inner_build()

build_icons() {
	ICONS_DIR="$SCRIPT_DIR/icons"
	if [ -f "$ICONS_DIR/icon.png" ]; then
		echo "=== Icons already built (cached) ==="
		return 0
	fi
	_t=$(date +%s)
	echo "=== Generating icons ==="
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
	echo "=== Icons done ($(elapsed_since $_t)) ==="
}

build_frontend() {
	if [ -f "$ROOT_DIR/frontend/build/index.html" ]; then
		echo "=== Frontend already built (cached) ==="
		return 0
	fi
	_t=$(date +%s)
	echo "=== Building frontend ==="
	cd "$ROOT_DIR/frontend"
	./build.sh
	echo "=== Frontend done ($(elapsed_since $_t)) ==="
}

build_backend() {
	if [ "$BUILD_OS" = "macos" ] && [ "$BUILD_ARCH" = "universal" ]; then
		_t=$(date +%s)
		echo "=== Building universal backend (lipo) ==="
		cd "$ROOT_DIR/backend"
		LIPO_TMP=$(mktemp -d)
		./build.sh --target bun-darwin-x64
		cp build/lish-backend "$LIPO_TMP/lish-backend-x64"
		./build.sh --target bun-darwin-arm64
		cp build/lish-backend "$LIPO_TMP/lish-backend-arm64"
		lipo -create "$LIPO_TMP/lish-backend-x64" "$LIPO_TMP/lish-backend-arm64" -output build/lish-backend
		rm -rf "$LIPO_TMP"
		echo "=== Universal backend done ($(elapsed_since $_t)) ==="
	else
		_t=$(date +%s)
		echo "=== Building backend (target: $BUN_TARGET) ==="
		cd "$ROOT_DIR/backend"
		./build.sh --target "$BUN_TARGET"
		echo "=== Backend done ($(elapsed_since $_t)) ==="
	fi
}

sync_product_info() {
	PRODUCT_JSON="$ROOT_DIR/shared/src/product.json"
	_PRODUCT_DATA=$(jq -r '[.name, .version, .identifier, (.website // "https://github.com/libersoft-org/libershare")] | join("\n")' "$PRODUCT_JSON")
	PRODUCT_NAME=$(echo "$_PRODUCT_DATA" | sed -n '1p')
	PRODUCT_VERSION=$(echo "$_PRODUCT_DATA" | sed -n '2p')
	PRODUCT_IDENTIFIER=$(echo "$_PRODUCT_DATA" | sed -n '3p')
	PRODUCT_WEBSITE=$(echo "$_PRODUCT_DATA" | sed -n '4p')
	unset _PRODUCT_DATA
	PRODUCT_NAME_LOWER=$(echo "$PRODUCT_NAME" | tr '[:upper:]' '[:lower:]')
	echo "Product: $PRODUCT_NAME v$PRODUCT_VERSION ($PRODUCT_IDENTIFIER)"

	# Config files only need patching once per container invocation
	if [ "$_PRODUCT_INFO_SYNCED" != "1" ]; then
		cp "$SCRIPT_DIR/tauri.conf.json" "$SCRIPT_DIR/tauri.conf.json.orig" 2>/dev/null || true
		jq --tab --arg name "$PRODUCT_NAME" --arg ver "$PRODUCT_VERSION" --arg id "$PRODUCT_IDENTIFIER" \
			'.productName = $name | .mainBinaryName = $name | .version = $ver | .identifier = $id | .bundle.windows.nsis.startMenuFolder = $name' \
			"$SCRIPT_DIR/tauri.conf.json" >"$SCRIPT_DIR/tauri.conf.json.tmp" && mv "$SCRIPT_DIR/tauri.conf.json.tmp" "$SCRIPT_DIR/tauri.conf.json"

		cp "$SCRIPT_DIR/Cargo.toml" "$SCRIPT_DIR/Cargo.toml.orig" 2>/dev/null || true
		sed "s/^version = \"[^\"]*\"/version = \"$PRODUCT_VERSION\"/" "$SCRIPT_DIR/Cargo.toml" >"$SCRIPT_DIR/Cargo.toml.tmp" && mv "$SCRIPT_DIR/Cargo.toml.tmp" "$SCRIPT_DIR/Cargo.toml"
		_PRODUCT_INFO_SYNCED=1
	fi

	# OS-specific config patching (once per OS)
	if [ "$BUILD_OS" = "linux" ] && [ "$_SYNCED_LINUX" != "1" ]; then
		cp "$SCRIPT_DIR/tauri.linux.conf.json" "$SCRIPT_DIR/tauri.linux.conf.json.orig" 2>/dev/null || true
		jq --tab --arg name "$PRODUCT_NAME_LOWER" \
			'.productName = $name | .mainBinaryName = $name
			| .bundle.linux.deb.files = {("/usr/share/applications/" + $name + "-debug.desktop"): "desktop-entry-debug.desktop"}
			| .bundle.linux.rpm.files = {("/usr/share/applications/" + $name + "-debug.desktop"): "desktop-entry-debug.desktop"}
			| .bundle.linux.appimage.files = {("usr/share/applications/" + $name + "-debug.desktop"): "desktop-entry-debug.desktop"}' \
			"$SCRIPT_DIR/tauri.linux.conf.json" >"$SCRIPT_DIR/tauri.linux.conf.json.tmp" && mv "$SCRIPT_DIR/tauri.linux.conf.json.tmp" "$SCRIPT_DIR/tauri.linux.conf.json"

		cp "$SCRIPT_DIR/desktop-entry-debug.desktop" "$SCRIPT_DIR/desktop-entry-debug.desktop.orig" 2>/dev/null || true
		sed -i "s/{{product_name}}/$PRODUCT_NAME/g; s/{{exec_name}}/$PRODUCT_NAME_LOWER/g" "$SCRIPT_DIR/desktop-entry-debug.desktop"

		cp "$SCRIPT_DIR/desktop-entry.desktop" "$SCRIPT_DIR/desktop-entry.desktop.orig" 2>/dev/null || true
		sed -i "s/%%product_name%%/$PRODUCT_NAME/g" "$SCRIPT_DIR/desktop-entry.desktop"
		_SYNCED_LINUX=1
	fi

	if [ "$BUILD_OS" = "windows" ] && [ "$_SYNCED_WINDOWS" != "1" ]; then
		cp "$SCRIPT_DIR/wix-fragment-debug.wxs" "$SCRIPT_DIR/wix-fragment-debug.wxs.orig" 2>/dev/null || true
		sed -i "s/{{product_name}}/$PRODUCT_NAME/g" "$SCRIPT_DIR/wix-fragment-debug.wxs"
		_SYNCED_WINDOWS=1
	fi
}

build_tauri() {
	_t=$(date +%s)
	echo "=== Building Tauri app (target: $RUST_TARGET) ==="
	cd "$SCRIPT_DIR"

	# LDD wrapper for Linux AppImage builds (Bun binaries fail ldd)
	if [ "$BUILD_OS" = "linux" ]; then
		LDD_WRAPPER_DIR=$(mktemp -d)
		cat >"$LDD_WRAPPER_DIR/ldd" <<'LDDWRAPPER'
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

	if command -v nproc >/dev/null 2>&1; then
		export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=$(nproc)
	elif command -v sysctl >/dev/null 2>&1; then
		export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=$(sysctl -n hw.ncpu)
	fi

	# Platform-specific Tauri config overlay
	PLATFORM_CONFIG=""
	case "$BUILD_OS" in
	linux) PLATFORM_CONFIG="--config tauri.linux.conf.json" ;;
	windows) PLATFORM_CONFIG="--config tauri.windows.conf.json" ;;
	macos) PLATFORM_CONFIG="--config tauri.macos.conf.json" ;;
	esac

	if [ "$BUILD_OS" = "windows" ]; then
		cargo tauri build --target "$RUST_TARGET" --runner cargo-xwin $PLATFORM_CONFIG $BUNDLE_ARGS
	elif [ "$BUILD_OS" = "macos" ]; then
		# CI=true makes Tauri bundler skip Finder AppleScript (--skip-jenkins),
		# preventing DMG volume windows from auto-opening during build.
		# See: https://github.com/tauri-apps/tauri/issues/592
		CI=true cargo tauri build --target "$RUST_TARGET" $PLATFORM_CONFIG $BUNDLE_ARGS
	else
		cargo tauri build --target "$RUST_TARGET" $PLATFORM_CONFIG $BUNDLE_ARGS
	fi

	echo "=== Tauri done ($(elapsed_since $_t)) ==="
}

# ── Utility: generate .desktop entry ──
# Usage: generate_desktop_entry <output_path> [--debug]
generate_desktop_entry() {
	_gde_output="$1"
	_gde_debug="${2:-}"
	{
		echo "[Desktop Entry]"
		echo "Categories=Network;FileTransfer;"
		echo "Exec=${PRODUCT_NAME_LOWER}${_gde_debug:+ --debug}"
		echo "StartupWMClass=${PRODUCT_NAME_LOWER}"
		echo "Icon=${PRODUCT_NAME_LOWER}"
		echo "Name=${PRODUCT_NAME}${_gde_debug:+ - debug}"
		[ "$_gde_debug" = "--debug" ] && echo "Comment=Launch ${PRODUCT_NAME} in debug mode"
		echo "Terminal=false"
		echo "Type=Application"
	} >"$_gde_output"
}

# ── Utility: run a package build as a background job ──
# Usage: run_pkg_job <label> <function_name> <format_name>
# Sets up temp dir ($WORK), trap, timing; appends fmt:PID to $PKG_JOBS
run_pkg_job() {
	_rpj_label="$1"
	_rpj_fn="$2"
	_rpj_fmt="$3"
	(
		WORK=$(mktemp -d)
		trap 'rm -rf "$WORK"' EXIT
		_t=$(date +%s)
		echo "=== Building $_rpj_label ==="
		"$_rpj_fn"
		echo "=== $_rpj_label complete ($(elapsed_since $_t)) ==="
	) &
	PKG_JOBS="$PKG_JOBS $_rpj_fmt:$!"
}

# ── Utility: create ZIP via staging callback ──
# Usage: stage_zip <callback_fn>
# Callback receives $ZIP_STAGING as the staging directory
stage_zip() {
	_sz_fn="$1"
	ZIP_STAGING=$(mktemp -d)
	"$_sz_fn"
	cd "$ZIP_STAGING"
	zip $ZIP_LEVEL -ry "$FINAL_DIR/${PRODUCT_NAME}_${VERSION}_${OS_LABEL}_${ARCH}.zip" .
	cd "$SCRIPT_DIR"
	rm -rf "$ZIP_STAGING"
}

# ── Utility: copy debug launch script into $ZIP_STAGING ──
_copy_debug_script() {
	sed "s/{{product_name}}/$PRODUCT_NAME/g; s/{{exec_name}}/$PRODUCT_NAME_LOWER/g" \
		"$SCRIPT_DIR/bundle-scripts/debug.sh" >"$ZIP_STAGING/debug.sh"
	chmod +x "$ZIP_STAGING/debug.sh"
}

# ── Package builders (each uses $WORK from run_pkg_job) ──

_build_deb() {
	mkdir -p "$WORK/control"
	cat >"$WORK/control/control" <<CTRL_EOF
Package: ${PRODUCT_NAME_LOWER}
Version: ${PRODUCT_VERSION}
Architecture: ${PKG_DEB_ARCH}
Maintainer: LiberSoft <info@libersoft.org>
Installed-Size: ${PKG_INSTALLED_SIZE}
Depends: libwebkit2gtk-4.1-0, libgtk-3-0
Section: net
Priority: optional
Homepage: ${PRODUCT_WEBSITE}
Description: ${PRODUCT_NAME} - peer-to-peer file sharing
CTRL_EOF
	tar -cf - -C "$WORK/control" . | xz $XZ_FLAGS >"$WORK/control.tar.xz"
	tar -cf - -C "$PKG_STAGING" . | xz $XZ_FLAGS >"$WORK/data.tar.xz"
	echo "2.0" >"$WORK/debian-binary"
	ar rcs "$FINAL_DIR/${PRODUCT_NAME_LOWER}_${PRODUCT_VERSION}_${PKG_DEB_ARCH}.deb" \
		"$WORK/debian-binary" \
		"$WORK/control.tar.xz" \
		"$WORK/data.tar.xz"
}

_build_rpm() {
	mkdir -p "$WORK/BUILD" "$WORK/RPMS" "$WORK/SOURCES" "$WORK/SPECS" "$WORK/BUILDROOT"
	cp -a "$PKG_STAGING"/* "$WORK/BUILDROOT/"
	cat >"$WORK/SPECS/${PRODUCT_NAME_LOWER}.spec" <<SPEC_EOF
Name: ${PRODUCT_NAME_LOWER}
Version: ${PRODUCT_VERSION}
Release: 1
Summary: ${PRODUCT_NAME} - peer-to-peer file sharing
License: MIT
URL: ${PRODUCT_WEBSITE}
AutoReqProv: no
Requires: webkit2gtk4.1, gtk3

%description
${PRODUCT_NAME} - peer-to-peer file sharing application

%files
/usr/bin/${PRODUCT_NAME_LOWER}
/usr/bin/lish-backend
/usr/share/applications/${PRODUCT_NAME_LOWER}.desktop
/usr/share/applications/${PRODUCT_NAME_LOWER}-debug.desktop
/usr/share/icons/hicolor/256x256/apps/${PRODUCT_NAME_LOWER}.png
SPEC_EOF
	XZ_DEFAULTS="-T0" rpmbuild -bb --quiet \
		--define "_topdir $WORK" \
		--define "_binary_payload $RPM_PAYLOAD" \
		--define "_buildhost build.local" \
		--buildroot "$WORK/BUILDROOT" \
		--target "$PKG_RPM_ARCH" \
		"$WORK/SPECS/${PRODUCT_NAME_LOWER}.spec"
	RPM_BUILT=$(find "$WORK/RPMS" -name "*.rpm" | head -1)
	mv "$RPM_BUILT" "$FINAL_DIR/${PRODUCT_NAME_LOWER}-${PRODUCT_VERSION}-1.${PKG_RPM_ARCH}.rpm"
}

_build_pacman() {
	PAC_BUILDDATE=$(date +%s)
	PAC_SIZE=$(du -sb "$PKG_STAGING" | cut -f1)
	cat >"$WORK/.PKGINFO" <<PKGINFO_EOF
pkgname = ${PRODUCT_NAME_LOWER}
pkgver = ${PRODUCT_VERSION}-1
pkgdesc = ${PRODUCT_NAME} - peer-to-peer file sharing
url = ${PRODUCT_WEBSITE}
builddate = ${PAC_BUILDDATE}
packager = LiberSoft <info@libersoft.org>
size = ${PAC_SIZE}
arch = ${PKG_PACMAN_ARCH}
license = MIT
depend = webkit2gtk-4.1
depend = gtk3
PKGINFO_EOF
	cd "$PKG_STAGING"
	bsdtar -czf "$WORK/.MTREE" \
		--format=mtree \
		--options='!all,use-set,type,uid,gid,mode,time,size,md5,sha256,link' \
		.
	bsdtar -cf - -C "$WORK" .PKGINFO .MTREE -C "$PKG_STAGING" . |
		xz $XZ_FLAGS >"$FINAL_DIR/${PRODUCT_NAME_LOWER}-${PRODUCT_VERSION}-1-${PKG_PACMAN_ARCH}.pkg.tar.xz"
}

_build_appimage() {
	AI_APPDIR="$WORK/AppDir"
	mkdir -p "$AI_APPDIR"
	cp -a "$PKG_STAGING"/* "$AI_APPDIR/"

	cat >"$AI_APPDIR/AppRun" <<APPRUN_EOF
#!/bin/sh
SELF=\$(readlink -f "\$0")
HERE=\${SELF%/*}
exec "\$HERE/usr/bin/${PRODUCT_NAME_LOWER}" "\$@"
APPRUN_EOF
	chmod +x "$AI_APPDIR/AppRun"

	cp "$AI_APPDIR/usr/share/applications/${PRODUCT_NAME_LOWER}.desktop" "$AI_APPDIR/${PRODUCT_NAME_LOWER}.desktop"
	cp "$AI_APPDIR/usr/share/icons/hicolor/256x256/apps/${PRODUCT_NAME_LOWER}.png" "$AI_APPDIR/${PRODUCT_NAME_LOWER}.png"
	ln -sf "${PRODUCT_NAME_LOWER}.png" "$AI_APPDIR/.DirIcon"

	SQUASHFS_BCJ=""
	case "$BUILD_ARCH" in
	x86_64) SQUASHFS_BCJ="-Xbcj x86" ;;
	esac
	mksquashfs "$AI_APPDIR" "$WORK/app.squashfs" \
		-root-owned -noappend \
		-comp xz $SQUASHFS_BCJ -Xdict-size 100% \
		-processors $(nproc)

	AI_RUNTIME_CACHE="/tmp/appimage-runtime-${BUILD_ARCH}"
	if [ ! -f "$AI_RUNTIME_CACHE" ]; then
		echo "Downloading AppImage runtime for $BUILD_ARCH..."
		curl -fsSL -o "$AI_RUNTIME_CACHE" \
			"https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-${BUILD_ARCH}"
	fi

	AI_OUTPUT="$FINAL_DIR/${PRODUCT_NAME}_${VERSION}_${OS_LABEL}_${ARCH}.AppImage"
	cat "$AI_RUNTIME_CACHE" "$WORK/app.squashfs" >"$AI_OUTPUT"
	chmod +x "$AI_OUTPUT"
}

# ── ZIP staging callbacks ──

_stage_zip_linux() {
	cp "$BUILD_RELEASE_DIR/$PRODUCT_NAME_LOWER" "$ZIP_STAGING/"
	cp "$ROOT_DIR/backend/build/lish-backend" "$ZIP_STAGING/lish-backend"
	_copy_debug_script
	chmod +x "$ZIP_STAGING/$PRODUCT_NAME_LOWER" "$ZIP_STAGING/lish-backend"
}

_stage_zip_windows() {
	cp "$BUILD_RELEASE_DIR/${PRODUCT_NAME}.exe" "$ZIP_STAGING/"
	cp "$ROOT_DIR/backend/build/lish-backend.exe" "$ZIP_STAGING/lish-backend.exe"
	sed "s/{{product_name}}/$PRODUCT_NAME/g" \
		"$SCRIPT_DIR/bundle-scripts/Debug.bat" >"$ZIP_STAGING/Debug.bat"
}

_stage_zip_macos() {
	APP_BUNDLE="$BUILD_RELEASE_DIR/bundle/macos/${PRODUCT_NAME}.app"
	if [ ! -d "$APP_BUNDLE" ]; then
		echo "Building .app bundle for macOS ZIP..."
		cargo tauri build --target "$RUST_TARGET" $PLATFORM_CONFIG --config '{"bundle":{"targets":["app"]}}'
	fi
	cp -r "$APP_BUNDLE" "$ZIP_STAGING/"
	_copy_debug_script
}

# ─── Main build phase functions ─────────────────────────────────────────────

build_linux_packages() {
	# Architecture mapping
	case "$BUILD_ARCH" in
	x86_64)
		PKG_DEB_ARCH="amd64"
		PKG_RPM_ARCH="x86_64"
		PKG_PACMAN_ARCH="x86_64"
		;;
	aarch64)
		PKG_DEB_ARCH="arm64"
		PKG_RPM_ARCH="aarch64"
		PKG_PACMAN_ARCH="aarch64"
		;;
	esac

	# Create common staging tree
	PKG_STAGING=$(mktemp -d)
	mkdir -p "$PKG_STAGING/usr/bin"
	mkdir -p "$PKG_STAGING/usr/share/applications"
	mkdir -p "$PKG_STAGING/usr/share/icons/hicolor/256x256/apps"

	cp "$BUILD_RELEASE_DIR/$PRODUCT_NAME_LOWER" "$PKG_STAGING/usr/bin/"
	chmod +x "$PKG_STAGING/usr/bin/$PRODUCT_NAME_LOWER"
	cp "$ROOT_DIR/backend/build/lish-backend" "$PKG_STAGING/usr/bin/"
	chmod +x "$PKG_STAGING/usr/bin/lish-backend"

	generate_desktop_entry "$PKG_STAGING/usr/share/applications/${PRODUCT_NAME_LOWER}.desktop"
	generate_desktop_entry "$PKG_STAGING/usr/share/applications/${PRODUCT_NAME_LOWER}-debug.desktop" --debug

	cp "$SCRIPT_DIR/icons/icon.png" "$PKG_STAGING/usr/share/icons/hicolor/256x256/apps/${PRODUCT_NAME_LOWER}.png"

	PKG_INSTALLED_SIZE=$(du -sk "$PKG_STAGING" | cut -f1)

	PKG_JOBS=""
	[ "$MAKE_DEB" = "1" ] && run_pkg_job "DEB package (xz $XZ_FLAGS)" _build_deb deb
	[ "$MAKE_RPM" = "1" ] && run_pkg_job "RPM package (xz, $RPM_PAYLOAD)" _build_rpm rpm
	[ "$MAKE_PACMAN" = "1" ] && run_pkg_job "Pacman package (xz $XZ_FLAGS)" _build_pacman pacman
	[ "$MAKE_APPIMAGE" = "1" ] && run_pkg_job "AppImage (xz, $(nproc) cores)" _build_appimage appimage

	# Wait for all package builds and record per-format results
	for _job in $PKG_JOBS; do
		_fmt="${_job%%:*}"
		_pid="${_job##*:}"
		if wait "$_pid"; then
			echo "OK $_fmt" >>"$BUILD_RESULTS_FILE"
		else
			echo "FAIL $_fmt" >>"$BUILD_RESULTS_FILE"
			_inner_fail=1
		fi
	done
	rm -rf "$PKG_STAGING"
	echo "=== All Linux packages complete ==="
}

move_bundles() {
	# Move and rename Tauri-produced bundles (nsis, msi, dmg)
	for dir in nsis msi dmg; do
		if [ -d "$BUILD_OUTPUT_DIR/$dir" ]; then
			for f in "$BUILD_OUTPUT_DIR/$dir"/*; do
				[ -f "$f" ] || continue
				EXT="${f##*.}"
				case "$EXT" in
				exe) NEWNAME="${PRODUCT_NAME}_${VERSION}_${OS_LABEL}_${ARCH}_setup.exe" ;;
				msi) NEWNAME="${PRODUCT_NAME}_${VERSION}_${OS_LABEL}_${ARCH}.msi" ;;
				dmg) NEWNAME="${PRODUCT_NAME}_${VERSION}_${OS_LABEL}_${ARCH}.dmg" ;;
				*) NEWNAME="$(basename "$f")" ;;
				esac
				mv "$f" "$FINAL_DIR/$NEWNAME"
			done
			rmdir "$BUILD_OUTPUT_DIR/$dir" 2>/dev/null || true
		fi
	done
}

build_zip() {
	_t=$(date +%s)
	echo "=== Creating ZIP bundle ==="
	case "$BUILD_OS" in
	linux) stage_zip _stage_zip_linux ;;
	windows) stage_zip _stage_zip_windows ;;
	macos) stage_zip _stage_zip_macos ;;
	esac
	echo "=== ZIP done ($(elapsed_since $_t)) ==="
}

# ─── Docker inner build ────────────────────────────────────────────────────
# This runs INSIDE the Docker container

docker_inner_build() {
	BUILD_TOTAL_START=$(date +%s)
	BUILD_OS="$INNER_OS"
	BUILD_ARCH="$INNER_ARCH"

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
	macos_x86_64)
		RUST_TARGET="x86_64-apple-darwin"
		BUN_TARGET="bun-darwin-x64"
		;;
	macos_aarch64)
		RUST_TARGET="aarch64-apple-darwin"
		BUN_TARGET="bun-darwin-arm64"
		;;
	macos_universal)
		RUST_TARGET="universal-apple-darwin"
		BUN_TARGET=""
		;;
	*)
		echo "Error: Unsupported OS/arch combination: $BUILD_OS/$BUILD_ARCH"
		exit 1
		;;
	esac

	# Ensure Rust target is installed
	if [ "$BUILD_ARCH" = "universal" ]; then
		rustup target add x86_64-apple-darwin 2>/dev/null || true
		rustup target add aarch64-apple-darwin 2>/dev/null || true
	else
		rustup target add "$RUST_TARGET" 2>/dev/null || true
	fi

	# ── Cross-compilation setup for different Linux arch ──
	CONTAINER_ARCH=$(uname -m)
	if [ "$BUILD_OS" = "linux" ] && [ "$CONTAINER_ARCH" != "$BUILD_ARCH" ]; then
		case "$BUILD_ARCH" in
		x86_64) CROSS_GNU_TRIPLE="x86_64-linux-gnu" ;;
		aarch64) CROSS_GNU_TRIPLE="aarch64-linux-gnu" ;;
		esac
		echo "=== Cross-compiling: $CONTAINER_ARCH -> $BUILD_ARCH (via $CROSS_GNU_TRIPLE) ==="
		export PKG_CONFIG_LIBDIR="/usr/lib/${CROSS_GNU_TRIPLE}/pkgconfig:/usr/share/pkgconfig"
		export PKG_CONFIG_ALLOW_CROSS=1
	fi

	# Build formats argument for cargo tauri build
	# Linux packages (deb, rpm, appimage) are built manually for speed (xz, parallel).
	# Windows/macOS packages are still built by Tauri bundler.
	# We use --config with bundle.targets instead of --bundles because Tauri CLI
	# filters --bundles by host OS (Linux host rejects 'nsis', 'dmg').
	TAURI_BUNDLE_TARGETS=""
	SKIPPED_FORMATS=""
	MAKE_ZIP=0
	MAKE_DEB=0
	MAKE_RPM=0
	MAKE_PACMAN=0
	MAKE_APPIMAGE=0
	for fmt in $FORMAT_LIST; do
		case "$fmt" in
		all)
			for efmt in $(expand_formats_for_os "$BUILD_OS"); do
				case "$efmt" in
				zip) MAKE_ZIP=1 ;;
				deb) MAKE_DEB=1 ;;
				rpm) MAKE_RPM=1 ;;
				pacman) MAKE_PACMAN=1 ;;
				appimage) MAKE_APPIMAGE=1 ;;
				msi)
					if [ "$DOCKER_INNER" = "1" ]; then
						echo "Warning: MSI format requires WiX (Windows-only) - skipping in Docker"
						SKIPPED_FORMATS="$SKIPPED_FORMATS msi"
					else
						TAURI_BUNDLE_TARGETS="$TAURI_BUNDLE_TARGETS $efmt"
					fi
					;;
				*) TAURI_BUNDLE_TARGETS="$TAURI_BUNDLE_TARGETS $efmt" ;;
				esac
			done
			;;
		zip)
			MAKE_ZIP=1
			;;
		*)
			case "$BUILD_OS" in
			linux) case "$fmt" in
				deb) MAKE_DEB=1 ;;
				rpm) MAKE_RPM=1 ;;
				pacman) MAKE_PACMAN=1 ;;
				appimage) MAKE_APPIMAGE=1 ;;
				esac ;;
			windows) case "$fmt" in
				nsis) TAURI_BUNDLE_TARGETS="$TAURI_BUNDLE_TARGETS $fmt" ;;
				msi)
					if [ "$DOCKER_INNER" = "1" ]; then
						echo "Warning: MSI format requires WiX (Windows-only) - skipping in Docker"
						SKIPPED_FORMATS="$SKIPPED_FORMATS msi"
					else
						TAURI_BUNDLE_TARGETS="$TAURI_BUNDLE_TARGETS $fmt"
					fi
					;;
				esac ;;
			macos) case "$fmt" in dmg) TAURI_BUNDLE_TARGETS="$TAURI_BUNDLE_TARGETS $fmt" ;; esac ;;
			esac
			;;
		esac
	done

	# Convert bundle targets to --config JSON (bypasses host-OS filtering of --bundles)
	BUNDLE_ARGS=""
	if [ -n "$TAURI_BUNDLE_TARGETS" ]; then
		_targets_json=$(echo $TAURI_BUNDLE_TARGETS | tr ' ' '\n' | sed 's/.*/"&"/' | tr '\n' ',' | sed 's/,$//')
		BUNDLE_ARGS="--config {\"bundle\":{\"targets\":[$_targets_json]}}"
	fi
	# If no Tauri-native bundles requested, build only the binary
	# Tauri config has "targets": [] so it won't bundle anything by default

	# ── Compute all expected formats and write results file ──
	_all_expected_formats=""
	for _bf in $TAURI_BUNDLE_TARGETS; do _all_expected_formats="$_all_expected_formats $_bf"; done
	[ "$MAKE_DEB" = "1" ] && _all_expected_formats="$_all_expected_formats deb"
	[ "$MAKE_RPM" = "1" ] && _all_expected_formats="$_all_expected_formats rpm"
	[ "$MAKE_PACMAN" = "1" ] && _all_expected_formats="$_all_expected_formats pacman"
	[ "$MAKE_APPIMAGE" = "1" ] && _all_expected_formats="$_all_expected_formats appimage"
	[ "$MAKE_ZIP" = "1" ] && _all_expected_formats="$_all_expected_formats zip"
	for _sf in $SKIPPED_FORMATS; do _all_expected_formats="$_all_expected_formats $_sf"; done
	_all_expected_formats=$(echo $_all_expected_formats) # trim leading space

	# ── Output directory (needed for results file before build starts) ──
	BUILD_RELEASE_DIR="$SCRIPT_DIR/build/${RUST_TARGET}/release"
	BUILD_OUTPUT_DIR="$BUILD_RELEASE_DIR/bundle"
	FINAL_DIR="$SCRIPT_DIR/build/release/bundle"
	mkdir -p "$FINAL_DIR"

	BUILD_RESULTS_FILE="$FINAL_DIR/.build-results-${BUILD_OS}-${BUILD_ARCH}"
	echo "EXPECTED $_all_expected_formats" >"$BUILD_RESULTS_FILE"
	for _sf in $SKIPPED_FORMATS; do echo "SKIP $_sf" >>"$BUILD_RESULTS_FILE"; done
	_inner_fail=0

	build_icons
	build_frontend
	build_backend
	sync_product_info

	# ── Naming (after sync_product_info sets PRODUCT_VERSION) ──
	VERSION="$PRODUCT_VERSION"
	ARCH="$BUILD_ARCH"
	OS_LABEL="$BUILD_OS"

	# ── Tauri build (binary + Tauri-native bundles) ──
	set +e
	build_tauri
	_tauri_rc=$?
	set -e

	if [ "$_tauri_rc" != "0" ]; then
		# Tauri build failed → mark ALL expected formats as FAIL
		for _bf in $_all_expected_formats; do
			echo "FAIL $_bf" >>"$BUILD_RESULTS_FILE"
		done
		echo "=== Build FAILED: OS=$BUILD_OS ARCH=$BUILD_ARCH (total $(elapsed_since $BUILD_TOTAL_START)) ==="
		exit 1
	fi

	# Mark Tauri-native bundle formats as OK
	for _bf in $TAURI_BUNDLE_TARGETS; do
		echo "OK $_bf" >>"$BUILD_RESULTS_FILE"
	done

	# ── Custom Linux packages (DEB, RPM, Pacman, AppImage) ──
	PKG_LINUX_ANY=0
	[ "$MAKE_DEB" = "1" ] && PKG_LINUX_ANY=1
	[ "$MAKE_RPM" = "1" ] && PKG_LINUX_ANY=1
	[ "$MAKE_PACMAN" = "1" ] && PKG_LINUX_ANY=1
	[ "$MAKE_APPIMAGE" = "1" ] && PKG_LINUX_ANY=1
	if [ "$BUILD_OS" = "linux" ] && [ "$PKG_LINUX_ANY" = "1" ]; then
		build_linux_packages
	fi

	move_bundles

	if [ "$MAKE_ZIP" = "1" ]; then
		set +e
		build_zip
		_zip_rc=$?
		set -e
		if [ "$_zip_rc" = "0" ]; then
			echo "OK zip" >>"$BUILD_RESULTS_FILE"
		else
			echo "FAIL zip" >>"$BUILD_RESULTS_FILE"
			_inner_fail=1
		fi
	fi

	if [ "$_inner_fail" != "0" ]; then
		echo "=== Build PARTIAL: OS=$BUILD_OS ARCH=$BUILD_ARCH (some formats failed, total $(elapsed_since $BUILD_TOTAL_START)) ==="
	else
		echo "=== Build complete: OS=$BUILD_OS ARCH=$BUILD_ARCH (total $(elapsed_since $BUILD_TOTAL_START)) ==="
	fi
	echo "Output: $FINAL_DIR/"
	if [ "$_inner_fail" != "0" ]; then exit 1; fi
}

# ─── Docker inner mode ──────────────────────────────────────────────────────

if [ "$DOCKER_INNER" = "1" ]; then
	docker_inner_build
	exit 0
fi

# ─── Orchestrator utility functions ─────────────────────────────────────────────────────────────

ensure_colima() {
	if ! command -v colima >/dev/null 2>&1; then
		echo "Error: Colima is required on macOS."
		echo "Install: brew install colima docker docker-buildx"
		exit 1
	fi
	export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"

	_host_cpus=$(sysctl -n hw.ncpu 2>/dev/null || echo 4)
	_min_memory=8

	# --docker-rebuild: destroy and recreate the VM for a clean state
	if [ "$DOCKER_REBUILD" = "1" ]; then
		echo "Recreating Colima VM (--docker-rebuild)..."
		colima stop 2>/dev/null || true
		colima delete -f 2>/dev/null || true
		colima start --cpu "$_host_cpus" --memory "$_min_memory"
	elif colima status >/dev/null 2>&1; then
		_cur_cpus=$(colima status 2>/dev/null | grep -i cpu | head -1 | grep -oE '[0-9]+' | head -1)
		_cur_memory=$(colima status 2>/dev/null | grep -i memory | head -1 | grep -oE '[0-9]+' | head -1)
		_cur_cpus=${_cur_cpus:-0}
		_cur_memory=${_cur_memory:-0}
		_restart=0
		[ "$_cur_cpus" -lt "$_host_cpus" ] 2>/dev/null && _restart=1
		[ "$_cur_memory" -lt "$_min_memory" ] 2>/dev/null && _restart=1
		if [ "$_restart" = "1" ]; then
			echo "Restarting Colima (${_host_cpus} CPUs, ${_min_memory}GB RAM)..."
			colima stop
			colima start --cpu "$_host_cpus" --memory "$_min_memory"
		fi
	else
		echo "Starting Colima (${_host_cpus} CPUs, ${_min_memory}GB RAM)..."
		colima start --cpu "$_host_cpus" --memory "$_min_memory"
	fi

	_wait=0
	while ! docker info >/dev/null 2>&1; do
		_wait=$((_wait + 1))
		if [ "$_wait" -ge 60 ]; then
			echo "Error: Colima did not start within 60 seconds."
			exit 1
		fi
		sleep 1
	done
	echo "Docker is ready (Colima: ${_host_cpus} CPUs, ${_min_memory}GB RAM)."
}

ensure_docker_buildx() {
	if ! docker buildx version >/dev/null 2>&1; then
		echo "docker-buildx plugin not found."
		if command -v brew >/dev/null 2>&1; then
			echo "Installing docker-buildx via Homebrew..."
			brew install docker-buildx
		else
			echo "Error: Install docker-buildx: brew install docker-buildx"
			exit 1
		fi
	fi
	# Ensure Docker knows where to find Homebrew CLI plugins
	_plugins_dir="/opt/homebrew/lib/docker/cli-plugins"
	_docker_config="$HOME/.docker/config.json"
	if [ -d "$_plugins_dir" ]; then
		mkdir -p "$HOME/.docker"
		if [ ! -f "$_docker_config" ]; then
			printf '{"cliPluginsExtraDirs": ["%s"]}\n' "$_plugins_dir" >"$_docker_config"
		elif ! grep -q "cliPluginsExtraDirs" "$_docker_config" 2>/dev/null; then
			if command -v jq >/dev/null 2>&1; then
				_tmp=$(jq --arg d "$_plugins_dir" '. + {"cliPluginsExtraDirs": [$d]}' "$_docker_config")
				printf '%s\n' "$_tmp" >"$_docker_config"
			else
				echo "Warning: ~/.docker/config.json exists but missing cliPluginsExtraDirs."
				echo "Add this manually: \"cliPluginsExtraDirs\": [\"$_plugins_dir\"]"
			fi
		fi
	fi
}

build_docker_image() {
	if [ "$DOCKER_REBUILD" = "1" ]; then
		echo "=== Rebuilding Docker image (--docker-rebuild) ==="
		docker rmi "$DOCKER_IMAGE" 2>/dev/null || true
		DOCKER_BUILDKIT=1 docker build --network=host --no-cache -t "$DOCKER_IMAGE" "$SCRIPT_DIR"
	elif docker image inspect "$DOCKER_IMAGE" >/dev/null 2>&1; then
		echo "=== Docker image $DOCKER_IMAGE already exists (cached) ==="
	else
		echo "=== Building Docker image ==="
		echo "    (first build may take a long time)"
		DOCKER_BUILDKIT=1 docker build --network=host -t "$DOCKER_IMAGE" "$SCRIPT_DIR"
	fi
}

# ─── Orchestrator mode (runs on host, spawns Docker containers) ─────────────

# Defaults
HOST_OS=$(detect_host_os)
HOST_ARCH=$(detect_host_arch)

[ -z "$OS_LIST" ] && OS_LIST="all"
[ -z "$TARGET_LIST" ] && TARGET_LIST="all"
[ -z "$FORMAT_LIST" ] && FORMAT_LIST="all"

# Validate
validate_os_values
validate_target_values
validate_format_values
validate_no_all_combined "os" $OS_LIST
validate_no_all_combined "target" $TARGET_LIST
validate_no_all_combined "format" $FORMAT_LIST

# Expand 'all' for OS (always includes all 3; macOS will be skipped on non-macOS hosts)
case "$OS_LIST" in *all*) OS_LIST="linux windows macos" ;; esac
# Note: target 'all' is expanded per-OS in the build loop

# Check Docker availability (needed for non-macOS builds)
NEEDS_DOCKER=0
for os in $OS_LIST; do
	[ "$os" != "macos" ] && NEEDS_DOCKER=1
done
DOCKER_IMAGE="libershare-builder"
if [ "$NEEDS_DOCKER" = "1" ]; then
	if ! command -v docker >/dev/null 2>&1; then
		echo "Error: Docker is required for Linux/Windows builds. Install Docker first."
		exit 1
	fi
	[ "$HOST_OS" = "macos" ] && ensure_colima
	[ "$(uname)" = "Darwin" ] && ensure_docker_buildx
	build_docker_image
fi

# ── Clean old output ──
[ -d "$SCRIPT_DIR/build/release/bundle" ] && rm -rf "$SCRIPT_DIR/build/release/bundle"
[ -d "$SCRIPT_DIR/icons" ] && rm -rf "$SCRIPT_DIR/icons"
[ -d "$ROOT_DIR/frontend/build" ] && rm -rf "$ROOT_DIR/frontend/build"
mkdir -p "$SCRIPT_DIR/build/release/bundle"

# ── Iterate over OS × target combinations ──

_build_ok=""
_build_fail=""
_build_skip=""
_build_count=0
_fail_count=0
_skip_count=0

for os in $OS_LIST; do
	# Expand target 'all' per-OS
	_eff_targets="$TARGET_LIST"
	case "$_eff_targets" in
	*all*)
		if [ "$os" = "macos" ]; then
			_eff_targets="x86_64 aarch64 universal"
		else
			_eff_targets="x86_64 aarch64"
		fi
		;;
	esac

	# Skip macOS on non-macOS hosts
	if [ "$os" = "macos" ] && [ "$HOST_OS" != "macos" ]; then
		for target in $_eff_targets; do
			_skip_fmts=$(resolve_formats_for_os "$os" "$FORMAT_LIST")
			for _sf in $_skip_fmts; do
				_build_count=$((_build_count + 1))
				_skip_count=$((_skip_count + 1))
				_build_skip="${_build_skip} ${os}/${target}/${_sf}"
			done
			print_box "SKIPPED: OS=$os  ARCH=$target  (requires macOS host)"
		done
		continue
	fi

	for target in $_eff_targets; do
		# Skip 'universal' for non-macOS
		if [ "$target" = "universal" ] && [ "$os" != "macos" ]; then
			echo "Skipping: 'universal' target is only valid for macOS"
			continue
		fi

		echo ""
		print_box "Building: OS=$os  ARCH=$target"
		echo ""

		# Compose --format args for inner script
		INNER_FORMAT_ARGS=""
		if [ -n "$FORMAT_LIST" ]; then
			INNER_FORMAT_ARGS="--format $FORMAT_LIST"
		fi

		_build_start=$(date +%s)

		set +e
		if [ "$os" = "macos" ]; then
			# macOS: native build (no Docker)
			(
				set -e
				INNER_OS="$os"
				INNER_ARCH="$target"
				docker_inner_build
			)
			_rc=$?
		else
			# Linux/Windows: build inside Docker (cross-compilation via linkers)
			# --init: tini as PID 1 forwards signals to the entire process group
			# exec: build script replaces sh, becoming tini's direct child
			docker run --rm --init \
				--network=host \
				-v "$ROOT_DIR:/workspace" \
				-v "${HOME}/.cargo/registry:/root/.cargo/registry" \
				-v "${HOME}/.cargo/git:/root/.cargo/git" \
				-v "${HOME}/.cache/cargo-xwin:/root/.cache/cargo-xwin" \
				-v "${HOME}/.bun/install/cache:/root/.bun/install/cache" \
				-e APPIMAGE_EXTRACT_AND_RUN=1 \
				"$DOCKER_IMAGE" \
				sh -c "cd /workspace/app && exec ./build.sh --docker-inner --inner-os $os --inner-arch $target --compress $COMPRESS_LEVEL $INNER_FORMAT_ARGS"
			_rc=$?
		fi
		set -e

		_build_elapsed=$(elapsed_since $_build_start)
		echo ""

		# ── Read per-format results from inner build ──
		_results_file="$SCRIPT_DIR/build/release/bundle/.build-results-${os}-${target}"
		_got_results=0
		if [ -f "$_results_file" ]; then
			_expected_line=$(head -1 "$_results_file")
			_expected="${_expected_line#EXPECTED }"
			for _fmt in $_expected; do
				_build_count=$((_build_count + 1))
				if grep -q "^OK $_fmt$" "$_results_file"; then
					_build_ok="${_build_ok} ${os}/${target}/${_fmt}"
				elif grep -q "^SKIP $_fmt$" "$_results_file"; then
					_build_skip="${_build_skip} ${os}/${target}/${_fmt}"
					_skip_count=$((_skip_count + 1))
				else
					_build_fail="${_build_fail} ${os}/${target}/${_fmt}"
					_fail_count=$((_fail_count + 1))
				fi
			done
			_got_results=1
			rm -f "$_results_file"
		fi

		if [ "$_rc" = "0" ]; then
			print_box "Done: OS=$os  ARCH=$target  (${_build_elapsed})"
			if [ "$_got_results" = "0" ]; then
				# No results file but success → record as os/target (shouldn't happen)
				_build_count=$((_build_count + 1))
				_build_ok="${_build_ok} ${os}/${target}"
			fi
		else
			print_box "FAILED: OS=$os  ARCH=$target  (${_build_elapsed})"
			if [ "$_got_results" = "0" ]; then
				# No results file → build crashed before writing anything
				# Expand expected formats and mark all as failed
				_crash_fmts=$(resolve_formats_for_os "$os" "$FORMAT_LIST")
				for _cf in $_crash_fmts; do
					_build_count=$((_build_count + 1))
					_build_fail="${_build_fail} ${os}/${target}/${_cf}"
					_fail_count=$((_fail_count + 1))
				done
			fi
		fi
	done
done

echo ""
_ok_count=$((_build_count - _fail_count - _skip_count))

# ── Build Summary ──
_summary="Build Summary: ${_ok_count} passed, ${_fail_count} failed"
[ "$_skip_count" -gt 0 ] && _summary="$_summary, ${_skip_count} skipped"
_summary="$_summary (${_build_count} total)"
print_box "$_summary"
echo ""

if [ -n "$_build_ok" ]; then
	echo "  Succeeded:"
	for _s in $_build_ok; do
		echo "    + $_s"
	done
fi

if [ -n "$_build_fail" ]; then
	echo "  Failed:"
	for _f in $_build_fail; do
		echo "    - $_f"
	done
fi

if [ -n "$_build_skip" ]; then
	echo "  Skipped:"
	for _sk in $_build_skip; do
		echo "    ~ $_sk"
	done
fi

echo ""
echo "Output: $SCRIPT_DIR/build/release/bundle/"
if [ "$(uname -s)" = "Linux" ]; then
	ls -lah --color "$SCRIPT_DIR/build/release/bundle/"
else
	ls -lah "$SCRIPT_DIR/build/release/bundle/"
fi

[ "$_fail_count" -gt 0 ] && exit 1
exit 0
