import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  rmdir,
  statfs,
  unlink
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  assertFat32CompatibleSize,
  assertPathWithin,
  sha256File,
  writeSha256Manifest
} from "./usb-handoff-lib.mjs";
import { verifyUsbHandoff } from "./verify-usb-handoff.mjs";
import {
  HOST_PREP_INBOUND_FILES,
  HOST_PREP_MANIFEST_PATH,
  HOST_PREP_ROOT_NAME,
  assertTreeSnapshotEqual,
  createPhase2Input,
  manifestFingerprint,
  snapshotRegularTree
} from "./usb-host-prep-lib.mjs";
import { verifyUsbHostPrep } from "./verify-usb-host-prep.mjs";

const PHASE1_ROOT_NAME = "Project-A-Migration";
const STAGING_PREFIX = `${HOST_PREP_ROOT_NAME}.partial-`;
const MINIMUM_HEADROOM_BYTES = 1024 * 1024;
const CLI_USAGE = "Usage: node scripts/migration/build-usb-host-prep.mjs --usb-root <absolute drive root>";
const PRESERVED_STAGING_ERROR =
  "Host-prep bundle creation failed safely; builder-owned partial staging was preserved for operator inspection.";
const TRANSFER_FILES = Object.freeze([
  ["deploy/usb-host-prep/ISOLATION-BOUNDARY.txt", "ISOLATION-BOUNDARY.txt"],
  ["deploy/usb-host-prep/README-FIRST.txt", "README-FIRST.txt"],
  ["scripts/migration/apply-host-prep.sh", "TO-DEBIAN/apply-host-prep.sh"],
  ["scripts/migration/collect-host-prep-evidence.sh", "TO-DEBIAN/collect-host-prep-evidence.sh"],
  ["scripts/migration/preflight-host-prep.sh", "TO-DEBIAN/preflight-host-prep.sh"]
]);
const CHILD_DIRECTORIES = Object.freeze([
  "TO-DEBIAN",
  "FROM-DEBIAN",
  "CHECKSUMS",
  "SECRETS-ENCRYPTED"
]);

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..", "..");
const execFileAsync = promisify(execFile);

