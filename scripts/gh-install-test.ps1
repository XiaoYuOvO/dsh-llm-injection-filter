$ErrorActionPreference = 'Stop'
$env:HTTPS_PROXY = 'http://127.0.0.1:7800'
$env:HTTP_PROXY = 'http://127.0.0.1:7800'
$scratch = 'G:\Deepseek Harness Desktop\data\dsh\plugins\_gh-install-test'
if (Test-Path $scratch) { Remove-Item $scratch -Recurse -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Path $scratch -Force | Out-Null
'{"name":"gh-test","private":true,"version":"0.0.0"}' | Set-Content -Path (Join-Path $scratch 'package.json') -Encoding utf8
Push-Location $scratch
try {
  & 'C:\Users\19662\AppData\Roaming\npm\pnpm.cmd' add "github:XiaoYuOvO/dsh-llm-injection-filter#v1.0.0" 2>&1 | Select-Object -Last 6
} finally { Pop-Location }
$installed = Join-Path $scratch 'node_modules\dsh-llm-injection-filter'
Write-Output "installed exists: $(Test-Path $installed)"
if (Test-Path $installed) {
  Write-Output '--- 安装结构 ---'
  Get-ChildItem $installed -Recurse -File | ForEach-Object { "  $($_.FullName.Replace($installed,''))" }
  node -e "const d=process.argv[1]; const fs=require('fs'); const p=require(d); const m=require(d+'/package.json'); console.log('lib/index.js:', fs.existsSync(d+'/lib/index.js'), '| apply:', typeof p.apply, '| mode:', p.CFG.mode, '| dsh.bundle.patch:', m.dsh&&m.dsh.bundle&&m.dsh.bundle.patch, '| test excluded:', !fs.existsSync(d+'/test'))" $installed
}
