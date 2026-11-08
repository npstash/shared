@echo off
REM Test double of shared/tools/auth/run.bat. See fake-vault.ts.
node "%~dp0fake-vault.ts" %*
