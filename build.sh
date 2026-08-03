#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

print_help() {
  cat <<'HELP'
用法：./build.sh

交互式构建 SuperWiki 的 macOS DMG：
  - 输入版本号，默认使用 package.json 中的版本
  - 选择 Universal、Apple Silicon 或 Intel 架构
  - 选择是否跳过代码签名

输出文件名格式：superwiki-{架构}-{版本}.dmg
HELP
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  print_help
  exit 0
fi

if [[ $# -gt 0 ]]; then
  echo "错误：不支持参数：$*" >&2
  print_help >&2
  exit 1
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "错误：DMG 必须在 macOS 上构建。" >&2
  exit 1
fi

require_command() {
  local command_name="$1"
  local install_hint="$2"

  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "错误：缺少命令 '$command_name'。" >&2
    echo "请先安装：$install_hint" >&2
    exit 1
  fi
}

require_command node "Node.js（https://nodejs.org/）"
require_command npm "Node.js（https://nodejs.org/）"
require_command rustup "Rust（https://rustup.rs/）"
require_command cargo "Rust（https://rustup.rs/）"
require_command xcode-select "运行 xcode-select --install 安装 Xcode Command Line Tools"

if ! xcode-select -p >/dev/null 2>&1; then
  echo "错误：未安装 Xcode Command Line Tools。" >&2
  echo "请先运行：xcode-select --install" >&2
  exit 1
fi

default_version="$(node -p "require('./package.json').version")"

while true; do
  printf "请输入版本号 [%s]: " "$default_version"
  IFS= read -r version
  version="${version:-$default_version}"

  if [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?(\+[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]]; then
    break
  fi

  echo "无效版本号，请输入 SemVer 格式，例如 1.0.0 或 1.0.0-beta.1。"
done

echo
echo "请选择要构建的 macOS 架构："
echo "  1) Universal（Intel + Apple Silicon，推荐）"
echo "  2) Apple Silicon（arm64）"
echo "  3) Intel（x86_64）"

while true; do
  printf "请输入选项 [1]: "
  IFS= read -r architecture_choice
  architecture_choice="${architecture_choice:-1}"

  case "$architecture_choice" in
    1)
      target="universal-apple-darwin"
      architecture_name="universal"
      rust_targets=("aarch64-apple-darwin" "x86_64-apple-darwin")
      break
      ;;
    2)
      target="aarch64-apple-darwin"
      architecture_name="arm64"
      rust_targets=("aarch64-apple-darwin")
      break
      ;;
    3)
      target="x86_64-apple-darwin"
      architecture_name="x86_64"
      rust_targets=("x86_64-apple-darwin")
      break
      ;;
    *)
      echo "无效选项，请输入 1、2 或 3。"
      ;;
  esac
done

echo
echo "请选择签名方式："
echo "  1) 正常构建（使用已有的 Tauri/Apple 签名配置）"
echo "  2) 跳过代码签名（仅建议本地测试）"

while true; do
  printf "请输入选项 [1]: "
  IFS= read -r signing_choice
  signing_choice="${signing_choice:-1}"

  case "$signing_choice" in
    1)
      skip_signing=false
      break
      ;;
    2)
      skip_signing=true
      break
      ;;
    *)
      echo "无效选项，请输入 1 或 2。"
      ;;
  esac
done

echo
if npm ls --depth=0 >/dev/null 2>&1; then
  echo "npm 依赖已安装，跳过安装。"
else
  echo "npm 依赖缺失或与锁文件不一致，正在执行 npm ci..."
  npm ci
fi

installed_targets="$(rustup target list --installed)"
for rust_target in "${rust_targets[@]}"; do
  if grep -Fxq "$rust_target" <<<"$installed_targets"; then
    echo "Rust target 已安装：$rust_target"
  else
    echo "正在安装 Rust target：$rust_target"
    rustup target add "$rust_target"
  fi
done

bundle_dir="$SCRIPT_DIR/src-tauri/target/$target/release/bundle"
dmg_dir="$bundle_dir/dmg"
output_name="superwiki-$architecture_name-$version.dmg"
output_path="$dmg_dir/$output_name"
marker_dir="$SCRIPT_DIR/src-tauri/target"
marker_file="$marker_dir/.superwiki-dmg-build-start"

mkdir -p "$marker_dir"
touch "$marker_file"

echo
echo "开始构建：版本 ${version}，架构 ${architecture_name}"
config_override="{\"version\":\"$version\"}"

if [[ "$skip_signing" == true ]]; then
  echo "执行命令：npm run tauri build -- --target $target --bundles dmg --config '$config_override' --no-sign"
  npm run tauri build -- \
    --target "$target" \
    --bundles dmg \
    --config "$config_override" \
    --no-sign
else
  echo "执行命令：npm run tauri build -- --target $target --bundles dmg --config '$config_override'"
  npm run tauri build -- \
    --target "$target" \
    --bundles dmg \
    --config "$config_override"
fi

source_dmg=""
if [[ -d "$dmg_dir" ]]; then
  while IFS= read -r dmg_file; do
    if [[ "$dmg_file" != "$output_path" ]]; then
      source_dmg="$dmg_file"
      break
    fi
  done < <(find "$dmg_dir" -maxdepth 1 -type f -name '*.dmg' -newer "$marker_file" -print)
fi

if [[ -z "$source_dmg" ]]; then
  echo "错误：构建命令已完成，但没有找到新生成的 DMG：$dmg_dir" >&2
  exit 1
fi

mv -f "$source_dmg" "$output_path"

printf '\n'
printf '%s\n' "============================================================"
printf '%s\n' "  ✅ SuperWiki DMG 打包完成"
printf '%s\n' "------------------------------------------------------------"
printf '  📦 文件名   : %s\n' "$output_name"
printf '  📁 所在目录 : %s\n' "$dmg_dir"
printf '  🔗 完整路径 : %s\n' "$output_path"
printf '%s\n' "============================================================"
printf '\n'
