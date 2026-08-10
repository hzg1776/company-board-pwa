#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { createRuntimeBackup, RUNTIME_FILES } from "../linux/runtime-backup-lib.mjs";
import { TWO_PHASE_PHASE_ID, verifyTwoPhaseUsb } from "./two-phase-usb-lib.mjs";

const execFile = promisify(execFileCallback);
const FINAL_FILES = Object.freeze({
  "runtime.tar.gz.age": "runtimeArchive",
  "production-env.age": "productionEnv",
  "cloudflared-credential.age": "cloudflaredCredential",
  "cloudflared-config.age": "cloudflaredConfig"
});

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function requireRegularFile(candidate, label) {
  const resolved = path.resolve(candidate);
  const metadata = await lstat(resolved);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be an absolute regular file`);
  }
  if (!path.isAbsolute(candidate)) {
    throw new Error(`${label} must be an absolute regular file`);
  }
  return resolved;
}

async function encryptFile({ ageExecutable, recipient, source, destination }) {
  const partial = `${destination}.partial`;
  await rm(partial, { force: true });
  try {
    await execFile(ageExecutable, ["--encrypt", "--recipient", recipient, "--output", partial, source], {
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
    await rename(partial, destination);
  } finally {
    await rm(partial, { force: true });
  }
}

export async function prepareTwoPhaseCutover({
  bundleRoot,
  runtimeDataDir,
  productionEnvPath,
  cloudflaredCredentialPath,
  cloudflaredConfigPath,
  ageExecutable,
  authorizeCutover = false,
  releaseSha = "windows-source"
}) {
  if (!authorizeCutover) {
    throw new Error("Explicit cutover authorization is required before source freeze");
  }
  const root = path.resolve(bundleRoot);
  await verifyTwoPhaseUsb({ bundleRoot: root, mode: "staged-return" });
  const finalRoot = path.join(root, "FINAL-ENCRYPTED");
  if ((await readdir(finalRoot)).length !== 0) {
    throw new Error("FINAL-ENCRYPTED must be empty before cutover preparation");
  }
  const recipientFile = await readFile(path.join(root, "FROM-DEBIAN", "age-recipient.txt"), "utf8");
  const recipient = recipientFile.trim();
  if (!/^age1[ac-hj-np-z02-9]{58}$/.test(recipient)) {
    throw new Error("The Debian age recipient is invalid");
  }
  const stageReceipt = await readFile(path.join(root, "FROM-DEBIAN", "STAGE-SUCCESS.json"));
  const parsedStageReceipt = JSON.parse(stageReceipt.toString("utf8"));

  const dataRoot = path.resolve(runtimeDataDir);
  const dataMetadata = await lstat(dataRoot);
  if (!path.isAbsolute(runtimeDataDir) || dataMetadata.isSymbolicLink() || !dataMetadata.isDirectory()) {
    throw new Error("Runtime data directory must be an absolute real directory");
  }
  const entries = await readdir(dataRoot, { withFileTypes: true });
  for (const fileName of RUNTIME_FILES) {
    const entry = entries.find((candidate) => candidate.name === fileName);
    if (!entry || !entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Runtime file is missing or unsafe: ${fileName}`);
    }
  }

  const inputs = {
    productionEnv: await requireRegularFile(productionEnvPath, "Production environment"),
    cloudflaredCredential: await requireRegularFile(cloudflaredCredentialPath, "Cloudflared credential"),
    cloudflaredConfig: await requireRegularFile(cloudflaredConfigPath, "Cloudflared config")
  };
  const agePath = await requireRegularFile(ageExecutable, "age executable");
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "project-a-cutover-"));

  try {
    const backup = await createRuntimeBackup({
      dataDir: dataRoot,
      outputDir: temporaryRoot,
      releaseSha,
      dailyRetention: 1,
      weeklyRetention: 0
    });
    const sources = {
      runtimeArchive: backup.archivePath,
      ...inputs
    };
    const hashes = {};
    for (const [fileName, sourceKey] of Object.entries(FINAL_FILES)) {
      const destination = path.join(finalRoot, fileName);
      await encryptFile({ ageExecutable: agePath, recipient, source: sources[sourceKey], destination });
      hashes[fileName] = sha256(await readFile(destination));
    }

    const authorization = {
      schemaVersion: 1,
      phaseId: TWO_PHASE_PHASE_ID,
      classification: "cutover-authorized",
      releaseSha: parsedStageReceipt.releaseSha,
      sourceReleaseSha: String(releaseSha).slice(0, 80),
      stageReceiptSha256: sha256(stageReceipt),
      ageRecipientSha256: sha256(Buffer.from(`${recipient}\n`)),
      runtimeArchivePlaintextSha256: backup.archiveSha256,
      createdAt: new Date().toISOString()
    };
    await writeFile(path.join(finalRoot, "CUTOVER-AUTHORIZATION.json"), `${JSON.stringify(authorization)}\n`, { flag: "wx" });
    const checksumLines = Object.entries(hashes)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([fileName, hash]) => `${hash}  ${fileName}`);
    await writeFile(path.join(finalRoot, "FINAL-ENCRYPTED.sha256"), `${checksumLines.join("\n")}\n`, { flag: "wx" });
    await verifyTwoPhaseUsb({ bundleRoot: root, mode: "cutover-ready" });
    return { ok: true, phaseId: TWO_PHASE_PHASE_ID, finalEncryptedDir: finalRoot, encryptedFiles: Object.keys(FINAL_FILES).length };
  } catch (error) {
    await rm(finalRoot, { recursive: true, force: true });
    await mkdir(finalRoot);
    throw error;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`);
  return process.argv[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await prepareTwoPhaseCutover({
      bundleRoot: argumentValue("--bundle-root"),
      runtimeDataDir: argumentValue("--runtime-data-dir"),
      productionEnvPath: argumentValue("--production-env"),
      cloudflaredCredentialPath: argumentValue("--cloudflared-credential"),
      cloudflaredConfigPath: argumentValue("--cloudflared-config"),
      ageExecutable: argumentValue("--age-executable"),
      authorizeCutover: process.argv.includes("--authorize-cutover"),
      releaseSha: argumentValue("--release-sha")
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
