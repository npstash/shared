@echo off
REM Launcher of the browser tool facades. Each facade is an MCP server on stdio.
REM   run.bat <facade> [args]   start a facade, e.g. "run.bat playwright --isolated"
REM   run.bat install           make the runtime and install the browsers, then stop
REM   run.bat test              run the tests of the shared parts and of each facade
REM A facade is a folder with src\server.js (e.g. playwright\).
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

REM 2. Node.js packages in node_modules\, again when package-lock.json changes.
fc /b "%DIR%\package-lock.json" "%DIR%\node_modules\.facade-lock" >nul 2>&1
if errorlevel 1 call :install_packages || exit /b 1

REM 3. Playwright facade: Chromium, again when the Playwright version changes.
for /f "usebackq delims=" %%v in (`node -p "require(process.argv[1]).version" "%DIR%\node_modules\playwright-core\package.json"`) do set "PW_VERSION=%%v"
if not exist "%PLAYWRIGHT_BROWSERS_PATH%\.facade-chromium-%PW_VERSION%" call :install_browser || exit /b 1

if /i "%~1"=="install" (
    echo run.bat: the runtime is ready 1>&2
    exit /b 0
)
if /i "%~1"=="test" goto :tests
set "FACADE=%~1"
if "%FACADE%"=="" goto :usage
if not exist "%DIR%\%FACADE%\src\server.js" goto :usage
REM Give each argument after the facade name to the facade.
set "ARGS="
:collect
shift
if "%~1"=="" goto :start
set ARGS=%ARGS% %1
goto :collect
:start
node "%DIR%\%FACADE%\src\server.js" %ARGS%
exit /b %errorlevel%

:usage
echo run.bat: give a facade, e.g. run.bat playwright 1>&2
exit /b 2

:tests
pushd "%DIR%"
node --test --test-concurrency=1 "tests/*.test.js" "*/tests/*.test.js"
set "RC=%errorlevel%"
popd
exit /b %RC%

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
call npm ci --no-audit --no-fund --loglevel=error 1>&2
set "RC=%errorlevel%"
popd
if not "%RC%"=="0" exit /b %RC%
copy /y "%DIR%\package-lock.json" "%DIR%\node_modules\.facade-lock" >nul
exit /b 0

:install_browser
echo run.bat: install Chromium for Playwright %PW_VERSION% 1>&2
node "%DIR%\node_modules\@playwright\mcp\cli.js" install-browser chromium 1>&2 || exit /b 1
type nul > "%PLAYWRIGHT_BROWSERS_PATH%\.facade-chromium-%PW_VERSION%"
exit /b 0
