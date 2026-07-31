import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { sha256File } from "./usb-handoff-lib.mjs";

export const HOST_PREP_ROOT_NAME = "Project-A-Migration-Phase-2-Host-Prep";
export const HOST_PREP_PHASE_ID = "debian-host-prep-v1";
export const HOST_PREP_MANIFEST_PATH = "CHECKSUMS/PHASE-2-HOST-PREP.sha256";
export const HOST_PREP_INBOUND_FILES = Object.freeze([
  "ISOLATION-BOUNDARY.txt",
  "PHASE-2-INPUT.json",
  "README-FIRST.txt",
  "TO-DEBIAN/apply-host-prep.sh",
  "TO-DEBIAN/collect-host-prep-evidence.sh",
  "TO-DEBIAN/preflight-host-prep.sh"
]);
export const NODE_PROVENANCE = Object.freeze({
  version: "v24.18.0",
  archiveFileName: "node-v24.18.0-linux-x64.tar.xz",
  archiveUrl: "https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz",
  archiveSha256: "55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742",
  releaseKeysCommit: "b28073028e6d6855cfb53bf7fa0137599c01f967"
});

const REPORT_FILE_NAME = /^debian-readiness-\d{8}T\d{6}Z-[A-Za-z0-9._-]+\.txt$/;
const SHA256 = /^[a-f0-9]{64}$/;
const INPUT_KEYS = ["schemaVersion", "phaseId", "phase1", "node"];
const PHASE1_KEYS = ["bundleName", "reportFileName", "reportSha256", "outboundManifestSha256"];
const NODE_KEYS = ["version", "archiveFileName", "archiveUrl", "archiveSha256", "releaseKeysCommit"];

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
}

