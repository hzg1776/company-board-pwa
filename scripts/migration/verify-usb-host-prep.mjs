import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FAT32_MAX_FILE_BYTES,
  scanReturnedReport
} from "./usb-handoff-lib.mjs";
import {
  HOST_PREP_INBOUND_FILES,
  HOST_PREP_MANIFEST_PATH,
  HOST_PREP_PHASE_ID,
  HOST_PREP_ROOT_NAME,
  validatePhase2Input
} from "./usb-host-prep-lib.mjs";

const TOP_LEVEL = Object.freeze([
  "CHECKSUMS",
  "FROM-DEBIAN",
  "ISOLATION-BOUNDARY.txt",
  "PHASE-2-INPUT.json",
  "README-FIRST.txt",
  "SECRETS-ENCRYPTED",
  "TO-DEBIAN"
]);
const TOP_LEVEL_DIRECTORIES = new Set([
  "CHECKSUMS",
  "FROM-DEBIAN",
  "SECRETS-ENCRYPTED",
  "TO-DEBIAN"
]);
const FIXED_DIRECTORY_ENTRIES = Object.freeze({
  CHECKSUMS: ["PHASE-2-HOST-PREP.sha256"],
  "SECRETS-ENCRYPTED": [],
  "TO-DEBIAN": [
    "apply-host-prep.sh",
    "collect-host-prep-evidence.sh",
    "preflight-host-prep.sh"
  ]
});
const RECEIPT_NAME = /^debian-host-prep-\d{8}T\d{6}Z-[A-Za-z0-9._-]+\.txt$/;
const MANIFEST_LINE = /^([a-f0-9]{64}) {2}([^\r\n]+)$/;
const MAX_CHECKSUM_BYTES = 1024;
const MAX_PHASE2_INPUT_BYTES = 64 * 1024;
const MAX_RETURNED_RECEIPT_BYTES = 64 * 1024 * 1024;
const READ_BUFFER_BYTES = 64 * 1024;
const scriptPath = fileURLToPath(import.meta.url);

class SafeVerificationError extends Error {}

function failSafely(message) {
  throw new SafeVerificationError(message);
}

function sameEntries(actual, expected) {
  return (
    actual.length === expected.length
    && actual.every((entry, index) => entry === expected[index])
  );
}

function sameFileIdentity(approved, candidate) {
  return (
    (approved.dev === 0n || candidate.dev === 0n || approved.dev === candidate.dev)
    && approved.ino === candidate.ino
    && approved.mode === candidate.mode
    && approved.size === candidate.size
    && approved.mtimeNs === candidate.mtimeNs
    && approved.ctimeNs === candidate.ctimeNs
  );
}

async function safeLstat(candidatePath, failureMessage) {
  try {
    return await lstat(candidatePath, { bigint: true });
  } catch {
    failSafely(failureMessage);
  }
}

async function assertNoLinkedPathComponents(candidatePath) {
  const resolved = path.resolve(candidatePath);
  const volumeRoot = path.parse(resolved).root;
  const relative = path.relative(volumeRoot, resolved);
  const components = relative ? relative.split(path.sep) : [];
  let current = volumeRoot;

  for (const component of [null, ...components]) {
    if (component) current = path.join(current, component);
    const metadata = await safeLstat(
      current,
      "Handoff path could not be inspected safely."
    );
    if (metadata.isSymbolicLink()) {
      failSafely("Handoff ancestor contains a symbolic link or junction.");
    }
  }
}

async function requireDirectory(directoryPath, failureMessage) {
  const metadata = await safeLstat(directoryPath, failureMessage);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    failSafely(failureMessage);
  }
  return metadata;
}

async function readStableDirectory(directoryPath, failureMessage) {
  const approved = await requireDirectory(directoryPath, failureMessage);
  let entries;
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch {
    failSafely(failureMessage);
  }
  const after = await safeLstat(directoryPath, failureMessage);
  if (
    after.isSymbolicLink()
    || !after.isDirectory()
    || !sameFileIdentity(approved, after)
  ) {
    failSafely(failureMessage);
  }
  return { entries, identity: approved };
}

