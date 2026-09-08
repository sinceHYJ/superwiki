#requires -Version 5.1
<#
.SYNOPSIS
  Build the SuperWiki desktop app for Windows.

.DESCRIPTION
  Checks required dependencies, builds with Tauri, and prints the generated
  exe, NSIS installer, and MSI package paths.
#>

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
Set-Location -LiteralPath $root

function Write-Step {
    param([string]$Message)
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Require-Command {
    param(
        [string]$Name,
        [string]$Hint
    )
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        Write-Host "错误：缺少命令 '$Name'。" -ForegroundColor Red
        Write-Host "请先安装：$Hint" -ForegroundColor Yellow
        exit 1
    }
}

function Require-Path {
    param(
        [string]$Path,
        [string]$Hint
    )
    if (-not (Test-Path -LiteralPath $Path)) {
        Write-Host "错误：缺少路径 '$Path'。" -ForegroundColor Red
        Write-Host "请先处理：$Hint" -ForegroundColor Yellow
        exit 1
    }
}

function Get-LatestFile {
    param(
        [string]$Directory,
        [string]$Filter
    )
    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) {
        return $null
    }
    Get-ChildItem -LiteralPath $Directory -Filter $Filter -File |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
}

Write-Host '============================================================' -ForegroundColor Green
Write-Host '  SuperWiki Windows 打包脚本' -ForegroundColor Green
Write-Host '============================================================' -ForegroundColor Green

Write-Step '检查操作系统'
if ($PSVersionTable.Platform -and $PSVersionTable.Platform -ne 'Win32NT') {
    Write-Host '错误：此脚本只能在 Windows 上运行。' -ForegroundColor Red
    exit 1
}

Write-Step '检查基础命令'
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if (Test-Path -LiteralPath $cargoBin) {
    $env:Path = "$cargoBin;$env:Path"
}

Require-Command node 'Node.js（https://nodejs.org/）'
Require-Command npm 'Node.js（https://nodejs.org/）'
Require-Command rustup 'Rust（https://rustup.rs/）'
Require-Command cargo 'Rust（https://rustup.rs/）'
Require-Command rustc 'Rust（https://rustup.rs/）'

Write-Step '检查 Rust 目标'
$targets = & rustup target list --installed
if ($LASTEXITCODE -ne 0) {
    Write-Host '错误：无法读取 Rust 目标列表。' -ForegroundColor Red
    exit 1
}
if ($targets -notcontains 'x86_64-pc-windows-msvc') {
    Write-Host '错误：缺少 Rust 目标 x86_64-pc-windows-msvc。' -ForegroundColor Red
    Write-Host '请运行：rustup target add x86_64-pc-windows-msvc' -ForegroundColor Yellow
    exit 1
}

Write-Step '检查 Visual Studio C++ 生成工具'
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
    Write-Host '错误：未找到 Visual Studio Installer。' -ForegroundColor Red
    Write-Host '请安装 Visual Studio 2022 Build Tools。' -ForegroundColor Yellow
    exit 1
}

$vsPath = & $vswhere -products * -property installationPath
if ($LASTEXITCODE -ne 0 -or -not $vsPath) {
    Write-Host '错误：未检测到 Visual Studio 2022 Build Tools。' -ForegroundColor Red
    Write-Host '请安装 Visual Studio 2022 Build Tools，并勾选“使用 C++ 的桌面开发”。' -ForegroundColor Yellow
    exit 1
}

$msvcRoot = Join-Path $vsPath 'VC\Tools\MSVC'
if (-not (Test-Path -LiteralPath $msvcRoot -PathType Container)) {
    Write-Host '错误：未找到 MSVC 工具目录。' -ForegroundColor Red
    Write-Host '请在 Visual Studio Installer 中安装“使用 C++ 的桌面开发”。' -ForegroundColor Yellow
    exit 1
}

$msvcDir = Get-ChildItem -LiteralPath $msvcRoot -Directory |
    Sort-Object Name -Descending |
    Select-Object -First 1
if (-not $msvcDir) {
    Write-Host '错误：未找到 MSVC 版本目录。' -ForegroundColor Red
    Write-Host '请安装 MSVC v143 生成工具。' -ForegroundColor Yellow
    exit 1
}

