param([switch]$Preview, [switch]$Real)
if ($Preview -and $Real) { throw "Use -Real for the local API development server, without -Preview." }
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$runner = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
if ($runner) { $pnpmPath = $runner.Source }
else {
  $runtime = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies'
  $pnpmPath = Join-Path $runtime 'bin\fallback\pnpm.cmd'
  if (!(Test-Path $pnpmPath)) { throw 'Please install Node.js 22.12+ and pnpm 11, then rerun.' }
  $env:PATH = (Join-Path $runtime 'node\bin') + ';' + $env:PATH
}
if (!(Test-Path 'node_modules')) {
  & $pnpmPath install
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}
if ($Preview) {
  & $pnpmPath build
  if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
  & $pnpmPath preview
} elseif ($Real) { & $pnpmPath dev:real } else { & $pnpmPath dev }