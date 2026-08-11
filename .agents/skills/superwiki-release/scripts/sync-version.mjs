#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = process.env.SUPERWIKI_ROOT
  ? path.resolve(process.env.SUPERWIKI_ROOT)
  : fileURLToPath(new URL("../../../../", import.meta.url));
const paths = {
  packageJson: path.join(repoRoot, "package.json"),
  packageLock: path.join(repoRoot, "package-lock.json"),
  tauriConfig: path.join(repoRoot, "src-tauri/tauri.conf.json"),
  cargoToml: path.join(repoRoot, "src-tauri/Cargo.toml"),
  cargoLock: path.join(repoRoot, "src-tauri/Cargo.lock"),
};
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function replacePackageVersion(lockfile, packageName, version) {
  const blocks = lockfile.split(/(?=^\[\[package\]\]$)/m);
  let updated = false;
  const result = blocks.map((block) => {
    if (!block.startsWith("[[package]]") || !new RegExp(`^name = "${packageName}"$`, "m").test(block)) {
      return block;
    }
    updated = true;
    return block.replace(/^version = "[^"]+"$/m, `version = "${version}"`);
  });

  if (!updated) {
    throw new Error(`未在 Cargo.lock 中找到包：${packageName}`);
  }
  return result.join("");
}

function readCargoPackageVersion(toml) {
  const packageSection = toml.match(/^\[package\]\s*\n([\s\S]*?)(?=^\[|\Z)/m)?.[1];
  const version = packageSection?.match(/^version\s*=\s*"([^"]+)"$/m)?.[1];
  if (!version) {
    throw new Error("未在 Cargo.toml 的 [package] 中找到 version");
  }
  return version;
}

function readCargoLockVersion(lockfile, packageName) {
  for (const block of lockfile.split(/(?=^\[\[package\]\]$)/m)) {
    if (new RegExp(`^name = "${packageName}"$`, "m").test(block)) {
      const version = block.match(/^version = "([^"]+)"$/m)?.[1];
      if (version) return version;
    }
  }
  throw new Error(`未在 Cargo.lock 中找到包：${packageName}`);
}

function collectVersions() {
  const packageJson = readJson(paths.packageJson);
  const packageLock = readJson(paths.packageLock);
  const tauriConfig = readJson(paths.tauriConfig);
  const cargoToml = fs.readFileSync(paths.cargoToml, "utf8");
  const cargoLock = fs.readFileSync(paths.cargoLock, "utf8");

  return {
    "package.json": packageJson.version,
    "package-lock.json": packageLock.version,
    'package-lock.json packages[""]': packageLock.packages?.[""]?.version,
    "src-tauri/tauri.conf.json": tauriConfig.version,
    "src-tauri/Cargo.toml": readCargoPackageVersion(cargoToml),
    "src-tauri/Cargo.lock": readCargoLockVersion(cargoLock, packageJson.name),
  };
}

function checkVersions() {
  const versions = collectVersions();
  const uniqueVersions = new Set(Object.values(versions));
  for (const [file, version] of Object.entries(versions)) {
    console.log(`${file}: ${version}`);
  }
  if (uniqueVersions.size !== 1) {
    throw new Error("版本号不一致，请先同步所有版本文件");
  }
  const [version] = uniqueVersions;
  if (!semverPattern.test(version)) {
    throw new Error(`版本号不符合 SemVer：${version}`);
  }
  console.log(`版本检查通过：${version}`);
}

function syncVersion(version) {
  if (!semverPattern.test(version)) {
    throw new Error(`版本号不符合 SemVer：${version}`);
  }

  const packageJson = readJson(paths.packageJson);
  const packageLock = readJson(paths.packageLock);
  const tauriConfig = readJson(paths.tauriConfig);
  let cargoToml = fs.readFileSync(paths.cargoToml, "utf8");
  let cargoLock = fs.readFileSync(paths.cargoLock, "utf8");

  packageJson.version = version;
  packageLock.version = version;
  if (!packageLock.packages?.[""]) {
    throw new Error('package-lock.json 缺少 packages[""] 根包信息');
  }
  packageLock.packages[""].version = version;
  tauriConfig.version = version;

  const packageSectionPattern = /(^\[package\]\s*\n[\s\S]*?^version\s*=\s*")[^"]+("$)/m;
  if (!packageSectionPattern.test(cargoToml)) {
    throw new Error("未在 Cargo.toml 的 [package] 中找到 version");
  }
  cargoToml = cargoToml.replace(packageSectionPattern, `$1${version}$2`);
  cargoLock = replacePackageVersion(cargoLock, packageJson.name, version);

  writeJson(paths.packageJson, packageJson);
  writeJson(paths.packageLock, packageLock);
  writeJson(paths.tauriConfig, tauriConfig);
  fs.writeFileSync(paths.cargoToml, cargoToml);
  fs.writeFileSync(paths.cargoLock, cargoLock);

  console.log(`已同步 SuperWiki 版本：${version}`);
  checkVersions();
}

try {
  const [argument, extra] = process.argv.slice(2);
  if (extra || !argument || (argument !== "--check" && argument.startsWith("-"))) {
    throw new Error("用法：sync-version.mjs --check | <semver>");
  }
  if (argument === "--check") {
    checkVersions();
  } else {
    syncVersion(argument);
  }
} catch (error) {
  console.error(`错误：${error.message}`);
  process.exit(1);
}
