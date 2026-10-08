#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const DEFAULTS = {
  apiHost: "api.aibipocket.com",
  capturedIdentityFile: "aibi-identity.json",
  outDir: "firmware",
  identityFile: "firmware-identity.json",
  type: "1",
  versionNum: "8",
  currentName: "1.5.0",
  language: "en",
  deviceId: "",
  signKey: "4F82eb2fa3H05a61",
  signSuffix: "0ab33c",
  directVersions: [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
};

const OTA_ENDPOINTS_FROM_FIRMWARE = [
  "GET /aibi/ota/version HTTP/1.1",
  "GET /aibi/ota/version?type=%d&version_num=%d&current_name=%s HTTP/1.1",
  "GET /aibi/ota/res/%d?current_name=%s HTTP/1.1",
  "GET /aibi/ota/allres/%d?current_name=%s HTTP/1.1",
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = path.resolve(args.root || process.cwd());
  const outDir = path.resolve(rootDir, args.out || DEFAULTS.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const explicitDeviceId = args.deviceId || process.env.AIBI_DEVICE_ID || "";

  const options = {
    rootDir,
    outDir,
    type: String(args.type || DEFAULTS.type),
    versionNum: String(args.versionNum || args.version || DEFAULTS.versionNum),
    currentName: String(args.currentName || args.name || DEFAULTS.currentName),
    language: String(args.language || DEFAULTS.language),
    deviceId: String(explicitDeviceId || readOrCreateCachedDeviceId(outDir)),
    signKey: String(args.signKey || process.env.AIBI_SIGN_KEY || DEFAULTS.signKey),
    signSuffix: String(args.signSuffix || process.env.AIBI_SIGN_SUFFIX || DEFAULTS.signSuffix),
    force: Boolean(args.force),
    noAuth: Boolean(args.noAuth),
  };

  const report = {
    checkedAt: new Date().toISOString(),
    firmwareEndpointsFromImage: OTA_ENDPOINTS_FROM_FIRMWARE,
    baseline: {
      type: options.type,
      versionNum: options.versionNum,
      currentName: options.currentName,
      deviceId: options.deviceId,
    },
    scanned: [],
    probes: [],
    update: null,
    downloaded: null,
  };

  const scannedCandidates = [
    ...readCliMetadata(args),
    ...readMetadataFiles(outDir),
  ];
  report.scanned = uniqueBy(scannedCandidates.filter(Boolean), (metadata) => metadata.url).map(summarizeMetadata);

  let probeCandidates = [];
  if (!args.offline) {
    const auth = options.noAuth ? {} : await getAibiAuthHeaders(options);
    const probes = await probeFirmwareEndpoints({ ...options, auth });
    report.probes = probes.map(summarizeProbe);
    probeCandidates = probes.map((probe) => probe.metadata).filter(Boolean);
  }

  report.update = findLatestMetadata([...scannedCandidates, ...probeCandidates]);

  if (report.update?.url) {
    report.downloaded = await downloadFirmware({
      metadata: report.update,
      outDir,
      force: options.force,
    });
  }

  const reportPath = path.join(outDir, "latest-firmware.json");
  writeJson(reportPath, report);
  printReport(report, reportPath);
  if (!report.update) process.exitCode = 2;
}

async function probeFirmwareEndpoints({ type, versionNum, currentName, language, auth, noAuth }) {
  const headers = noAuth ? {} : normalizeRequestHeaders(auth, { versionNum, currentName });
  const targets = buildProbeTargets({ type, versionNum, currentName });
  const results = [];

  for (const target of targets) {
    const url = `https://${DEFAULTS.apiHost}${target}`;
    const response = await fetchJson(url, headers);
    results.push({ url, target, ...response, metadata: findLatestMetadata(extractMetadataCandidates(response.json)) });
  }

  // Some firmware builds also ask for language-specific voice/resources around startup.
  const powerOnUrl = `https://${DEFAULTS.apiHost}/aibi/poweron/voice?lang=${encodeURIComponent(language)}`;
  const powerOn = await fetchJson(powerOnUrl, headers);
  results.push({ url: powerOnUrl, target: "/aibi/poweron/voice", ...powerOn, metadata: findLatestMetadata(extractMetadataCandidates(powerOn.json)) });

  return results;
}

async function getAibiAuthHeaders(options) {
  const identity = readLatestAibiIdentity(options.outDir);
  const deviceId = options.deviceId;
  const versionNum = options.versionNum || identity.versionNum;
  const currentName = options.currentName || identity.currentName;
  const userAgent = identity.userAgent || `AIBI/${versionNum} LIVING/${currentName}`;

  if (!deviceId) {
    throw new Error("Could not create local firmware identity.");
  }

  const time = await fetchServerTime();
  const tokenSecret = signAibiSecret({ time, key: options.signKey, suffix: options.signSuffix });
  const tokenUrl = `https://${DEFAULTS.apiHost}/token/${encodeURIComponent(deviceId)}?version=${encodeURIComponent(versionNum)}&name=${encodeURIComponent(currentName)}`;
  const tokenResponse = await fetchJson(tokenUrl, { secret: tokenSecret, "user-agent": userAgent });
  const accessToken = tokenResponse.json?.access_token;
  const tokenType = tokenResponse.json?.type || "Bearer";
  if (!accessToken) {
    const message = tokenResponse.json?.errmsg || tokenResponse.error || tokenResponse.text || "token request failed";
    throw new Error(`Could not refresh AIBI token: ${message}`);
  }

  return {
    authorization: `${tokenType} ${accessToken}`,
    secret: signAibiSecret({ time: await fetchServerTime(), key: options.signKey, suffix: options.signSuffix }),
    "user-agent": userAgent,
  };
}

function readOrCreateCachedDeviceId(outDir) {
  const filePath = path.join(outDir, DEFAULTS.identityFile);
  const existing = readJsonIfExists(filePath);
  if (isDeviceId(existing?.deviceId)) return existing.deviceId;

  const identity = {
    deviceId: crypto.randomBytes(6).toString("hex"),
    createdAt: new Date().toISOString(),
  };
  writeJson(filePath, identity);
  return identity.deviceId;
}

function isDeviceId(value) {
  return /^[0-9a-f]{12}$/i.test(String(value || ""));
}

async function fetchServerTime() {
  const response = await fetchJson(`https://${DEFAULTS.apiHost}/time`, {});
  const time = Number(response.json?.time);
  if (!Number.isInteger(time)) {
    const message = response.json?.errmsg || response.error || response.text || "time request failed";
    throw new Error(`Could not fetch server time: ${message}`);
  }
  return time;
}

function signAibiSecret({ time, key, suffix }) {
  const plaintext = Buffer.from(`${time}${suffix}`, "utf8");
  if (plaintext.length !== 16) {
    throw new Error(`Invalid signing plaintext length: ${plaintext.length}`);
  }
  const keyBytes = Buffer.from(key, "utf8");
  if (keyBytes.length !== 16) {
    throw new Error(`Invalid signing key length: ${keyBytes.length}`);
  }
  const cipher = crypto.createCipheriv("aes-128-ecb", keyBytes, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]).toString("base64url");
}

