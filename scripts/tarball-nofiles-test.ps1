$ErrorActionPreference = 'Stop'
$root = 'G:\Deepseek Harness Desktop\data\dsh\plugins\_git-install-test'
$variant = Join-Path $root 'variant-nofiles'
if (Test-Path $variant) { Remove-Item $variant -Recurse -Force }
New-Item -ItemType Directory -Path $variant -Force | Out-Null

# 复制运行时文件，package.json 去掉 files 字段
Copy-Item -Path (Join-Path $root 'repo\lib') -Destination $variant -Recurse
foreach ($f in 'cordis.patch.yml','README.md','LICENSE') {
  Copy-Item -Path (Join-Path $root "repo\$f") -Destination (Join-Path $variant $f)
}
$pkg = Get-Content (Join-Path $root 'repo\package.json') -Raw | ConvertFrom-Json
$pkg.PSObject.Properties.Remove('files')
$pkg | ConvertTo-Json -Depth 10 | Set-Content -Path (Join-Path $variant 'package.json') -Encoding utf8

# 打成 tar.gz（与 codeload 同构）
$tarball = Join-Path $root 'pkg-nofiles.tar.gz'
Push-Location $variant
try {
  tar -czf $tarball .
} finally { Pop-Location }

# 新 consumer 安装
$consumer3 = Join-Path $root 'consumer-nofiles'
if (Test-Path $consumer3) { Remove-Item $consumer3 -Recurse -Force }
New-Item -ItemType Directory -Path $consumer3 -Force | Out-Null
'{"name":"consumer3","private":true,"version":"0.0.0"}' | Set-Content -Path (Join-Path $consumer3 'package.json') -Encoding utf8
Push-Location $consumer3
try {
  & 'C:\Users\19662\AppData\Roaming\npm\pnpm.cmd' add "file:$tarball" 2>&1 | Select-Object -Last 6
} finally { Pop-Location }

$installed3 = Join-Path $consumer3 'node_modules\dsh-llm-injection-filter'
Write-Output '--- 无 files 字段的 tarball 安装结构 ---'
Get-ChildItem $installed3 -Recurse -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName.Replace($installed3, '') }
node -e "const dir=process.argv[1]; const p=require(dir); console.log('require ok | apply:', typeof p.apply)" $installed3
