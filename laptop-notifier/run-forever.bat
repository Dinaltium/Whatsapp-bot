@echo off
rem Supervisor loop: keeps the notifier alive. If node exits for ANY reason
rem (crash, force-stop, Redis blip that kills it), it restarts after a short
rem delay. Launched hidden by start-hidden.vbs.
title WhatsApp Laptop Notifier
cd /d "%~dp0"
:loop
node index.js
echo [run-forever] notifier exited (code %errorlevel%), restarting in 5s...
timeout /t 5 /nobreak >nul
goto loop
