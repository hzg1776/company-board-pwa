import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  assertFat32CompatibleSize,
  assertPathWithin,
  verifySha256Manifest,
  writeSha256Manifest
} from "./usb-handoff-lib.mjs";

const HANDOFF_NAME = "Project-A-Migration";
const TRANSFER_FILES = Object.freeze([
  ["deploy/usb-migration/README-FIRST.txt", "README-FIRST.txt"],
  ["deploy/usb-migration/ISOLATION-BOUNDARY.txt", "ISOLATION-BOUNDARY.txt"],
  ["scripts/migration/collect-debian-readiness.sh", "TO-DEBIAN/collect-debian-readiness.sh"]
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

async function requireDirectory(directoryPath, label) {
  const metadata = await lstat(directoryPath);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be an existing non-symbolic-link directory: ${directoryPath}`);
  }
}

async function pathExists(candidatePath) {
  try {
    await lstat(candidatePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function removeValidatedStaging(usbRoot, stagingPath) {
  const root = path.resolve(usbRoot);
  const staging = assertPathWithin(root, stagingPath);
  const expectedPrefix = `${HANDOFF_NAME}.partial-`;
  if (path.dirname(staging) !== root || !path.basename(staging).startsWith(expectedPrefix)) {
    throw new Error(`Refusing to clean an invalid staging directory: ${staging}`);
  }
  await rm(staging, { recursive: true, force: true });
}

function sourceIdentityMatches(approved, candidate) {
  return (
    (approved.dev === 0 || candidate.dev === 0 || approved.dev === candidate.dev)
    && approved.ino === candidate.ino
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
      throw new Error(
        `Transfer source changed during handoff build: ${approvedSource.relativePath}`,
        { cause: error }
      );
    }
    const openedMetadata = await sourceHandle.stat();
    if (
      !openedMetadata.isFile()
      || !sourceIdentityMatches(approvedSource.metadata, openedMetadata)
    ) {
      throw new Error(`Transfer source changed during handoff build: ${approvedSource.relativePath}`);
    }

    destinationHandle = await open(destinationPath, "wx");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      let bytesWritten = 0;
      while (bytesWritten < bytesRead) {
        const result = await destinationHandle.write(
          buffer,
          bytesWritten,
          bytesRead - bytesWritten,
          position + bytesWritten
        );
        bytesWritten += result.bytesWritten;
      }
      position += bytesRead;
    }

    let currentMetadata;
    try {
      currentMetadata = await lstat(approvedSource.path);
    } catch (error) {
      throw new Error(
        `Transfer source changed during handoff build: ${approvedSource.relativePath}`,
        { cause: error }
      );
    }
    if (
      currentMetadata.isSymbolicLink()
      || !currentMetadata.isFile()
      || !sourceIdentityMatches(approvedSource.metadata, currentMetadata)
    ) {
      throw new Error(`Transfer source changed during handoff build: ${approvedSource.relativePath}`);
    }
  } finally {
    await destinationHandle?.close();
    await sourceHandle?.close();
  }
}

export async function publishStagingNoClobber({
  usbRoot,
  stagingPath,
  handoffRoot
}) {
  const root = path.resolve(usbRoot);
  const staging = assertPathWithin(root, stagingPath);
  const handoff = assertPathWithin(root, handoffRoot);
  if (
    path.dirname(staging) !== root
    || !path.basename(staging).startsWith(`${HANDOFF_NAME}.partial-`)
    || path.dirname(handoff) !== root
    || path.basename(handoff) !== HANDOFF_NAME
  ) {
    throw new Error("Refusing to publish invalid USB handoff paths.");
  }

  if (process.platform === "win32") {
    try {
      await rename(staging, handoff);
      return;
    } catch (error) {
      if (await pathExists(handoff)) {
        throw new Error(`${HANDOFF_NAME} already exists; this builder will not overwrite it.`);
      }
      throw error;
    }
  }

  if (process.platform !== "linux") {
    throw new Error(`Atomic no-clobber publication is unsupported on ${process.platform}.`);
  }
  const moveArguments = [
    "--no-clobber",
    "--no-target-directory",
    "--",
    staging,
    handoff
  ];
  try {
    await execFileAsync("mv", moveArguments, { windowsHide: true });
  } catch (error) {
    if (await pathExists(staging) && await pathExists(handoff)) {
      throw new Error(`${HANDOFF_NAME} already exists; this builder will not overwrite it.`);
    }
    throw error;
  }
  if (await pathExists(staging)) {
    if (await pathExists(handoff)) {
      throw new Error(`${HANDOFF_NAME} already exists; this builder will not overwrite it.`);
    }
    throw new Error(`No-clobber publication did not move the staged handoff: ${staging}`);
  }
}

export async function buildUsbHandoff({
  usbRoot,
  sourceRoot = repositoryRoot
}) {
  if (!path.isAbsolute(usbRoot || "")) {
    throw new Error("USB root must be an absolute path.");
  }

  const root = path.resolve(usbRoot);
  const source = path.resolve(sourceRoot);
  await requireDirectory(root, "USB root");
  await requireDirectory(source, "Source root");

  const handoffRoot = assertPathWithin(root, path.join(root, HANDOFF_NAME));
  if (await pathExists(handoffRoot)) {
    throw new Error(`${HANDOFF_NAME} already exists; this builder will not overwrite it.`);
  }

  let stagingPath;
  try {
    stagingPath = await mkdtemp(path.join(root, `${HANDOFF_NAME}.partial-`));
    stagingPath = assertPathWithin(root, stagingPath);

    for (const relativeDirectory of CHILD_DIRECTORIES) {
      await mkdir(path.join(stagingPath, relativeDirectory));
    }

    const approvedSources = [];
    for (const [sourceRelativePath, destinationRelativePath] of TRANSFER_FILES) {
      const sourcePath = assertPathWithin(
        source,
        path.join(source, ...sourceRelativePath.split("/"))
      );
      const sourceMetadata = await lstat(sourcePath);
      if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isFile()) {
        throw new Error(`Transfer source is not a regular file: ${sourceRelativePath}`);
      }
      assertFat32CompatibleSize(sourceMetadata.size, sourceRelativePath);
      approvedSources.push({
        path: sourcePath,
        relativePath: sourceRelativePath,
        destinationRelativePath,
        metadata: sourceMetadata
      });
    }

    const outboundPaths = [];
    for (const approvedSource of approvedSources) {
      const destinationPath = assertPathWithin(
        stagingPath,
        path.join(stagingPath, ...approvedSource.destinationRelativePath.split("/"))
      );
      await copyApprovedSource(approvedSource, destinationPath);
      const copiedMetadata = await lstat(destinationPath);
      if (!copiedMetadata.isFile() || copiedMetadata.isSymbolicLink()) {
        throw new Error(`Copied artifact is not a regular file: ${approvedSource.destinationRelativePath}`);
      }
      assertFat32CompatibleSize(copiedMetadata.size, approvedSource.destinationRelativePath);
      outboundPaths.push(approvedSource.destinationRelativePath);
    }

    const stagingManifestPath = path.join(stagingPath, "CHECKSUMS", "TO-DEBIAN.sha256");
    await writeSha256Manifest({
      rootPath: stagingPath,
      relativePaths: outboundPaths,
      manifestPath: stagingManifestPath
    });
    const files = await verifySha256Manifest({
      rootPath: stagingPath,
      manifestPath: stagingManifestPath
    });

    await publishStagingNoClobber({ usbRoot: root, stagingPath, handoffRoot });
    stagingPath = undefined;

    return {
      handoffRoot,
      manifestPath: path.join(handoffRoot, "CHECKSUMS", "TO-DEBIAN.sha256"),
      files
    };
  } catch (error) {
    if (stagingPath) {
      await removeValidatedStaging(root, stagingPath);
    }
    throw error;
  }
}

function parseCliArguments(args) {
  if (args.length !== 2 || args[0] !== "--usb-root" || !args[1]) {
    throw new Error("Usage: node scripts/migration/build-usb-handoff.mjs --usb-root <absolute drive root>");
  }
  return { usbRoot: args[1] };
}

const invokedDirectly = Boolean(
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath)
);

if (invokedDirectly) {
  try {
    const result = await buildUsbHandoff(parseCliArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