async function verifyTopLevelLayout(root) {
  const failureMessage = "Handoff top-level layout does not match the approved structure.";
  const snapshot = await readStableDirectory(root, failureMessage);
  const names = snapshot.entries.map((entry) => entry.name).sort();
  if (!sameEntries(names, TOP_LEVEL)) failSafely(failureMessage);

  const identities = new Map([[root, snapshot.identity]]);
  for (const entry of snapshot.entries) {
    const expectedDirectory = TOP_LEVEL_DIRECTORIES.has(entry.name);
    if (
      entry.isSymbolicLink()
      || (expectedDirectory ? !entry.isDirectory() : !entry.isFile())
    ) {
      failSafely(failureMessage);
    }
    const entryPath = path.join(root, entry.name);
    const metadata = await safeLstat(entryPath, failureMessage);
    if (
      metadata.isSymbolicLink()
      || (expectedDirectory ? !metadata.isDirectory() : !metadata.isFile())
    ) {
      failSafely(failureMessage);
    }
    identities.set(entryPath, metadata);
  }
  return identities;
}

async function verifyFixedInboundLayout(root) {
  const failureMessage = "Handoff inbound layout does not match the approved structure.";
  const identities = new Map();
  for (const [directoryName, expectedNames] of Object.entries(FIXED_DIRECTORY_ENTRIES)) {
    const directoryPath = path.join(root, directoryName);
    const snapshot = await readStableDirectory(directoryPath, failureMessage);
    identities.set(directoryPath, snapshot.identity);
    const names = snapshot.entries.map((entry) => entry.name).sort();
    if (
      !sameEntries(names, expectedNames)
      || snapshot.entries.some((entry) => entry.isSymbolicLink() || !entry.isFile())
    ) {
      failSafely(failureMessage);
    }
    for (const name of names) {
      const filePath = path.join(directoryPath, name);
      const metadata = await safeLstat(filePath, failureMessage);
      if (metadata.isSymbolicLink() || !metadata.isFile()) failSafely(failureMessage);
      identities.set(filePath, metadata);
    }
  }
  return identities;
}

async function openWithoutFollowing(filePath) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  return open(filePath, constants.O_RDONLY | noFollow);
}

async function readBoundedStableFile({
  filePath,
  maxBytes,
  invalidMessage,
  tooLargeMessage
}) {
  let handle;
  try {
    const approved = await safeLstat(filePath, invalidMessage);
    if (approved.isSymbolicLink() || !approved.isFile()) failSafely(invalidMessage);
    if (
      approved.size > BigInt(FAT32_MAX_FILE_BYTES)
      || approved.size > BigInt(maxBytes)
    ) {
      failSafely(tooLargeMessage);
    }

    handle = await openWithoutFollowing(filePath);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFileIdentity(approved, opened)) {
      failSafely(invalidMessage);
    }

    const chunks = [];
    const buffer = Buffer.allocUnsafe(Math.min(READ_BUFFER_BYTES, maxBytes + 1));
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      if (position > maxBytes) failSafely(tooLargeMessage);
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }

    const afterRead = await handle.stat({ bigint: true });
    const pathname = await safeLstat(filePath, invalidMessage);
    if (
      pathname.isSymbolicLink()
      || !pathname.isFile()
      || !sameFileIdentity(approved, opened)
      || !sameFileIdentity(approved, afterRead)
      || !sameFileIdentity(approved, pathname)
    ) {
      failSafely(invalidMessage);
    }
    return { buffer: Buffer.concat(chunks, position), metadata: approved };
  } catch (error) {
    if (error instanceof SafeVerificationError) throw error;
    failSafely(invalidMessage);
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        failSafely(invalidMessage);
      }
    }
  }
}

export async function approveHostPrepInboundManifest(manifestPath) {
  return readBoundedStableFile({
    filePath: manifestPath,
    maxBytes: MAX_CHECKSUM_BYTES,
    invalidMessage: "Inbound checksum manifest is invalid.",
    tooLargeMessage: "Inbound checksum manifest is too large."
  });
}

