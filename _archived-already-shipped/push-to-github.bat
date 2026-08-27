@echo off
echo Pushing annie-app to GitHub...
cd /d "%~dp0"
git add -A
git commit -m "Update annie-app"
git push origin main
echo Done.
pause
