@echo off
echo Step 1: Pushing test-payments to GitHub...
cd /d "%~dp0"
git push origin test-payments
if errorlevel 1 (
  echo.
  echo Push failed - see the error above.
  pause
  exit /b 1
)

echo.
echo Step 2: Merging test-payments into main...
git checkout main
if errorlevel 1 (
  echo Could not switch to main - see the error above.
  pause
  exit /b 1
)
git merge test-payments --ff-only
if errorlevel 1 (
  echo.
  echo Merge failed - main was NOT changed. Switching back to test-payments.
  git checkout test-payments
  pause
  exit /b 1
)

echo.
echo Step 3: Pushing main to GitHub - this triggers the production deploy...
git push origin main
git checkout test-payments

echo.
echo Done. main is updated and Netlify will deploy it shortly.
pause