function buildProbeTargets({ type, versionNum, currentName }) {
  const versions = unique([
    Number(versionNum),
    ...DEFAULTS.directVersions,
  ]).filter((value) => Number.isInteger(value) && value > 0);

  const targets = [
    "/aibi/ota/version",
    `/aibi/ota/version?type=${encodeURIComponent(type)}&version_num=${encodeURIComponent(versionNum)}&current_name=${encodeURIComponent(currentName)}`,
    `/aibi/ota/res/${encodeURIComponent(versionNum)}?current_name=${encodeURIComponent(currentName)}`,
    `/aibi/ota/allres/${encodeURIComponent(versionNum)}?current_name=${encodeURIComponent(currentName)}`,
  ];

  for (const version of versions) {
    targets.push(`/aibi/ota/version?type=${encodeURIComponent(type)}&version_num=${version}&current_name=${encodeURIComponent(currentName)}`);
    targets.push(`/aibi/ota/res/${version}?current_name=${encodeURIComponent(currentName)}`);
  }

  return unique(targets);
}

async function fetchJson(url, headers) {
  try {
    const response = await fetch(url, { headers });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Keep raw text in the report.
    }
    return { status: response.status, ok: response.ok, json, text };
  } catch (error) {
    return { status: 0, ok: false, json: null, text: "", error: error.message };
  }
}

function readMetadataFiles(outDir) {
  const candidates = [];
  for (const fileName of ["ota-metadata.json"]) {
    const filePath = path.join(outDir, fileName);
    if (!fs.existsSync(filePath)) continue;
    const json = readJson(filePath);
    candidates.push(...extractMetadataCandidates(json));
  }
  return candidates;
}

