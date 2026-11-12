@echo off
rem scout.sqlite maintenance (see scoutDbOptimize.js). Without options it only reports; changes need the
rem SOMP Vanguard service stopped:  scoutDbOptimize.bat --drop-duplicates --vacuum
cd /d "%~dp0.."
node --no-warnings scripts\scoutDbOptimize.js %*
