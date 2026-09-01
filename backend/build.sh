#!/bin/sh
set -e

# Parse arguments
BUN_TARGET=""
MODE=""
for arg in "$@"; do
	case "$arg" in
	--target) MODE="target" ;;
	*)
		case "$MODE" in
		target)
			BUN_TARGET="$arg"
			MODE=""
			;;
		*)
			echo "Unknown argument: $arg"
			exit 1
			;;
		esac
		;;
	esac
done

[ -d "./build/" ] && rm -r build
mkdir -p build
bun i --frozen-lockfile

hash_file() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk '{print $1}'
	else
		shasum -a 256 "$1" | awk '{print $1}'
	fi
}

if [ -n "$BUN_TARGET" ]; then
	echo "Building backend for target: $BUN_TARGET"
	case "$BUN_TARGET" in
	*windows*)
		# The version resource is what the UAC prompt shows as the program name, so every
		# binary a user may be asked to approve carries a readable one instead of its file name.
		PRODUCT_NAME=$(node -p "require('../shared/src/product.json').name")
		PRODUCT_VERSION=$(node -p "require('../shared/src/product.json').version")
		bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig --no-compile-autoload-package-json --no-compile-autoload-tsconfig --target "$BUN_TARGET" --windows-title "$PRODUCT_NAME" --windows-publisher "LiberSoft" --windows-version "$PRODUCT_VERSION.0" --windows-description "$PRODUCT_NAME network settings helper" src/network-helper.ts --outfile build/lish-network-helper.exe
		bun scripts/set-windows-gui-subsystem.ts build/lish-network-helper.exe
		HELPER_HASH=$(hash_file build/lish-network-helper.exe)
		bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig --no-compile-autoload-package-json --no-compile-autoload-tsconfig --target "$BUN_TARGET" --windows-title "$PRODUCT_NAME" --windows-publisher "LiberSoft" --windows-version "$PRODUCT_VERSION.0" --windows-description "$PRODUCT_NAME network settings launcher" src/network-helper-windows-launcher.ts --outfile build/lish-network-launcher.exe --define "LISH_NETWORK_HELPER_SHA256=\"$HELPER_HASH\""
		bun scripts/set-windows-gui-subsystem.ts build/lish-network-launcher.exe
		bun build --compile --target "$BUN_TARGET" --windows-title "$PRODUCT_NAME" --windows-publisher "LiberSoft" --windows-version "$PRODUCT_VERSION.0" --windows-description "$PRODUCT_NAME backend" src/app.ts --outfile build/lish-backend.exe --define "LISH_NETWORK_HELPER_SHA256=\"$HELPER_HASH\""
		bun scripts/set-windows-gui-subsystem.ts build/lish-backend.exe
		;;
	*)
		bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig --no-compile-autoload-package-json --no-compile-autoload-tsconfig --target "$BUN_TARGET" src/network-helper.ts --outfile build/lish-network-helper
		HELPER_HASH=$(hash_file build/lish-network-helper)
		bun build --compile --target "$BUN_TARGET" src/app.ts --outfile build/lish-backend --define "LISH_NETWORK_HELPER_SHA256=\"$HELPER_HASH\""
		;;
	esac
else
	bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig --no-compile-autoload-package-json --no-compile-autoload-tsconfig src/network-helper.ts --outfile build/lish-network-helper
	HELPER_HASH=$(hash_file build/lish-network-helper)
	bun build --compile src/app.ts --outfile build/lish-backend --define "LISH_NETWORK_HELPER_SHA256=\"$HELPER_HASH\""
fi