function readCliMetadata(args) {
  const candidates = [];
  if (args.url) {
    candidates.push(normalizeFirmwareMetadata({
      versionName: inferVersionName(args.url),
      md5: args.md5 || "",
      updates: { firmware: args.url },
    }));
  }
  if (args.metadataFile) {
    candidates.push(...extractMetadataCandidates(readJson(path.resolve(args.metadataFile))));
  }
  if (args.metadataJson) {
    candidates.push(...extractMetadataCandidates(parseJson(args.metadataJson)));
  }
  return candidates.filter(Boolean);
}

function extractMetadataCandidates(value, candidates = []) {
  if (!value) return candidates;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      extractMetadataCandidates(parseJson(trimmed), candidates);
    } else if (looksLikeFirmwareUrl(trimmed)) {
      candidates.push(normalizeFirmwareMetadata({ updates: { firmware: trimmed } }));
    }
    return candidates.filter(Boolean);
  }
  if (Array.isArray(value)) {
    for (const item of value) extractMetadataCandidates(item, candidates);
    return candidates.filter(Boolean);
  }
  if (typeof value !== "object") return candidates;

  const metadata = normalizeFirmwareMetadata(value);
  if (metadata) candidates.push(metadata);

  if (value.body?.kind === "text" && value.body.text) extractMetadataCandidates(value.body.text, candidates);
  for (const item of Object.values(value)) {
    if (item && typeof item === "object") extractMetadataCandidates(item, candidates);
  }
  return candidates.filter(Boolean);
}

function normalizeFirmwareMetadata(json) {
  if (!json || typeof json !== "object") return null;
  const updates = json.updates && typeof json.updates === "object" ? json.updates : null;
  const firmware = updates?.firmware || updates?.url || json.firmware || json.url || "";
  const host = updates?.host || json.host || "";
  if (!firmware) return null;
  if (!updates && !hasFirmwareExtension(firmware)) return null;

  const url = buildFirmwareUrl({ host, firmware });
  if (!url || !looksLikeFirmwareUrl(url)) return null;

  return {
    versionNum: String(json["version-num"] || json.version_num || json.versionNum || ""),
    versionName: String(json["version-name"] || json.version_name || json.versionName || inferVersionName(url) || ""),
    responseTag: json.responsetag || json.responseTag || "",
    host,
    firmware,
    md5: updates?.md5 || json.md5 || "",
    url,
    source: json.source || "",
    raw: json.raw || json,
  };
}

function buildFirmwareUrl({ host, firmware }) {
  if (/^https?:\/\//i.test(firmware)) return firmware;
  if (!host) return "";
  return `https://${host}${firmware.startsWith("/") ? "" : "/"}${firmware}`;
}

function findLatestMetadata(candidates) {
  const valid = uniqueBy(candidates.filter((candidate) => candidate?.url), (candidate) => candidate.url);
  valid.sort((a, b) => compareVersions(b.versionName || inferVersionName(b.url), a.versionName || inferVersionName(a.url)));
  return valid[0] || null;
}

async function downloadFirmware({ metadata, outDir, force }) {
  const url = new URL(metadata.url);
  const filePath = path.join(outDir, safeFirmwareFilename(metadata, url));

  if (fs.existsSync(filePath) && !force) {
    const md5 = md5File(filePath);
    return {
      skipped: true,
      reason: "already_exists",
      filePath,
      bytes: fs.statSync(filePath).size,
      md5,
      md5Ok: metadata.md5 ? md5.toLowerCase() === metadata.md5.toLowerCase() : null,
    };
  }

  const response = await fetch(metadata.url);
  if (!response.ok) throw new Error(`Firmware download failed: HTTP ${response.status}`);

  const tempPath = `${filePath}.part`;
  const hash = crypto.createHash("md5");
  let bytes = 0;
  const hashStream = new TransformHash({ hash, onBytes: (count) => { bytes += count; } });
  await pipeline(Readable.fromWeb(response.body), hashStream, fs.createWriteStream(tempPath));
  fs.renameSync(tempPath, filePath);

  const md5 = hash.digest("hex");
  return {
    skipped: false,
    filePath,
    bytes,
    contentType: response.headers.get("content-type") || "",
    etag: response.headers.get("etag") || "",
    lastModified: response.headers.get("last-modified") || "",
    md5,
    md5Ok: metadata.md5 ? md5.toLowerCase() === metadata.md5.toLowerCase() : null,
  };
}

class TransformHash extends Transform {
  constructor({ hash, onBytes }) {
    super();
    this.hash = hash;
    this.onBytes = onBytes;
  }

  _transform(chunk, _encoding, callback) {
    this.hash.update(chunk);
    this.onBytes(chunk.length);
    callback(null, chunk);
  }
}

function normalizeRequestHeaders(headers, { versionNum, currentName }) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (value === undefined || value === null || value === "") continue;
    const lower = key.toLowerCase();
    if (["authorization", "secret", "user-agent"].includes(lower)) normalized[lower] = String(value);
  }
  if (!normalized["user-agent"]) normalized["user-agent"] = `AIBI/${versionNum} LIVING/${currentName}`;
  normalized["content-type"] = "application/x-www-form-urlencoded";
  return normalized;
}

