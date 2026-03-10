@echo off
title LISH BACKEND (HOT)
call bun i --frozen-lockfile
call bun --watch run src/app.ts %*
