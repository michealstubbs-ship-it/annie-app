@echo off
cd /d "%~dp0"
echo Finishing the deploy: merging test-payments into main and pushing...
echo.

git checkout main
echo (checkout - errorlevel %errorlevel%)
pause

echo.
git merge test-payments --ff-only
echo (merge - errorlevel %errorlevel%)
pause

echo.
echo Pushing main to GitHub now...
git push origin main
echo (push - errorlevel %errorlevel%)
pause

echo.
git checkout test-payments
echo.
echo All done.
pause
