import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const RUNTIME_FILES = ["analytics.json", "board.json", "push.json", "security.json"];

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      ...options,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function createRuntimeData(dataDir) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "analytics.json"), `${JSON.stringify({ totals: { requests: 4 } }, null, 2)}\n`);
  await writeFile(path.join(dataDir, "board.json"), `${JSON.stringify({ posts: [{ id: "notice-1" }] }, null, 2)}\n`);
  await writeFile(path.join(dataDir, "push.json"), `${JSON.stringify({ vapid: { publicKey: "preserve-me" }, subscriptions: [] }, null, 2)}\n`);
  await writeFile(path.join(dataDir, "security.json"), `${JSON.stringify({ users: [], sessions: [] }, null, 2)}\n`);
  await writeFile(path.join(dataDir, "board.json.stale.tmp"), "must not be archived\n");
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

test("Linux backup archives only canonical runtime JSON and writes verifiable hashes", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "palziv-linux-backup-"));
  const dataDir = path.join(tempRoot, "data");
  const outputDir = path.join(tempRoot, "backups");

  try {
    await createRuntimeData(dataDir);
    const result = await run(process.execPath, [
      "scripts/linux/backup-runtime.mjs",
      "--data-dir", dataDir,
      "--output-dir", outputDir,
      "--release-sha", "migration-test-sha",
      "--daily-retention", "14",
      "--weekly-retention", "8"
    ]);

    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(result.stdout.trim());
    const archive = await readFile(summary.archivePath);
    const sidecar = JSON.parse(await readFile(summary.manifestPath, "utf8"));
    const listing = await run("tar", ["-tzf", summary.archivePath]);

    assert.equal(listing.code, 0, listing.stderr);
    assert.deepEqual(
      listing.stdout.trim().split(/\r?\n/).sort(),
      ["data/analytics.json", "data/board.json", "data/push.json", "data/security.json", "manifest.json"].sort()
    );
    assert.equal(sidecar.archiveSha256, sha256(archive));
    assert.equal(sidecar.releaseSha, "migration-test-sha");
    assert.deepEqual(Object.keys(sidecar.files).sort(), RUNTIME_FILES);
    assert.equal(sidecar.files["push.json"].sha256.length, 64);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Linux backup refuses invalid runtime JSON without creating an archive", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "palziv-linux-backup-invalid-"));
  const dataDir = path.join(tempRoot, "data");
  const outputDir = path.join(tempRoot, "backups");

  try {
    await createRuntimeData(dataDir);
    await writeFile(path.join(dataDir, "analytics.json"), "{not-json\n");
    const result = await run(process.execPath, [
      "scripts/linux/backup-runtime.mjs",
      "--data-dir", dataDir,
      "--output-dir", outputDir
    ]);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /analytics\.json is not valid JSON/i);
    const entries = await readdir(outputDir).catch(() => []);
    assert.equal(entries.some((entry) => entry.endsWith(".tar.gz")), false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Linux restore verifies and atomically restores the four runtime stores", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "palziv-linux-restore-"));
  const sourceDataDir = path.join(tempRoot, "source-data");
  const outputDir = path.join(tempRoot, "backups");
  const restoreDataDir = path.join(tempRoot, "restored-data");

  try {
    await createRuntimeData(sourceDataDir);
    const backupResult = await run(process.execPath, [
      "scripts/linux/backup-runtime.mjs",
      "--data-dir", sourceDataDir,
      "--output-dir", outputDir
    ]);
    assert.equal(backupResult.code, 0, backupResult.stderr);
    const backup = JSON.parse(backupResult.stdout.trim());

    const restoreResult = await run(process.execPath, [
      "scripts/linux/restore-runtime.mjs",
      "--archive", backup.archivePath,
      "--data-dir", restoreDataDir
    ]);

    assert.equal(restoreResult.code, 0, restoreResult.stderr);
    const summary = JSON.parse(restoreResult.stdout.trim());
    assert.deepEqual(summary.restoredFiles.sort(), RUNTIME_FILES);
    assert.deepEqual((await readdir(restoreDataDir)).sort(), RUNTIME_FILES);

    for (const fileName of RUNTIME_FILES) {
      const source = JSON.parse(await readFile(path.join(sourceDataDir, fileName), "utf8"));
      const restored = JSON.parse(await readFile(path.join(restoreDataDir, fileName), "utf8"));
      assert.deepEqual(restored, source);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
