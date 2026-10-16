#!/bin/bash
# Builds lish-overlay (Nebula in user space, see main.go).
#
#   ./build.sh                    binary for this machine into build/
#   ./build.sh linux/arm64 ...    cross builds into build/lish-overlay-<os>-<arch>[.exe]
set -e
cd "$(dirname "$0")"
VERSION=$(jq -r '.version' ../shared/src/product.json 2>/dev/null || echo dev)

build() { # os arch output
	CGO_ENABLED=0 GOOS=$1 GOARCH=$2 go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o "$3" .
	echo "built $3"
}

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
