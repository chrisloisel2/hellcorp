@echo off
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 launch.py
  exit /b
)
where python >nul 2>nul
if %errorlevel%==0 (
  python launch.py
  exit /b
)
echo Python 3 est requis uniquement pour lancer le serveur local.
pause
