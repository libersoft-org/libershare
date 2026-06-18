# LiberShare - installation

## 1. Download the latest version of this software and install required tools

**On Linux (Debian / Ubuntu):**

Log in as **root** and then run in terminal:

```sh
apt update
apt -y upgrade
apt -y install git curl
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
git clone https://github.com/libersoft-org/libershare.git
cd libershare
```

**On macOS:**

```sh
brew install git
curl -fsSL https://bun.sh/install | bash
git clone https://github.com/libersoft-org/libershare.git
cd libershare
```

**On Windows:**

Download and install [**Git**](https://git-scm.com/download/win) and [**Bun**](https://bun.sh/), then in a command line:

```bat
git clone https://github.com/libersoft-org/libershare.git
cd libershare
```

## 2. Build and use the app

### a) Native application

The native application bundles the frontend and backend into a single installable application. The build system uses Docker for Linux/Windows cross-compilation and can target multiple OS/architecture combinations from a single host. macOS builds require a macOS host (Docker cannot be used due to Apple SDK licensing).

#### Prerequisites

**On Linux (Debian / Ubuntu):**

```sh
apt -y install docker.io
systemctl enable --now docker
cd app
```

**On macOS:**

```sh
brew install colima docker docker-buildx
mkdir -p ~/.docker && echo '{"cliPluginsExtraDirs": ["/opt/homebrew/lib/docker/cli-plugins"]}' > ~/.docker/config.json
colima start
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
curl -fsSL https://raw.githubusercontent.com/cargo-bins/cargo-binstall/main/install-from-binstall-release.sh | bash
cargo binstall tauri-cli --no-confirm
curl -fsSL https://bun.sh/install | bash
brew install librsvg imagemagick jq
cd app
```

**On Windows:**

Download and install:

- [**Docker Desktop**](https://www.docker.com/products/docker-desktop/) (needed only for Linux builds)
- [**Rust**](https://rustup.rs/) (includes cargo and MSVC build tools)
- [**ImageMagick**](https://imagemagick.org/script/download.php#windows) (add to PATH)
- [**Microsoft Visual Studio C++ Build Tools**](https://visualstudio.microsoft.com/visual-cpp-build-tools/)

Then install Tauri CLI:

```bat
curl -fsSL https://raw.githubusercontent.com/cargo-bins/cargo-binstall/main/install-from-binstall-release.sh | bash
cargo binstall tauri-cli --no-confirm
cd app
```

#### Building

The build script handles everything: generating icons, building the frontend, compiling the backend, building the Tauri app, and packaging.

Run `./build.sh --help` or `build.bat --help` for full usage details.

**On Linux / macOS:**

```sh
./build.sh [--os OS...] [--target ARCH...] [--format FMT...] [--compress LEVEL]
```

> **IMPORTANT NOTE:** macOS Gatekeeper blocks unsigned/non-notarized apps downloaded from the internet with a **"is damaged and can't be opened"** error. After downloading the DMG or ZIP, run this command in Terminal before opening the app:
>
> ```sh
> xattr -cr /path/to/LiberShare.app
> ```
>
> For example, after installing from DMG: `xattr -cr /Applications/LiberShare.app`
>
> Or after extracting the ZIP: `xattr -cr ~/Downloads/LiberShare.app`
>
> This removes the quarantine attribute and you can run the app.

**On Windows:**

```bat
build.bat [--os OS...] [--target ARCH...] [--format FMT...] [--compress LEVEL]
```

The NSIS installer (.exe) includes a language selector dialog, license agreement, and installation directory selection. The MSI installer provides standard Windows Installer experience. The .zip contains portable binaries (no installation needed).

#### Build compatibility matrix

| Target                  | Host: Linux | Host: Windows | Host: macOS |
| ----------------------- | :---------: | :-----------: | :---------: |
| **Linux x86_64**        |  ✅ Docker  |   ✅ Docker   |  ✅ Docker  |
| **Linux aarch64**       |  ✅ Docker  |   ✅ Docker   |  ✅ Docker  |
| **Windows x86_64**      | ✅ Docker¹  |   ✅ Native   | ✅ Docker¹  |
| **Windows aarch64**     | ✅ Docker¹  |   ✅ Native   | ✅ Docker¹  |
| **macOS x86_64**        |     ❌      |      ❌       |  ✅ Native  |
| **macOS aarch64**       |     ❌      |      ❌       |  ✅ Native  |
| **macOS universal**     |     ❌      |      ❌       |  ✅ Native  |
| **Format: deb**         |     ✅      |      ✅       |     ✅      |
| **Format: rpm**         |     ✅      |      ✅       |     ✅      |
| **Format: pacman**      |     ✅      |      ✅       |     ✅      |
| **Format: appimage**    |     ✅      |      ✅       |     ✅      |
| **Format: nsis** (Win)  |     ✅      |      ✅       |     ✅      |
| **Format: msi** (Win)   |     ❌²     |      ✅       |     ❌²     |
| **Format: dmg** (macOS) |     ❌      |      ❌       |     ✅      |
| **Format: zip**         |     ✅      |      ✅       |     ✅      |

- ¹ Windows cross-compilation via `cargo-xwin` inside Docker
- ² MSI requires WiX toolset (Windows-only)

#### Running the native app

- **Normal mode:** Just launch the application. The backend runs silently in the background.
- **Debug mode:** Opens a built-in debug console window that shows backend log messages. Also enables the developer console in the webview (F12). Useful for troubleshooting issues.

**How to launch debug mode:**

| Platform    | Bundle               | How to launch                                                |
| ----------- | -------------------- | ------------------------------------------------------------ |
| **Windows** | NSIS / MSI installer | Start Menu → "LiberShare - debug" shortcut (also on desktop) |
| **Windows** | ZIP                  | Run `Debug.bat`                                              |
| **Windows** | Command line         | `LiberShare.exe /debug`                                      |
| **Linux**   | DEB / RPM / AppImage | App menu → "LiberShare - debug"                              |
| **Linux**   | ZIP                  | Run `./debug.sh`                                             |
| **Linux**   | Terminal             | `./libershare --debug`                                       |
| **macOS**   | ZIP                  | Run `./debug.sh`                                             |
| **macOS**   | Terminal             | `open LiberShare.app --args --debug`                         |

### b) Run backend and frontend only (not bundled together in a native app):

#### Backend:

**On Linux / macOS:**

```sh
cd backend
./start.sh
```

**On Windows:**

```bat
cd backend
start.bat
```

By default backend starts on a random network port (ws://localhost:XXXXX) and accepts connections from localhost only. If you'd like to start it publicly, you can use parameter **--host** (0.0.0.0 means to make it public on all networks). You can also change port by **--port** and if you need secure connection (wss://), add **--secure** parameter following with **--privkey** and **--pubkey** paths for private and public key of your domain certificate. Use **--token** to protect the WebSocket API against misuse. When starting the frontend manually, pass the same token there.

**For example:**

```sh
./start.sh --datadir ./data --host 0.0.0.0 --port 1158 --token devtoken --secure --privkey /etc/letsencrypt/live/example.com/privkey.pem --pubkey /etc/letsencrypt/live/example.com/fullchain.pem
```

##### Token environment variables

You can also provide the API token through environment variables instead of command-line arguments.

| Variable          | Used by              | Description                                                       |
| ----------------- | -------------------- | ----------------------------------------------------------------- |
| `LISH_TOKEN`      | Backend              | Protects the backend WebSocket API with the given token.          |
| `VITE_LISH_TOKEN` | Frontend development | Passes the backend token to the Vite frontend development server. |

**On Linux / macOS:**

```sh
cd backend
LISH_TOKEN=devtoken ./start.sh --port 1158

cd ../frontend
VITE_LISH_TOKEN=devtoken ./start-dev.sh wss://localhost:1158/
```

**On Windows (PowerShell):**

```powershell
cd backend
$env:LISH_TOKEN='devtoken'; .\start.bat --port 1158

cd ..\frontend
$env:VITE_LISH_TOKEN='devtoken'; .\start-dev.bat wss://localhost:1158/
```

##### Debug logging (environment variables)

If you are not a developer, please skip this.

The backend respects a few environment variables for verbose diagnostic output. None of them are required for normal operation - they exist only for development and troubleshooting.

| Variable                          | Source                                  | Description                                                                                                                |
| --------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `DEBUG`                           | External (`libp2p` / `weald` / `debug`) | Enables namespace-based debug logs from the libp2p stack. Standard `debug`-style pattern syntax (wildcards, `-` excludes). |
| `LOG_PREFIX`                      | LiberShare-specific                     | Adds a prefix to backend log lines, useful when comparing logs from multiple backend instances.                            |
| `LIBERSHARE_SCORE_DEBUG`          | LiberShare-specific                     | Set to `1` to print a per-peer breakdown of the peer scoring algorithm.                                                    |
| `LIBERSHARE_TRACE_PX`             | LiberShare-specific                     | Set to `1` to trace PX trust score decisions for a small bounded set of peers.                                             |
| `MEMTRACE`             | LiberShare-specific                     | Set to `0` to disable periodic memory trace logging.                                                                       |
| `MEMTRACE_INTERVAL_MS` | LiberShare-specific                     | Memory trace interval in milliseconds. Defaults to `30000`.                                                                |
| `MEMTRACE_FILE`        | LiberShare-specific                     | Memory trace output file. Defaults to `memory-trace.jsonl` in the data directory.                                          |
| `HEAP_TRIGGER`         | LiberShare-specific                     | Set to `0` to disable heap snapshot trigger support.                                                                       |

`DEBUG` is **not** a LiberShare-defined variable — it comes from the [`debug`](https://www.npmjs.com/package/debug) convention used by libp2p (via the `weald` library). Common patterns:

- `DEBUG='libp2p:*'` — all libp2p namespaces (verbose).
- `DEBUG='libp2p:gossipsub*'` — only gossipsub.
- `DEBUG='libp2p:*,-libp2p:noise*'` — everything except noise.

**On Linux / macOS:**

```sh
DEBUG='libp2p:*' ./start.sh
```

**On Windows (PowerShell):**

```powershell
$env:DEBUG='libp2p:*'; .\start.bat
```

#### Frontend:

If you'd like to **run this software in developer mode**, you need HTTPS certificate keys.

You can either use your own certificate (e.g. from Let's Encrypt) with `--privkey` and `--pubkey` parameters, or generate a self-signed certificate:

**On Linux:**

```sh
openssl req -x509 -newkey rsa:2048 -nodes -days $(expr '(' $(date -d 2999/01/01 +%s) - $(date +%s) + 86399 ')' / 86400) -subj "/" -keyout server.key -out server.crt
```

**On macOS:**

```sh
openssl req -x509 -newkey rsa:2048 -nodes -days $(( ( $(date -j -f "%Y/%m/%d" "2999/01/01" +%s) - $(date +%s) + 86399 ) / 86400 )) -subj "/" -keyout server.key -out server.crt
```

**On Windows (PowerShell):**

```powershell
$days = [math]::Floor(([datetime]"2999-01-01" - (Get-Date)).TotalDays)
openssl req -x509 -newkey rsa:2048 -nodes -days $days -subj "/" -keyout server.key -out server.crt
```

... then run frontend in developer mode that connects to a specified port on backend:

**On Linux / macOS:**

With self-signed certificates in the frontend directory:

```sh
cd ../frontend
./start-dev.sh wss://localhost:1158/ --token devtoken
```

With custom certificate paths:

```sh
cd ../frontend
./start-dev.sh wss://localhost:1158/ --token devtoken --privkey /etc/letsencrypt/live/example.com/privkey.pem --pubkey /etc/letsencrypt/live/example.com/fullchain.pem
```

**On Windows:**

With self-signed certificates in the frontend directory:

```bat
cd ..\frontend
start-dev.bat wss://localhost:1158/ --token devtoken
```

With custom certificate paths:

```bat
cd ..\frontend
start-dev.bat wss://localhost:1158/ --token devtoken --privkey C:\certs\privkey.pem --pubkey C:\certs\fullchain.pem
```

##### Frontend development environment variables

The frontend development server can also be configured through Vite environment variables. The `start-dev` scripts set these for you when you use command-line arguments.

| Variable           | Description                                                         |
| ------------------ | ------------------------------------------------------------------- |
| `VITE_BACKEND_URL` | Backend WebSocket URL used by the frontend, e.g. `wss://host:1158`. |
| `VITE_SSL_KEY`     | Private key path for the HTTPS development server.                  |
| `VITE_SSL_CERT`    | Certificate path for the HTTPS development server.                  |

Open your browser with parameter that allows playing sounds without user's interaction, for example in Chrome:

```sh
chrome --autoplay-policy=no-user-gesture-required
```

Navigate to: https://127.0.0.1:6003/

Browser will show the certificate error, just skip it.

## 3. Kiosk mode (Linux)

The `install-kiosk.sh` script turns a clean minimal Debian installation (netinst) into a dedicated LiberShare kiosk — the app starts automatically in fullscreen after boot with no desktop environment, login screen, or visible OS interface. This is intended for standalone devices such as TV boxes.

**Important note**: Do not run this on a machine with an existing desktop environment or other services!

**Usage:**

```sh
sudo ./install-kiosk.sh
```

After the script finishes, reboot the machine. It will boot directly into LiberShare in kiosk mode.
