import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

export const APPLIANCE_SCHEMA_VERSION = 1;
export const APPLIANCE_REQUIRED_FILES = Object.freeze([
  "ARTIFACTS.sha256",
  "BUILD-MANIFEST.json",
  "IMPORT-ON-PROXMOX.sh",
  "README-FIRST.txt",
  "STAGE-SUCCESS.json",
  "STAGE-SUCCESS.sha256",
  "VERIFY-LOCAL.json",
  "age-recipient.txt"
]);

const RELEASE_SHA = /^[a-f0-9]{40}$/;
const DISK_SHA = /^[a-f0-9]{64}$/;
const IMAGE_SHA = /^[a-f0-9]{128}$/;
const AGE_RECIPIENT = /^age1[ac-hj-np-z02-9]{58}\r?\n$/;
const BUILD_ID = /^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/;
const CHECKSUM_LINE = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/;
const DEBIAN_IMAGE_URL = "https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2";
const STAGE_RECEIPT_FIELDS = Object.freeze([
  "app",
  "classification",
  "cloudflared",
  "completedAt",
  "nodeVersion",
  "phaseId",
  "releaseSha",
  "routeCount",
  "schemaVersion"
]);
const BUILD_MANIFEST_FIELDS = Object.freeze([
  "buildId",
  "classification",
  "completedAt",
  "debianImage",
  "diskActualSize",
  "diskFile",
  "diskSha256",
  "diskVirtualSize",
  "nodeVersion",
  "releaseSha",
  "schemaVersion"
]);
const DEBIAN_IMAGE_FIELDS = Object.freeze(["bytes", "retrievedAt", "sha512", "url"]);

function hasExactFields(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...fields].sort());
}

