import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";

export const RUNTIME_FILES = Object.freeze([
  "analytics.json",
  "board.json",
  "push.json",
  "security.json"
]);

export function parseArguments(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith("--")) {
      throw new Error(`Unexpected argument: ${entry}`);
    }

    const key = entry.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }

    args[key] = value;
    index += 1;
  }

  return args;
}

export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

export async function runTar(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`tar failed with exit code ${code}: ${stderr.trim()}`));
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

export async function readAndValidateRuntimeFiles(dataDir) {
  const files = {};

  for (const fileName of RUNTIME_FILES) {
    const filePath = path.join(dataDir, fileName);
    let content;

    try {
      content = await readFile(filePath);
    } catch (error) {
      throw new Error(`${fileName} is missing or unreadable: ${error.message}`);
    }

    try {
      JSON.parse(content.toString("utf8"));
    } catch {
      throw new Error(`${fileName} is not valid JSON`);
    }

    files[fileName] = {
      content,
      sha256: sha256(content),
      size: content.length
    };
  }

  return files;
}

export function backupStem(date = new Date()) {
  const timestamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "-");
  return `palziv-runtime-${timestamp}`;
}

function isoWeekKey(date) {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc - yearStart) / 86_400_000) + 1) / 7);
  return `${utc.getUTCFullYear()}-${String(week).padStart(2, "0")}`;
}

export async function pruneBackups(outputDir, dailyRetention, weeklyRetention) {
  const entries = await readdir(outputDir, { withFileTypes: true });
  const archives = [];

  for (const entry of entries) {
    if (!entry.isFile() || !/^palziv-runtime-.*\.tar\.gz$/.test(entry.name)) {
      continue;
    }

    const filePath = path.join(outputDir, entry.name);
    const metadata = await stat(filePath);
    archives.push({ filePath, name: entry.name, modifiedAt: metadata.mtime });
  }

  archives.sort((left, right) => right.modifiedAt - left.modifiedAt);
  const keep = new Set(archives.slice(0, Math.max(0, dailyRetention)).map((entry) => entry.filePath));
  const weekly = new Set();

  for (const archive of archives) {
    if (weekly.size >= Math.max(0, weeklyRetention)) {
      break;
    }

    const week = isoWeekKey(archive.modifiedAt);
    if (!weekly.has(week)) {
      weekly.add(week);
      keep.add(archive.filePath);
    }
  }

  for (const archive of archives) {
    if (keep.has(archive.filePath)) {
      continue;
    }

    await rm(archive.filePath, { force: true });
    await rm(archive.filePath.replace(/\.tar\.gz$/, ".manifest.json"), { force: true });
  }
}

