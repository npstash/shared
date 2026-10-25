@echo off
REM Test double of shared/tools/auth/run.bat. See fake-vault.mjs.
node "%~dp0fake-vault.mjs" %*
