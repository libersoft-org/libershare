# syntax=docker/dockerfile:1
# Multi-arch build environment for LiberShare Tauri app
# Usage: docker build -t libershare-builder .
#        docker run --platform linux/amd64 -v ...  (for x86_64)
#        docker run --platform linux/arm64 -v ...  (for aarch64)

FROM debian:trixie

ARG DEBIAN_FRONTEND=noninteractive

# System dependencies for Tauri + bundling
RUN --mount=type=cache,target=/var/cache/apt \
	--mount=type=cache,target=/var/lib/apt/lists \
	apt-get update && apt-get install -y --no-install-recommends \
	# Build essentials
	build-essential \
	curl \
	wget \
	ca-certificates \
	pkg-config \
	file \
	# Tauri/WebKitGTK dependencies
	libwebkit2gtk-4.1-dev \
	libgtk-3-dev \
	libayatana-appindicator3-dev \
	librsvg2-dev \
	libssl-dev \
	# Icon generation
	imagemagick \
	librsvg2-bin \
	# JSON processing
	jq \
	# Bundling tools
	nsis \
	zip \
	unzip \
	# AppImage support (FUSE not available in Docker, use extract-and-run)
	libfuse2 \
	# Git (for cargo dependencies)
	git \
	# Python3 (for PE patching on Windows cross-builds)
	python3

# Install Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
ENV PATH="/root/.cargo/bin:${PATH}"

# Install cargo-binstall (downloads pre-built binaries, avoids compiling under QEMU)
RUN curl -fsSL https://raw.githubusercontent.com/cargo-bins/cargo-binstall/main/install-from-binstall-release.sh | bash

# Install Tauri CLI (pre-built binary via binstall to avoid QEMU segfaults on cross-arch)
RUN cargo binstall tauri-cli --no-confirm

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# AppImage: disable FUSE requirement (not available in Docker)
ENV APPIMAGE_EXTRACT_AND_RUN=1

# Working directory will be mounted at runtime
WORKDIR /workspace
