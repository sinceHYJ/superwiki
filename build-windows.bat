@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem SuperWiki Windows build script
rem This script intentionally avoids PowerShell.

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "CARGO_BIN=%USERPROFILE%\.cargo\bin"
if exist "%CARGO_BIN%\cargo.exe" set "PATH=%CARGO_BIN%;%PATH%"

echo ============================================================
echo   SuperWiki Windows build script
echo ============================================================

call :step "Checking base commands"
call :require_command node "Node.js"
call :require_command npm "Node.js"
call :require_command rustup "Rust"
call :require_command cargo "Rust"
call :require_command rustc "Rust"

call :step "Checking Rust target"
rustup target list --installed | findstr /c:"x86_64-pc-windows-msvc" >nul
if errorlevel 1 (
    echo [ERROR] Rust target x86_64-pc-windows-msvc is missing.
    echo Run: rustup target add x86_64-pc-windows-msvc
    goto :error
)

call :step "Checking Visual Studio C++ build tools"
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
    echo [ERROR] Visual Studio Installer was not found.
    echo Install Visual Studio 2022 Build Tools with the C++ workload.
    goto :error
)

set "VS_PATH="
for /f "usebackq delims=" %%I in (`"%VSWHERE%" -products * -property installationPath`) do set "VS_PATH=%%I"
if not defined VS_PATH (
    echo [ERROR] Visual Studio 2022 Build Tools was not found.
    echo Install the "Desktop development with C++" workload.
    goto :error
)

set "MSVC_ROOT=%VS_PATH%\VC\Tools\MSVC"
if not exist "%MSVC_ROOT%" (
    echo [ERROR] MSVC tools were not found under Visual Studio Build Tools.
    echo Install MSVC v143 build tools.
    goto :error
)

set "MSVC_VERSION="
for /f "delims=" %%D in ('dir /b /ad /o-n "%MSVC_ROOT%" 2^>nul') do (
    if not defined MSVC_VERSION set "MSVC_VERSION=%%D"
)
if not defined MSVC_VERSION (
    echo [ERROR] No MSVC version directory was found.
    goto :error
)

set "MSVC_DIR=%MSVC_ROOT%\%MSVC_VERSION%"
for %%F in (
    "bin\Hostx64\x64\cl.exe"
    "bin\Hostx64\x64\link.exe"
    "lib\x64\libcmt.lib"
    "lib\x64\libvcruntime.lib"
    "lib\x64\msvcrt.lib"
) do (
    if not exist "%MSVC_DIR%\%%~F" (
        echo [ERROR] Required MSVC file is missing: "%MSVC_DIR%\%%~F"
        echo Repair Visual Studio 2022 Build Tools or install the C++ workload.
        goto :error
    )
)

call :step "Checking Windows SDK"
set "SDK_ROOT=%ProgramFiles(x86)%\Windows Kits\10\Lib"
if not exist "%SDK_ROOT%" (
    echo [ERROR] Windows 10/11 SDK was not found.
    echo Install Windows 11 SDK from Visual Studio Installer.
    goto :error
)

set "SDK_VERSION="
for /f "delims=" %%D in ('dir /b /ad /o-n "%SDK_ROOT%" 2^>nul') do (
    if not defined SDK_VERSION set "SDK_VERSION=%%D"
)
if not defined SDK_VERSION (
    echo [ERROR] No Windows SDK version directory was found.
    goto :error
)

set "SDK_DIR=%SDK_ROOT%\%SDK_VERSION%"
for %%F in (
    "ucrt\x64\ucrt.lib"
    "um\x64\kernel32.lib"
) do (
    if not exist "%SDK_DIR%\%%~F" (
        echo [ERROR] Required Windows SDK file is missing: "%SDK_DIR%\%%~F"
        goto :error
    )
)

call :step "Checking project files"
if not exist "%ROOT%\package.json" (
    echo [ERROR] package.json is missing. Run this script from the SuperWiki repository root.
    goto :error
)
if not exist "%ROOT%\src-tauri\tauri.conf.json" (
    echo [ERROR] src-tauri\tauri.conf.json is missing.
    goto :error
)
if not exist "%ROOT%\src-tauri\Cargo.toml" (
    echo [ERROR] src-tauri\Cargo.toml is missing.
    goto :error
)

