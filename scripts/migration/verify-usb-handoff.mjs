import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FAT32_MAX_FILE_BYTES,
  scanReturnedReport,
  verifySha256Manifest
} from "./usb-handoff-lib.mjs";

const TOP_LEVEL = Object.freeze([
  "CHECKSUMS",
  "FROM-DEBIAN",
  "ISOLATION-BOUNDARY.txt",
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
const INBOUND_FILES = Object.freeze([
  "ISOLATION-BOUNDARY.txt",
  "README-FIRST.txt",
  "TO-DEBIAN/collect-debian-readiness.sh"
]);
const FIXED_DIRECTORY_ENTRIES = Object.freeze({
  CHECKSUMS: ["TO-DEBIAN.sha256"],
  "SECRETS-ENCRYPTED": [],
  "TO-DEBIAN": ["collect-debian-readiness.sh"]
});
const RETURN_NAME = /^debian-readiness-\d{8}T\d{6}Z-[A-Za-z0-9._-]+\.txt(?:\.sha256)?$/;
const RETURN_MANIFEST_LINE = /^([a-f0-9]{64}) {2}([^\r\n]+)$/;
// Three inbound records or one returned record fit well below this defensive bound.
const MAX_CHECKSUM_BYTES = 1024;
// Collector output is text inventory; cap buffering far below FAT32's file ceiling.
const MAX_RETURNED_REPORT_BYTES = 64 * 1024 * 1024;
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

async function requireNonSymlinkDirectory(directoryPath, failureMessage) {
  const metadata = await safeLstat(directoryPath, failureMessage);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    failSafely(failureMessage);
  }
}

async function verifyTopLevelLayout(root) {
  await requireNonSymlinkDirectory(
    root,
    "Handoff top-level layout does not match the approved structure"
  );
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    failSafely("Handoff top-level layout does not match the approved structure");
  }
  const names = entries.map((entry) => entry.name).sort();
  if (!sameEntries(names, TOP_LEVEL)) {
    failSafely("Handoff top-level layout does not match the approved structure");
  }

  for (const entry of entries) {
    const expectedDirectory = TOP_LEVEL_DIRECTORIES.has(entry.name);
    if (
      entry.isSymbolicLink()
      || (expectedDirectory ? !entry.isDirectory() : !entry.isFile())
    ) {
      failSafely("Handoff top-level layout does not match the approved structure");
    }
  }
}

async function verifyFixedInboundLayout(root) {
  for (const [directoryName, expectedNames] of Object.entries(FIXED_DIRECTORY_ENTRIES)) {
    const directoryPath = path.join(root, directoryName);
    await requireNonSymlinkDirectory(
      directoryPath,
      "Handoff inbound layout does not match the approved structure"
    );
    let entries;
    try {
      entries = await readdir(directoryPath, { withFileTypes: true });
    } catch {
      failSafely("Handoff inbound layout does not match the approved structure");
    }
    const names = entries.map((entry) => entry.name).sort();
    if (
      !sameEntries(names, expectedNames)
      || entries.some((entry) => entry.isSymbolicLink() || !entry.isFile())
    ) {
      failSafely("Handoff inbound layout does not match the approved structure");
    }
  }
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
    if (approved.isSymbolicLink() || !approved.isFile()) {
      failSafely(invalidMessage);
    }
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
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position
      );
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
    return Buffer.concat(chunks, position);
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

async function preflightInboundManifest(manifestPath) {
  await readBoundedStableFile({
    filePath: manifestPath,
    maxBytes: MAX_CHECKSUM_BYTES,
    invalidMessage: "Inbound checksum manifest is invalid.",
    tooLargeMessage: "Inbound checksum manifest is too large."
  });
}

function parseReturnedSidecar(sidecarBuffer, reportName) {
  const text = sidecarBuffer.toString("utf8");
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 1) {
    failSafely("Returned checksum sidecar is invalid.");
  }
  const match = RETURN_MANIFEST_LINE.exec(lines[0]);
  if (!match || match[2] !== reportName) {
    failSafely("Returned checksum sidecar is invalid.");
  }
  return match[1];
}

export async function readStableOpenedReport({
  handle,
  reportPath,
  approvedMetadata,
  expectedSha256
}) {
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile()
      || !sameFileIdentity(approvedMetadata, opened)
      || opened.size > BigInt(FAT32_MAX_FILE_BYTES)
      || opened.size > BigInt(MAX_RETURNED_REPORT_BYTES)
    ) {
      failSafely("Returned report changed during verification.");
    }

    const hash = createHash("sha256");
    const chunks = [];
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position
      );
      if (bytesRead === 0) break;
      position += bytesRead;
      if (position > MAX_RETURNED_REPORT_BYTES) {
        failSafely("Returned report exceeds the safe verification size limit.");
      }
      const chunk = Buffer.from(buffer.subarray(0, bytesRead));
      hash.update(chunk);
      chunks.push(chunk);
    }

    const afterRead = await handle.stat({ bigint: true });
    const pathname = await safeLstat(
      reportPath,
      "Returned report changed during verification."
    );
    if (
      pathname.isSymbolicLink()
      || !pathname.isFile()
      || !sameFileIdentity(approvedMetadata, opened)
      || !sameFileIdentity(approvedMetadata, afterRead)
      || !sameFileIdentity(approvedMetadata, pathname)
    ) {
      failSafely("Returned report changed during verification.");
    }

    const sha256 = hash.digest("hex");
    if (sha256 !== expectedSha256) {
      failSafely("Returned report checksum mismatch.");
    }
    return {
      buffer: Buffer.concat(chunks, position),
      sha256
    };
  } catch (error) {
    if (error instanceof SafeVerificationError) throw error;
    failSafely("Returned report could not be read safely.");
  }
}