function isUtcTimestamp(value) {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

export function artifactDiskName(releaseSha) {
  if (!RELEASE_SHA.test(releaseSha)) throw new Error("Expected a 40-character release SHA.");
  return `palziv-debian13-${releaseSha}.qcow2`;
}

export function validateBuildManifest(manifest) {
  if (!hasExactFields(manifest, BUILD_MANIFEST_FIELDS) ||
      manifest.schemaVersion !== APPLIANCE_SCHEMA_VERSION ||
      !BUILD_ID.test(manifest.buildId ?? "") ||
      !hasExactFields(manifest.debianImage, DEBIAN_IMAGE_FIELDS) ||
      manifest.debianImage.url !== DEBIAN_IMAGE_URL ||
      !IMAGE_SHA.test(manifest.debianImage.sha512 ?? "") ||
      !Number.isSafeInteger(manifest.debianImage.bytes) || manifest.debianImage.bytes < 1 ||
      !isUtcTimestamp(manifest.debianImage.retrievedAt) ||
      !RELEASE_SHA.test(manifest.releaseSha ?? "") ||
      manifest.nodeVersion !== "v24.18.0" ||
      manifest.diskFile !== artifactDiskName(manifest.releaseSha) ||
      !DISK_SHA.test(manifest.diskSha256 ?? "") ||
      manifest.diskVirtualSize !== 42949672960 ||
      !Number.isSafeInteger(manifest.diskActualSize) || manifest.diskActualSize < 1 ||
      !isUtcTimestamp(manifest.completedAt) ||
      manifest.classification !== "pass") {
    throw new Error("Build manifest does not satisfy the appliance contract.");
  }
  return manifest;
}

function validateStageReceipt(receipt, releaseSha) {
  if (!hasExactFields(receipt, STAGE_RECEIPT_FIELDS) ||
      receipt.schemaVersion !== APPLIANCE_SCHEMA_VERSION ||
      receipt.phaseId !== "project-a-two-phase-v1" ||
      receipt.classification !== "staged" ||
      receipt.releaseSha !== releaseSha ||
      receipt.nodeVersion !== "v24.18.0" ||
      receipt.app !== "active" ||
      receipt.cloudflared !== "disabled-inactive" ||
      receipt.routeCount !== 8 ||
      !isUtcTimestamp(receipt.completedAt)) {
    throw new Error("Stage receipt does not satisfy the appliance contract.");
  }
  return receipt;
}

async function requireRegularFile(filePath, label) {
  const metadata = await lstat(filePath);
  if (metadata.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link.`);
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file.`);
  return metadata;
}

async function readJsonFile(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} must contain valid JSON.`, { cause: error });
  }
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function parseChecksumManifest(raw, label) {
  if (!raw.endsWith("\n")) throw new Error(`${label} is not a valid checksum manifest.`);
  const lines = raw.split(/\r?\n/);
  lines.pop();
  if (lines.length === 0 || lines.some((line) => !line)) {
    throw new Error(`${label} is not a valid checksum manifest.`);
  }

  const entries = new Map();
  for (const line of lines) {
    const match = CHECKSUM_LINE.exec(line);
    if (!match || entries.has(match[2])) {
      throw new Error(`${label} is not a valid checksum manifest.`);
    }
    entries.set(match[2], match[1]);
  }
  return entries;
}

async function verifyChecksumManifest(root, manifestName, expectedNames, knownDigests = new Map()) {
  const entries = parseChecksumManifest(await readFile(path.join(root, manifestName), "utf8"), manifestName);
  const actualNames = [...entries.keys()].sort();
  const expected = [...expectedNames].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expected)) {
    throw new Error(`${manifestName} does not cover the exact expected files.`);
  }
  for (const [name, expectedDigest] of entries) {
    const actualDigest = knownDigests.get(name) ?? await hashFile(path.join(root, name));
    if (actualDigest !== expectedDigest) throw new Error(`Checksum mismatch for ${name}.`);
  }
}

async function requireExactArtifactTree(root, diskName) {
  const expected = [...APPLIANCE_REQUIRED_FILES, diskName].sort();
  const actual = (await readdir(root)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Unexpected artifact root tree.");
  }
  for (const name of expected) {
    await requireRegularFile(path.join(root, name), name);
  }
}

export async function verifyApplianceArtifacts({ artifactRoot }) {
  if (typeof artifactRoot !== "string" || !artifactRoot) throw new Error("Artifact root is required.");
  const requestedRoot = path.resolve(artifactRoot);
  const requestedRootStat = await lstat(requestedRoot);
  if (requestedRootStat.isSymbolicLink() || !requestedRootStat.isDirectory()) {
    throw new Error("Artifact root must be a real directory.");
  }
  const root = await realpath(requestedRoot);

  const manifestPath = path.join(root, "BUILD-MANIFEST.json");
  await requireRegularFile(manifestPath, "BUILD-MANIFEST.json");
  const rawManifest = await readJsonFile(manifestPath, "BUILD-MANIFEST.json");
  const manifest = validateBuildManifest(rawManifest);
  await requireExactArtifactTree(root, manifest.diskFile);
  validateStageReceipt(
    await readJsonFile(path.join(root, "STAGE-SUCCESS.json"), "STAGE-SUCCESS.json"),
    manifest.releaseSha
  );
  const recipient = await readFile(path.join(root, "age-recipient.txt"), "utf8");
  if (!AGE_RECIPIENT.test(recipient)) throw new Error("Invalid age recipient.");

  const diskPath = path.join(root, manifest.diskFile);
  const diskMetadata = await requireRegularFile(diskPath, "QCOW2");
  if (diskMetadata.size !== manifest.diskActualSize) {
    throw new Error("QCOW2 actual size does not match BUILD-MANIFEST.json.");
  }
  const diskDigest = await hashFile(diskPath);
  if (diskDigest !== manifest.diskSha256) throw new Error("QCOW2 checksum mismatch.");

  await verifyChecksumManifest(root, "STAGE-SUCCESS.sha256", ["STAGE-SUCCESS.json", "age-recipient.txt"]);
  await verifyChecksumManifest(
    root,
    "ARTIFACTS.sha256",
    [manifest.diskFile, ...APPLIANCE_REQUIRED_FILES.filter((name) => name !== "ARTIFACTS.sha256")],
    new Map([[manifest.diskFile, diskDigest]])
  );

  return {
    ok: true,
    releaseSha: manifest.releaseSha,
    diskFile: manifest.diskFile,
    diskSha256: diskDigest
  };
}
