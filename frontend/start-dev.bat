@echo off

REM Usage: start-dev.bat [backend_url] [--token token] [--privkey path] [--pubkey path]
REM Backend URL: first positional argument, e.g.: start-dev.bat wss://backend.example.com:1234
REM Default: ws://localhost:1158
REM Backend token: --token token
REM Certificates: --privkey and --pubkey for HTTPS dev server
REM Default: server.key/server.crt or certs/server.key/certs/server.crt

:parse_args
if "%~1"=="" goto done_args
if /i "%~1"=="--privkey" (
	set "VITE_SSL_KEY=%~2"
	shift
	shift
	goto parse_args
)
if /i "%~1"=="--pubkey" (
	set "VITE_SSL_CERT=%~2"
	shift
	shift
	goto parse_args
)
if /i "%~1"=="--token" (
	set "VITE_LISH_TOKEN=%~2"
	echo Using backend token
	shift
	shift
	goto parse_args
)
if not defined VITE_BACKEND_URL (
	set "VITE_BACKEND_URL=%~1"
	echo Using custom backend: %VITE_BACKEND_URL%
)
shift
goto parse_args
:done_args

title LISH FRONTEND
call bun i --frozen-lockfile
call npm run dev
