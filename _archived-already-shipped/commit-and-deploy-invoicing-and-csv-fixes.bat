@echo off
cd /d "%~dp0"

echo Cleaning up any leftover lock files...
if exist ".git\index.lock" del /f /q ".git\index.lock"
if exist ".git\HEAD.lock" del /f /q ".git\HEAD.lock"
echo Done.
echo.

echo Staging this round's changed/new files...
git add package.json package-lock.json
git add src\pages\LinkedInImport.jsx
git add src\components\icons.jsx src\components\Sidebar.jsx src\pages\Dashboard.jsx src\components\Settings.jsx
git add src\lib\data\jobs.js src\lib\data\jobs.test.js
git add src\lib\data\candidates.js src\lib\data\candidates.test.js
git add src\lib\data\invoices.js src\lib\data\invoices.test.js
git add src\lib\data\invoicingDetails.js src\lib\data\invoicingDetails.test.js
git add src\lib\invoiceCalc.js src\lib\invoiceCalc.test.js
git add src\lib\invoiceApi.js
git add src\components\Invoices.jsx src\components\InvoiceFormModal.jsx
git add netlify\functions\lib\invoicePdf.js
git add netlify\functions\lib\email.js netlify\functions\lib\email.test.js
git add netlify\functions\send-invoice.js netlify\functions\download-invoice.js
git add netlify\functions\tests\send-invoice.test.js netlify\functions\tests\download-invoice.test.js netlify\functions\tests\invoicePdf.test.js
git add supabase-migrations\2026-08-26-invoicing.sql
echo (add - errorlevel %errorlevel%)
echo.

echo Committing the staged changes...
git commit -F commit-message-invoicing-and-csv-fixes.txt
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
echo All done.
echo.
echo IMPORTANT: the invoicing.sql migration in this commit has ALREADY been
echo applied directly to the production database -- you do not need to run
echo it again. It's included here only so it's in the repo for history.
echo.
echo Also: this round adds a new npm dependency (pdf-lib). Netlify's own
echo build runs "npm install" automatically from package.json, so a plain
echo deploy needs nothing extra from you -- but if you want to run/test this
echo locally on your machine, run "npm install" here first.
pause
