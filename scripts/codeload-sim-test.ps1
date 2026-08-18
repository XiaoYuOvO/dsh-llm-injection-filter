$ErrorActionPreference = 'Stop'
$root = 'G:\Deepseek Harness Desktop\data\dsh\plugins'
$src  = Join-Path $root 'llm-injection-filter'
$scratch = Join-Path $root '_git-install-test'
if (Test-Path $scratch) { Remove-Item $scratch -Recurse -Force }
New-Item -ItemType Directory -Path $scratch -Force | Out-Null

# 模拟 codeload 包裹格式：<repo>-<commit>/lib/index.js ...
$wrapper = Join-Path $scratch 'dsh-llm-injection-filter-main'
New-Item -ItemType Directory -Path $wrapper -Force | Out-Null
Copy-Item -Path (Join-Path $src 'lib') -Destination $wrapper -Recurse
foreach ($f in 'index.js','package.json','cordis.patch.yml','README.md','LICENSE','.gitattributes','.npmignore') {
  Copy-Item -Path (Join-Path $src $f) -Destination (Join-Path $wrapper $f)
}
$tarball = Join-Path $scratch 'codeload-sim.tar.gz'
Push-Location $scratch
try { tar -czf $tarball 'dsh-llm-injection-filter-main' } finally { Pop-Location }
Write-Output 'tarball entries:'
tar -tzf $tarball

# 安装
$consumer = Join-Path $scratch 'consumer'
New-Item -ItemType Directory -Path $consumer -Force | Out-Null
'{"name":"c","private":true,"version":"0.0.0"}' | Set-Content -Path (Join-Path $consumer 'package.json') -Encoding utf8
Push-Location $consumer
try { & 'C:\Users\19662\AppData\Roaming\npm\pnpm.cmd' add "file:$tarball" 2>&1 | Select-Object -Last 3 } finally { Pop-Location }

$installed = Join-Path $consumer 'node_modules\dsh-llm-injection-filter'
Write-Output '--- 安装结构 ---'
Get-ChildItem $installed -Recurse -File | ForEach-Object { "  $($_.FullName.Replace($installed,''))" }
node -e "const d=process.argv[1]; const fs=require('fs'); console.log('  lib/index.js exists:', fs.existsSync(d+'/lib/index.js')); const p=require(d); console.log('  require ok | apply:', typeof p.apply, '| mode:', p.CFG.mode)" $installed
Write-Output "  cordis.patch.yml: $(Test-Path (Join-Path $installed 'cordis.patch.yml')) | .npmignore 生效(test 排除): $(-not (Test-Path (Join-Path $installed 'test')))"
