import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  HOST_PREP_INBOUND_FILES,
  HOST_PREP_MANIFEST_PATH,
  HOST_PREP_PHASE_ID,
  HOST_PREP_ROOT_NAME,
  NODE_PROVENANCE,
  assertTreeSnapshotEqual,
  createPhase2Input,
  manifestFingerprint,
  snapshotRegularTree,
  validatePhase2Input
} from "../scripts/migration/usb-host-prep-lib.mjs";

const PHASE1_REPORT = "debian-readiness-20260730T192552Z-palziv-prod.txt";
const PHASE1_REPORT_SHA = "6170af37d51ee151424dc505ae9537c3e78a381bd6867eeb39a40fbd2634a588";
const PHASE1_MANIFEST_SHA = "a".repeat(64);
const execFile = promisify(execFileCallback);

async function addLinkedContent(root) {
  const manifestPath = path.join(root, "manifest.sha256");
  const linkPath = path.join(root, "linked.txt");
  try {
    await symlink(manifestPath, linkPath);
  } catch (error) {
    if (error?.code !== "EPERM" || process.platform !== "win32") throw error;
    const junctionTarget = path.join(root, "junction-target");
    await mkdir(junctionTarget);
    await writeFile(path.join(junctionTarget, "manifest.sha256"), "safe\n");
    await execFile("powershell.exe", [
      "-NoProfile",
      "-Command",
      `New-Item -ItemType Junction -Path '${linkPath}' -Target '${junctionTarget}' | Out-Null`
    ]);
  }
}

async function replaceDirectoryWithLink(directoryPath, targetPath) {
  await rm(directoryPath, { recursive: true, force: true });
  try {
    await symlink(targetPath, directoryPath, "dir");
  } catch (error) {
    if (error?.code !== "EPERM" || process.platform !== "win32") throw error;
    await execFile("powershell.exe", [
      "-NoProfile",
      "-Command",
      `New-Item -ItemType Junction -Path '${directoryPath}' -Target '${targetPath}' | Out-Null`
    ]);
  }
}

test("host prep profile pins exact names, files, and Node provenance", () => {
  assert.equal(HOST_PREP_ROOT_NAME, "Project-A-Migration-Phase-2-Host-Prep");
  assert.equal(HOST_PREP_PHASE_ID, "debian-host-prep-v1");
  assert.equal(HOST_PREP_MANIFEST_PATH, "CHECKSUMS/PHASE-2-HOST-PREP.sha256");
  assert.deepEqual(HOST_PREP_INBOUND_FILES, [
    "ISOLATION-BOUNDARY.txt",
    "PHASE-2-INPUT.json",
    "README-FIRST.txt",
    "TO-DEBIAN/apply-host-prep.sh",
    "TO-DEBIAN/collect-host-prep-evidence.sh",
    "TO-DEBIAN/preflight-host-prep.sh"
  ]);
  assert.deepEqual(NODE_PROVENANCE, {
    version: "v24.18.0",
    archiveFileName: "node-v24.18.0-linux-x64.tar.xz",
    archiveUrl: "https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz",
    archiveSha256: "55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742",
    releaseKeysCommit: "b28073028e6d6855cfb53bf7fa0137599c01f967"
  });
});

test("phase 2 input accepts only the exact metadata-only schema", () => {
  const input = createPhase2Input({
    reportFileName: PHASE1_REPORT,
    reportSha256: PHASE1_REPORT_SHA,
    phase1ManifestSha256: PHASE1_MANIFEST_SHA
  });
  assert.deepEqual(validatePhase2Input(input), input);
  assert.throws(
    () => validatePhase2Input({ ...input, secret: "must-not-exist" }),
    /unexpected phase 2 input field/i
  );
  assert.throws(
    () => validatePhase2Input({
      ...input,
      phase1: { ...input.phase1, reportSha256: "bad" }
    }),
    /report sha-256/i
  );
  const missingNode = { ...input };
  delete missingNode.node;
  assert.throws(() => validatePhase2Input(missingNode), /unexpected phase 2 input field/i);
  assert.throws(
    () => validatePhase2Input({ ...input, phase1: { ...input.phase1, extra: true } }),
    /unexpected phase 2 input field/i
  );
  assert.throws(
    () => validatePhase2Input({ ...input, phase1: { ...input.phase1, reportFileName: "report.txt" } }),
    /report file name/i
  );
  assert.throws(
    () => validatePhase2Input({ ...input, phase1: { ...input.phase1, outboundManifestSha256: PHASE1_MANIFEST_SHA.toUpperCase() } }),
    /SHA-256/i
  );
  assert.throws(
    () => validatePhase2Input({ ...input, node: { ...input.node, version: "v0.0.0" } }),
    /Node provenance/i
  );
});

