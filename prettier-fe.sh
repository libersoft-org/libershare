#!/bin/sh

cd frontend
npx prettier --plugin prettier-plugin-svelte --write "**/*.{js,ts,svelte,html,css,json}"
cd ..