function parseApprovedInboundManifest(buffer) {
  const lines = buffer.toString("utf8").split(/\r?\n/);
  if (lines.at(-1) !== "") {
    failSafely("Inbound checksum manifest does not contain the approved files.");
  }
  lines.pop();
  if (lines.length !== HOST_PREP_INBOUND_FILES.length) {
    failSafely("Inbound checksum manifest does not contain the approved files.");
  }

  const records = [];
  const seen = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const match = MANIFEST_LINE.exec(lines[index]);
    const expectedPath = HOST_PREP_INBOUND_FILES[index];
    if (!match || match[2] !== expectedPath || seen.has(match[2])) {
      failSafely("Inbound checksum manifest does not contain the approved files.");
    }
    seen.add(match[2]);
    records.push({ path: expectedPath, sha256: match[1] });
  }
  return records;
}

async function hashStableInboundFile(filePath, expectedSha256) {
  let handle;
  try {
    const approved = await safeLstat(filePath, "Inbound checksum verification failed.");
    if (
      approved.isSymbolicLink()
      || !approved.isFile()
      || approved.size > BigInt(FAT32_MAX_FILE_BYTES)
    ) {
      failSafely("Inbound checksum verification failed.");
    }

    handle = await openWithoutFollowing(filePath);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFileIdentity(approved, opened)) {
      failSafely("Inbound checksum verification failed.");
    }

    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      if (position > FAT32_MAX_FILE_BYTES) {
        failSafely("Inbound checksum verification failed.");
      }
      hash.update(buffer.subarray(0, bytesRead));
    }

    const afterRead = await handle.stat({ bigint: true });
    const pathname = await safeLstat(filePath, "Inbound checksum verification failed.");
    if (
      pathname.isSymbolicLink()
      || !pathname.isFile()
      || !sameFileIdentity(approved, opened)
      || !sameFileIdentity(approved, afterRead)
      || !sameFileIdentity(approved, pathname)
      || hash.digest("hex") !== expectedSha256
    ) {
      failSafely("Inbound checksum verification failed.");
    }
    return approved;
  } catch (error) {
    if (error instanceof SafeVerificationError) throw error;
    failSafely("Inbound checksum verification failed.");
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        failSafely("Inbound checksum verification failed.");
      }
    }
  }
}

export async function verifyApprovedHostPrepInboundManifest({
  root,
  manifestPath,
  approval
}) {
  if (!approval || !Buffer.isBuffer(approval.buffer) || !approval.metadata) {
    failSafely("Inbound checksum manifest is invalid.");
  }
  const records = parseApprovedInboundManifest(approval.buffer);
  const identities = new Map();
  for (const record of records) {
    const filePath = path.join(root, ...record.path.split("/"));
    identities.set(filePath, await hashStableInboundFile(filePath, record.sha256));
  }

  const currentManifest = await safeLstat(
    manifestPath,
    "Inbound checksum manifest changed during verification."
  );
  if (
    currentManifest.isSymbolicLink()
    || !currentManifest.isFile()
    || !sameFileIdentity(approval.metadata, currentManifest)
  ) {
    failSafely("Inbound checksum manifest changed during verification.");
  }
  identities.set(manifestPath, currentManifest);
  return { records, identities };
}

function parseReturnedSidecar(sidecarBuffer, receiptName) {
  const lines = sidecarBuffer.toString("utf8").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 1) failSafely("Returned checksum sidecar is invalid.");
  const match = MANIFEST_LINE.exec(lines[0]);
  if (!match || match[2] !== receiptName) {
    failSafely("Returned checksum sidecar is invalid.");
  }
  return match[1];
}

