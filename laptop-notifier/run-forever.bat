@echo off
rem Supervisor loop: keeps the notifier alive. If node exits for ANY reason
rem (crash, force-stop, Redis blip that kills it), it restarts after a short
rem delay. Launched hidden by start-hidden.vbs.
title WhatsApp Laptop Notifier
cd /d "%~dp0"
:loop
node index.js
set EC=%errorlevel%
rem Exit code 3 = another instance already holds the single-instance lock, so
rem this supervisor must stop (prevents duplicate instances/toasts when the
rem scheduled task relaunches us while one is already running).
if "%EC%"=="3" exit /b 0
echo [run-forever] notifier exited (code %EC%), restarting in 5s...
timeout /t 5 /nobreak >nul
goto loop