async function pathExists(candidatePath) {
  try {
    await lstat(candidatePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function assertNoLinkedExistingComponents(candidatePath, label) {
  const resolved = path.resolve(candidatePath);
  const volumeRoot = path.parse(resolved).root;
  const relative = path.relative(volumeRoot, resolved);
  const components = relative ? relative.split(path.sep) : [];
  let current = volumeRoot;
  for (const component of [null, ...components]) {
    if (component) current = path.join(current, component);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw new Error(`${label} could not be inspected safely.`, { cause: error });
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(`${label} contains a symbolic link or junction.`);
    }
  }
}

async function requirePlainDirectory(directoryPath, label) {
  const metadata = await lstat(directoryPath);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be an existing non-linked directory.`);
  }
}

function sameSourceIdentity(approved, candidate) {
  return (
    (approved.dev === 0 || candidate.dev === 0 || approved.dev === candidate.dev)
    && approved.ino === candidate.ino
    && approved.mode === candidate.mode
    && approved.size === candidate.size
    && approved.mtimeMs === candidate.mtimeMs
    && approved.ctimeMs === candidate.ctimeMs
  );
}

async function copyApprovedSource(approvedSource, destinationPath) {
  let sourceHandle;
  let destinationHandle;
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    try {
      sourceHandle = await open(approvedSource.path, constants.O_RDONLY | noFollow);
    } catch (error) {
      throw new Error("Approved host-prep source changed during the build.", { cause: error });
    }
    const opened = await sourceHandle.stat();
    if (!opened.isFile() || !sameSourceIdentity(approvedSource.metadata, opened)) {
      throw new Error("Approved host-prep source changed during the build.");
    }

    destinationHandle = await open(destinationPath, "wx");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(
          buffer,
          written,
          bytesRead - written,
          position + written
        );
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    await destinationHandle.sync();

    const afterHandle = await sourceHandle.stat();
    let afterPath;
    try {
      afterPath = await lstat(approvedSource.path);
    } catch (error) {
      throw new Error("Approved host-prep source changed during the build.", { cause: error });
    }
    if (
      afterPath.isSymbolicLink()
      || !afterPath.isFile()
      || !sameSourceIdentity(approvedSource.metadata, afterHandle)
      || !sameSourceIdentity(approvedSource.metadata, afterPath)
    ) {
      throw new Error("Approved host-prep source changed during the build.");
    }
  } finally {
    await destinationHandle?.close();
    await sourceHandle?.close();
  }
}

async function writeJsonAtomically(stagingRoot, relativePath, value) {
  const destination = assertPathWithin(
    stagingRoot,
    path.join(stagingRoot, ...relativePath.split("/"))
  );
  const temporary = `${destination}.partial`;
  let handle;
  try {
    handle = await open(temporary, "wx");
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (process.platform === "win32") {
      await rename(temporary, destination);
    } else {
      const { link } = await import("node:fs/promises");
      await link(temporary, destination);
      await unlink(temporary);
    }
  } catch (error) {
    await handle?.close();
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function publishHostPrepStagingNoClobber({
  usbRoot,
  stagingPath,
  finalRoot
}) {
  const root = path.resolve(usbRoot);
  const staging = assertPathWithin(root, stagingPath);
  const destination = assertPathWithin(root, finalRoot);
  const directStaging = path.dirname(staging) === root
    && path.basename(staging).startsWith(STAGING_PREFIX);
  const nestedStaging = path.dirname(path.dirname(staging)) === root
    && path.basename(path.dirname(staging)).startsWith(STAGING_PREFIX)
    && path.basename(staging) === HOST_PREP_ROOT_NAME;
  if (
    (!directStaging && !nestedStaging)
    || path.dirname(destination) !== root
    || path.basename(destination) !== HOST_PREP_ROOT_NAME
  ) {
    throw new Error("Refusing to publish invalid host-prep paths.");
  }
  await assertNoLinkedExistingComponents(staging, "Host-prep staging path");
  await assertNoLinkedExistingComponents(destination, "Host-prep destination");

  if (process.platform === "win32") {
    try {
      await rename(staging, destination);
      return;
    } catch (error) {
      if (await pathExists(destination)) {
        throw new Error(`${HOST_PREP_ROOT_NAME} already exists; this builder will not overwrite it.`);
      }
      throw error;
    }
  }
  if (process.platform !== "linux") {
    throw new Error(`Atomic no-clobber publication is unsupported on ${process.platform}.`);
  }
  try {
    await execFileAsync("mv", [
      "--no-clobber",
      "--no-target-directory",
      "--",
      staging,
      destination
    ], { windowsHide: true });
  } catch (error) {
    if (await pathExists(staging) && await pathExists(destination)) {
      throw new Error(`${HOST_PREP_ROOT_NAME} already exists; this builder will not overwrite it.`);
    }
    throw error;
  }
  if (await pathExists(staging)) {
    if (await pathExists(destination)) {
      throw new Error(`${HOST_PREP_ROOT_NAME} already exists; this builder will not overwrite it.`);
    }
    throw new Error("No-clobber publication did not move the staged host-prep bundle.");
  }
}

function snapshotHash(snapshot, relativePath) {
  const entry = snapshot.find((candidate) => candidate.path === relativePath);
  return entry?.type === "file" ? entry.sha256 : null;
}

async function availableBytesAt(root) {
  const filesystem = await statfs(root, { bigint: true });
  return filesystem.bavail * filesystem.bsize;
}

export async function buildUsbHostPrep({
  usbRoot,
  sourceRoot = repositoryRoot,
  availableBytes
}) {
  if (!path.isAbsolute(usbRoot || "")) {
    throw new Error("USB root must be an absolute path.");
  }
  const root = path.resolve(usbRoot);
  const source = path.resolve(sourceRoot);
  const phase1Root = path.join(root, PHASE1_ROOT_NAME);
  const finalRoot = path.join(root, HOST_PREP_ROOT_NAME);

  await assertNoLinkedExistingComponents(root, "USB root");
  await requirePlainDirectory(root, "USB root");
  await assertNoLinkedExistingComponents(source, "Repository source root");
  await requirePlainDirectory(source, "Repository source root");
  await assertNoLinkedExistingComponents(phase1Root, "Phase 1 path");
  await requirePlainDirectory(phase1Root, "Phase 1 path");
  await assertNoLinkedExistingComponents(finalRoot, "Phase 2 target path");
  if (await pathExists(finalRoot)) {
    throw new Error(`${HOST_PREP_ROOT_NAME} already exists; this builder will not overwrite it.`);
  }

  const returned = await verifyUsbHandoff({ handoffRoot: phase1Root, mode: "returned" });
  if (returned.reports.length !== 1) {
    throw new Error("Returned Phase 1 must contain exactly one approved report.");
  }
  const [report] = returned.reports;
  const phase1Snapshot = await snapshotRegularTree(phase1Root);
  const reportRelativePath = `FROM-DEBIAN/${report.fileName}`;
  if (snapshotHash(phase1Snapshot, reportRelativePath) !== report.sha256) {
    throw new Error("Returned Phase 1 changed after verification.");
  }
  const phase1ManifestPath = path.join(phase1Root, "CHECKSUMS", "TO-DEBIAN.sha256");
  const phase1ManifestSha256 = await sha256File(phase1ManifestPath);
  if (snapshotHash(phase1Snapshot, "CHECKSUMS/TO-DEBIAN.sha256") !== phase1ManifestSha256) {
    throw new Error("Returned Phase 1 changed after verification.");
  }

  const approvedSources = [];
  let requiredBytes = MINIMUM_HEADROOM_BYTES;
  for (const [sourceRelativePath, destinationRelativePath] of TRANSFER_FILES) {
    const sourcePath = assertPathWithin(
      source,
      path.join(source, ...sourceRelativePath.split("/"))
    );
    await assertNoLinkedExistingComponents(sourcePath, "Host-prep source path");
    const metadata = await lstat(sourcePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("Approved host-prep source is not a regular file.");
    }
    assertFat32CompatibleSize(metadata.size, sourceRelativePath);
    requiredBytes += metadata.size;
    approvedSources.push({
      path: sourcePath,
      relativePath: sourceRelativePath,
      destinationRelativePath,
      metadata
    });
  }
  const freeBytes = availableBytes === undefined
    ? await availableBytesAt(root)
    : BigInt(availableBytes);
  if (freeBytes < BigInt(requiredBytes)) {
    throw new Error("USB root does not have enough free space for the host-prep bundle.");
  }

  let stagingPath;
  try {
    stagingPath = await mkdtemp(path.join(root, STAGING_PREFIX));
    stagingPath = assertPathWithin(root, stagingPath);
    await assertNoLinkedExistingComponents(stagingPath, "Host-prep staging path");
    await requirePlainDirectory(stagingPath, "Host-prep staging path");
    const stagingBundleRoot = path.join(stagingPath, HOST_PREP_ROOT_NAME);
    await mkdir(stagingBundleRoot);
    for (const relativeDirectory of CHILD_DIRECTORIES) {
      await mkdir(path.join(stagingBundleRoot, relativeDirectory));
    }

    for (const approvedSource of approvedSources) {
      const destinationPath = assertPathWithin(
        stagingBundleRoot,
        path.join(stagingBundleRoot, ...approvedSource.destinationRelativePath.split("/"))
      );
      await copyApprovedSource(approvedSource, destinationPath);
      const copied = await lstat(destinationPath);
      if (copied.isSymbolicLink() || !copied.isFile()) {
        throw new Error("Copied host-prep artifact is not a regular file.");
      }
      assertFat32CompatibleSize(copied.size, approvedSource.destinationRelativePath);
    }

    const phase2Input = createPhase2Input({
      reportFileName: report.fileName,
      reportSha256: report.sha256,
      phase1ManifestSha256
    });
    await writeJsonAtomically(stagingBundleRoot, "PHASE-2-INPUT.json", phase2Input);
    const inputMetadata = await lstat(path.join(stagingBundleRoot, "PHASE-2-INPUT.json"));
    assertFat32CompatibleSize(inputMetadata.size, "PHASE-2-INPUT.json");

    const stagingManifestPath = path.join(
      stagingBundleRoot,
      ...HOST_PREP_MANIFEST_PATH.split("/")
    );
    await writeSha256Manifest({
      rootPath: stagingBundleRoot,
      relativePaths: HOST_PREP_INBOUND_FILES,
      manifestPath: stagingManifestPath
    });
    assertFat32CompatibleSize((await lstat(stagingManifestPath)).size, HOST_PREP_MANIFEST_PATH);
    const staged = await verifyUsbHostPrep({ handoffRoot: stagingBundleRoot, mode: "outbound" });
    if (staged.inboundFiles !== HOST_PREP_INBOUND_FILES.length) {
      throw new Error("Staged host-prep verification returned an unexpected file count.");
    }

    await publishHostPrepStagingNoClobber({
      usbRoot: root,
      stagingPath: stagingBundleRoot,
      finalRoot
    });
    await rmdir(stagingPath);
    stagingPath = undefined;

    const finalVerification = await verifyUsbHostPrep({ handoffRoot: finalRoot, mode: "outbound" });
    const phase1After = await snapshotRegularTree(phase1Root);
    assertTreeSnapshotEqual(phase1Snapshot, phase1After);
    const fingerprint = await manifestFingerprint(
      path.join(finalRoot, ...HOST_PREP_MANIFEST_PATH.split("/"))
    );
    return {
      rootName: HOST_PREP_ROOT_NAME,
      fileCount: finalVerification.inboundFiles,
      manifestFingerprint: fingerprint,
      phase1ReportFileName: report.fileName,
      phase1ReportSha256: report.sha256,
      phase1Unchanged: true
    };
  } catch (error) {
    if (stagingPath) {
      throw new Error(PRESERVED_STAGING_ERROR, { cause: error });
    }
    throw error;
  }
}

function parseCliArguments(args) {
  if (args.length !== 2 || args[0] !== "--usb-root" || !args[1]) {
    throw new Error(CLI_USAGE);
  }
  return { usbRoot: args[1] };
}

function fixedCliErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message === CLI_USAGE) return message;
  if (/[\\/]/.test(message) || /[A-Za-z]:/.test(message)) {
    return "Host-prep bundle creation failed safely.";
  }
  return message;
}

const invokedDirectly = Boolean(
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath)
);

if (invokedDirectly) {
  try {
    const result = await buildUsbHostPrep(parseCliArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${fixedCliErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
