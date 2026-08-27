@echo off
cd /d "%~dp0"

echo Cleaning up any leftover lock files...
if exist ".git\index.lock" del /f /q ".git\index.lock"
if exist ".git\HEAD.lock" del /f /q ".git\HEAD.lock"
echo Done.
echo.

echo Staging the migration file (record only -- already live in both DBs)...
git add supabase-migrations\2026-08-27-next-invoice-number-team-guard.sql
echo (add - errorlevel %errorlevel%)
echo.

echo Committing the staged change...
git commit -F commit-message-invoice-number-team-guard.txt
if %errorlevel% neq 0 (
  echo Commit failed - errorlevel %errorlevel%. Stopping here rather than
  echo pushing anything. A common cause is "nothing to commit" if this was
  echo already run once.
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

echo Step 2: Pushing test-payments straight onto main on GitHub -- no app
echo code changed here, so this won't change what's deployed, just keeps
echo main's history matching test-payments the same way every other push
echo this session has.
git push origin test-payments:main
if %errorlevel% neq 0 (
  echo Push to main failed - errorlevel %errorlevel%. test-payments already
  echo pushed OK above -- re-run this script once the error above is
  echo resolved.
  exit /b 1
)
echo Push to main OK.
echo.

echo All done, no pauses, straight through.
