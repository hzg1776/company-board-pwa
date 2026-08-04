#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  lstat,
  mkdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import {
  TWO_PHASE_PHASE_ID,
  TWO_PHASE_ROOT_NAME,
  verifyTwoPhaseUsb,
  writeTwoPhaseManifest
} from "./two-phase-usb-lib.mjs";

const execFile = promisify(execFileCallback);
const EXCLUDED = /^(?:\.agents|\.git|\.github|\.worktrees|node_modules|local-secrets|runtime|backups|test|docs\/superpowers|docs\/manual-artifacts|scripts\/migration|scripts\/proxmox)(?:\/|$)|^(?:analytics|board|push|security)\.json$/;

async function trackedFiles(repositoryRoot, releaseSha) {
  const { stdout } = await execFile("git", ["-C", repositoryRoot, "ls-tree", "-r", "-z", "--name-only", releaseSha], { encoding: "buffer" });
  return stdout.toString("utf8").split("\0").filter(Boolean).map((entry) => entry.split(path.sep).join("/")).filter((entry) => !EXCLUDED.test(entry));
}

async function copyCommitted(repositoryRoot, releaseSha, relativePath, destination) {
  const { stdout } = await execFile("git", ["-C", repositoryRoot, "show", `${releaseSha}:${relativePath}`], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024
  });
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, stdout, { flag: "wx" });
}

export async function buildTwoPhaseUsb({ repositoryRoot, destinationRoot }) {
  const repository = path.resolve(repositoryRoot);
  const destination = path.resolve(destinationRoot);
  const releaseSha = (await execFile("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
  const finalRoot = path.join(destination, TWO_PHASE_ROOT_NAME);
  const partialParent = path.join(destination, `.${TWO_PHASE_ROOT_NAME}.publish-${process.pid}`);
  const partialRoot = path.join(partialParent, TWO_PHASE_ROOT_NAME);
  if ((await lstat(finalRoot).catch(() => null)) || (await lstat(partialParent).catch(() => null))) {
    throw new Error("Two-phase destination already exists");
  }

  try {
    await mkdir(path.join(partialRoot, "CHECKSUMS"), { recursive: true });
    await mkdir(path.join(partialRoot, "PAYLOAD", "release"), { recursive: true });
    await mkdir(path.join(partialRoot, "FINAL-ENCRYPTED"));
    await mkdir(path.join(partialRoot, "FROM-DEBIAN"));

    for (const relativePath of await trackedFiles(repository, releaseSha)) {
      await copyCommitted(repository, releaseSha, relativePath, path.join(partialRoot, "PAYLOAD", "release", ...relativePath.split("/")));
    }
    for (const [sourceName, destinationName] of [
      ["1-STAGE-DEBIAN.sh", "1-STAGE-DEBIAN.sh"],
      ["2-CUTOVER-DEBIAN.sh", "2-CUTOVER-DEBIAN.sh"],
      ["ROLLBACK-WINDOWS.ps1", "ROLLBACK-WINDOWS.ps1"]
    ]) {
      await copyCommitted(repository, releaseSha, `scripts/migration/${sourceName}`, path.join(partialRoot, destinationName));
    }
    await copyCommitted(
      repository,
      releaseSha,
      "docs/USB-TWO-PHASE-MIGRATION-EASY-INSTRUCTIONS.txt",
      path.join(partialRoot, "README-FIRST.txt")
    );
    await writeFile(
      path.join(partialRoot, "BUNDLE.json"),
      `${JSON.stringify({ schemaVersion: 1, phaseId: TWO_PHASE_PHASE_ID, releaseSha })}\n`
    );
    await writeTwoPhaseManifest({ bundleRoot: partialRoot });
    await verifyTwoPhaseUsb({ bundleRoot: partialRoot, mode: "outbound" });
    await rename(partialRoot, finalRoot);
    await rm(partialParent, { recursive: true, force: true });
    return verifyTwoPhaseUsb({ bundleRoot: finalRoot, mode: "outbound" });
  } catch (error) {
    await rm(partialParent, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}`) {
  try {
    const repositoryIndex = process.argv.indexOf("--repository-root");
    const destinationIndex = process.argv.indexOf("--destination-root");
    const summary = await buildTwoPhaseUsb({
      repositoryRoot: process.argv[repositoryIndex + 1],
      destinationRoot: process.argv[destinationIndex + 1]
    });
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
