#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const ESP32S3_TOOLCHAIN = {
  name: "xtensa-esp32s3-elf",
  version: "gcc8_4_0-esp-2021r2-patch5",
  url: "https://github.com/espressif/crosstool-NG/releases/download/esp-2021r2-patch5/xtensa-esp32s3-elf-gcc8_4_0-esp-2021r2-patch5-win64.zip",
  sha256: "9000be38d44bf79c39b93a2aeb99b42e956c593ccbc02fe31cb9c71ae1bbcb22",
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = path.resolve(args.root || process.cwd());

  ensureDirectory(path.join(rootDir, "firmware"));
  await installEsp32S3Toolchain({ rootDir, force: Boolean(args.force) });

  console.log("Setup complete.");
}

async function installEsp32S3Toolchain({ rootDir, force }) {
  const toolsDir = path.join(rootDir, ".tools", "espressif");
  const zipPath = path.join(toolsDir, `${ESP32S3_TOOLCHAIN.name}-${ESP32S3_TOOLCHAIN.version}-win64.zip`);
  const objdumpPath = path.join(toolsDir, ESP32S3_TOOLCHAIN.name, "bin", `${ESP32S3_TOOLCHAIN.name}-objdump.exe`);

  if (fs.existsSync(objdumpPath) && !force) {
    console.log(`ESP32-S3 analysis tool already installed: ${objdumpPath}`);
    return objdumpPath;
  }

  ensureDirectory(toolsDir);
  await downloadIfNeeded({ url: ESP32S3_TOOLCHAIN.url, filePath: zipPath, force });
  verifySha256(zipPath, ESP32S3_TOOLCHAIN.sha256);

  const targetDir = path.join(toolsDir, ESP32S3_TOOLCHAIN.name);
  fs.rmSync(targetDir, { recursive: true, force: true });
  const result = spawnSync("tar", ["-xf", zipPath, "-C", toolsDir], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Could not extract ESP32-S3 analysis tool: ${result.stderr || result.stdout || "tar failed"}`);
  }

  if (!fs.existsSync(objdumpPath)) {
    throw new Error(`ESP32-S3 analysis tool was not found after setup: ${objdumpPath}`);
  }

  console.log(`Installed ESP32-S3 analysis tool: ${objdumpPath}`);
  return objdumpPath;
}

async function downloadIfNeeded({ url, filePath, force }) {
  if (fs.existsSync(filePath) && !force) {
    console.log(`Using existing download: ${filePath}`);
    return;
  }

  console.log(`Downloading ${path.basename(filePath)}...`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);

  const tempPath = `${filePath}.part`;
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  const hashStream = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      callback(null, chunk);
    },
  });

  await pipeline(Readable.fromWeb(response.body), hashStream, fs.createWriteStream(tempPath));
  fs.renameSync(tempPath, filePath);
  console.log(`Downloaded ${bytes} bytes`);
}

function verifySha256(filePath, expected) {
  const actual = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`Checksum mismatch for ${filePath}. Expected ${expected}, got ${actual}`);
  }
  console.log("Checksum OK");
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, rawValue] = arg.slice(2).split("=");
    args[toCamel(key)] = rawValue === undefined ? true : rawValue;
  }
  return args;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
