#!/bin/sh

find . -type f \( -perm -100 -o -perm -010 -o -perm -001 \) \
	-not -path "*/node_modules/*" \
	-not -path "*/build/*" \
	-not -path "*/binaries/*" \
	-not -path "*/.git/*" \
	-not -path "*/.husky/*" \
	-not -path "*/.githooks/*" \
	-not -name "*.sh" \
	-not -name "*.lockb" \
	-not -name "*.fish" \
	-exec echo "chmod -x {}" \;
