import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";

export const TWO_PHASE_ROOT_NAME = "Project-A-Migration-Two-Phase";
export const TWO_PHASE_PHASE_ID = "project-a-two-phase-v1";
export const TWO_PHASE_MANIFEST_PATH = "CHECKSUMS/TWO-PHASE.sha256";
export const TWO_PHASE_MODES = Object.freeze([
  "outbound",
  "staged-return",
  "cutover-ready",
  "cutover-return"
]);

const ROOT_CHILDREN = Object.freeze([
  "1-STAGE-DEBIAN.sh",
  "2-CUTOVER-DEBIAN.sh",
  "BUNDLE.json",
  "CHECKSUMS",
  "FINAL-ENCRYPTED",
  "FROM-DEBIAN",
  "PAYLOAD",
  "README-FIRST.txt",
  "ROLLBACK-WINDOWS.ps1"
]);
const MUTABLE_DIRECTORIES = new Set(["FINAL-ENCRYPTED", "FROM-DEBIAN"]);
const SHA256_LINE = /^([a-f0-9]{64})  ([A-Za-z0-9._/-]+)$/;
const FAT32_MAX_FILE_BYTES = 0xffffffff;

function digest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function toPosix(root, candidate) {
  const relative = path.relative(root, candidate).split(path.sep).join("/");
  if (!relative || relative === "." || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
    throw new Error(`Path escapes the two-phase bundle: ${candidate}`);
  }
  return relative;
}

async function requireDirectory(candidate, label) {
  const metadata = await lstat(candidate);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
  return metadata;
}

async function snapshotTree(bundleRoot) {
  const root = path.resolve(bundleRoot);
  await requireDirectory(root, "Two-phase bundle root");
  const entries = [];

  async function walk(directory) {
    const children = await readdir(directory);
    children.sort();
    for (const name of children) {
      const candidate = path.join(directory, name);
      const relative = toPosix(root, candidate);
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Symbolic link or junction is not allowed: ${relative}`);
      }
      if (metadata.isDirectory()) {
        entries.push({ path: relative, type: "directory", size: 0 });
        await walk(candidate);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error(`Unsupported filesystem entry: ${relative}`);
      }
      if (metadata.size > FAT32_MAX_FILE_BYTES) {
        throw new Error(`File exceeds the FAT32 limit: ${relative}`);
      }
      entries.push({ path: relative, type: "file", size: metadata.size });
    }
  }

  await walk(root);
  return entries;
}

function isMutablePath(relativePath) {
  const first = relativePath.split("/", 1)[0];
  return MUTABLE_DIRECTORIES.has(first);
}

async function inboundFiles(bundleRoot) {
  const entries = await snapshotTree(bundleRoot);
  return entries
    .filter((entry) => entry.type === "file")
    .map((entry) => entry.path)
    .filter((entry) => entry !== TWO_PHASE_MANIFEST_PATH && !isMutablePath(entry))
    .sort();
}

async function requireExactRootChildren(bundleRoot) {
  const children = (await readdir(bundleRoot)).sort();
  if (JSON.stringify(children) !== JSON.stringify([...ROOT_CHILDREN].sort())) {
    throw new Error(`Unexpected two-phase root tree: ${children.join(", ")}`);
  }
  for (const directory of ["CHECKSUMS", "PAYLOAD", "FINAL-ENCRYPTED", "FROM-DEBIAN"]) {
    await requireDirectory(path.join(bundleRoot, directory), directory);
  }
  await requireDirectory(path.join(bundleRoot, "PAYLOAD", "release"), "PAYLOAD/release");
}

async function requireEmptyDirectory(directory, label) {
  if ((await readdir(directory)).length !== 0) {
    throw new Error(`${label} must be empty in outbound mode`);
  }
}

async function readBundleMetadata(bundleRoot) {
  const raw = await readFile(path.join(bundleRoot, "BUNDLE.json"), "utf8");
  const parsed = JSON.parse(raw);
  const keys = Object.keys(parsed).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["phaseId", "releaseSha", "schemaVersion"])) {
    throw new Error("BUNDLE.json has unexpected fields");
  }
  if (parsed.schemaVersion !== 1 || parsed.phaseId !== TWO_PHASE_PHASE_ID || !/^[a-f0-9]{40}$/.test(parsed.releaseSha)) {
    throw new Error("BUNDLE.json is invalid");
  }
  return parsed;
}

export async function writeTwoPhaseManifest({ bundleRoot }) {
  const root = path.resolve(bundleRoot);
  if (path.basename(root) !== TWO_PHASE_ROOT_NAME) {
    throw new Error(`Bundle root must be named ${TWO_PHASE_ROOT_NAME}`);
  }
  const files = await inboundFiles(root);
  const lines = [];
  for (const relativePath of files) {
    const contents = await readFile(path.join(root, ...relativePath.split("/")));
    lines.push(`${digest(contents)}  ${relativePath}`);
  }
  const manifestPath = path.join(root, ...TWO_PHASE_MANIFEST_PATH.split("/"));
  const partialPath = `${manifestPath}.partial`;
  await rm(partialPath, { force: true });
  try {
    await writeFile(partialPath, `${lines.join("\n")}\n`, { flag: "wx" });
    await rename(partialPath, manifestPath);
  } finally {
    await rm(partialPath, { force: true });
  }
  return files;
}

async function verifyManifest(bundleRoot) {
  const manifestPath = path.join(bundleRoot, ...TWO_PHASE_MANIFEST_PATH.split("/"));
  const raw = await readFile(manifestPath, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const expectedPaths = await inboundFiles(bundleRoot);
  const seen = new Set();
  const actualPaths = [];

  for (const line of lines) {
    const match = SHA256_LINE.exec(line);
    if (!match) throw new Error("Invalid two-phase manifest line");
    const relativePath = match[2];
    if (seen.has(relativePath)) throw new Error(`Duplicate manifest path: ${relativePath}`);
    seen.add(relativePath);
    actualPaths.push(relativePath);
    const contents = await readFile(path.join(bundleRoot, ...relativePath.split("/")));
    if (digest(contents) !== match[1]) {
      throw new Error(`Checksum mismatch for ${relativePath}`);
    }
  }
  actualPaths.sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error("Manifest entries do not match the inbound tree");
  }
  return expectedPaths;
}

export async function verifyTwoPhaseUsb({ bundleRoot, mode }) {
  if (!TWO_PHASE_MODES.includes(mode)) {
    throw new Error("Mode must be outbound, staged-return, cutover-ready, or cutover-return");
  }
  const root = path.resolve(bundleRoot);
  if (path.basename(root) !== TWO_PHASE_ROOT_NAME) {
    throw new Error(`Bundle root must be named ${TWO_PHASE_ROOT_NAME}`);
  }
  await requireExactRootChildren(root);
  await snapshotTree(root);
  await readBundleMetadata(root);
  const files = await verifyManifest(root);

  if (mode === "outbound") {
    await requireEmptyDirectory(path.join(root, "FROM-DEBIAN"), "FROM-DEBIAN");
    await requireEmptyDirectory(path.join(root, "FINAL-ENCRYPTED"), "FINAL-ENCRYPTED");
  }

  return {
    ok: true,
    phaseId: TWO_PHASE_PHASE_ID,
    mode,
    inboundFiles: files.length,
    stageReceipt: null,
    cutoverReceipt: null
  };
}
