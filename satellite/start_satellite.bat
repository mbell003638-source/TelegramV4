@echo off
title ClaudeClaw Windows Satellite Worker
cd /d "%~dp0"
echo Starting ClaudeClaw Windows Satellite Worker...
node desktop-worker.js
pause
