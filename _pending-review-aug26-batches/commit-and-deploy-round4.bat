@echo off
cd /d "%~dp0"

echo Cleaning up any leftover lock files...
if exist ".git\index.lock" del /f /q ".git\index.lock"
if exist ".git\HEAD.lock" del /f /q ".git\HEAD.lock"
echo Done.
echo.

echo Staging round-4 changed files...
git add src\components\Pipeline.jsx
git add netlify\functions\lib\scanShared.js netlify\functions\lib\scanShared.test.js
git add netlify\functions\apollo-enrich-companies.js netlify\functions\tests\apollo-enrich-companies.test.js
git add netlify\functions\chat.js
git add supabase-migrations\2026-08-26-apollo-credit-release.sql
echo (add - errorlevel %errorlevel%)
echo.

echo Committing the staged changes...
git commit -F commit-message-round4.txt
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
echo All done. The apollo_release_credits SQL migration has already been
echo applied directly to production -- nothing else to run.
pause
