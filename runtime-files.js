import crypto from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const UNSAFE_RUNTIME_PATH_ERROR = "ERR_UNSAFE_RUNTIME_PATH";
const RUNTIME_DIRECTORY_MODE = 0o700;
const RUNTIME_FILE_MODE = 0o600;

function unsafeRuntimePathError(message) {
  const error = new Error(message);
  error.code = UNSAFE_RUNTIME_PATH_ERROR;
  return error;
}

export function isUnsafeRuntimePathError(error) {
  return error?.code === UNSAFE_RUNTIME_PATH_ERROR;
}

async function assertNoSymlinkPath(targetPath) {
  const resolvedPath = path.resolve(targetPath);
  const parsed = path.parse(resolvedPath);
  const relativeParts = path
    .relative(parsed.root, resolvedPath)
    .split(path.sep)
    .filter(Boolean);

  let currentPath = parsed.root;

  for (const part of relativeParts) {
    currentPath = path.join(currentPath, part);

    try {
      const stats = await lstat(currentPath);
      if (stats.isSymbolicLink()) {
        throw unsafeRuntimePathError("Runtime data path must not contain symlinks.");
      }
    } catch (error) {
      if (error?.code === "ENOENT") {
        return;
      }

      throw error;
    }
  }
}

async function restrictMode(targetPath, mode) {
  try {
    await chmod(targetPath, mode);
  } catch {
    // Windows ACL hardening is handled by the deployment scripts. POSIX mode
    // hardening still matters for development and non-Windows hosts.
  }
}

export async function ensureRuntimeDirectory(filePath) {
  const directory = path.dirname(path.resolve(filePath));
  await assertNoSymlinkPath(directory);
  await mkdir(directory, { recursive: true, mode: RUNTIME_DIRECTORY_MODE });
  await restrictMode(directory, RUNTIME_DIRECTORY_MODE);
  await assertNoSymlinkPath(directory);
}

export async function readRuntimeTextFile(filePath) {
  await ensureRuntimeDirectory(filePath);
  await assertNoSymlinkPath(filePath);
  return readFile(filePath, "utf8");
}

export async function writeRuntimeJsonFileAtomic(filePath, data) {
  const resolvedPath = path.resolve(filePath);
  await ensureRuntimeDirectory(resolvedPath);
  await assertNoSymlinkPath(resolvedPath);

  const directory = path.dirname(resolvedPath);
  const baseName = path.basename(resolvedPath);
  const tempFile = path.join(directory, `${baseName}.${crypto.randomUUID()}.tmp`);
  let renamed = false;

  try {
    await writeFile(tempFile, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: RUNTIME_FILE_MODE
    });
    await restrictMode(tempFile, RUNTIME_FILE_MODE);
    await rename(tempFile, resolvedPath);
    renamed = true;
    await restrictMode(resolvedPath, RUNTIME_FILE_MODE);
  } finally {
    if (!renamed) {
      await rm(tempFile, { force: true }).catch(() => {});
    }
  }
}
