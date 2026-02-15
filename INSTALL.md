# LiberShare - installation

## 1. Download the latest version of this software and install required system tools

These are the installation instructions of this software for [Debian Linux](https://www.debian.org/).

Log in as "root" on your device and run the following commands to download the necessary dependencies and the latest version of this software from GitHub:

```sh
apt update
apt -y upgrade
apt -y install git curl
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
git clone https://github.com/libersoft-org/libershare.git
cd libershare/frontend/
./build.sh
cd ../backend/
./start.sh
```

By default backend starts on ws://localhost:1158 (accepts connections from localhost only), if you'd like to start it publicly, you can use parameter **--host** (0.0.0.0 means to make it public on all networks). You can also change port by **--port** and if you need secure connection (wss://), add **--secure** parameter following with **--privkey** and **--pubkey** paths for private and public key of your domain certificate. For example:

```sh
./start.sh --datadir ./data --host 0.0.0.0 --port 1158 --secure --privkey /etc/letsencrypt/live/example.com/privkey.pem --pubkey /etc/letsencrypt/live/example.com/fullchain.pem
```

## 2. Use this software

Open your browser with parameter that allows playing sounds without user's interaction, for example in Chrome:

```sh
chrome --autoplay-policy=no-user-gesture-required
```

Navigate to: http://127.0.0.1/

If you'd like to **run this software in developer mode**, you need HTTPS certificate keys.

**Generate self-signed certificate keys:**

```sh
openssl req -x509 -newkey rsa:2048 -nodes -days $(expr '(' $(date -d 2999/01/01 +%s) - $(date +%s) + 86399 ')' / 86400) -subj "/" -keyout server.key -out server.crt
```

... then use this command to start the server in development mode:

```sh
./start-dev.sh
```

If you have your backend somewhere else (for example for development purposes, specify the backend address, for example:

```sh
./start-dev.sh wss://example.com:1234/
```

... and then navigate to: https://YOUR_SERVER_ADDRESS:6003/ in your browser. Browser will show the certificate error, just skip it.

## 3. Native application

The native app bundles the frontend and backend into a single installable application for various platforms.

**On Linux (Debian / Ubuntu):**

```sh
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
cargo install tauri-cli --version "^2"
apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev librsvg2-bin imagemagick
cd app
./build.sh
```

To create a .deb package: `./build.sh --deb`
To create an .rpm package: `./build.sh --rpm`
Both: `./build.sh --deb --rpm`

**On macOS:**

```sh
curl -fsSL https://bun.sh/install | bash
source ~/.zshrc
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
cargo install tauri-cli --version "^2"
cd app
./build.sh
```

To create a .dmg installer: `./build.sh --dmg`

**On Windows:**

Download and install:

- [**Bun**](https://bun.sh/)
- [**Rust**](https://rustup.rs/)
- [**ImageMagick**](https://imagemagick.org/script/download.php#windows)
- [**Microsoft Visual Studio C++ Build Tools**](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
- [**WebView2**](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (included in Windows 10/11 by default)

Then in a command line:

```bat
cargo install tauri-cli --version "^2"
cd app
build.bat
```

To create an MSI installer: `build.bat /msi`

**Additional information**

The build script will:

1. Install dependencies and build the frontend (static HTML/JS/CSS)
2. Install dependencies and compile the backend into a standalone binary
3. Build the Tauri app with the backend as a sidecar

The resulting binary will be in `app/build/release/`. Packages (if created) will be in `app/build/release/bundle/`.

### Running the native app

- **Normal mode:** Just launch the application. The backend runs silently in the background.
- **Debug mode:** Launch from terminal / command line with `--debug` flag to see backend logs in the terminal.
