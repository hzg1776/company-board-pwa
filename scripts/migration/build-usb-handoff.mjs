import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

    const outboundPaths = [];
    for (const [sourceRelativePath, destinationRelativePath] of TRANSFER_FILES) {
      const sourcePath = path.join(source, ...sourceRelativePath.split("/"));
      const destinationPath = assertPathWithin(
        stagingPath,
        path.join(stagingPath, ...destinationRelativePath.split("/"))
      );
      const sourceMetadata = await lstat(sourcePath);
      if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isFile()) {
        throw new Error(`Transfer source is not a regular file: ${sourceRelativePath}`);
      }
      assertFat32CompatibleSize(sourceMetadata.size, sourceRelativePath);
      await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL);
      const copiedMetadata = await lstat(destinationPath);
      if (!copiedMetadata.isFile() || copiedMetadata.isSymbolicLink()) {
        throw new Error(`Copied artifact is not a regular file: ${destinationRelativePath}`);
      }
      assertFat32CompatibleSize(copiedMetadata.size, destinationRelativePath);
      outboundPaths.push(destinationRelativePath);
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

    if (await pathExists(handoffRoot)) {
      throw new Error(`${HANDOFF_NAME} already exists; this builder will not overwrite it.`);
    }
    await rename(stagingPath, handoffRoot);
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
