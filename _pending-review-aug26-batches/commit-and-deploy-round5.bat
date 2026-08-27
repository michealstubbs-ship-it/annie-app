@echo off
cd /d "%~dp0"

echo Cleaning up any leftover lock files...
if exist ".git\index.lock" del /f /q ".git\index.lock"
if exist ".git\HEAD.lock" del /f /q ".git\HEAD.lock"
echo Done.
echo.

echo Staging round-5 changed files...
git add src\components\Pipeline.jsx
git add netlify\functions\apollo-enrich-companies.js
git add netlify\functions\lib\scanShared.js
git add netlify\functions\lib\entitlements.js
git add netlify\functions\tests\admin-resource-caps.test.js
git add .env.example
git add supabase-migrations\2026-08-26-recovered-undocumented-schema-gaps-2.sql
echo (add - errorlevel %errorlevel%)
echo.

echo Committing the staged changes...
git commit -F commit-message-round5.txt
echo (commit - errorlevel %errorlevel%)
pause

echo.
echo Step 1: Pushing test-payments to GitHub...
git push origin test-payments
echo (push test-payments - errorlevel %errorlevel%)
pause

echo.
echo Step 2: Pushing test-payments straight onto main on GitHub -- this is
echo what triggers the production deploy.
git push origin test-payments:main
echo (push main - errorlevel %errorlevel%)
pause

echo.
echo All done. No SQL migration needs to be run this round -- the recovered-
echo undocumented-schema-gaps-2 file documents production state that is
echo already live; it does not need to be applied.
pause
