#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULTS = {
  version: "1.6.0",
  sourceDir: "firmware/analysis/1.6.0",
  decompiledDir: "firmware/decompiled/1.6.0",
  originalZip: "firmware/1.6.0.zip",
  outDir: "firmware/rebuilt",
};

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = path.resolve(args.root || process.cwd());
  const version = String(args.version || DEFAULTS.version);
  const sourceDir = path.resolve(rootDir, args.source || DEFAULTS.sourceDir);
  const decompiledDir = path.resolve(rootDir, args.decompiled || DEFAULTS.decompiledDir);
  const originalZip = path.resolve(rootDir, args.originalZip || DEFAULTS.originalZip);
  const outDir = path.resolve(rootDir, args.outDir || DEFAULTS.outDir);
  const outZip = path.resolve(rootDir, args.out || path.join(outDir, `${version}.zip`));
  const reportPath = path.resolve(rootDir, args.report || path.join(outDir, `${version}.rebuild-report.json`));
  const flat = Boolean(args.flat);

  assertDirectory(sourceDir, "source update directory");
  assertDirectory(decompiledDir, "decompiled firmware directory");
  fs.mkdirSync(path.dirname(outZip), { recursive: true });

  const imageInfoPath = path.join(decompiledDir, "image-info.json");
  const imageInfo = readJson(imageInfoPath);
  const originalImagePath = path.resolve(rootDir, imageInfo.source || path.join(sourceDir, "-8114815", "pocket.bin"));
  const rebuiltImage = rebuildEspImage(decompiledDir, imageInfo, originalImagePath);
  const imageTargetRelative = path.relative(sourceDir, originalImagePath);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aibi-firmware-rebuild-"));
  try {
    const stageRoot = flat ? tempDir : path.join(tempDir, version);
    fs.cpSync(sourceDir, stageRoot, { recursive: true, preserveTimestamps: true });
    fs.mkdirSync(path.dirname(path.join(stageRoot, imageTargetRelative)), { recursive: true });
    fs.writeFileSync(path.join(stageRoot, imageTargetRelative), rebuiltImage.buffer);

    if (fs.existsSync(outZip)) fs.unlinkSync(outZip);
    if (flat) {
      zipDirectory(stageRoot, fs.readdirSync(stageRoot).sort(), outZip);
    } else {
      zipDirectory(tempDir, [version], outZip);
    }

    const report = buildReport({
      version,
      sourceDir,
      decompiledDir,
      originalZip,
      outZip,
      originalImagePath,
      rebuiltImage,
      stageRoot,
    });
    writeJson(reportPath, report);
    printReport(report, reportPath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function rebuildEspImage(decompiledDir, imageInfo, originalImagePath) {
  const header = getImageHeader(imageInfo, originalImagePath);
  const parts = [header];
  const dataParts = [];

  for (const segment of imageInfo.segments || []) {
    const data = fs.readFileSync(resolveSegmentPath(decompiledDir, segment));
    const segmentHeader = Buffer.alloc(8);
    segmentHeader.writeUInt32LE(Number(segment.loadAddress), 0);
    segmentHeader.writeUInt32LE(data.length, 4);
    parts.push(segmentHeader, data);
    dataParts.push(data);
  }

  let body = Buffer.concat(parts);
  while (body.length % 16 !== 15) {
    body = Buffer.concat([body, Buffer.from([0])]);
  }

  const checksum = calculateEspChecksum(dataParts);
  body = Buffer.concat([body, Buffer.from([checksum])]);
  const appendSha256 = imageInfo.appendedSha256 !== null;
  const buffer = appendSha256
    ? Buffer.concat([body, crypto.createHash("sha256").update(body).digest()])
    : body;

  return {
    buffer,
    checksum,
    sha256: hashBuffer(buffer, "sha256"),
    md5: hashBuffer(buffer, "md5"),
  };
}

function getImageHeader(imageInfo, originalImagePath) {
  if (imageInfo.imageHeaderHex) return Buffer.from(imageInfo.imageHeaderHex, "hex");
  if (fs.existsSync(originalImagePath)) return fs.readFileSync(originalImagePath).subarray(0, 24);

  const header = Buffer.alloc(24);
  header[0] = 0xe9;
  header[1] = Number(imageInfo.segmentCount);
  header[2] = Number(imageInfo.spiMode);
  header[3] = Number(imageInfo.spiSpeedSize);
  header.writeUInt32LE(Number(imageInfo.entryAddress), 4);
  return header;
}

function resolveSegmentPath(decompiledDir, segment) {
  const hexAddress = Number(segment.loadAddress).toString(16).padStart(8, "0");
  const baseNames = [
    `${String(segment.kind).toLowerCase()}_0x${hexAddress}.bin`,
    `${String(segment.kind).toLowerCase()}_${hexAddress}.bin`,
  ];
  for (const baseName of baseNames) {
    const candidate = path.join(decompiledDir, "segments", baseName);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Missing segment ${segment.kind} 0x${hexAddress}`);
}

function calculateEspChecksum(dataParts) {
  let checksum = 0xef;
  for (const data of dataParts) {
    for (const byte of data) checksum ^= byte;
  }
  return checksum;
}

function zipDirectory(cwd, entries, outZip) {
  const result = spawnSync("zip", ["-q", "-r", outZip, ...entries], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 16,
  });
  if (result.error) throw new Error(`zip failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`zip failed (${result.status}): ${result.stderr || result.stdout}`);
  }
}

function buildReport({ version, sourceDir, decompiledDir, originalZip, outZip, originalImagePath, rebuiltImage, stageRoot }) {
  const originalImage = fs.existsSync(originalImagePath) ? fs.readFileSync(originalImagePath) : null;
  const originalZipExists = fs.existsSync(originalZip);
  const rebuiltZip = fs.readFileSync(outZip);
  const manifest = buildManifest(stageRoot);
  const packageMd5 = hashBuffer(rebuiltZip, "md5");
  const packageSha256 = hashBuffer(rebuiltZip, "sha256");

  return {
    rebuiltAt: new Date().toISOString(),
    version,
    inputs: {
      sourceDir: relative(sourceDir),
      decompiledDir: relative(decompiledDir),
      originalZip: originalZipExists ? relative(originalZip) : null,
      originalImage: fs.existsSync(originalImagePath) ? relative(originalImagePath) : null,
    },
    outputs: {
      zip: relative(outZip),
      md5: packageMd5,
      sha256: packageSha256,
      size: rebuiltZip.length,
    },
    originalZip: originalZipExists ? {
      md5: hashFile(originalZip, "md5"),
      sha256: hashFile(originalZip, "sha256"),
      size: fs.statSync(originalZip).size,
      byteExact: Buffer.compare(rebuiltZip, fs.readFileSync(originalZip)) === 0,
    } : null,
    appImage: {
      pathInPackage: path.relative(sourceDir, originalImagePath),
      md5: rebuiltImage.md5,
      sha256: rebuiltImage.sha256,
      size: rebuiltImage.buffer.length,
      checksum: `0x${rebuiltImage.checksum.toString(16).padStart(2, "0")}`,
      byteExact: originalImage ? Buffer.compare(rebuiltImage.buffer, originalImage) === 0 : null,
      originalMd5: originalImage ? hashBuffer(originalImage, "md5") : null,
      originalSha256: originalImage ? hashBuffer(originalImage, "sha256") : null,
    },
    manifest,
  };
}

function buildManifest(root) {
  return listFiles(root).map((filePath) => {
    const buffer = fs.readFileSync(filePath);
    return {
      path: path.relative(root, filePath).replaceAll(path.sep, "/"),
      size: buffer.length,
      crc32: crc32Hex(buffer),
      md5: hashBuffer(buffer, "md5"),
      sha256: hashBuffer(buffer, "sha256"),
    };
  });
}

function listFiles(root) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(filePath));
    if (entry.isFile()) files.push(filePath);
  }
  return files.sort((a, b) => a.localeCompare(b));
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32Hex(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

function assertDirectory(dir, label) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`Missing ${label}: ${dir}`);
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function hashFile(filePath, algorithm) {
  return hashBuffer(fs.readFileSync(filePath), algorithm);
}

function hashBuffer(buffer, algorithm) {
  return crypto.createHash(algorithm).update(buffer).digest("hex");
}

function printReport(report, reportPath) {
  console.log(`Rebuilt update: ${report.outputs.zip}`);
  console.log(`Package MD5: ${report.outputs.md5}`);
  if (report.originalZip) {
    console.log(`Original package MD5: ${report.originalZip.md5}`);
    console.log(`Package byte exact: ${report.originalZip.byteExact}`);
  }
  console.log(`App image byte exact: ${report.appImage.byteExact}`);
  console.log(`Manifest files: ${report.manifest.length}`);
  console.log(`Report: ${relative(reportPath)}`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const [key, inlineValue] = arg.slice(2).split("=");
    if (inlineValue !== undefined) {
      args[toCamel(key)] = inlineValue;
    } else if (argv[index + 1] && !argv[index + 1].startsWith("--")) {
      args[toCamel(key)] = argv[index + 1];
      index += 1;
    } else {
      args[toCamel(key)] = true;
    }
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
