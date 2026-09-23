@echo off
REM Set up this repository, then run setup.bat in each submodule. You can run it again.
REM 1. Check out the submodules that have no checkout. Submodules with a checkout stay as they are.
REM 2. Use .githooks\ as the hooks folder, if the repository has one.
REM 3. Link each skills\<name>\ and <folder>\skills\<name>\ into .claude\skills\ (junctions).
REM Keep the same as setup.sh and as the copies in the other repositories.
setlocal EnableDelayedExpansion
cd /d "%~dp0"

for /f "tokens=1,2" %%a in ('git submodule status') do (
    set "state=%%a"
    if "!state:~0,1!"=="-" git submodule update --init -- "%%b" || exit /b 1
)

set "hooks="
for /f "delims=" %%h in ('git config --get core.hooksPath 2^>nul') do set "hooks=%%h"
if exist ".githooks\" (
    if "!hooks!"=="" (git config core.hooksPath .githooks) else if "!hooks!"==".githooks" (
        git config core.hooksPath .githooks
    ) else echo warning: core.hooksPath is '!hooks!', .githooks\ is not used 1>&2
) else if "!hooks!"==".githooks" git config --unset core.hooksPath

for /d %%s in (skills\*) do call :link "%%s"
REM "*" also gives dot folders such as .claude; "%%~nc" is empty for them, as in sh.
for /d %%c in (*) do if not "%%~nc"=="" for /d %%s in ("%%c\skills\*") do call :link "%%s"
for /d %%l in (.claude\skills\*) do (
    if not exist "%%l\SKILL.md" fsutil reparsepoint query "%%l" >nul 2>&1 && rmdir "%%l"
)

for /f "tokens=2" %%b in ('git submodule status') do (
    if exist "%%b\setup.bat" (call "%%b\setup.bat" || exit /b 1) else echo note: %%b has no setup.bat 1>&2
)
exit /b 0

:link
if not exist "%~1\SKILL.md" exit /b 0
if not exist ".claude\skills" mkdir ".claude\skills"
set "link=.claude\skills\%~nx1"
if exist "%link%\" (
    fsutil reparsepoint query "%link%" >nul 2>&1 && rmdir "%link%" || (
        echo warning: %link% is not a link, it stays as it is 1>&2
        exit /b 0
    )
)
mklink /J "%link%" "%~f1" >nul
exit /b 0
