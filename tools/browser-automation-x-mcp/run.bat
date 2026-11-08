@echo off
REM Launcher of the MCP server browser-automation-x-mcp on stdio.
REM   run.bat [args]    start the server, e.g. "run.bat --config-dir DIR"
REM   run.bat install   make the runtime and install the browser, then stop
REM   run.bat test [phase...]  run the test phases: all, or the given ones (static, unit, functional, online)
REM stdout is the MCP channel. Send all setup output to stderr.
setlocal EnableExtensions
set "DIR=%~dp0"
set "DIR=%DIR:~0,-1%"
set "ASSETS=%DIR%\.local_assets"

REM Pinned Node.js runtime. Playwright needs Node.js 20 or later.
set "NODE_VERSION=v24.22.1"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" (
    set "PLATFORM=win-arm64"
    set "SHA=a0c807319fede24c4a0d8f84564c82a619bd313b16b10c007c383c2609e99171"
) else (
    set "PLATFORM=win-x64"
    set "SHA=d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5"
)

REM 1. Node.js runtime in .local_assets\runtime\.
set "NODE_DIR=%ASSETS%\runtime\node-%NODE_VERSION%-%PLATFORM%"
if not exist "%NODE_DIR%\node.exe" call :install_node || exit /b 1
set "PATH=%NODE_DIR%;%PATH%"
set "npm_config_cache=%ASSETS%\npm-cache"
if not defined PLAYWRIGHT_BROWSERS_PATH set "PLAYWRIGHT_BROWSERS_PATH=%ASSETS%\browsers\%PLATFORM%"

REM 2. Node.js packages in node_modules\, again when package-lock.json changes. The dev packages
REM    (type check, lint) only for "run.bat test". A full install is also good for a start.
set "LOCK_STAMP=%DIR%\node_modules\.bax-lock"
set "OMIT=--omit=dev"
if /i "%~1"=="test" (
    set "LOCK_STAMP=%DIR%\node_modules\.bax-lock-dev"
    set "OMIT="
)
fc /b "%DIR%\package-lock.json" "%LOCK_STAMP%" >nul 2>&1
if errorlevel 1 call :install_packages || exit /b 1

REM 3. Chromium, again when the Playwright version changes.
for /f "usebackq delims=" %%v in (`node -p "require(process.argv[1]).version" "%DIR%\node_modules\playwright-core\package.json"`) do set "PW_VERSION=%%v"
if not exist "%PLAYWRIGHT_BROWSERS_PATH%\.bax-chromium-%PW_VERSION%" call :install_browser || exit /b 1

if /i "%~1"=="install" (
    echo run.bat: the runtime is ready 1>&2
    exit /b 0
)
if /i "%~1"=="test" goto :tests
REM Give each argument to the server.
set "ARGS="
:collect
if "%~1"=="" goto :start
set ARGS=%ARGS% %1
shift
goto :collect
:start
node "%DIR%\playwright\src\server.ts" %ARGS%
exit /b %errorlevel%

:tests
shift
set "PHASES="
:collect_phases
if "%~1"=="" goto :run_tests
set PHASES=%PHASES% %1
shift
goto :collect_phases
:run_tests
node "%DIR%\tests\run-phases.ts" %PHASES%
exit /b %errorlevel%

:install_node
echo run.bat: download Node.js %NODE_VERSION% (%PLATFORM%) 1>&2
if not exist "%ASSETS%\runtime" mkdir "%ASSETS%\runtime"
set "ARCHIVE=%NODE_DIR%.zip"
curl -fsSL -o "%ARCHIVE%" "https://nodejs.org/dist/%NODE_VERSION%/node-%NODE_VERSION%-%PLATFORM%.zip" || exit /b 1
set "ACTUAL="
for /f "skip=1 delims=" %%h in ('certutil -hashfile "%ARCHIVE%" SHA256') do if not defined ACTUAL set "ACTUAL=%%h"
set "ACTUAL=%ACTUAL: =%"
if /i not "%ACTUAL%"=="%SHA%" (
    del "%ARCHIVE%"
    echo run.bat: checksum of the Node.js download is wrong 1>&2
    exit /b 1
)
tar -xf "%ARCHIVE%" -C "%ASSETS%\runtime" || exit /b 1
del "%ARCHIVE%"
exit /b 0

:install_packages
echo run.bat: install the Node.js packages 1>&2
pushd "%DIR%"
call npm ci %OMIT% --no-audit --no-fund --loglevel=error 1>&2
set "RC=%errorlevel%"
popd
if not "%RC%"=="0" exit /b %RC%
del /q "%DIR%\node_modules\.bax-lock" "%DIR%\node_modules\.bax-lock-dev" >nul 2>&1
copy /y "%DIR%\package-lock.json" "%LOCK_STAMP%" >nul
if not defined OMIT copy /y "%DIR%\package-lock.json" "%DIR%\node_modules\.bax-lock" >nul
exit /b 0

:install_browser
echo run.bat: install Chromium for Playwright %PW_VERSION% 1>&2
node "%DIR%\node_modules\@playwright\mcp\cli.js" install-browser chromium 1>&2 || exit /b 1
type nul > "%PLAYWRIGHT_BROWSERS_PATH%\.bax-chromium-%PW_VERSION%"
exit /b 0
