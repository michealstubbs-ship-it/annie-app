@echo off
cd /d "%~dp0"

echo Cleaning up any leftover lock files...
if exist ".git\index.lock" del /f /q ".git\index.lock"
if exist ".git\HEAD.lock" del /f /q ".git\HEAD.lock"
echo Done.
echo.

echo Staging this round's changed files...
git add netlify\functions\lib\scanShared.js
git add netlify\functions\lib\scanShared.test.js
git add netlify\functions\scan-now-background.js
git add netlify\functions\intelligence-scan.js
git add supabase-migrations\2026-08-27-signal-pool.sql
git add supabase-migrations\2026-08-27-signal-pool-quality-feedback.sql
git add netlify\functions\admin-market-coverage.js
git add src\lib\data\adminDashboard.js
git add src\lib\data\adminDashboard.test.js
git add src\components\AdminOverview.jsx
git add supabase-migrations\2026-08-27-market-coverage-log.sql
git add supabase-migrations\2026-08-27-learn-from-customer-crm.sql
git add src\components\Chat.jsx
git add src\lib\watchlist.js
git add src\lib\watchlist.test.js
git add supabase-migrations\2026-08-27-learned-sources-quality-guard.sql
git add src\lib\data\adminLearnedSources.js
git add src\lib\data\adminLearnedSources.test.js
git add src\components\AdminLearnedSources.jsx
git add src\components\Insights.jsx
git add supabase-migrations\2026-08-27-close-trigger-only-rpc-exposure.sql
echo (add - errorlevel %errorlevel%)
echo.

echo Committing the staged changes...
git commit -F commit-message-cross-customer-signal-pool.txt
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

echo All done, no pauses, straight through. Note: the signal_pool,
echo market_coverage_log tables, the customer-CRM-learning triggers, the
echo learned-sources quality guard + admin RPCs, and the trigger-only-RPC
echo security lockdown have ALREADY been applied directly to BOTH staging
echo and production this session -- this push was just the application
echo code that reads/writes them. Nothing else to apply.