async function readVerifiedReturnedReport(reportPath, expectedSha256) {
  let handle;
  try {
    const approvedMetadata = await safeLstat(
      reportPath,
      "Returned report could not be read safely."
    );
    if (approvedMetadata.isSymbolicLink() || !approvedMetadata.isFile()) {
      failSafely("Returned report could not be read safely.");
    }
    handle = await openWithoutFollowing(reportPath);
    return await readStableOpenedReport({
      handle,
      reportPath,
      approvedMetadata,
      expectedSha256
    });
  } catch (error) {
    if (error instanceof SafeVerificationError) throw error;
    failSafely("Returned report could not be read safely.");
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        failSafely("Returned report could not be read safely.");
      }
    }
  }
}

export async function verifyUsbHandoff({ handoffRoot, mode }) {
  if (typeof handoffRoot !== "string" || !path.isAbsolute(handoffRoot)) {
    throw new Error("--handoff-root must be an absolute path");
  }
  if (!["outbound", "returned"].includes(mode)) {
    throw new Error("--mode must be outbound or returned");
  }

  const root = path.resolve(handoffRoot);
  await assertNoLinkedPathComponents(root);
  await verifyTopLevelLayout(root);
  await verifyFixedInboundLayout(root);

  const inboundManifestPath = path.join(
    root,
    "CHECKSUMS",
    "TO-DEBIAN.sha256"
  );
  await preflightInboundManifest(inboundManifestPath);
  let inbound;
  try {
    inbound = await verifySha256Manifest({
      rootPath: root,
      manifestPath: inboundManifestPath
    });
  } catch {
    failSafely("Inbound checksum verification failed.");
  }
  if (!sameEntries(inbound.map((entry) => entry.path), INBOUND_FILES)) {
    failSafely("Inbound checksum manifest does not contain the approved files");
  }

  const returnDir = path.join(root, "FROM-DEBIAN");
  await requireNonSymlinkDirectory(
    returnDir,
    "Handoff top-level layout does not match the approved structure"
  );
  let returnedEntries;
  try {
    returnedEntries = await readdir(returnDir, { withFileTypes: true });
  } catch {
    failSafely("Returned evidence directory could not be read safely.");
  }
  const returnedNames = returnedEntries.map((entry) => entry.name).sort();

  if (mode === "outbound") {
    if (returnedNames.length) {
      failSafely("Outbound handoff already contains returned files");
    }
    await assertNoLinkedPathComponents(root);
    return { ok: true, mode, inboundFiles: inbound.length, reports: [] };
  }

  if (!returnedNames.length) {
    failSafely("At least one returned report is required");
  }
  if (returnedNames.some((name) => !RETURN_NAME.test(name))) {
    failSafely("Unexpected return file.");
  }
  if (
    returnedEntries.some(
      (entry) => entry.isSymbolicLink() || !entry.isFile()
    )
  ) {
    failSafely("Returned entry is not a regular file.");
  }

  const reportNames = returnedNames.filter((name) => name.endsWith(".txt"));
  const sidecarNames = new Set(
    returnedNames.filter((name) => name.endsWith(".txt.sha256"))
  );
  for (const sidecarName of sidecarNames) {
    const reportName = sidecarName.slice(0, -".sha256".length);
    if (!reportNames.includes(reportName)) {
      failSafely("Missing returned report.");
    }
  }

  const reports = [];
  for (const reportName of reportNames) {
    const sidecarName = `${reportName}.sha256`;
    if (!sidecarNames.has(sidecarName)) {
      failSafely("Missing checksum sidecar.");
    }
    const sidecarBuffer = await readBoundedStableFile({
      filePath: path.join(returnDir, sidecarName),
      maxBytes: MAX_CHECKSUM_BYTES,
      invalidMessage: "Returned checksum sidecar is invalid.",
      tooLargeMessage: "Returned checksum sidecar is too large."
    });
    const expectedSha256 = parseReturnedSidecar(sidecarBuffer, reportName);
    const verified = await readVerifiedReturnedReport(
      path.join(returnDir, reportName),
      expectedSha256
    );

    const report = verified.buffer.toString("utf8");
    const screening = scanReturnedReport(report);
    if (!screening.ok) {
      const finding = screening.findings[0];
      failSafely(
        `Potential secret material detected at line ${finding.line} (${finding.rule}); do not open or share this report.`
      );
    }
    reports.push({ fileName: reportName, sha256: verified.sha256 });
  }

  await assertNoLinkedPathComponents(root);
  return { ok: true, mode, inboundFiles: inbound.length, reports };
}

function parseCliArguments(args) {
  const usage = "Usage: node scripts/migration/verify-usb-handoff.mjs --handoff-root <absolute path> --mode outbound|returned";
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
    const result = await verifyUsbHandoff(
      parseCliArguments(process.argv.slice(2))
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