export async function readStableOpenedHostPrepReceipt({
  handle,
  receiptPath,
  approvedMetadata,
  expectedSha256
}) {
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile()
      || !sameFileIdentity(approvedMetadata, opened)
    ) {
      failSafely("Returned receipt changed during verification.");
    }
    if (
      opened.size > BigInt(FAT32_MAX_FILE_BYTES)
      || opened.size > BigInt(MAX_RETURNED_RECEIPT_BYTES)
    ) {
      failSafely("Returned receipt exceeds the safe verification size limit.");
    }

    const hash = createHash("sha256");
    const chunks = [];
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      if (position > MAX_RETURNED_RECEIPT_BYTES) {
        failSafely("Returned receipt exceeds the safe verification size limit.");
      }
      const chunk = Buffer.from(buffer.subarray(0, bytesRead));
      hash.update(chunk);
      chunks.push(chunk);
    }

    const afterRead = await handle.stat({ bigint: true });
    const pathname = await safeLstat(
      receiptPath,
      "Returned receipt changed during verification."
    );
    if (
      pathname.isSymbolicLink()
      || !pathname.isFile()
      || !sameFileIdentity(approvedMetadata, opened)
      || !sameFileIdentity(approvedMetadata, afterRead)
      || !sameFileIdentity(approvedMetadata, pathname)
    ) {
      failSafely("Returned receipt changed during verification.");
    }

    const sha256 = hash.digest("hex");
    if (sha256 !== expectedSha256) failSafely("Returned receipt checksum mismatch.");
    return { buffer: Buffer.concat(chunks, position), sha256 };
  } catch (error) {
    if (error instanceof SafeVerificationError) throw error;
    failSafely("Returned receipt could not be read safely.");
  }
}

async function readVerifiedReturnedReceipt(receiptPath, expectedSha256) {
  let handle;
  try {
    const approvedMetadata = await safeLstat(
      receiptPath,
      "Returned receipt could not be read safely."
    );
    if (approvedMetadata.isSymbolicLink() || !approvedMetadata.isFile()) {
      failSafely("Returned receipt could not be read safely.");
    }
    if (
      approvedMetadata.size > BigInt(FAT32_MAX_FILE_BYTES)
      || approvedMetadata.size > BigInt(MAX_RETURNED_RECEIPT_BYTES)
    ) {
      failSafely("Returned receipt exceeds the safe verification size limit.");
    }
    handle = await openWithoutFollowing(receiptPath);
    return await readStableOpenedHostPrepReceipt({
      handle,
      receiptPath,
      approvedMetadata,
      expectedSha256
    });
  } catch (error) {
    if (error instanceof SafeVerificationError) throw error;
    failSafely("Returned receipt could not be read safely.");
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        failSafely("Returned receipt could not be read safely.");
      }
    }
  }
}

async function assertIdentityMapUnchanged(identities) {
  for (const [candidatePath, approved] of identities) {
    const current = await safeLstat(
      candidatePath,
      "Handoff changed during verification."
    );
    if (
      current.isSymbolicLink()
      || !sameFileIdentity(approved, current)
    ) {
      failSafely("Handoff changed during verification.");
    }
  }
}

async function readReturnedEntries(returnDir) {
  const failureMessage = "Returned evidence directory could not be read safely.";
  const snapshot = await readStableDirectory(returnDir, failureMessage);
  return snapshot;
}

