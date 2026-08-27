@echo off
cd /d "%~dp0"

echo Cleaning up any leftover lock files...
if exist ".git\index.lock" del /f /q ".git\index.lock"
if exist ".git\HEAD.lock" del /f /q ".git\HEAD.lock"
echo Done.
echo.

echo Staging round-2 changed files...
git add netlify\functions\scan-now-background.js netlify\functions\stripe-webhook.js
git add netlify\functions\tests\stripe-webhook.test.js
git add src\components\IntelligenceFeed.jsx src\components\Overview.jsx src\components\Pipeline.jsx src\components\Settings.jsx
git add src\components\TodaysActions\useTodaysActions.js
git add src\lib\jsonExtract.js src\lib\jsonExtract.test.js
echo (add - errorlevel %errorlevel%)
echo.

echo Committing the staged changes...
git commit -F commit-message-round2.txt
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
echo All done. No SQL migrations in this round -- nothing else to run.
pause
