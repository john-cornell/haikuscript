@echo off
REM Starts the REPL server (static files + /build-exe route) and opens the browser.
cd /d "%~dp0"
if not exist "node_modules\wabt\index.js" (
    echo node_modules missing/broken for this OS. Run: npm install
    pause
    exit /b 1
)
start "" http://localhost:3000/repl.html
node server.js
