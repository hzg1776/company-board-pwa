import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  APPLIANCE_REQUIRED_FILES,
  APPLIANCE_SCHEMA_VERSION,
  artifactDiskName,
  validateBuildManifest,
  verifyApplianceArtifacts
} from "../scripts/appliance/appliance-lib.mjs";

const RELEASE_SHA = "a".repeat(40);
const DISK_CONTENTS = "fixture-qcow2";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function runProcess(command, args, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Process timed out after ${timeoutMs}ms: ${output}`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, output });
    });
  });
}

async function writeFixture(root) {
  const diskName = `palziv-debian13-${RELEASE_SHA}.qcow2`;
  await writeFile(path.join(root, diskName), DISK_CONTENTS);
  await writeFile(path.join(root, "STAGE-SUCCESS.json"), `${JSON.stringify({
    schemaVersion: 1,
    phaseId: "project-a-two-phase-v1",
    classification: "staged",
    releaseSha: RELEASE_SHA,
    nodeVersion: "v24.18.0",
    app: "active",
    cloudflared: "disabled-inactive",
    routeCount: 8,
    completedAt: "2026-08-05T12:00:00Z"
  })}\n`);
  await writeFile(path.join(root, "age-recipient.txt"), `age1${"q".repeat(58)}\n`);
  await writeFile(path.join(root, "VERIFY-LOCAL.json"), '{"classification":"pass"}\n');
  await writeFile(path.join(root, "IMPORT-ON-PROXMOX.sh"), "#!/usr/bin/env bash\nexit 0\n");
  await writeFile(path.join(root, "README-FIRST.txt"), "fixture\n");
  await writeFile(path.join(root, "BUILD-MANIFEST.json"), `${JSON.stringify({
    schemaVersion: 1,
    buildId: "20260805T120000Z-aaaaaaaaaaaa",
    debianImage: {
      url: "https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2",
      sha512: "b".repeat(128),
      bytes: 342032384,
      retrievedAt: "2026-08-05T11:00:00Z"
    },
    releaseSha: RELEASE_SHA,
    nodeVersion: "v24.18.0",
    diskFile: diskName,
    diskSha256: sha256(DISK_CONTENTS),
    diskVirtualSize: 42949672960,
    diskActualSize: Buffer.byteLength(DISK_CONTENTS),
    completedAt: "2026-08-05T12:00:00Z",
    classification: "pass"
  })}\n`);

  const stageFiles = ["STAGE-SUCCESS.json", "age-recipient.txt"];
  await writeFile(path.join(root, "STAGE-SUCCESS.sha256"), `${(await Promise.all(stageFiles.map(async (name) => (
    `${sha256(await readFile(path.join(root, name)))}  ${name}`
  )))).join("\n")}\n`);

  const artifactFiles = [diskName, ...APPLIANCE_REQUIRED_FILES.filter((name) => name !== "ARTIFACTS.sha256")];
  await writeFile(path.join(root, "ARTIFACTS.sha256"), `${(await Promise.all(artifactFiles.map(async (name) => (
    `${sha256(await readFile(path.join(root, name)))}  ${name}`
  )))).join("\n")}\n`);
  return { diskName };
}

test("artifact disk name is derived only from the release SHA", () => {
  assert.equal(artifactDiskName(RELEASE_SHA), `palziv-debian13-${RELEASE_SHA}.qcow2`);
  assert.throws(() => artifactDiskName("main"), /40-character release SHA/i);
});

test("build manifest accepts only the pinned appliance schema", () => {
  const manifest = {
    schemaVersion: APPLIANCE_SCHEMA_VERSION,
    buildId: "20260805T120000Z-aaaaaaaaaaaa",
    debianImage: {
      url: "https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2",
      sha512: "b".repeat(128),
      bytes: 1,
      retrievedAt: "2026-08-05T11:00:00Z"
    },
    releaseSha: RELEASE_SHA,
    nodeVersion: "v24.18.0",
    diskFile: `palziv-debian13-${RELEASE_SHA}.qcow2`,
    diskSha256: "c".repeat(64),
    diskVirtualSize: 42949672960,
    diskActualSize: 1,
    completedAt: "2026-08-05T12:00:00Z",
    classification: "pass"
  };
  assert.equal(validateBuildManifest(manifest), manifest);
  assert.throws(() => validateBuildManifest({ ...manifest, diskFile: "palziv-debian13-main.qcow2" }), /contract/i);
});

test("artifact verifier accepts the exact successful tree and rejects disk tampering", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "palziv-appliance-"));
  try {
    const { diskName } = await writeFixture(root);
    assert.deepEqual(
      await verifyApplianceArtifacts({ artifactRoot: root }),
      { ok: true, releaseSha: RELEASE_SHA, diskFile: diskName, diskSha256: sha256(DISK_CONTENTS) }
    );
    await writeFile(path.join(root, diskName), "changed-qcow2");
    await assert.rejects(verifyApplianceArtifacts({ artifactRoot: root }), /checksum/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact verifier rejects a build manifest whose diskActualSize differs from the QCOW2", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "palziv-appliance-"));
  try {
    await writeFixture(root);
    const manifestPath = path.join(root, "BUILD-MANIFEST.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.diskActualSize += 1;
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await assert.rejects(verifyApplianceArtifacts({ artifactRoot: root }), /actual size/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact verifier rejects no-clobber residue and malformed checksum manifests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "palziv-appliance-"));
  try {
    await writeFixture(root);
    await writeFile(path.join(root, ".BUILD-MANIFEST.json.partial"), "incomplete\n");
    await assert.rejects(verifyApplianceArtifacts({ artifactRoot: root }), /unexpected artifact root tree/i);
    await rm(path.join(root, ".BUILD-MANIFEST.json.partial"));
    await writeFile(path.join(root, "ARTIFACTS.sha256"), "not a manifest\n");
    await assert.rejects(verifyApplianceArtifacts({ artifactRoot: root }), /checksum manifest/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact verifier validates the bounded stage receipt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "palziv-appliance-"));
  try {
    await writeFixture(root);
    const receiptPath = path.join(root, "STAGE-SUCCESS.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    receipt.routeCount = 9;
    await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
    await assert.rejects(verifyApplianceArtifacts({ artifactRoot: root }), /stage receipt/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact verifier rejects a linked build manifest before it can be dereferenced", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "palziv-appliance-"));
  const fifo = path.join(os.tmpdir(), `palziv-appliance-manifest-${process.pid}-${Date.now()}`);
  try {
    await writeFixture(root);
    await runProcess("mkfifo", [fifo]);
    await rm(path.join(root, "BUILD-MANIFEST.json"));
    await symlink(fifo, path.join(root, "BUILD-MANIFEST.json"), "file");
    const result = await runProcess(process.execPath, ["scripts/appliance/verify-local-appliance.mjs", root]);
    assert.notEqual(result.code, 0);
    assert.match(result.output, /BUILD-MANIFEST\.json must not be a symbolic link/i);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(fifo, { force: true });
  }
});
