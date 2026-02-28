#!/bin/sh

cd backend
npx prettier --write "**/*.{js,ts,json}"
cd ..
