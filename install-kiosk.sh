#!/usr/bin/env bash
set -euo pipefail

# ---- Settings (EDIT AS NEEDED) -----------------------------------------------
KIOSK_USER="kiosk"
# Set the command used to launch LiberShare:
# Examples:
#   APP_CMD="/usr/local/bin/libreshare"
#   APP_CMD="/opt/libreshare/libreshare --kiosk"
#   APP_CMD="/home/kiosk/LiberShare.AppImage --kiosk"
APP_CMD="/usr/bin/libershare"

# If your app doesn't support kiosk/fullscreen via a parameter, you can send F11:
SEND_F11_FALLBACK="no" # yes/no

# ------------------------------------------------------------------------------
require_root() {
	if [[ "${EUID}" -ne 0 ]]; then
		echo "Please run as root (or via sudo)."
		exit 1
	fi
}

apt_install_min_x() {
	export DEBIAN_FRONTEND=noninteractive
	apt update
	apt dist-upgrade -y

	# Minimal Xorg + xinit (no display manager) + input driver
	# matchbox-window-manager = simple WM for kiosk without decorations
	# unclutter = hides cursor
	# x11-xserver-utils = xset etc.
	# xdotool = optionally for sending keystrokes (F11)
	apt install -y --no-install-recommends \
		xserver-xorg-core \
		xserver-xorg-input-libinput \
		xinit \
		matchbox-window-manager \
		x11-xserver-utils \
		unclutter \
		dbus \
		dbus-x11 \
		xdotool \
		wmctrl \
		feh \
		plymouth plymouth-themes \
		kbd

}

install_plymouth_splash() {
	local theme="kiosk"
	local img_src="/home/${KIOSK_USER}/splash.png" # place your image here
	local theme_dir="/usr/share/plymouth/themes/${theme}"
	local img_dst="${theme_dir}/splash.png"

	if [[ ! -f "$img_src" ]]; then
		echo "WARNING: Missing $img_src (upload splash.png there). Plymouth theme will be created, but it won't display without the image."
	fi

	install -d "$theme_dir"

	# copy image (if exists)
	if [[ -f "$img_src" ]]; then
		install -m 0644 "$img_src" "$img_dst"
	fi

	# .plymouth descriptor
	cat >"${theme_dir}/${theme}.plymouth" <<EOF
[Plymouth Theme]
Name=Kiosk
Description=Static kiosk splash (script)
ModuleName=script

[script]
ImageDir=/usr/share/plymouth/themes/kiosk
ScriptFile=/usr/share/plymouth/themes/kiosk/kiosk.script
EOF

	# script module: static image centered (scales to fit)
	cat >"${theme_dir}/${theme}.script" <<'EOF'
splash_image = Image("splash.png");

fun draw_callback ()
{
  sw = Window.GetWidth();
  sh = Window.GetHeight();

  Window.SetBackgroundTopColor(0, 0, 0);
  Window.SetBackgroundBottomColor(0, 0, 0);

  iw = splash_image.GetWidth();
  ih = splash_image.GetHeight();

  if (iw <= 0 || ih <= 0)
    return;

  # Keep aspect ratio, cover the whole screen (may crop)
  screen_ratio = sh / sw;
  image_ratio  = ih / iw;

  if (screen_ratio > image_ratio)
    scale = sh / ih;  # screen "taller" => match height
  else
    scale = sw / iw;  # screen "wider"  => match width

  new_w = Math.Int(iw * scale);
  new_h = Math.Int(ih * scale);

  scaled = splash_image.Scale(new_w, new_h);

  x = Window.GetX() + sw / 2 - scaled.GetWidth() / 2;
  y = Window.GetY() + sh / 2 - scaled.GetHeight() / 2;

  splash_sprite.SetImage(scaled);
  splash_sprite.SetPosition(x, y, -1000);
}

# Create sprite once; we'll update its image/position on refresh
splash_sprite = Sprite();

Plymouth.SetRefreshFunction(draw_callback);
EOF

	# Set theme as default and rebuild initramfs
	plymouth-set-default-theme -R "$theme" || true
}

create_kiosk_user() {
	if ! id -u "$KIOSK_USER" >/dev/null 2>&1; then
		useradd -m -s /bin/bash "$KIOSK_USER"
	fi

	touch /home/"$KIOSK_USER"/.hushlogin
	chown kiosk:kiosk /home/"$KIOSK_USER"/.hushlogin
	chmod 0644 /home/"$KIOSK_USER"/.hushlogin

	: >/etc/motd
	: >/etc/issue
	: >/etc/issue.net
}

