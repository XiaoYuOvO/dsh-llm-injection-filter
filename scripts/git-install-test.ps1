$ErrorActionPreference = 'Stop'
$root = 'G:\Deepseek Harness Desktop\data\dsh\plugins'
$src  = Join-Path $root 'llm-injection-filter'
$scratch = Join-Path $root '_git-install-test'
if (Test-Path $scratch) { Remove-Item $scratch -Recurse -Force }
$repo = Join-Path $scratch 'repo'
$repoIg = Join-Path $scratch 'repo-with-gitignore'
$cg = Join-Path $scratch 'c-git'
$ct = Join-Path $scratch 'c-tar'
$ci = Join-Path $scratch 'c-gitignore'
New-Item -ItemType Directory -Path $repo, $repoIg, $cg, $ct, $ci -Force | Out-Null

function New-Repo([string]$dir, [bool]$withGitignore) {
  Copy-Item -Path (Join-Path $src 'lib') -Destination $dir -Recurse
  foreach ($f in 'index.js','package.json','cordis.patch.yml','README.md','LICENSE','.gitattributes','.npmignore','plugin-body.js','test') {
    Copy-Item -Path (Join-Path $src $f) -Destination $dir -Recurse -ErrorAction SilentlyContinue
  }
  if ($withGitignore) { '# dev artifacts' | Set-Content -Path (Join-Path $dir '.gitignore') -Encoding utf8 }
  git -C $dir init -q
  git -C $dir config user.name 'test'
  git -C $dir config user.email 'test@example.com'
  git -C $dir add -A
  git -C $dir commit -qm 't'
}

function Add-Consumer([string]$consumerDir, [string]$spec) {
  '{"name":"c","private":true,"version":"0.0.0"}' | Set-Content -Path (Join-Path $consumerDir 'package.json') -Encoding utf8
  Push-Location $consumerDir
  try { & 'C:\Users\19662\AppData\Roaming\npm\pnpm.cmd' add $spec 2>&1 | Select-Object -Last 2 } finally { Pop-Location }
}

function Check-Install([string]$label, [string]$installed) {
  Write-Output "--- $label ---"
  Get-ChildItem $installed -Recurse -File | ForEach-Object { "  $($_.FullName.Replace($installed,''))" }
  node -e "const d=process.argv[1]; const fs=require('fs'); console.log('  lib/index.js exists:', fs.existsSync(d+'/lib/index.js')); const p=require(d); console.log('  require ok | apply:', typeof p.apply, '| mode:', p.CFG.mode, '| hardBlock:', p.CFG.hardBlockRareScripts)" $installed
  Write-Output "  cordis.patch.yml: $(Test-Path (Join-Path $installed 'cordis.patch.yml'))"
}

Write-Output '=== 组装 repos ==='
New-Repo $repo $false
New-Repo $repoIg $true

$fso = New-Object -ComObject Scripting.FileSystemObject
$repoShort = $fso.GetFolder($repo).ShortPath

Write-Output ''
Write-Output '=== A) git resolver（github: 同源）==='
Add-Consumer $cg "git+file:///$($repoShort -replace '\\','/')"
Check-Install 'git clone 安装' (Join-Path $cg 'node_modules\dsh-llm-injection-filter')

Write-Output ''
Write-Output '=== B) codeload 等价（git archive tarball）==='
$tarball = Join-Path $scratch 'pkg.tar.gz'
git -C $repo archive --format=tar.gz -o $tarball HEAD
Write-Output "tarball entries: $(tar -tzf $tarball | Measure-Object | Select-Object -ExpandProperty Count)"
Add-Consumer $ct "file:$tarball"
Check-Install 'codeload tarball 安装' (Join-Path $ct 'node_modules\dsh-llm-injection-filter')

Write-Output ''
Write-Output '=== C) 脚枪场景：仓库带 .gitignore（git resolver）==='
$repoIgShort = $fso.GetFolder($repoIg).ShortPath
Add-Consumer $ci "git+file:///$($repoIgShort -replace '\\','/')"
Check-Install '带 .gitignore 的 git clone 安装' (Join-Path $ci 'node_modules\dsh-llm-injection-filter')

Write-Output ''
Write-Output '=== 清理 ==='
Remove-Item $scratch -Recurse -Force
Write-Output "scratch removed: $(-not (Test-Path $scratch))"
