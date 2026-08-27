@echo off
cd /d "%~dp0"

echo Cleaning up any leftover lock files...
if exist ".git\index.lock" del /f /q ".git\index.lock"
if exist ".git\HEAD.lock" del /f /q ".git\HEAD.lock"
echo Done.
echo.

echo Staging this round's changed files...
git add src\components\Contacts.jsx src\components\Companies.jsx src\components\Chat.jsx
git add src\lib\signalTypes.js src\lib\todaysActions\pools\sourcedPool.js
git add src\components\Overview.jsx src\components\IntelligenceFeed.jsx src\components\TodaysActions\index.jsx
git add src\pages\LinkedInImport.jsx
git add netlify\functions\lib\scanShared.js netlify\functions\apollo-enrich-companies.js
git add netlify\functions\tests\apollo-enrich-companies.test.js
echo (add - errorlevel %errorlevel%)
echo.

echo Committing the staged changes...
git commit -F commit-message-customer-journey-round.txt
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