write_xinitrc() {
	local home_dir
	home_dir="$(getent passwd "$KIOSK_USER" | cut -d: -f6)"

	install -d -m 0755 "$home_dir"
	chown "$KIOSK_USER:$KIOSK_USER" "$home_dir"

	cat >"$home_dir/.xinitrc" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

# --- Disable screensaver/blanking/DPMS to keep the screen on ---
xset s off
xset s noblank
xset -dpms

# --- Hide mouse cursor after a moment of inactivity ---
unclutter -idle 0.2 -root &

feh --no-fehbg --bg-fill --fullscreen --hide-pointer /home/kiosk/splash.png &

# --- Start minimal WM without title bars ---
# -use_titlebar no -> no title bars
# -use_cursor no  -> set to "yes" if you want the cursor completely hidden
matchbox-window-manager -use_titlebar no &

# Small delay to let the WM start up
sleep 0.5

# --- App launch (filled in by the install script) ---
EOF

	# Inject APP_CMD and fallback option into .xinitrc
	# (done this way to keep the heredoc above clean and readable)
	cat >>"$home_dir/.xinitrc" <<EOF

APP_CMD=${APP_CMD@Q}
SEND_F11_FALLBACK=${SEND_F11_FALLBACK@Q}

# Launch the app:
# - If the app supports "--kiosk" / "--fullscreen", put it in APP_CMD.
# - If not, we'll try sending F11 after startup (often works with Electron/Chromium).

  # Start app in background so we can optionally send F11
  dbus-run-session -- bash -lc "\$APP_CMD" &
  APP_PID=\$!

  # Fallback: send F11 a few times after startup (harmless if the app ignores it)
  if [[ "\$SEND_F11_FALLBACK" == "yes" ]]; then
    sleep 1.2
    xdotool key F11 || true
    sleep 0.6
    xdotool key F11 || true
  fi

  sleep .5
  for i in \$(seq 1 80); do
    WIN_ID="\$(wmctrl -l 2>/dev/null | awk 'NF{print \$1}' | tail -n 1)"
    if [ -n "\$WIN_ID" ]; then
      wmctrl -ia "\$WIN_ID" || true
      break
    fi
    sleep 0.1
  done

  wait "\$APP_PID"

EOF

	chmod +x "$home_dir/.xinitrc"
	chown "$KIOSK_USER:$KIOSK_USER" "$home_dir/.xinitrc"
}

enable_autologin_tty1() {
	install -d /etc/systemd/system/getty@tty1.service.d
	cat >/etc/systemd/system/getty@tty1.service.d/override.conf <<EOF
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin ${KIOSK_USER} --skip-login --nonewline --noissue %I \$TERM
Type=idle
EOF

	systemctl daemon-reload
	systemctl enable --now getty@tty1.service
}

write_bash_profile_startx() {
	local home_dir
	home_dir="$(getent passwd "$KIOSK_USER" | cut -d: -f6)"

	cat >"$home_dir/.bash_profile" <<'EOF'
# Start X automatically only on tty1
if [ -z "${DISPLAY:-}" ] && [ "$(tty)" = "/dev/tty1" ]; then
  exec startx -- :0 -nolisten tcp -quiet -logverbose 0 > /home/kiosk/startx.log 2>&1
fi
EOF

	chown "$KIOSK_USER:$KIOSK_USER" "$home_dir/.bash_profile"
	chmod 0644 "$home_dir/.bash_profile"
}

sanity_checks() {
	command -v startx >/dev/null 2>&1 || {
		echo "Error: startx not found."
		exit 1
	}
	if [[ ! -x "${APP_CMD%% *}" ]]; then
		echo "WARNING: APP_CMD looks incorrect: $APP_CMD"
		echo "Set APP_CMD to an existing executable file."
	fi
}

configure_grub_splash() {
	local f="/etc/default/grub"

	# helper: set or append KEY=VALUE
	set_kv() {
		local key="$1" value="$2"
		if grep -qE "^${key}=" "$f"; then
			sed -i "s|^${key}=.*|${key}=${value}|" "$f"
		else
			echo "${key}=${value}" >>"$f"
		fi
	}

	# Graphical GRUB mode + keep it for the kernel
	set_kv "GRUB_GFXMODE" "1024x768"
	set_kv "GRUB_GFXPAYLOAD_LINUX" "keep"
	set_kv "GRUB_TERMINAL" "gfxterm"
	set_kv "GRUB_TIMEOUT" "0"
	set_kv "GRUB_TIMEOUT_STYLE" "hidden"

	# Ensure cmdline contains the required parameters (preserve existing ones)
	if grep -qE '^GRUB_CMDLINE_LINUX_DEFAULT=' "$f"; then
		local cur
		cur="$(sed -n 's/^GRUB_CMDLINE_LINUX_DEFAULT="\([^"]*\)".*/\1/p' "$f")"

		ensure_arg() {
			local arg="$1"
			[[ " $cur " == *" $arg "* ]] || cur="$arg $cur"
		}

		ensure_arg "quiet"
		ensure_arg "splash"
		ensure_arg "vt.global_cursor_default=0"

		# ensure_arg "loglevel=0"
		# ensure_arg "systemd.show_status=0"
		# ensure_arg "rd.systemd.show_status=0"
		# ensure_arg "udev.log_level=0"
		# ensure_arg "rd.udev.log_level=0"

		cur="$(echo "$cur" | awk '{$1=$1;print}')"
		sed -i "s|^GRUB_CMDLINE_LINUX_DEFAULT=.*|GRUB_CMDLINE_LINUX_DEFAULT=\"${cur}\"|" "$f"
	else
		echo 'GRUB_CMDLINE_LINUX_DEFAULT="quiet splash vt.global_cursor_default=0"' >>"$f"
	fi

	update-grub
}

ensure_kms_modules_in_initramfs() {
	local m="/etc/initramfs-tools/modules"
	touch "$m"

	# Not harmful, just increases initramfs size. Helps on Intel/AMD/NVIDIA/virt and modern simpledrm.
	for mod in simpledrm bochs_drm virtio_gpu vmwgfx i915 amdgpu radeon nouveau; do
		grep -qxF "$mod" "$m" || echo "$mod" >>"$m"
	done
	echo 'FRAMEBUFFER=y' >/etc/initramfs-tools/conf.d/splash
}

main() {
	require_root
	apt_install_min_x
	create_kiosk_user
	ensure_kms_modules_in_initramfs
	configure_grub_splash
	install_plymouth_splash
	write_xinitrc
	write_bash_profile_startx
	enable_autologin_tty1
	sanity_checks

	echo "Logs: journalctl -u getty@tty1"

	# Auto-login
	systemctl restart getty@tty1
}

main "$@"
