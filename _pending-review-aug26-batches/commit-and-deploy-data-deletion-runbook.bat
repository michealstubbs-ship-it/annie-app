@echo off
cd /d "%~dp0"

echo Cleaning up any leftover lock files...
if exist ".git\index.lock" del /f /q ".git\index.lock"
if exist ".git\HEAD.lock" del /f /q ".git\HEAD.lock"
echo Done.
echo.

echo Staging the account-deletion/export runbook...
git add scripts\team-data-request.mjs
git add scripts\README-team-data-request.md
echo (add - errorlevel %errorlevel%)
echo.

echo Committing the staged changes...
git commit -F commit-message-data-deletion-runbook.txt
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
echo All done. This is a standalone admin script -- nothing in the deployed
echo app imports or runs it, and no SQL migration is needed. See
echo scripts\README-team-data-request.md for how to actually use it when a
echo real request comes in.
pause
