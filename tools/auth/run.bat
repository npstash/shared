@echo off
REM credstore launcher: builds the project venv on first use (or when requirements change).
REM `run.bat test` runs the project's tests, pulling in requirements-dev.txt on demand.
setlocal
set "DIR=%~dp0"
set "PY=%DIR%.venv\Scripts\python.exe"
fc /b "%DIR%requirements.txt" "%DIR%.venv\requirements.txt" >nul 2>&1
if errorlevel 1 (
    if not exist "%PY%" python -m venv "%DIR%.venv" || exit /b 1
    "%PY%" -m pip install --quiet -r "%DIR%requirements.txt" || exit /b 1
    copy /y "%DIR%requirements.txt" "%DIR%.venv\requirements.txt" >nul
)
if /i "%~1"=="test" goto :tests
"%PY%" "%DIR%credstore.py" %*
goto :eof
:tests
REM Dev dependencies stay out of the runtime venv until tests are actually asked for.
"%PY%" -m pip install --quiet -r "%DIR%requirements-dev.txt" || exit /b 1
"%PY%" -m pytest "%DIR%tests"
