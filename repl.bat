@echo off
REM Starts static server and opens browser REPL.
cd /d "%~dp0"
if not exist "node_modules\serve\build\main.js" (
    echo node_modules missing/broken for this OS. Run: npm install
    pause
    exit /b 1
)
start "" http://localhost:3000/repl.html
node node_modules\serve\build\main.js .
