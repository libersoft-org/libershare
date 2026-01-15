# LiberShare - installation

## 1. Download the latest version of this software and install required system tools

These are the installation instructions of this software for [Debian Linux](https://www.debian.org/).

Log in as "root" on your device and run the following commands to download the necessary dependencies and the latest version of this software from GitHub:

```sh
apt update
apt -y upgrade
apt -y install git curl
curl -fsSL https://bun.sh/install | bash
git clone https://github.com/libersoft-org/libershare.git
cd libershare/frontend/
./build.sh
cd ../backend/
./start.sh
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

... and then navigate to: https://YOUR_SERVER_ADDRESS:6003/ in your browser. Browser will show the certificate error, just skip it.
