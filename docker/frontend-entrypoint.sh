#!/bin/sh
set -eu

cert_dir="${TLS_CERT_DIR:-/app/certs}"
key_file="${TLS_KEY_FILE:-$cert_dir/privkey.pem}"
cert_file="${TLS_CERT_FILE:-$cert_dir/pubkey.pem}"
cert_days="${TLS_CERT_DAYS:-3650}"
cert_subject="${TLS_CERT_SUBJECT:-/CN=libershare.local}"
cert_san="${TLS_CERT_SAN:-DNS:localhost,IP:127.0.0.1}"

# Repair ownership of the bind-mounted certs dir so openssl below can write
# the freshly generated private key and certificate. Without this, a host
# `mkdir ./certs` performed by an unprivileged user (UID != 0) would fail
# with EACCES inside the container — the `cap_drop: ALL` setup strips
# CAP_DAC_OVERRIDE, so root inside the container cannot bypass DAC. The
# CAP_CHOWN granted back via compose lets this chown succeed without
# re-introducing CAP_DAC_OVERRIDE.
if [ -d "$cert_dir" ]; then
	chown -R 0:0 "$cert_dir" 2>/dev/null || true
fi

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
