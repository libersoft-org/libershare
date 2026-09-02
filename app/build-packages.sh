_build_deb() {
	mkdir -p "$WORK/control"
	cat >"$WORK/control/control" <<CTRL_EOF
Package: ${PRODUCT_NAME_LOWER}
Version: ${PRODUCT_VERSION}
Architecture: ${PKG_DEB_ARCH}
Maintainer: LiberSoft <info@libersoft.org>
Installed-Size: ${PKG_INSTALLED_SIZE}
Depends: libwebkit2gtk-4.1-0, libgtk-3-0, pkexec
Section: net
Priority: optional
Homepage: ${PRODUCT_WEBSITE}
Description: ${PRODUCT_NAME} - peer-to-peer file sharing
CTRL_EOF
	tar -cf - -C "$WORK/control" . | xz $XZ_FLAGS >"$WORK/control.tar.xz"
	tar --owner=0 --group=0 -cf - -C "$PKG_STAGING" . | xz $XZ_FLAGS >"$WORK/data.tar.xz"
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
Requires: webkit2gtk4.1, gtk3, polkit

%description
${PRODUCT_NAME} - peer-to-peer file sharing application

%files
/usr/bin/${PRODUCT_NAME_LOWER}
/usr/bin/lish-backend
/usr/libexec/libershare/lish-network-helper
/usr/share/applications/${PRODUCT_NAME_LOWER}.desktop
/usr/share/applications/${PRODUCT_NAME_LOWER}-debug.desktop
/usr/share/icons/hicolor/256x256/apps/${PRODUCT_NAME_LOWER}.png
/usr/share/polkit-1/actions/org.libersoft.libershare.network.policy
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
depend = polkit
PKGINFO_EOF
	cd "$PKG_STAGING"
	bsdtar -czf "$WORK/.MTREE" \
		--format=mtree \
		--options='!all,use-set,type,uid,gid,mode,time,size,md5,sha256,link' \
		.
	bsdtar --uid 0 --gid 0 -cf - -C "$WORK" .PKGINFO .MTREE -C "$PKG_STAGING" . |
		xz $XZ_FLAGS >"$FINAL_DIR/${PRODUCT_NAME_LOWER}-${PRODUCT_VERSION}-1-${PKG_PACMAN_ARCH}.pkg.tar.xz"
}

_build_appimage() {
	AI_APPDIR="$WORK/AppDir"
	mkdir -p "$AI_APPDIR"
	cp -a "$PKG_STAGING"/* "$AI_APPDIR/"
	rm -f "$AI_APPDIR/usr/libexec/libershare/lish-network-helper"
	rm -f "$AI_APPDIR/usr/share/polkit-1/actions/org.libersoft.libershare.network.policy"
	rmdir "$AI_APPDIR/usr/libexec/libershare" "$AI_APPDIR/usr/libexec" "$AI_APPDIR/usr/share/polkit-1/actions" "$AI_APPDIR/usr/share/polkit-1" 2>/dev/null || true

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

_stage_zip_linux() {
	cp "$BUILD_RELEASE_DIR/$PRODUCT_NAME_LOWER" "$ZIP_STAGING/"
	cp "$ROOT_DIR/backend/build/lish-backend" "$ZIP_STAGING/lish-backend"
	_copy_debug_script
	chmod +x "$ZIP_STAGING/$PRODUCT_NAME_LOWER" "$ZIP_STAGING/lish-backend"
}

_stage_zip_windows() {
	cp "$BUILD_RELEASE_DIR/${PRODUCT_NAME}.exe" "$ZIP_STAGING/"
	cp "$ROOT_DIR/backend/build/lish-backend.exe" "$ZIP_STAGING/lish-backend.exe"
	# No network helper here on purpose: it may only elevate from an administrator-
	# owned directory (Program Files), and a portable ZIP runs from wherever it was
	# extracted. Host network settings are read-only in this bundle.
	PRODUCT_NAME="$PRODUCT_NAME" perl -pe 's/\{\{product_name\}\}/$ENV{PRODUCT_NAME}/g' \
		"$SCRIPT_DIR/bundle-scripts/Debug.bat" >"$ZIP_STAGING/Debug.bat"
}

_stage_zip_macos() {
	APP_BUNDLE="$BUILD_RELEASE_DIR/bundle/macos/${PRODUCT_NAME}.app"
	echo "Building .app bundle for macOS ZIP..."
	cargo tauri build --target "$RUST_TARGET" $PLATFORM_CONFIG --config '{"bundle":{"targets":["app"]}}'
	cp -r "$APP_BUNDLE" "$ZIP_STAGING/"
	_copy_debug_script
}

build_linux_packages() {
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

	PKG_STAGING=$(mktemp -d)
	mkdir -p "$PKG_STAGING/usr/bin"
	mkdir -p "$PKG_STAGING/usr/libexec/libershare"
	mkdir -p "$PKG_STAGING/usr/share/applications"
	mkdir -p "$PKG_STAGING/usr/share/icons/hicolor/256x256/apps"
	mkdir -p "$PKG_STAGING/usr/share/polkit-1/actions"

	cp "$BUILD_RELEASE_DIR/$PRODUCT_NAME_LOWER" "$PKG_STAGING/usr/bin/"
	chmod +x "$PKG_STAGING/usr/bin/$PRODUCT_NAME_LOWER"
	cp "$ROOT_DIR/backend/build/lish-backend" "$PKG_STAGING/usr/bin/"
	chmod +x "$PKG_STAGING/usr/bin/lish-backend"
	cp "$ROOT_DIR/backend/build/lish-network-helper" "$PKG_STAGING/usr/libexec/libershare/"
	chmod 0755 "$PKG_STAGING/usr/libexec/libershare/lish-network-helper"
	cp "$SCRIPT_DIR/polkit/org.libersoft.libershare.network.policy" "$PKG_STAGING/usr/share/polkit-1/actions/"
	chmod 0644 "$PKG_STAGING/usr/share/polkit-1/actions/org.libersoft.libershare.network.policy"

	generate_desktop_entry "$PKG_STAGING/usr/share/applications/${PRODUCT_NAME_LOWER}.desktop"
	generate_desktop_entry "$PKG_STAGING/usr/share/applications/${PRODUCT_NAME_LOWER}-debug.desktop" --debug
	cp "$SCRIPT_DIR/icons/icon.png" "$PKG_STAGING/usr/share/icons/hicolor/256x256/apps/${PRODUCT_NAME_LOWER}.png"

	PKG_INSTALLED_SIZE=$(du -sk "$PKG_STAGING" | cut -f1)
	PKG_JOBS=""
	[ "$MAKE_DEB" = "1" ] && run_pkg_job "DEB package (xz $XZ_FLAGS)" _build_deb deb
	[ "$MAKE_RPM" = "1" ] && run_pkg_job "RPM package (xz, $RPM_PAYLOAD)" _build_rpm rpm
	[ "$MAKE_PACMAN" = "1" ] && run_pkg_job "Pacman package (xz $XZ_FLAGS)" _build_pacman pacman
	[ "$MAKE_APPIMAGE" = "1" ] && run_pkg_job "AppImage (xz, $(nproc) cores)" _build_appimage appimage

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
	rm -r "$PKG_STAGING"
	echo "=== All Linux packages complete ==="
}