function assertExactKeys(value, expectedKeys, label) {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (actualKeys.length !== sortedExpectedKeys.length || actualKeys.some((key, index) => key !== sortedExpectedKeys[index])) {
    throw new Error(`Unexpected phase 2 input field in ${label}`);
  }
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 hash`);
  }
}

function snapshotEntryPath(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative.split(path.sep).join("/");
}

function fileIdentity(metadata) {
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs
  };
}

function sameFileIdentity(before, after) {
  return Object.keys(before).every((key) => before[key] === after[key]);
}

function snapshotPathSort(left, right) {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

function assertAllowedTreeEntry(metadata, candidatePath) {
  if (metadata.isSymbolicLink()) {
    throw new Error(`Symbolic link or junction is not allowed in Phase 1: ${candidatePath}`);
  }
  if (!metadata.isDirectory() && !metadata.isFile()) {
    throw new Error(`Unsupported Phase 1 filesystem entry: ${candidatePath}`);
  }
}

function directoryChangedError() {
  return new Error("Phase 1 directory changed while snapshotting.");
}

async function assertDirectoryIdentity(directoryPath, expectedIdentity) {
  let metadata;
  try {
    metadata = await lstat(directoryPath);
  } catch {
    throw directoryChangedError();
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || !sameFileIdentity(expectedIdentity, fileIdentity(metadata))) {
    throw directoryChangedError();
  }
}

function canonicalSnapshot(snapshot) {
  if (!Array.isArray(snapshot)) throw new Error("Phase 1 snapshot is invalid.");
  const paths = new Set();
  const entries = snapshot.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Phase 1 snapshot is invalid.");
    }
    const { path: entryPath, type, size, sha256 } = entry;
    if (typeof entryPath !== "string" || !entryPath || entryPath.includes("\\") || path.posix.isAbsolute(entryPath)) {
      throw new Error("Phase 1 snapshot is invalid.");
    }
    if (paths.has(entryPath)) throw new Error("Phase 1 snapshot is invalid.");
    paths.add(entryPath);
    if (type === "directory" && size === 0 && sha256 === null) {
      return { path: entryPath, type, size, sha256 };
    }
    if (type === "file" && Number.isSafeInteger(size) && size >= 0 && typeof sha256 === "string" && SHA256.test(sha256)) {
      return { path: entryPath, type, size, sha256 };
    }
    throw new Error("Phase 1 snapshot is invalid.");
  });
  return entries;
}

export function createPhase2Input({
  reportFileName,
  reportSha256,
  phase1ManifestSha256
}) {
  return {
    schemaVersion: 1,
    phaseId: HOST_PREP_PHASE_ID,
    phase1: {
      bundleName: "Project-A-Migration",
      reportFileName,
      reportSha256,
      outboundManifestSha256: phase1ManifestSha256
    },
    node: { ...NODE_PROVENANCE }
  };
}

export function validatePhase2Input(value) {
  assertPlainObject(value, "Phase 2 input");
  assertExactKeys(value, INPUT_KEYS, "Phase 2 input");
  if (value.schemaVersion !== 1) throw new Error("Phase 2 input schema version is invalid");
  if (value.phaseId !== HOST_PREP_PHASE_ID) throw new Error("Phase 2 input phase ID is invalid");

  assertPlainObject(value.phase1, "Phase 2 input phase1");
  assertExactKeys(value.phase1, PHASE1_KEYS, "Phase 2 input phase1");
  if (value.phase1.bundleName !== "Project-A-Migration") throw new Error("Phase 1 bundle name is invalid");
  if (typeof value.phase1.reportFileName !== "string" || !REPORT_FILE_NAME.test(value.phase1.reportFileName)) {
    throw new Error("Phase 1 report file name is invalid");
  }
  assertSha256(value.phase1.reportSha256, "Phase 1 report SHA-256");
  assertSha256(value.phase1.outboundManifestSha256, "Phase 1 outbound manifest SHA-256");

  assertPlainObject(value.node, "Phase 2 input node");
  assertExactKeys(value.node, NODE_KEYS, "Phase 2 input node");
  for (const key of NODE_KEYS) {
    if (value.node[key] !== NODE_PROVENANCE[key]) {
      throw new Error(`Phase 2 Node provenance ${key} is invalid`);
    }
  }

  return {
    schemaVersion: 1,
    phaseId: HOST_PREP_PHASE_ID,
    phase1: {
      bundleName: "Project-A-Migration",
      reportFileName: value.phase1.reportFileName,
      reportSha256: value.phase1.reportSha256,
      outboundManifestSha256: value.phase1.outboundManifestSha256
    },
    node: { ...NODE_PROVENANCE }
  };
}

export async function snapshotRegularTree(rootPath) {
  if (typeof rootPath !== "string" || !path.isAbsolute(rootPath)) {
    throw new Error("Phase 1 snapshot root must be an absolute path");
  }

  const root = path.resolve(rootPath);
  const rootMetadata = await lstat(root);
  assertAllowedTreeEntry(rootMetadata, root);
  if (!rootMetadata.isDirectory()) throw new Error("Phase 1 snapshot root must be a directory");

  const entries = [];
  async function walk(directoryPath, approvedIdentity) {
    await assertDirectoryIdentity(directoryPath, approvedIdentity);
    let children;
    try {
      children = await readdir(directoryPath);
    } catch {
      throw directoryChangedError();
    }
    await assertDirectoryIdentity(directoryPath, approvedIdentity);
    children.sort();
    for (const name of children) {
      await assertDirectoryIdentity(directoryPath, approvedIdentity);
      const candidatePath = path.join(directoryPath, name);
      const metadata = await lstat(candidatePath);
      assertAllowedTreeEntry(metadata, candidatePath);
      const relativePath = snapshotEntryPath(root, candidatePath);
      if (metadata.isDirectory()) {
        entries.push({ path: relativePath, type: "directory", size: 0, sha256: null });
        const childIdentity = fileIdentity(metadata);
        await walk(candidatePath, childIdentity);
        await assertDirectoryIdentity(candidatePath, childIdentity);
        continue;
      }

      const identityBeforeHash = fileIdentity(metadata);
      const sha256 = await sha256File(candidatePath);
      const metadataAfterHash = await lstat(candidatePath);
      assertAllowedTreeEntry(metadataAfterHash, candidatePath);
      if (!metadataAfterHash.isFile() || !sameFileIdentity(identityBeforeHash, fileIdentity(metadataAfterHash))) {
        throw new Error(`Phase 1 file identity changed while snapshotting: ${candidatePath}`);
      }
      entries.push({ path: relativePath, type: "file", size: metadata.size, sha256 });
    }
    await assertDirectoryIdentity(directoryPath, approvedIdentity);
  }

  await walk(root, fileIdentity(rootMetadata));
  return entries.sort(snapshotPathSort);
}

export function assertTreeSnapshotEqual(before, after) {
  if (JSON.stringify(canonicalSnapshot(before)) !== JSON.stringify(canonicalSnapshot(after))) {
    throw new Error("Phase 1 changed while building the host-prep bundle.");
  }
}

export async function manifestFingerprint(manifestPath) {
  return sha256File(manifestPath);
}
