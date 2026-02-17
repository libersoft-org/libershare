@echo off
title LISH BACKEND
call bun i --frozen-lockfile
call bun run src/app.ts %*
