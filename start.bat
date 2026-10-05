@echo off
rem Serves this folder on http://localhost:8123 and opens the terrain generator in your browser.
rem Close this window (or press Ctrl+C) to stop the server.
cd /d "%~dp0"

set PY=
where python >nul 2>nul && set PY=python
if not defined PY where py >nul 2>nul && set PY=py
if not defined PY (
  echo Python was not found. Install it from https://www.python.org/downloads/
  echo or see README.md for other ways to run the terrain generator.
  pause
  exit /b 1
)

echo Terrain generator: http://localhost:8123
echo Close this window to stop the server.
rem Open the browser a moment after the server starts.
start "" cmd /c "timeout /t 1 >nul & start http://localhost:8123"
%PY% -m http.server 8123
