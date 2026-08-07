import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { buildTwoPhaseUsb } from "../scripts/migration/build-two-phase-usb.mjs";
import {
  TWO_PHASE_PHASE_ID,
  TWO_PHASE_ROOT_NAME,
  verifyTwoPhaseUsb,
  writeTwoPhaseManifest
} from "../scripts/migration/two-phase-usb-lib.mjs";

const execFile = promisify(execFileCallback);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function createOutboundFixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "project-a-two-phase-"));
  const root = path.join(parent, TWO_PHASE_ROOT_NAME);
  await mkdir(path.join(root, "CHECKSUMS"), { recursive: true });
  await mkdir(path.join(root, "PAYLOAD", "release"), { recursive: true });
  await mkdir(path.join(root, "FINAL-ENCRYPTED"));
  await mkdir(path.join(root, "FROM-DEBIAN"));

  const files = new Map([
    ["README-FIRST.txt", "fixture instructions\n"],
    ["1-STAGE-DEBIAN.sh", "#!/usr/bin/env bash\nexit 0\n"],
    ["2-CUTOVER-DEBIAN.sh", "#!/usr/bin/env bash\nexit 0\n"],
    ["ROLLBACK-WINDOWS.ps1", "exit 0\n"],
    [
      "BUNDLE.json",
      `${JSON.stringify({ schemaVersion: 1, phaseId: TWO_PHASE_PHASE_ID, releaseSha: "a".repeat(40) })}\n`
    ],
    ["PAYLOAD/release/package.json", '{"name":"fixture"}\n'],
    ["PAYLOAD/release/server.js", "process.exit(0);\n"]
  ]);

  for (const [relativePath, contents] of files) {
    const destination = path.join(root, ...relativePath.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
  await writeTwoPhaseManifest({ bundleRoot: root });
  return { parent, root };
}

test("two-phase verifier accepts one exact outbound tree", async () => {
  const fixture = await createOutboundFixture();
  try {
    const summary = await verifyTwoPhaseUsb({ bundleRoot: fixture.root, mode: "outbound" });
    assert.deepEqual(summary, {
      ok: true,
      phaseId: TWO_PHASE_PHASE_ID,
      mode: "outbound",
      inboundFiles: 7,
      stageReceipt: null,
      cutoverReceipt: null
    });
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("two-phase verifier rejects plaintext final payloads", async () => {
  const fixture = await createOutboundFixture();
  try {
    await writeFile(path.join(fixture.root, "FINAL-ENCRYPTED", "security.json"), "{}\n");
    await assert.rejects(
      verifyTwoPhaseUsb({ bundleRoot: fixture.root, mode: "outbound" }),
      /FINAL-ENCRYPTED must be empty in outbound mode/i
    );
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("two-phase verifier rejects linked release content", async () => {
  const fixture = await createOutboundFixture();
  try {
    await symlink(
      path.join(fixture.root, "PAYLOAD", "release"),
      path.join(fixture.root, "PAYLOAD", "release", "linked-release"),
      "junction"
    );
    await assert.rejects(
      verifyTwoPhaseUsb({ bundleRoot: fixture.root, mode: "outbound" }),
      /symbolic link|junction/i
    );
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("two-phase verifier rejects changed manifest-covered files", async () => {
  const fixture = await createOutboundFixture();
  try {
    const serverPath = path.join(fixture.root, "PAYLOAD", "release", "server.js");
    const original = await readFile(serverPath);
    assert.equal(sha256(original).length, 64);
    await writeFile(serverPath, "process.exit(9);\n");
    await assert.rejects(
      verifyTwoPhaseUsb({ bundleRoot: fixture.root, mode: "outbound" }),
      /checksum mismatch/i
    );
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("two-phase builder publishes a verified no-clobber bundle", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "project-a-two-phase-builder-"));
  const repository = path.join(parent, "repository");
  const destination = path.join(parent, "destination");
  try {
    await mkdir(path.join(repository, "scripts", "migration"), { recursive: true });
    await mkdir(path.join(repository, "docs"), { recursive: true });
    await mkdir(destination);
    for (const [relativePath, contents] of new Map([
      ["package.json", '{"name":"fixture"}\n'],
      ["server.js", "process.exit(0);\n"],
      ["scripts/migration/1-STAGE-DEBIAN.sh", "#!/usr/bin/env bash\nexit 0\n"],
      ["scripts/migration/2-CUTOVER-DEBIAN.sh", "#!/usr/bin/env bash\nexit 0\n"],
      ["scripts/migration/ROLLBACK-WINDOWS.ps1", "exit 0\n"],
      ["docs/USB-TWO-PHASE-MIGRATION-EASY-INSTRUCTIONS.txt", "fixture instructions\n"]
    ])) {
      const target = path.join(repository, ...relativePath.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents);
    }
    await execFile("git", ["init"], { cwd: repository });
    await execFile("git", ["config", "user.email", "fixture@example.invalid"], { cwd: repository });
    await execFile("git", ["config", "user.name", "Fixture"], { cwd: repository });
    await execFile("git", ["add", "."], { cwd: repository });
    await execFile("git", ["commit", "-m", "fixture"], { cwd: repository });

    const summary = await buildTwoPhaseUsb({ repositoryRoot: repository, destinationRoot: destination });
    assert.equal(summary.ok, true);
    assert.equal(summary.mode, "outbound");
    const finalRoot = path.join(destination, TWO_PHASE_ROOT_NAME);
    assert.equal((await readFile(path.join(finalRoot, "PAYLOAD", "release", "server.js"), "utf8")), "process.exit(0);\n");
    await assert.rejects(
      buildTwoPhaseUsb({ repositoryRoot: repository, destinationRoot: destination }),
      /destination already exists/i
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("two-phase Debian scripts preserve the stage-before-cutover boundary", async () => {
  const stage = await readFile(new URL("../scripts/migration/1-STAGE-DEBIAN.sh", import.meta.url), "utf8");
  const cutover = await readFile(new URL("../scripts/migration/2-CUTOVER-DEBIAN.sh", import.meta.url), "utf8");
  const windowsPrep = await readFile(new URL("../scripts/migration/prepare-two-phase-cutover.ps1", import.meta.url), "utf8");

  assert.match(stage, /ERROR line=%s status=%s command=%q/);
  assert.match(stage, /systemctl disable --now cloudflared\.service/);
  assert.match(stage, /classification:\"staged\"/);
  assert.doesNotMatch(stage, /\baddgroup\b/);
  assert.ok(cutover.indexOf('for route in "${LOCAL_ROUTES[@]}"') < cutover.indexOf("systemctl enable --now cloudflared.service"));
  assert.match(cutover, /classification:\"cutover-complete\"/);
  assert.match(windowsPrep, /Explicit cutover authorization is required/);
});

test("two-phase operator instructions stay short and copy-ready", async () => {
  const instructions = await readFile(new URL("../docs/USB-TWO-PHASE-MIGRATION-EASY-INSTRUCTIONS.txt", import.meta.url), "utf8");
  assert.match(instructions, /Project-A-Migration-Two-Phase\/1-STAGE-DEBIAN\.sh/);
  assert.match(instructions, /STOP\. Do not rerun the script\./);
  assert.match(instructions, /Do not run 2-CUTOVER-DEBIAN\.sh yet\./);
  assert.doesNotMatch(instructions, /<<['"]|\w+\(\)\s*\{/);
});
