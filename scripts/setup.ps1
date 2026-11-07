#Requires -Version 5.1
<#
.SYNOPSIS
  为本插件目录里的 engine/ 创建虚拟环境并安装依赖（Windows）。
.DESCRIPTION
  每个外部命令都会检查退出码。模型下载失败时脚本失败，不会显示安装完成。
  用法:
    .\scripts\setup.ps1
    .\scripts\setup.ps1 -SkipModels
    .\scripts\setup.ps1 -Python C:\Path\python.exe
#>
param(
  [string]$Python = '',
  [switch]$SkipModels,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Engine = Join-Path $Root 'engine'
$Venv = Join-Path $Engine '.venv'
$Req = Join-Path $Engine 'requirements.txt'
$Models = Join-Path $Engine 'models'
$CpuIndex = 'https://download.pytorch.org/whl/cpu'

function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)][string]$File,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList,
    [Parameter(Mandatory = $true)][string]$What
  )
  & $File @ArgumentList
  if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) {
    throw "$What failed with exit $LASTEXITCODE"
  }
}

function Test-Python310 {
  param([Parameter(Mandatory = $true)][string]$File)
  & $File -c 'import sys; assert sys.version_info >= (3, 10)'
  return ($LASTEXITCODE -eq 0)
}

function Find-Python {
  if ($Python) {
    if (-not (Test-Python310 -File $Python)) {
      throw "Python is not 3.10+: $Python"
    }
    return $Python
  }
  foreach ($cand in @('py -3.12', 'py -3.11', 'py -3.10', 'python', 'python3')) {
    try {
      $parts = $cand -split ' '
      $exe = $parts[0]
      $extra = @()
      if ($parts.Length -gt 1) { $extra = $parts[1..($parts.Length - 1)] }
      $args = $extra + @('-c', 'import sys; assert sys.version_info >= (3,10); print(sys.executable)')
      $out = & $exe @args 2>$null
      if ($LASTEXITCODE -eq 0 -and $out) { return "$out".Trim() }
    } catch {}
  }
  throw 'Need Python 3.10+ on PATH (python / py launcher).'
}

Write-Host '== dsh-meeting-recorder engine setup ==' -ForegroundColor Cyan
Write-Host "Plugin root: $Root"
Write-Host "Engine: $Engine"

$Py = Find-Python
Write-Host "Using Python: $Py"

if ((Test-Path $Venv) -and $Force) {
  Write-Host 'Removing existing .venv (-Force)...'
  Remove-Item -Recurse -Force $Venv
}

$VenvPy = Join-Path $Venv 'Scripts\python.exe'
if (-not (Test-Path $VenvPy)) {
  Write-Host 'Creating venv...'
  Invoke-Native -File $Py -ArgumentList @('-m', 'venv', $Venv) -What 'python -m venv'
}

if (-not (Test-Path $VenvPy)) { throw "venv python missing: $VenvPy" }

Write-Host 'Upgrading pip...'
Invoke-Native -File $VenvPy -ArgumentList @('-m', 'pip', 'install', '-U', 'pip', 'wheel', 'setuptools') -What 'pip upgrade'

Write-Host "Installing CPU torch / torchaudio from $CpuIndex ..."
Invoke-Native -File $VenvPy -ArgumentList @(
  '-m', 'pip', 'install', '--index-url', $CpuIndex, 'torch', 'torchaudio'
) -What 'torch install'

Write-Host 'Installing FunASR stack from requirements.txt...'
Invoke-Native -File $VenvPy -ArgumentList @('-m', 'pip', 'install', '-r', $Req) -What 'requirements install'

Write-Host 'Running selfcheck...'
Push-Location $Engine
try {
  Invoke-Native -File $VenvPy -ArgumentList @('-m', 'speech_engine', 'selfcheck') -What 'selfcheck'
} finally {
  Pop-Location
}

if (-not $SkipModels) {
  Write-Host 'Downloading FunASR models into engine/models (about 2GB+, needs network)...' -ForegroundColor Yellow
  New-Item -ItemType Directory -Force -Path $Models | Out-Null
  Push-Location $Engine
  try {
    Invoke-Native -File $VenvPy -ArgumentList @('-m', 'speech_engine', 'models', '--model-cache', $Models) -What 'model download'
  } catch {
    Write-Host 'ERROR: model download failed. Python dependencies may be present, but setup is NOT complete.' -ForegroundColor Red
    Write-Host 'Re-run setup, or transcribe later to retry the download. Do not treat this run as finished.' -ForegroundColor Red
    throw
  } finally {
    Pop-Location
  }
  Write-Host 'Python dependencies are installed and the model download step succeeded.' -ForegroundColor Green
} else {
  Write-Host 'Skipped model download (-SkipModels).' -ForegroundColor Yellow
  Write-Host 'Python dependencies are installed. Model weights were NOT downloaded.'
  Write-Host 'The first transcription will try to download them (about 2GB+), or re-run without -SkipModels.'
}

Write-Host ''
Write-Host 'Setup script finished. This does not install the plugin into Harness.'
Write-Host 'If Harness loaded a copy of this folder, run setup in that copy, or use the in-plugin installer.'
