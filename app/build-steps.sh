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
		cp build/lish-network-helper "$LIPO_TMP/lish-network-helper-x64"
		./build.sh --target bun-darwin-arm64
		cp build/lish-network-helper "$LIPO_TMP/lish-network-helper-arm64"
		lipo -create "$LIPO_TMP/lish-network-helper-x64" "$LIPO_TMP/lish-network-helper-arm64" -output build/lish-network-helper
		HELPER_HASH=$(shasum -a 256 build/lish-network-helper | awk '{print $1}')
		bun build --compile --target bun-darwin-x64 src/app.ts --outfile "$LIPO_TMP/lish-backend-x64" --define "LISH_NETWORK_HELPER_SHA256=\"$HELPER_HASH\""
		bun build --compile --target bun-darwin-arm64 src/app.ts --outfile "$LIPO_TMP/lish-backend-arm64" --define "LISH_NETWORK_HELPER_SHA256=\"$HELPER_HASH\""
		lipo -create "$LIPO_TMP/lish-backend-x64" "$LIPO_TMP/lish-backend-arm64" -output build/lish-backend
		rm -r "$LIPO_TMP"
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
	PRODUCT_NAME=$(jq -r '.name' "$PRODUCT_JSON")
	PRODUCT_VERSION=$(jq -r '.version' "$PRODUCT_JSON")
	PRODUCT_IDENTIFIER=$(jq -r '.identifier' "$PRODUCT_JSON")
	PRODUCT_WEBSITE=$(jq -r '(.website // "https://github.com/libersoft-org/libershare")' "$PRODUCT_JSON")
	PRODUCT_NAME_LOWER=$(echo "$PRODUCT_NAME" | tr '[:upper:]' '[:lower:]')
	echo "Product: $PRODUCT_NAME v$PRODUCT_VERSION ($PRODUCT_IDENTIFIER)"

	if [ "$_PRODUCT_INFO_SYNCED" != "1" ]; then
		bun "$SCRIPT_DIR/sync-config.ts"
		if [ "$DOCKER_INNER" != "1" ]; then
			cp "$SCRIPT_DIR/Cargo.toml" "$SCRIPT_DIR/Cargo.toml.orig" 2>/dev/null || true
		fi
		PRODUCT_VERSION="$PRODUCT_VERSION" perl -pi -e 's/^version = "[^"]*"/version = "$ENV{PRODUCT_VERSION}"/' "$SCRIPT_DIR/Cargo.toml"
		_PRODUCT_INFO_SYNCED=1
	fi

	if [ "$BUILD_OS" = "linux" ] && [ "$_SYNCED_LINUX" != "1" ]; then
		if [ "$DOCKER_INNER" != "1" ]; then
			cp "$SCRIPT_DIR/desktop-entry-debug.desktop" "$SCRIPT_DIR/desktop-entry-debug.desktop.orig" 2>/dev/null || true
			cp "$SCRIPT_DIR/desktop-entry.desktop" "$SCRIPT_DIR/desktop-entry.desktop.orig" 2>/dev/null || true
		fi
		PRODUCT_NAME="$PRODUCT_NAME" PRODUCT_NAME_LOWER="$PRODUCT_NAME_LOWER" perl -pi -e 's/\{\{product_name\}\}/$ENV{PRODUCT_NAME}/g; s/\{\{exec_name\}\}/$ENV{PRODUCT_NAME_LOWER}/g' "$SCRIPT_DIR/desktop-entry-debug.desktop"
		PRODUCT_NAME="$PRODUCT_NAME" perl -pi -e 's/%%product_name%%/$ENV{PRODUCT_NAME}/g' "$SCRIPT_DIR/desktop-entry.desktop"
		_SYNCED_LINUX=1
	fi

	if [ "$BUILD_OS" = "windows" ] && [ "$_SYNCED_WINDOWS" != "1" ]; then
		if [ "$DOCKER_INNER" != "1" ]; then
			cp "$SCRIPT_DIR/wix-fragment-debug.wxs" "$SCRIPT_DIR/wix-fragment-debug.wxs.orig" 2>/dev/null || true
		fi
		PRODUCT_NAME="$PRODUCT_NAME" perl -pi -e 's/\{\{product_name\}\}/$ENV{PRODUCT_NAME}/g' "$SCRIPT_DIR/wix-fragment-debug.wxs"
		_SYNCED_WINDOWS=1
	fi
}

sign_macos_network_binaries() {
	[ "$BUILD_OS" = "macos" ] || return 0
	if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
		echo "=== Network helper remains disabled in this unsigned macOS build ==="
		return 0
	fi
	codesign --force --options runtime --timestamp --identifier "${PRODUCT_IDENTIFIER}.backend" --sign "$APPLE_SIGNING_IDENTITY" "$ROOT_DIR/backend/build/lish-backend"
	codesign --force --options runtime --timestamp --identifier "${PRODUCT_IDENTIFIER}.network-helper" --sign "$APPLE_SIGNING_IDENTITY" "$ROOT_DIR/backend/build/lish-network-helper"
}