export async function createRuntimeBackup({
  dataDir,
  outputDir,
  releaseSha = "unknown",
  dailyRetention = 14,
  weeklyRetention = 8,
  now = new Date()
}) {
  if (!dataDir || !outputDir) {
    throw new Error("Both dataDir and outputDir are required");
  }

  const files = await readAndValidateRuntimeFiles(dataDir);
  await mkdir(outputDir, { recursive: true });
  const stagingRoot = await mkdtemp(path.join(outputDir, ".palziv-backup-"));
  const stagingData = path.join(stagingRoot, "data");
  const stem = backupStem(now);
  const archivePath = path.join(outputDir, `${stem}.tar.gz`);
  const partialArchivePath = `${archivePath}.partial`;
  const manifestPath = path.join(outputDir, `${stem}.manifest.json`);
  const partialManifestPath = `${manifestPath}.partial`;

  try {
    await mkdir(stagingData, { recursive: true });
    const manifestFiles = {};

    for (const fileName of RUNTIME_FILES) {
      const targetPath = path.join(stagingData, fileName);
      await writeFile(targetPath, files[fileName].content, { mode: 0o600 });
      manifestFiles[fileName] = {
        sha256: files[fileName].sha256,
        size: files[fileName].size
      };
    }

    const manifest = {
      formatVersion: 1,
      createdAt: now.toISOString(),
      releaseSha: String(releaseSha || "unknown").slice(0, 80),
      files: manifestFiles
    };
    await writeFile(path.join(stagingRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await runTar([
      "-czf",
      partialArchivePath,
      "-C",
      stagingRoot,
      ...RUNTIME_FILES.map((fileName) => `data/${fileName}`),
      "manifest.json"
    ]);
    await rename(partialArchivePath, archivePath);

    const archiveContent = await readFile(archivePath);
    const sidecar = {
      ...manifest,
      archiveFile: path.basename(archivePath),
      archiveSha256: sha256(archiveContent)
    };
    await writeFile(partialManifestPath, `${JSON.stringify(sidecar, null, 2)}\n`, { mode: 0o600 });
    await rename(partialManifestPath, manifestPath);
    await pruneBackups(outputDir, dailyRetention, weeklyRetention);

    return {
      archivePath,
      manifestPath,
      files: RUNTIME_FILES.length,
      archiveSha256: sidecar.archiveSha256
    };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
    await rm(partialArchivePath, { force: true });
    await rm(partialManifestPath, { force: true });
  }
}

export async function restoreRuntimeBackup({ archivePath, dataDir, force = false }) {
  if (!archivePath || !dataDir) {
    throw new Error("Both archivePath and dataDir are required");
  }

  const manifestPath = archivePath.replace(/\.tar\.gz$/, ".manifest.json");
  if (manifestPath === archivePath) {
    throw new Error("Backup archive must end with .tar.gz");
  }

  const archiveContent = await readFile(archivePath);
  const sidecar = JSON.parse(await readFile(manifestPath, "utf8"));
  if (sidecar.archiveSha256 !== sha256(archiveContent)) {
    throw new Error("Backup archive SHA-256 does not match its manifest");
  }

  const listing = await runTar(["-tzf", archivePath]);
  const entries = listing.stdout.trim().split(/\r?\n/).filter(Boolean).sort();
  const expected = ["manifest.json", ...RUNTIME_FILES.map((fileName) => `data/${fileName}`)].sort();
  if (JSON.stringify(entries) !== JSON.stringify(expected)) {
    throw new Error(`Backup archive contains unexpected entries: ${entries.join(", ")}`);
  }

  const parentDir = path.dirname(dataDir);
  await mkdir(parentDir, { recursive: true });
  const extractRoot = await mkdtemp(path.join(parentDir, ".palziv-restore-"));
  let previousDataDir = "";

  try {
    await runTar(["-xzf", archivePath, "-C", extractRoot]);
    const embeddedManifest = JSON.parse(await readFile(path.join(extractRoot, "manifest.json"), "utf8"));
    const extractedData = path.join(extractRoot, "data");
    const extractedFiles = await readAndValidateRuntimeFiles(extractedData);

    for (const fileName of RUNTIME_FILES) {
      const expectedFile = embeddedManifest.files?.[fileName];
      if (!expectedFile || expectedFile.sha256 !== extractedFiles[fileName].sha256 || expectedFile.size !== extractedFiles[fileName].size) {
        throw new Error(`${fileName} does not match the embedded backup manifest`);
      }
      if (sidecar.files?.[fileName]?.sha256 !== extractedFiles[fileName].sha256) {
        throw new Error(`${fileName} does not match the external backup manifest`);
      }
      await chmod(path.join(extractedData, fileName), 0o600).catch(() => {});
    }

    const existingEntries = await readdir(dataDir).catch((error) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
    if (existingEntries.length > 0 && !force) {
      throw new Error("Target data directory is not empty; pass --force to preserve it as a pre-restore directory");
    }

    if (existingEntries.length > 0) {
      previousDataDir = `${dataDir}.pre-restore-${Date.now()}`;
      await rename(dataDir, previousDataDir);
    } else {
      await rm(dataDir, { recursive: true, force: true });
    }

    await rename(extractedData, dataDir);
    return {
      archivePath,
      dataDir,
      restoredFiles: [...RUNTIME_FILES],
      previousDataDir: previousDataDir || null,
      releaseSha: embeddedManifest.releaseSha || "unknown"
    };
  } finally {
    await rm(extractRoot, { recursive: true, force: true });
  }
}
