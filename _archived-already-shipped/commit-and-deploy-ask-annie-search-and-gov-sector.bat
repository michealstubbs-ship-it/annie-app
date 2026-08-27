@echo off
cd /d "%~dp0"

echo Cleaning up any leftover lock files...
if exist ".git\index.lock" del /f /q ".git\index.lock"
if exist ".git\HEAD.lock" del /f /q ".git\HEAD.lock"
echo Done.
echo.

echo Staging this round's changed files...
git add netlify\functions\lib\scanShared.js
git add src\components\Chat.jsx
git add src\lib\chatWebSearch.js
git add src\lib\chatWebSearch.test.js
echo (add - errorlevel %errorlevel%)
echo.

echo Committing the staged changes...
git commit -F commit-message-ask-annie-search-and-gov-sector.txt
if %errorlevel% neq 0 (
  echo Commit failed - errorlevel %errorlevel%. Stopping here rather than
  echo pushing anything. Nothing to fix by re-running blindly -- check the
  echo error above first ^(a common one is "nothing to commit" if this was
  echo already run once^).
  exit /b 1
)
echo Commit OK.
echo.

echo Step 1: Pushing test-payments to GitHub...
git push origin test-payments
if %errorlevel% neq 0 (
  echo Push to test-payments failed - errorlevel %errorlevel%. Stopping
  echo before touching main.
  exit /b 1
)
echo Push to test-payments OK.
echo.

echo Step 2: Pushing test-payments straight onto main on GitHub -- this is
echo what triggers the production deploy.
git push origin test-payments:main
if %errorlevel% neq 0 (
  echo Push to main failed - errorlevel %errorlevel%. test-payments already
  echo pushed OK above, so staging has this; production does not yet --
  echo re-run this script once the error above is resolved.
  exit /b 1
)
echo Push to main OK -- production deploy triggered.
echo.

echo All done, no pauses, straight through.