export async function verifyUsbHostPrep({ handoffRoot, mode }) {
  if (typeof handoffRoot !== "string" || !path.isAbsolute(handoffRoot)) {
    throw new Error("--handoff-root must be an absolute path");
  }
  if (!["outbound", "returned"].includes(mode)) {
    throw new Error("--mode must be outbound or returned");
  }

  const root = path.resolve(handoffRoot);
  if (path.basename(root) !== HOST_PREP_ROOT_NAME) {
    throw new Error("--handoff-root must use the approved Phase 2 root name");
  }
  await assertNoLinkedPathComponents(root);
  const identities = await verifyTopLevelLayout(root);
  for (const [candidatePath, identity] of await verifyFixedInboundLayout(root)) {
    identities.set(candidatePath, identity);
  }

  const manifestPath = path.join(root, ...HOST_PREP_MANIFEST_PATH.split("/"));
  const approval = await approveHostPrepInboundManifest(manifestPath);
  const inbound = await verifyApprovedHostPrepInboundManifest({
    root,
    manifestPath,
    approval
  });
  for (const [candidatePath, identity] of inbound.identities) {
    identities.set(candidatePath, identity);
  }

  const inputRecord = inbound.records.find((record) => record.path === "PHASE-2-INPUT.json");
  const inputPath = path.join(root, "PHASE-2-INPUT.json");
  const inputApproval = await readBoundedStableFile({
    filePath: inputPath,
    maxBytes: MAX_PHASE2_INPUT_BYTES,
    invalidMessage: "Phase 2 input metadata is invalid.",
    tooLargeMessage: "Phase 2 input metadata is too large."
  });
  const inputReferenceSha256 = createHash("sha256")
    .update(inputApproval.buffer)
    .digest("hex");
  if (!inputRecord || inputReferenceSha256 !== inputRecord.sha256) {
    failSafely("Phase 2 input metadata is invalid.");
  }
  identities.set(inputPath, inputApproval.metadata);
  try {
    validatePhase2Input(JSON.parse(inputApproval.buffer.toString("utf8")));
  } catch {
    failSafely("Phase 2 input metadata is invalid.");
  }

  const returnDir = path.join(root, "FROM-DEBIAN");
  const returned = await readReturnedEntries(returnDir);
  identities.set(returnDir, returned.identity);
  const returnedNames = returned.entries.map((entry) => entry.name).sort();

  if (mode === "outbound") {
    if (returnedNames.length !== 0) {
      failSafely("Outbound handoff already contains returned files.");
    }
    await assertNoLinkedPathComponents(root);
    await assertIdentityMapUnchanged(identities);
    return {
      ok: true,
      phaseId: HOST_PREP_PHASE_ID,
      mode,
      inputReferenceSha256,
      inboundFiles: inbound.records.length,
      receipt: null
    };
  }

  if (
    returnedNames.length !== 2
    || returned.entries.some((entry) => entry.isSymbolicLink() || !entry.isFile())
  ) {
    failSafely("Returned evidence must contain exactly one receipt and sidecar.");
  }
  const receiptNames = returnedNames.filter((name) => RECEIPT_NAME.test(name));
  if (receiptNames.length !== 1) failSafely("Returned evidence file names are invalid.");
  const receiptName = receiptNames[0];
  const sidecarName = `${receiptName}.sha256`;
  if (!sameEntries(returnedNames, [receiptName, sidecarName].sort())) {
    failSafely("Returned evidence file names are invalid.");
  }

  const receiptPath = path.join(returnDir, receiptName);
  const sidecarPath = path.join(returnDir, sidecarName);
  for (const candidatePath of [receiptPath, sidecarPath]) {
    const metadata = await safeLstat(candidatePath, "Returned evidence entry is invalid.");
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      failSafely("Returned evidence entry is invalid.");
    }
    identities.set(candidatePath, metadata);
  }
  const sidecar = await readBoundedStableFile({
    filePath: sidecarPath,
    maxBytes: MAX_CHECKSUM_BYTES,
    invalidMessage: "Returned checksum sidecar is invalid.",
    tooLargeMessage: "Returned checksum sidecar is too large."
  });
  identities.set(sidecarPath, sidecar.metadata);
  const expectedSha256 = parseReturnedSidecar(sidecar.buffer, receiptName);
  const receipt = await readVerifiedReturnedReceipt(receiptPath, expectedSha256);

  const screening = scanReturnedReport(receipt.buffer.toString("utf8"));
  if (!screening.ok) {
    const finding = screening.findings[0];
    failSafely(
      `Potential secret material detected at line ${finding.line} (${finding.rule}); do not open or share this receipt.`
    );
  }

  await assertNoLinkedPathComponents(root);
  await assertIdentityMapUnchanged(identities);
  return {
    ok: true,
    phaseId: HOST_PREP_PHASE_ID,
    mode,
    inputReferenceSha256,
    inboundFiles: inbound.records.length,
    receipt: { fileName: receiptName, sha256: receipt.sha256 }
  };
}

function parseCliArguments(args) {
  const usage = "Usage: node scripts/migration/verify-usb-host-prep.mjs --handoff-root <absolute path> --mode outbound|returned";
  if (args.length !== 4) throw new Error(usage);

  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      !["--handoff-root", "--mode"].includes(name)
      || !value
      || value.startsWith("--")
      || values.has(name)
    ) {
      throw new Error(usage);
    }
    values.set(name, value);
  }
  if (!values.has("--handoff-root") || !values.has("--mode")) {
    throw new Error(usage);
  }
  return {
    handoffRoot: values.get("--handoff-root"),
    mode: values.get("--mode")
  };
}

const invokedDirectly = Boolean(
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath)
);

if (invokedDirectly) {
  try {
    const result = await verifyUsbHostPrep(parseCliArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
