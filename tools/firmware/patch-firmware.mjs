#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DEFAULTS = {
  version: "1.6.0",
  sourceDir: "firmware/analysis/1.6.0",
  decompiledDir: "firmware/decompiled/1.6.0",
  outDir: "firmware/patched",
  intentTimeoutMs: 300000,
  originalHost: "api.aibipocket.com",
  timeoutLiteralAddress: 0x42000974,
};

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = path.resolve(args.root || process.cwd());
  const version = String(args.version || DEFAULTS.version);
  const sourceDir = path.resolve(rootDir, args.source || DEFAULTS.sourceDir);
  const inputDecompiledDir = path.resolve(rootDir, args.decompiled || DEFAULTS.decompiledDir);
  const outDir = path.resolve(rootDir, args.outDir || DEFAULTS.outDir);
  const workDir = path.join(outDir, `${version}-work`);
  const patchedDecompiledDir = path.join(workDir, "decompiled");
  const host = args.host ? String(args.host) : "";
  const intentTimeoutMs = Number(args.intentTimeoutMs || args.timeoutMs || DEFAULTS.intentTimeoutMs);
  const zipPath = path.join(outDir, `${version}-patched.zip`);
  const rebuildReportPath = path.join(outDir, `${version}-rebuild-report.json`);
  const patchReportPath = path.join(outDir, `${version}-patch-report.json`);

  if (host) validateHost(host);
  validateTimeout(intentTimeoutMs);
  assertDirectory(sourceDir, "source update directory");
  assertDirectory(inputDecompiledDir, "decompiled firmware directory");

  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.cpSync(inputDecompiledDir, patchedDecompiledDir, { recursive: true, preserveTimestamps: true });

  const patchReport = {
    patchedAt: new Date().toISOString(),
    version,
    host,
    intentTimeoutMs,
    decompiledDir: relative(patchedDecompiledDir),
    changes: [
      patchTimeoutLiteral(patchedDecompiledDir, intentTimeoutMs),
      ...(host ? [patchHostString(patchedDecompiledDir, host)] : []),
    ],
  };
  writeJson(patchReportPath, patchReport);

  runRebuild({
    version,
    sourceDir,
    decompiledDir: patchedDecompiledDir,
    outZip: zipPath,
    reportPath: rebuildReportPath,
  });

  console.log(`Patched firmware package: ${relative(zipPath)}`);
  console.log(`Patch report: ${relative(patchReportPath)}`);
  console.log(`Rebuild report: ${relative(rebuildReportPath)}`);
}

function patchHostString(decompiledDir, host) {
  const original = Buffer.from(`${DEFAULTS.originalHost}\0`, "ascii");
  const replacement = Buffer.alloc(original.length, 0);
  replacement.write(host, 0, "ascii");
  const files = [
    path.join(decompiledDir, "segments", "drom_0x3c1a0020.bin"),
  ];

  const patched = files.map((filePath) => patchUniqueBytes(filePath, original, replacement));
  return {
    type: "host",
    from: DEFAULTS.originalHost,
    to: host,
    patched,
  };
}

function patchTimeoutLiteral(decompiledDir, intentTimeoutMs) {
  const oldValue = Buffer.alloc(4);
  oldValue.writeUInt32LE(0x1f40, 0);
  const newValue = Buffer.alloc(4);
  newValue.writeUInt32LE(intentTimeoutMs, 0);
  const relativeOffset = DEFAULTS.timeoutLiteralAddress - 0x42000020;
  const files = [
    path.join(decompiledDir, "segments", "irom_0x42000020.bin"),
  ];

  const patched = files.map((filePath) => patchBytesAt(filePath, relativeOffset, oldValue, newValue));
  return {
    type: "intent_timeout",
    address: `0x${DEFAULTS.timeoutLiteralAddress.toString(16)}`,
    fromMs: 8000,
    toMs: intentTimeoutMs,
    patched,
  };
}

function patchUniqueBytes(filePath, original, replacement) {
  const buffer = fs.readFileSync(filePath);
  const first = buffer.indexOf(original);
  if (first < 0) throw new Error(`Pattern not found in ${filePath}`);
  const second = buffer.indexOf(original, first + 1);
  if (second >= 0) throw new Error(`Pattern is not unique in ${filePath}`);
  replacement.copy(buffer, first);
  fs.writeFileSync(filePath, buffer);
  return {
    file: relative(filePath),
    offset: first,
    offsetHex: `0x${first.toString(16)}`,
  };
}

function patchBytesAt(filePath, offset, expected, replacement) {
  const buffer = fs.readFileSync(filePath);
  const actual = buffer.subarray(offset, offset + expected.length);
  if (!actual.equals(expected)) {
    throw new Error(`Unexpected bytes in ${filePath} at 0x${offset.toString(16)}: ${actual.toString("hex")}`);
  }
  replacement.copy(buffer, offset);
  fs.writeFileSync(filePath, buffer);
  return {
    file: relative(filePath),
    offset,
    offsetHex: `0x${offset.toString(16)}`,
  };
}

function runRebuild({ version, sourceDir, decompiledDir, outZip, reportPath }) {
  const args = [
    fileURLToPath(new URL("./rebuild-firmware.mjs", import.meta.url)),
    "--version", version,
    "--source", sourceDir,
    "--decompiled", decompiledDir,
    "--out", outZip,
    "--report", reportPath,
  ];
  const result = spawnSync(process.execPath, [
    ...args,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) throw new Error(`rebuild failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`rebuild failed with exit code ${result.status}`);
}

function validateHost(host) {
  if (!/^[0-9A-Za-z.-]+$/.test(host)) throw new Error(`Host contains unsupported characters: ${host}`);
  const maxLength = DEFAULTS.originalHost.length;
  if (Buffer.byteLength(host, "ascii") > maxLength) {
    throw new Error(`Host is too long for same-size patch: ${host.length} > ${maxLength}`);
  }
}

function validateTimeout(value) {
  if (!Number.isInteger(value) || value < 1000 || value > 0xffffffff) {
    throw new Error(`Invalid timeout milliseconds: ${value}`);
  }
}

function assertDirectory(dir, label) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`Missing ${label}: ${dir}`);
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const [key, inlineValue] = arg.slice(2).split("=");
    args[toCamel(key)] = inlineValue ?? argv[index + 1];
    if (inlineValue === undefined) index += 1;
  }
  return args;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function relative(filePath) {
  return path.relative(process.cwd(), filePath) || ".";
}

main();
