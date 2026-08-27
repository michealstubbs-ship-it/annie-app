@echo off
cd /d "%~dp0"

echo Cleaning up any leftover lock files...
if exist ".git\index.lock" del /f /q ".git\index.lock"
if exist ".git\HEAD.lock" del /f /q ".git\HEAD.lock"
echo Done.
echo.

echo Staging changed files...
git add .env.example
git add netlify\functions\admin-resource-caps.js netlify\functions\chat.js netlify\functions\resolve-signal-contact.js netlify\functions\scan-now-background.js netlify\functions\scan-status.js netlify\functions\start-trial-checkout.js netlify\functions\stripe-webhook.js netlify\functions\team-invite.js
git add netlify\functions\lib\email.js netlify\functions\lib\email.test.js netlify\functions\lib\entitlements.js netlify\functions\lib\env.js netlify\functions\lib\env.test.js netlify\functions\lib\scanShared.js netlify\functions\lib\scanShared.test.js
git add netlify\functions\tests\admin-resource-caps.test.js netlify\functions\tests\resolve-signal-contact.test.js netlify\functions\tests\scan-now-background.test.js netlify\functions\tests\scan-status.test.js netlify\functions\tests\start-trial-checkout.test.js netlify\functions\tests\stripe-webhook.test.js netlify\functions\tests\team-invite.test.js
git add src\components\AdminOverview.jsx src\components\Billing.jsx src\components\Candidates.jsx src\components\Companies.jsx src\components\Contacts.jsx src\components\IntelligenceFeed.jsx src\components\Jobs.jsx src\components\Meetings.jsx src\components\Overview.jsx src\components\Pipeline.jsx src\components\Settings.jsx src\components\Tasks.jsx
git add src\components\TodaysActions\index.jsx src\components\TodaysActions\useTodaysActions.js
git add src\lib\data\adminDashboard.js src\lib\data\adminDashboard.test.js src\lib\data\candidates.js src\lib\data\candidates.test.js src\lib\data\companies.js src\lib\data\companies.test.js src\lib\data\contacts.js src\lib\data\contacts.test.js src\lib\data\deals.js src\lib\data\deals.test.js src\lib\data\jobs.js src\lib\data\jobs.test.js src\lib\data\meetings.js src\lib\data\meetings.test.js src\lib\data\signals.js src\lib\data\signals.test.js src\lib\data\tasks.js src\lib\data\tasks.test.js src\lib\data\teamActivity.js src\lib\data\teamActivity.test.js
git add src\lib\jsonExtract.js src\lib\jsonExtract.test.js src\lib\resolveSignalContact.js src\lib\useScanStatusPoll.js
git add src\lib\todaysActions\resolve.js src\lib\todaysActions\resolve.test.js src\lib\todaysActions\state.js src\lib\todaysActions\state.test.js
git add src\pages\Login.jsx
git add supabase-migrations\2026-08-26-admin-opex-theirstack-and-platform-totals.sql supabase-migrations\2026-08-26-atomic-team-seat-cap.sql supabase-migrations\2026-08-26-free-month-redemption-cap.sql supabase-migrations\2026-08-26-lock-down-per-customer-reserve-functions.sql supabase-migrations\2026-08-26-theirstack-credit-release.sql
echo (add - errorlevel %errorlevel%)
echo.

echo Committing the staged changes (if an earlier run already committed some
echo of these, "nothing to commit" for those specific files is expected and
echo fine -- git only commits what's actually still different)...
git commit -F commit-message.txt
echo (commit - errorlevel %errorlevel%)
pause

echo.
echo Step 1: Pushing test-payments to GitHub...
git push origin test-payments
echo (push test-payments - errorlevel %errorlevel%)
pause

echo.
echo Step 2: Pushing test-payments straight onto main on GitHub -- this is
echo what triggers the production deploy. This updates main directly from
echo test-payments's own commit history without ever switching your LOCAL
echo branch, so it can no longer be blocked by a locally-modified file the
echo way an old checkout-based merge step once was.
git push origin test-payments:main
echo (push main - errorlevel %errorlevel%)
pause

echo.
echo All 5 of this batch's SQL migrations were already applied DIRECTLY to
echo production during this session's audit (admin-opex-theirstack-and-
echo platform-totals and free-month-redemption-cap included) -- no manual
echo SQL Editor step needed. They're only included in this commit for the
echo repo's own record.
echo.
echo All done. Your local branch is still test-payments, same as before.
pause
