#!/bin/sh

cd cli
npx prettier --write "**/*.{js,ts,json}"
cd ..
