@echo off
echo Neo4j Browser Fix - Multiple Access Methods
echo ============================================

echo.
echo 1. Opening Neo4j in default browser...
start http://localhost:7474

echo.
echo 2. Opening Neo4j in Chrome (if available)...
start chrome.exe http://localhost:7474 2>nul

echo.
echo 3. Opening Neo4j in Firefox (if available)...
start firefox.exe http://localhost:7474 2>nul

echo.
echo 4. Opening Neo4j in Edge...
start msedge.exe http://localhost:7474 2>nul

echo.
echo 5. Alternative URLs to try manually:
echo    http://127.0.0.1:7474
echo    http://localhost:7474/browser/
echo    http://127.0.0.1:7474/browser/

echo.
echo 6. Login Information:
echo    Username: neo4j
echo    Password: testpassword

echo.
echo 7. If all browsers show white screen, try:
echo    - Press Ctrl+F5 (hard refresh)
echo    - Disable antivirus temporarily
echo    - Check Windows Firewall
echo    - Try incognito/private mode

echo.
echo 8. Browser developer console check:
echo    - Press F12 to open developer tools
echo    - Check Console tab for errors
echo    - Look for blocked resources or CORS errors

echo.
pause 