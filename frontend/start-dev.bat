@echo off

REM Backend URL can be passed as first argument, e.g.: start-dev.bat wss://backend.example.com:1234
REM Default: ws://localhost:1158
if not "%~1"=="" (
	set "VITE_BACKEND_URL=%~1"
	echo Using custom backend: %VITE_BACKEND_URL%
)

title LISH FRONTEND
call bun i --frozen-lockfile
call npm run dev
