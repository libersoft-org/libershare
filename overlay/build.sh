#!/bin/bash
# Builds lish-overlay against Nebula with the lighthouse "hide_addresses" patch.
#
#   ./build.sh prepare            patched Nebula source in .nebula/ (go.mod replaces the module with it)
#   ./build.sh                    binary for this machine into build/
#   ./build.sh linux/arm64 ...    cross builds into build/lish-overlay-<os>-<arch>[.exe]
set -e
cd "$(dirname "$0")"
NEBULA_VERSION=v1.11.2
VERSION=$(jq -r '.version' ../shared/src/product.json 2>/dev/null || echo dev)

prepare() {
	[ -f ".nebula/.patched-$NEBULA_VERSION" ] && return 0
	go mod download "github.com/slackhq/nebula@$NEBULA_VERSION"
	src="$(go env GOMODCACHE)/github.com/slackhq/nebula@$NEBULA_VERSION"
	[ -d .nebula ] && chmod -R u+w .nebula && rm -r .nebula
	cp -r "$src" .nebula
	chmod -R u+w .nebula
	# patch, not git apply: inside this repository git apply silently skips paths outside the repository root
	patch -d .nebula -p1 --forward --quiet < patches/nebula-hide-addresses.patch
	grep -q hideAddresses .nebula/lighthouse.go || { echo "the hide-addresses patch did not apply" >&2; exit 1; }
	touch ".nebula/.patched-$NEBULA_VERSION"
	echo "patched Nebula $NEBULA_VERSION in .nebula/"
}

build() { # os arch output
	CGO_ENABLED=0 GOOS=$1 GOARCH=$2 go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o "$3" .
	echo "built $3"
}

prepare
[ "$1" = "prepare" ] && exit 0
mkdir -p build
if [ $# -eq 0 ]; then
	ext=
	[ "$(go env GOOS)" = "windows" ] && ext=.exe
	build "$(go env GOOS)" "$(go env GOARCH)" "build/lish-overlay$ext"
	exit 0
fi
for target in "$@"; do
	os=${target%/*}
	arch=${target#*/}
	ext=
	[ "$os" = "windows" ] && ext=.exe
	build "$os" "$arch" "build/lish-overlay-$os-$arch$ext"
done
