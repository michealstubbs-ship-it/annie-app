@echo off
cd /d "%~dp0"

echo Cleaning up any leftover lock files...
if exist ".git\index.lock" del /f /q ".git\index.lock"
if exist ".git\HEAD.lock" del /f /q ".git\HEAD.lock"
echo Done.
echo.

echo Staging this round's changed files...
git add src\lib\pricing.js netlify\functions\lib\entitlements.js src\components\SupportWidget.jsx
git add src\pages\LinkedInImport.jsx
echo (add - errorlevel %errorlevel%)
echo.

echo Committing the staged changes...
git commit -F commit-message-pricing-alignment-round.txt
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
echo All done. Nothing else to run -- no new migrations this round.
pause
