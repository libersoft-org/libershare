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

The native application bundles the frontend and backend into a single installable application for various platforms.

**On Linux (Debian / Ubuntu):**

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
cargo install tauri-cli --version "^2"
apt -y install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev librsvg2-bin imagemagick libfuse2 patchelf zip jq
cd app
```

- To create a .deb package: `./build.sh --deb`
- To create an .rpm package: `./build.sh --rpm`
- To create an AppImage: `./build.sh --appimage`
- To create a portable .zip: `./build.sh --zip`
- All at once: `./build.sh --deb --rpm --appimage --zip`

**On macOS:**

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
cargo install tauri-cli --version "^2"
brew install librsvg imagemagick jq
cd app
```

- To create a .dmg installer: `./build.sh --dmg`
- To create a portable .zip: `./build.sh --zip`
- Both: `./build.sh --dmg --zip`

**On Windows:**

Download and install:

- [**Rust**](https://rustup.rs/)
- [**ImageMagick**](https://imagemagick.org/script/download.php#windows)
- [**Microsoft Visual Studio C++ Build Tools**](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
- [**WebView2**](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (included in Windows 10/11 by default)

Add **ImageMagick** to PATH. For example:

```powershell
[Environment]::SetEnvironmentVariable("PATH", "C:\Program Files\ImageMagick;" + [Environment]::GetEnvironmentVariable("PATH", "User"), "User")
```

Then in a command line:

```bat
cargo install tauri-cli --version "^2"
cd app
```

- To create an MSI installer: `build.bat /msi`
- To create an EXE installer (NSIS): `build.bat /nsis`
- To create a portable .zip: `build.bat /zip`
- All at once: `build.bat /msi /nsis /zip`

**Additional information**

The build script will:

1. Install dependencies and build the frontend (static HTML/JS/CSS)
2. Install dependencies and compile the backend into a standalone binary
3. Build the Tauri app with the backend as a sidecar

The resulting binary will be in `app/build/release/`. Packages (if created) will be in `app/build/release/bundle/`.

Available bundle formats per platform:

| Platform | Formats |
|----------|---------|
| **Linux** | `.deb`, `.rpm`, `.AppImage`, `.zip` |
| **macOS** | `.dmg`, `.zip` |
| **Windows** | `.msi`, `.exe` (NSIS), `.zip` |

The NSIS installer (.exe) includes a language selector dialog, license agreement, and installation directory selection. The MSI installer provides standard Windows Installer experience. The .zip contains the portable binaries (no installation needed).

#### Running the native app

- **Normal mode:** Just launch the application. The backend runs silently in the background.
- **Debug mode:** Launch from terminal / command line with `--debug` flag to see backend logs in the terminal.

### b) Build and run backend and frontend only (not bundled together in a native app):

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

By default backend starts on a random network port (ws://localhost:XXXXX) and accepts connections from localhost only. If you'd like to start it publicly, you can use parameter **--host** (0.0.0.0 means to make it public on all networks). You can also change port by **--port** and if you need secure connection (wss://), add **--secure** parameter following with **--privkey** and **--pubkey** paths for private and public key of your domain certificate.

**For example:**

```sh
./start.sh --datadir ./data --host 0.0.0.0 --port 1158 --secure --privkey /etc/letsencrypt/live/example.com/privkey.pem --pubkey /etc/letsencrypt/live/example.com/fullchain.pem
```

#### Frontend:

If you'd like to **run this software in developer mode**, you need HTTPS certificate keys.

**Generate self-signed certificate keys:**

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

```sh
cd ../frontend
./start-dev.sh wss://localhost:1158/
```

**On Windows:**

```bat
cd ..\frontend
start-dev.bat wss://localhost:1158/
```

Open your browser with parameter that allows playing sounds without user's interaction, for example in Chrome:

```sh
chrome --autoplay-policy=no-user-gesture-required
```

Navigate to: https://127.0.0.1:6003/

Browser will show the certificate error, just skip it.