$requiredMsvcFiles = @(
    'bin\Hostx64\x64\cl.exe',
    'bin\Hostx64\x64\link.exe',
    'lib\x64\libcmt.lib',
    'lib\x64\libvcruntime.lib',
    'lib\x64\msvcrt.lib'
)
foreach ($relativePath in $requiredMsvcFiles) {
    $fullPath = Join-Path $msvcDir.FullName $relativePath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        Write-Host "错误：缺少 MSVC 文件 '$fullPath'。" -ForegroundColor Red
        Write-Host '请修复 Visual Studio 2022 Build Tools 的 C++ 生成工具。' -ForegroundColor Yellow
        exit 1
    }
}

Write-Step '检查 Windows SDK'
$sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\Lib'
if (-not (Test-Path -LiteralPath $sdkRoot -PathType Container)) {
    Write-Host '错误：未检测到 Windows 10/11 SDK。' -ForegroundColor Red
    Write-Host '请通过 Visual Studio Installer 安装 Windows 11 SDK。' -ForegroundColor Yellow
    exit 1
}

$sdkDir = Get-ChildItem -LiteralPath $sdkRoot -Directory |
    Sort-Object Name -Descending |
    Select-Object -First 1
if (-not $sdkDir) {
    Write-Host '错误：未找到 Windows SDK 版本目录。' -ForegroundColor Red
    Write-Host '请安装 Windows 10/11 SDK。' -ForegroundColor Yellow
    exit 1
}

$requiredSdkFiles = @(
    'ucrt\x64\ucrt.lib',
    'um\x64\kernel32.lib'
)
foreach ($relativePath in $requiredSdkFiles) {
    $fullPath = Join-Path $sdkDir.FullName $relativePath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        Write-Host "错误：缺少 Windows SDK 文件 '$fullPath'。" -ForegroundColor Red
        Write-Host '请修复 Windows 10/11 SDK。' -ForegroundColor Yellow
        exit 1
    }
}

Write-Step '检查项目文件'
Require-Path 'package.json' '请确认当前目录是 SuperWiki 仓库根目录。'
Require-Path 'src-tauri\tauri.conf.json' '请确认 Tauri 配置文件存在。'
Require-Path 'src-tauri\Cargo.toml' '请确认 Rust 工程文件存在。'

Write-Step '检查前端依赖'
if (-not (Test-Path -LiteralPath 'node_modules' -PathType Container)) {
    Write-Host 'node_modules 不存在，正在执行 npm ci...'
    & npm ci
    if ($LASTEXITCODE -ne 0) {
        Write-Host '错误：npm ci 失败。' -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host 'node_modules 已存在，跳过安装。'
}

Write-Step '开始构建 SuperWiki Windows 版本'
& npm run tauri build
if ($LASTEXITCODE -ne 0) {
    Write-Host '错误：构建失败，请查看上方日志。' -ForegroundColor Red
    exit 1
}

Write-Step '定位打包产物'
$exe = Get-LatestFile 'src-tauri\target\release' 'superwiki.exe'
$nsis = Get-LatestFile 'src-tauri\target\release\bundle\nsis' '*_x64-setup.exe'
$msi = Get-LatestFile 'src-tauri\target\release\bundle\msi' '*_x64_en-US.msi'

if (-not $exe -or -not $nsis -or -not $msi) {
    Write-Host '错误：构建已完成，但没有找到全部产物。' -ForegroundColor Red
    exit 1
}

$artifacts = @($exe, $nsis, $msi)

Write-Host ''
Write-Host '============================================================' -ForegroundColor Green
Write-Host '  ✅ SuperWiki Windows 打包完成' -ForegroundColor Green
Write-Host '------------------------------------------------------------' -ForegroundColor Green
foreach ($item in $artifacts) {
    $hash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash
    $sizeMB = [Math]::Round($item.Length / 1MB, 2)
    Write-Host ("  📦 文件名   : {0}" -f $item.Name)
    Write-Host ("  📁 所在目录 : {0}" -f $item.DirectoryName)
    Write-Host ("  🔗 完整路径 : {0}" -f $item.FullName)
    Write-Host ("  📄 大小     : {0} MB" -f $sizeMB)
    Write-Host ("  🔐 SHA-256  : {0}" -f $hash)
    Write-Host '------------------------------------------------------------' -ForegroundColor Green
}
Write-Host ''

