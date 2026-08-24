@echo off
cd /d %~dp0
python v2\build_v2.py || exit /b 1
python launch.py