call :step "Checking frontend dependencies"
if not exist "%ROOT%\node_modules" (
    echo node_modules is missing. Running npm ci...
    pushd "%ROOT%"
    call npm ci
    if errorlevel 1 (
        popd
        echo [ERROR] npm ci failed.
        goto :error
    )
    popd
) else (
    echo node_modules already exists. Skipping install.
)

call :step "Building SuperWiki for Windows"
pushd "%ROOT%"
call npm run tauri build
if errorlevel 1 (
    popd
    echo [ERROR] Build failed. See the log above.
    goto :error
)
popd

call :step "Locating build artifacts"
set "RELEASE_DIR=%ROOT%\src-tauri\target\release"
set "NSIS_DIR=%RELEASE_DIR%\bundle\nsis"
set "MSI_DIR=%RELEASE_DIR%\bundle\msi"

set "EXE_FILE="
call :find_latest_file "%RELEASE_DIR%" "superwiki.exe" EXE_FILE
set "SETUP_FILE="
call :find_latest_file "%NSIS_DIR%" "*_x64-setup.exe" SETUP_FILE
set "MSI_FILE="
call :find_latest_file "%MSI_DIR%" "*_x64_en-US.msi" MSI_FILE

if not defined EXE_FILE (
    echo [ERROR] superwiki.exe was not found.
    goto :error
)
if not defined SETUP_FILE (
    echo [ERROR] NSIS setup exe was not found.
    goto :error
)
if not defined MSI_FILE (
    echo [ERROR] MSI package was not found.
    goto :error
)

set "EXE_PATH=%RELEASE_DIR%\%EXE_FILE%"
set "SETUP_PATH=%NSIS_DIR%\%SETUP_FILE%"
set "MSI_PATH=%MSI_DIR%\%MSI_FILE%"

echo.
echo ============================================================
echo   SuperWiki Windows build completed successfully
echo ------------------------------------------------------------
call :show_artifact "%EXE_PATH%"
call :show_artifact "%SETUP_PATH%"
call :show_artifact "%MSI_PATH%"
echo ============================================================

endlocal
exit /b 0

:step
echo.
echo ==^> %~1
exit /b 0

:require_command
where /q "%~1"
if errorlevel 1 (
    echo [ERROR] Required command '%~1' was not found.
    echo Please install: %~2
    goto :error
)
exit /b 0

:find_latest_file
set "SEARCH_DIR=%~1"
set "SEARCH_PATTERN=%~2"
set "RESULT_VAR=%~3"
set "%RESULT_VAR%="
if not exist "%SEARCH_DIR%" exit /b 1
for /f "delims=" %%F in ('dir /b /a:-d /o:-d "%SEARCH_DIR%\%SEARCH_PATTERN%" 2^>nul') do (
    if not defined %RESULT_VAR% set "%RESULT_VAR%=%%F"
)
exit /b 0

:show_artifact
set "FILE_PATH=%~1"
if not exist "%FILE_PATH%" (
    echo [ERROR] Artifact not found: "%FILE_PATH%"
    goto :error
)
for %%A in ("%FILE_PATH%") do set "FILE_SIZE=%%~zA"
set /a SIZE_MB=FILE_SIZE/1048576
set "HASH="
for /f "delims=" %%H in ('certutil -hashfile "%FILE_PATH%" SHA256 ^| findstr /r "^[0-9A-Fa-f][0-9A-Fa-f]*$"') do set "HASH=%%H"
if not defined HASH set "HASH=UNKNOWN"
echo   File      : %FILE_PATH%
echo   Size      : %FILE_SIZE% bytes
echo   Size (MB) : %SIZE_MB%
echo   SHA-256   : %HASH%
echo ------------------------------------------------------------
exit /b 0

:error
echo.
echo [ERROR] Build stopped.
endlocal
exit /b 1

