#!/bin/sh
set -eu

cert_dir="${TLS_CERT_DIR:-/app/certs}"
key_file="${TLS_KEY_FILE:-$cert_dir/privkey.pem}"
cert_file="${TLS_CERT_FILE:-$cert_dir/pubkey.pem}"
cert_days="${TLS_CERT_DAYS:-3650}"
cert_subject="${TLS_CERT_SUBJECT:-/CN=libershare.local}"
cert_san="${TLS_CERT_SAN:-DNS:localhost,IP:127.0.0.1}"

# The mounted certificate directory keeps its host owner: run as that UID/GID
# (LISH_UID/LISH_GID in compose) instead of changing ownership here.
if [ "$(id -u)" = 0 ]; then
	echo "Refusing to run as root. Set LISH_UID/LISH_GID to the owner of the mounted directories." >&2
	exit 1
fi
umask 077

if [ ! -s "$key_file" ] || [ ! -s "$cert_file" ]; then
	mkdir -p "$cert_dir"
	openssl req \
		-x509 \
		-nodes \
		-newkey rsa:2048 \
		-sha256 \
		-days "$cert_days" \
		-keyout "$key_file" \
		-out "$cert_file" \
		-subj "$cert_subject" \
		-addext "subjectAltName=$cert_san"
fi

export TLS_KEY_FILE="$key_file"
export TLS_CERT_FILE="$cert_file"

exec bun frontend-server.ts
