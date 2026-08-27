@echo off
cd /d "%~dp0"

echo Cleaning up any leftover lock files...
if exist ".git\index.lock" del /f /q ".git\index.lock"
if exist ".git\HEAD.lock" del /f /q ".git\HEAD.lock"
echo Done.
echo.

echo Staging the deletion-script fixes and the CSP/header fix...
git add scripts\team-data-request.mjs
git add netlify.toml
echo (add - errorlevel %errorlevel%)
echo.

echo Committing the staged changes...
git commit -F commit-message-deletion-script-fixes-and-csp.txt
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
echo All done. No SQL migration needed. The CSP change takes effect on the
echo next deploy -- worth a quick check of the login/signup page afterward
echo to confirm the Turnstile widget actually renders now.
pause