test("tree snapshots include empty directories and detect every Phase 1 change", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-a-phase1-snapshot-"));
  try {
    await mkdir(path.join(root, "empty"));
    await writeFile(path.join(root, "evidence.txt"), "verified\n");
    const before = await snapshotRegularTree(root);
    assert.deepEqual(before.map((entry) => [entry.path, entry.type]), [
      ["empty", "directory"],
      ["evidence.txt", "file"]
    ]);
    assert.doesNotThrow(() => assertTreeSnapshotEqual(before, before));
    await writeFile(path.join(root, "evidence.txt"), "changed\n");
    const after = await snapshotRegularTree(root);
    assert.throws(() => assertTreeSnapshotEqual(before, after), /Phase 1 changed/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tree snapshot comparison canonicalizes approved entry keys", () => {
  const snapshot = [{ path: "evidence.txt", type: "file", size: 5, sha256: "b".repeat(64) }];
  const reorderedKeys = [{ sha256: "b".repeat(64), size: 5, type: "file", path: "evidence.txt" }];
  assert.doesNotThrow(() => assertTreeSnapshotEqual(snapshot, reorderedKeys));
  assert.throws(
    () => assertTreeSnapshotEqual(snapshot, [{ path: "evidence.txt", type: "file", size: 6, sha256: "b".repeat(64) }]),
    /Phase 1 changed while building the host-prep bundle\./
  );
  const orderedSnapshot = [
    { path: "empty", type: "directory", size: 0, sha256: null },
    { path: "evidence.txt", type: "file", size: 5, sha256: "b".repeat(64) }
  ];
  assert.throws(
    () => assertTreeSnapshotEqual(orderedSnapshot, [...orderedSnapshot].reverse()),
    /Phase 1 changed while building the host-prep bundle\./
  );
});

test("tree snapshots fail closed when an approved directory is swapped before traversal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-a-phase1-directory-race-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "project-a-phase1-outside-"));
  const approvedDirectory = path.join(root, "approved");
  const originalReaddir = fs.promises.readdir;
  let swapped = false;
  try {
    await mkdir(approvedDirectory);
    await writeFile(path.join(approvedDirectory, "approved.txt"), "approved\n");
    await writeFile(path.join(outside, "attacker.txt"), "outside\n");
    fs.promises.readdir = async (directoryPath, ...args) => {
      if (!swapped && path.resolve(directoryPath) === approvedDirectory) {
        swapped = true;
        await replaceDirectoryWithLink(approvedDirectory, outside);
      }
      return originalReaddir(directoryPath, ...args);
    };
    syncBuiltinESMExports();
    await assert.rejects(
      snapshotRegularTree(root),
      /Phase 1 directory changed while snapshotting\./
    );
    assert.equal(swapped, true);
  } finally {
    fs.promises.readdir = originalReaddir;
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("tree snapshots reject linked content and manifest fingerprints hash raw bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-a-phase1-linked-"));
  try {
    await writeFile(path.join(root, "manifest.sha256"), "safe\r\n");
    assert.equal(
      await manifestFingerprint(path.join(root, "manifest.sha256")),
      "e57826a3cd819c880c5c695c5634ac55ba2b664c128516e8d0a7d942318c2959"
    );
    await addLinkedContent(root);
    await assert.rejects(snapshotRegularTree(root), /link|junction/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
