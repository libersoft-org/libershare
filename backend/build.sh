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
		# No --windows-* resource flags here: bun refuses them unless it is compiling
		# ON Windows ("Using --windows-title is only available when compiling on
		# Windows"), and this branch cross-compiles from the Linux build image. The
		# readable program name in the UAC prompt therefore comes from build.bat, the
		# Windows-native path; a binary cross-built here is identified to the user by
		# its Authenticode publisher instead.
		# The backend trusts the helper only when helper, launcher and backend carry a
		# valid Authenticode signature from one certificate, and it pins the hash of the
		# helper as shipped. So the helper is signed before its hash is taken, and the
		# other two are signed after they were built with that hash. Without a
		# certificate the build is explicitly read-only rather than silently so.
		if [ -z "${WINDOWS_CERTIFICATE_PFX:-}" ]; then
			echo "WARNING: WINDOWS_CERTIFICATE_PFX is not set; the network helper is unsigned and host network settings will remain read-only"
		elif ! command -v osslsigncode >/dev/null 2>&1; then
			echo "ERROR: WINDOWS_CERTIFICATE_PFX is set but osslsigncode is not installed" >&2
			exit 1
		fi
		sign_windows_binary() {
			[ -n "${WINDOWS_CERTIFICATE_PFX:-}" ] || return 0
			osslsigncode sign -pkcs12 "$WINDOWS_CERTIFICATE_PFX" -pass "${WINDOWS_CERTIFICATE_PASSWORD:-}" -h sha256 -t http://timestamp.digicert.com -in "$1" -out "$1.signed"
			mv "$1.signed" "$1"
			osslsigncode verify -in "$1" >/dev/null
		}
		bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig --no-compile-autoload-package-json --no-compile-autoload-tsconfig --target "$BUN_TARGET" src/network-helper.ts --outfile build/lish-network-helper.exe
		bun scripts/set-windows-gui-subsystem.ts build/lish-network-helper.exe
		sign_windows_binary build/lish-network-helper.exe
		HELPER_HASH=$(hash_file build/lish-network-helper.exe)
		bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig --no-compile-autoload-package-json --no-compile-autoload-tsconfig --target "$BUN_TARGET" src/network-helper-windows-launcher.ts --outfile build/lish-network-launcher.exe --define "LISH_NETWORK_HELPER_SHA256=\"$HELPER_HASH\""
		bun scripts/set-windows-gui-subsystem.ts build/lish-network-launcher.exe
		sign_windows_binary build/lish-network-launcher.exe
		bun build --compile --target "$BUN_TARGET" src/app.ts --outfile build/lish-backend.exe --define "LISH_NETWORK_HELPER_SHA256=\"$HELPER_HASH\""
		bun scripts/set-windows-gui-subsystem.ts build/lish-backend.exe
		sign_windows_binary build/lish-backend.exe
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
