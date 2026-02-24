# syntax=docker/dockerfile:1
# LiberShare cross-compilation build environment
# Runs natively on the host architecture (amd64 or arm64).
# Can cross-compile to the other Linux arch via cross-linker + multiarch libs.
# Can cross-compile to Windows via cargo-xwin.
# No QEMU emulation needed.

FROM debian:trixie

ARG DEBIAN_FRONTEND=noninteractive

# Detect host arch, add the foreign architecture, and install all dependencies.
# CROSS_ARCH is persisted to /etc/cross-arch so later RUN steps can reuse it.
RUN --mount=type=cache,target=/var/cache/apt \
	--mount=type=cache,target=/var/lib/apt/lists \
	rm -rf /var/lib/apt/lists/* && \
	NATIVE=$(dpkg --print-architecture) && \
	if [ "$NATIVE" = "amd64" ]; then \
		CROSS_ARCH=arm64; \
		CROSS_GCC="gcc-aarch64-linux-gnu g++-aarch64-linux-gnu"; \
		dpkg --add-architecture arm64; \
	else \
		CROSS_ARCH=amd64; \
		CROSS_GCC="gcc-x86-64-linux-gnu g++-x86-64-linux-gnu"; \
		dpkg --add-architecture amd64; \
	fi && \
	echo "$CROSS_ARCH" > /etc/cross-arch && \
	apt-get update && apt-get install -y --no-install-recommends \
		# Build essentials & tools
		build-essential \
		curl \
		ca-certificates \
		pkg-config \
		file \
		imagemagick \
		librsvg2-bin \
		jq \
		nsis \
		zip \
		unzip \
		squashfs-tools \
		rpm \
		libarchive-tools \
		git \
		python3 \
		llvm \
		clang \
		lld \
		# Cross-compiler for the other architecture
		$CROSS_GCC \
		# Native-arch Tauri/WebKitGTK development libraries
		libwebkit2gtk-4.1-dev \
		libgtk-3-dev \
		libayatana-appindicator3-dev \
		librsvg2-dev \
		libssl-dev \
		# Cross-arch libraries (non-conflicting -dev packages)
		libgtk-3-dev:${CROSS_ARCH} \
		librsvg2-dev:${CROSS_ARCH} \
		libssl-dev:${CROSS_ARCH} \
		# Cross-arch transitive deps
		libatk1.0-dev:${CROSS_ARCH} \
		libatk-bridge2.0-dev:${CROSS_ARCH} \
		libcairo2-dev:${CROSS_ARCH} \
		libgdk-pixbuf-2.0-dev:${CROSS_ARCH} \
		libglib2.0-dev:${CROSS_ARCH} \
		libpango1.0-dev:${CROSS_ARCH} \
		libjavascriptcoregtk-4.1-dev:${CROSS_ARCH} \
		# Cross-arch runtime lib (doesn't conflict)
		libwebkit2gtk-4.1-0:${CROSS_ARCH} && \
	# Extract conflicting cross-arch packages manually.
	# These packages (or their transitive deps) have Conflicts: on cross-arch,
	# so apt can't co-install both architectures. We download and extract them
	# (headers, .pc files, .so symlinks) without dpkg registration.
	cd /tmp && \
	apt-get download \
		libwebkit2gtk-4.1-dev:${CROSS_ARCH} \
		libayatana-appindicator3-dev:${CROSS_ARCH} \
		libayatana-appindicator3-1:${CROSS_ARCH} \
		libsoup-3.0-dev:${CROSS_ARCH} && \
	for deb in *.deb; do dpkg-deb -x "$deb" /; done && \
	rm -f /tmp/*.deb && \
	# Strip Requires.private from cross-arch .pc files.
	# pkgconf validates private deps even for dynamic linking; those transitive
	# -dev packages (sqlite3, libpsl, krb5, nghttp2, …) are not installed for
	# the cross arch. Private deps are only needed for static linking (--static).
	if [ "$CROSS_ARCH" = "arm64" ]; then CROSS_MULTIARCH="aarch64-linux-gnu"; \
	else CROSS_MULTIARCH="x86_64-linux-gnu"; fi && \
	sed -i 's/^Requires\.private:.*$/Requires.private:/' \
		/usr/lib/${CROSS_MULTIARCH}/pkgconfig/*.pc 2>/dev/null || true

# Install Rust with both Linux targets
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup-init.sh \
	&& sh /tmp/rustup-init.sh -y --default-toolchain stable \
	&& rm /tmp/rustup-init.sh
ENV PATH="/root/.cargo/bin:${PATH}"
RUN rustup target add aarch64-unknown-linux-gnu x86_64-unknown-linux-gnu

# Configure cross-linkers for Cargo
RUN printf '[target.aarch64-unknown-linux-gnu]\nlinker = "aarch64-linux-gnu-gcc"\n\n[target.x86_64-unknown-linux-gnu]\nlinker = "x86_64-linux-gnu-gcc"\n' \
	>> /root/.cargo/config.toml

# Install cargo-binstall (downloads pre-built binaries, avoids compiling from source)
RUN curl -fsSL https://raw.githubusercontent.com/cargo-bins/cargo-binstall/main/install-from-binstall-release.sh -o /tmp/binstall.sh \
	&& bash /tmp/binstall.sh \
	&& rm /tmp/binstall.sh

# Install Tauri CLI (pre-built binary via binstall)
RUN cargo binstall tauri-cli --no-confirm

# Install cargo-xwin for Windows cross-compilation
RUN cargo binstall cargo-xwin --no-confirm
RUN rustup target add x86_64-pc-windows-msvc

# Install Bun
RUN curl -fsSL https://bun.sh/install -o /tmp/bun-install.sh \
	&& bash /tmp/bun-install.sh \
	&& rm /tmp/bun-install.sh
ENV PATH="/root/.bun/bin:${PATH}"

# AppImage: disable FUSE requirement (not available in Docker)
ENV APPIMAGE_EXTRACT_AND_RUN=1

# Working directory will be mounted at runtime
WORKDIR /workspace
