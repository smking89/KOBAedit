@echo off
REM Builds KOBA Studios for Windows. Run this on a Windows PC.
REM One-time installs: Node.js 20+ (nodejs.org), Rust (rustup.rs), and
REM "Desktop development with C++" from Visual Studio Build Tools.
REM Result: apps\src-tauri\target\release\koba-studios.exe plus installers in
REM apps\src-tauri\target\release\bundle\
cd /d "%~dp0"
call npm install || goto :fail
cd apps\src-tauri
call npx tauri build || goto :fail
echo.
echo Done. Your app: %cd%\target\release\koba-studios.exe
echo Installers:     %cd%\target\release\bundle\
pause
exit /b 0
:fail
echo Build failed - see the messages above.
pause
exit /b 1
