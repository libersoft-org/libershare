#!/bin/sh

cd shared
npx prettier --write "**/*.{ts,json}"
cd ..