function readLatestAibiIdentity(outDir) {
  const fallback = {
    deviceId: "",
    versionNum: DEFAULTS.versionNum,
    currentName: DEFAULTS.currentName,
    userAgent: "",
  };
  const saved = readJsonIfExists(path.join(outDir, DEFAULTS.capturedIdentityFile));
  if (!saved?.deviceId) return fallback;
  return {
    deviceId: String(saved.deviceId),
    versionNum: String(saved.versionNum || fallback.versionNum),
    currentName: String(saved.currentName || fallback.currentName),
    userAgent: String(saved.userAgent || ""),
  };
}

function summarizeProbe(probe) {
  return {
    url: probe.url,
    status: probe.status,
    ok: probe.ok,
    error: probe.error || "",
    json: probe.json,
    text: probe.text?.slice(0, 500) || "",
    metadata: probe.metadata ? summarizeMetadata(probe.metadata) : null,
  };
}

function summarizeMetadata(metadata) {
  return {
    versionNum: metadata.versionNum,
    versionName: metadata.versionName,
    responseTag: metadata.responseTag,
    md5: metadata.md5,
    url: metadata.url,
    source: metadata.source,
  };
}

function safeFirmwareFilename(metadata, url) {
  const base = path.basename(url.pathname) || "firmware.zip";
  const version = metadata.versionName || metadata.versionNum || inferVersionName(url.href) || "latest";
  if (base === `${version}.zip`) return base.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${version}-${base}`.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

function looksLikeFirmwareUrl(value) {
  return /^https?:\/\//i.test(value)
    ? hasFirmwareExtension(value)
    : /(?:^|\/)(?:ota|firmware|fw|update|version|[^/]+\.(?:bin|zip|img))(?:[/?#]|$)/i.test(value);
}

function hasFirmwareExtension(value) {
  return /\.(?:bin|zip|img)(?:[?#]|$)/i.test(String(value));
}

function inferVersionName(value) {
  return String(value).match(/(?:^|\/)(\d+\.\d+\.\d+)(?:\/|\.zip|$)/)?.[1] || "";
}

function compareVersions(a, b) {
  const left = String(a || "").split(".").map((part) => Number(part) || 0);
  const right = String(b || "").split(".").map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function md5File(filePath) {
  return crypto.createHash("md5").update(fs.readFileSync(filePath)).digest("hex");
}

function readJson(filePath) {
  return parseJson(fs.readFileSync(filePath, "utf8"));
}

function readJsonIfExists(filePath) {
  return fs.existsSync(filePath) ? readJson(filePath) : null;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function unique(values) {
  return [...new Set(values)];
}

function uniqueBy(values, keyFn) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = keyFn(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
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

function printReport(report, reportPath) {
  console.log(`Report: ${reportPath}`);
  if (!report.update) {
    console.log("No firmware metadata found.");
    const authErrors = report.probes
      .map((probe) => probe.json?.errmsg || probe.error || "")
      .filter(Boolean);
    if (authErrors.length) console.log(`Last server error: ${authErrors[authErrors.length - 1]}`);
    return;
  }
  console.log(`Version: ${report.update.versionName || report.update.versionNum || "(unknown)"}`);
  console.log(`URL: ${report.update.url}`);
  console.log(`Expected MD5: ${report.update.md5 || "(none)"}`);
  if (report.downloaded) {
    console.log(`File: ${report.downloaded.filePath}`);
    console.log(`Bytes: ${report.downloaded.bytes}`);
    console.log(`Actual MD5: ${report.downloaded.md5}`);
    console.log(`MD5 OK: ${report.downloaded.md5Ok}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
