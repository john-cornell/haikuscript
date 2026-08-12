@echo off
REM Starts the REPL server (static files + /build-exe route) and opens the browser.
cd /d "%~dp0"
start "" http://localhost:3000/repl.html
node server.js
