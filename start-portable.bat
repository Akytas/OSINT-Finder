@echo off
setlocal

set "ROOT=%~dp0"
set "RUNTIME_ROOT=%ROOT%..\OSINT Finder Runtime\"
set "NODE_DIR=%ROOT%node-v24.16.0-win-x64"
if not exist "%NODE_DIR%\node.exe" set "NODE_DIR=%RUNTIME_ROOT%node-v24.16.0-win-x64"
set "NODE_EXE=%NODE_DIR%\node.exe"
set "NPM_CMD=%NODE_DIR%\npm.cmd"
set "NODE_MODULES_DIR=%ROOT%node_modules"
if not exist "%NODE_MODULES_DIR%" set "NODE_MODULES_DIR=%RUNTIME_ROOT%node_modules"
set "PORT=3000"

if not exist "%NODE_EXE%" (
  echo Chybi lokalni Node.js: %NODE_EXE%
  pause
  exit /b 1
)

if not exist "%NPM_CMD%" (
  echo Chybi lokalni npm.cmd: %NPM_CMD%
  pause
  exit /b 1
)

if not exist "%NODE_MODULES_DIR%" (
  echo Chybi slozka zavislosti: %NODE_MODULES_DIR%
  pause
  exit /b 1
)

set "NODE_PATH=%NODE_MODULES_DIR%"

if exist "%ROOT%.env" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%ROOT%.env") do (
    if /I "%%A"=="PORT" set "PORT=%%B"
  )
)

if not exist "%ROOT%data" mkdir "%ROOT%data"
if not exist "%ROOT%data\uploads" mkdir "%ROOT%data\uploads"
if not exist "%ROOT%data\exports" mkdir "%ROOT%data\exports"

call "%NODE_EXE%" -e "const http=require('http');const port=Number(process.argv[1]||3000);const req=http.get({host:'127.0.0.1',port,path:'/health',timeout:1200},res=>{res.resume();process.exit(res.statusCode===200?0:1);});req.on('error',()=>process.exit(1));req.on('timeout',()=>{req.destroy();process.exit(1);});" %PORT% >nul 2>nul
if "%ERRORLEVEL%"=="0" (
  echo Server uz bezi na http://localhost:%PORT% - preskakuji start dalsi instance.
  start "" "http://localhost:%PORT%/"
  exit /b 0
)

pushd "%ROOT%"
start "OSINT Finder Portable" cmd.exe /c "cd /d "%ROOT%" && "%NPM_CMD%" run start:portable"

echo Cekam na start serveru na http://localhost:%PORT%/health ...
call "%NODE_EXE%" -e "const http=require('http');const port=Number(process.argv[1]||3000);let tries=0;const max=20;const check=()=>{tries+=1;const req=http.get({host:'127.0.0.1',port,path:'/health',timeout:1500},res=>{res.resume();if(res.statusCode===200){console.log('Server bezi na http://localhost:'+port);process.exit(0);}retry();});req.on('error',retry);req.on('timeout',()=>{req.destroy(new Error('timeout'));});};const retry=()=>{if(tries>=max){console.error('Server se nepodarilo overit na /health.');process.exit(1);}setTimeout(check,500);};check();" %PORT%
set "HEALTH_EXIT=%ERRORLEVEL%"
popd

if not "%HEALTH_EXIT%"=="0" (
  echo Server byl spusten, ale health-check selhal.
  pause
  exit /b 1
)

start "" "http://localhost:%PORT%/"

echo Portable start dokonceny.
