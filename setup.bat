@echo off
REM Set up this repository, then run setup.bat in each submodule. You can run it again.
REM Give verbs to select the steps. Without a verb, all steps run. "setup.bat help" shows the verbs.
REM 1. submodules: check out the submodules that have no checkout. Others stay as they are.
REM 2. hooks: use .githooks\ as the hooks folder, if the repository has one.
REM 3. links: link each skills\[claude\]<name>\ and <folder>\skills\[claude\]<name>\ into .claude\skills\ (junctions).
REM    A parent setup gives --nested to a submodule: then only the parent's .claude\skills\ gets links.
REM The same verbs then run in each submodule.
REM Keep the same as setup.sh and as the copies in the other repositories.
setlocal EnableDelayedExpansion
cd /d "%~dp0"
set "nested="
if /i "%~1"=="--nested" (set "nested=1" & shift)
set "verbs="
set "do_submodules="
set "do_hooks="
set "do_links="

:args
if "%~1"=="" goto :argsdone
set "verbs=!verbs! %~1"
if /i "%~1"=="submodules" (set "do_submodules=1"
) else if /i "%~1"=="hooks" (set "do_hooks=1"
) else if /i "%~1"=="links" (set "do_links=1"
) else if /i "%~1"=="all" (set "do_submodules=1" & set "do_hooks=1" & set "do_links=1"
) else if /i "%~1"=="help" (call :usage & exit /b 0
) else if /i "%~1"=="-h" (call :usage & exit /b 0
) else if /i "%~1"=="--help" (call :usage & exit /b 0
) else (
    1>&2 echo error: unknown verb '%~1'
    call :usage 1>&2
    exit /b 2
)
shift
goto :args
:argsdone
if "!verbs!"=="" (
    set "verbs= all"
    set "do_submodules=1" & set "do_hooks=1" & set "do_links=1"
)

if not defined do_submodules goto :hooks
for /f "tokens=1,2" %%a in ('git submodule status') do (
    set "state=%%a"
    if "!state:~0,1!"=="-" git submodule update --init -- "%%b" || exit /b 1
)

:hooks
if not defined do_hooks goto :links
set "hooks="
for /f "delims=" %%h in ('git config --get core.hooksPath 2^>nul') do set "hooks=%%h"
if exist ".githooks\" (
    if "!hooks!"=="" (git config core.hooksPath .githooks) else if "!hooks!"==".githooks" (
        git config core.hooksPath .githooks
    ) else echo warning: core.hooksPath is '!hooks!', .githooks\ is not used 1>&2
) else if "!hooks!"==".githooks" git config --unset core.hooksPath

:links
if not defined do_links goto :recurse
if defined nested goto :recurse
for /d %%s in (skills\* skills\claude\*) do call :link "%%s"
REM "*" also gives dot folders such as .claude; "%%~nc" is empty for them, as in sh.
for /d %%c in (*) do if not "%%~nc"=="" for /d %%s in ("%%c\skills\*" "%%c\skills\claude\*") do call :link "%%s"
for /d %%l in (.claude\skills\*) do (
    if not exist "%%l\SKILL.md" fsutil reparsepoint query "%%l" >nul 2>&1 && rmdir "%%l"
)

:recurse
for /f "tokens=2" %%b in ('git submodule status') do (
    if exist "%%b\setup.bat" (call "%%b\setup.bat" --nested!verbs! || exit /b 1) else echo note: %%b has no setup.bat 1>&2
)
exit /b 0

:usage
echo Usage: setup.bat [verb...]
echo Verbs. They run in this order, whatever the order that you give:
echo   submodules  Check out the submodules that have no checkout.
echo   hooks       Use .githooks\ as the hooks folder, if the repository has one.
echo   links       Link each skills\[claude\]NAME\ and FOLDER\skills\[claude\]NAME\ into .claude\skills\.
echo   all         Do all the steps above. This is the default.
echo   help        Show this text.
echo The same verbs then run in each submodule. "links" runs only in the top repository.
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
