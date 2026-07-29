import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FAT32_MAX_FILE_BYTES,
  assertFat32CompatibleSize,
  assertPathWithin,
  scanReturnedReport,
  sha256File,
  verifySha256Manifest,
  writeSha256Manifest
} from "../scripts/migration/usb-handoff-lib.mjs";

test("USB path checks reject escape and FAT32-incompatible files", () => {
  const root = path.resolve(os.tmpdir(), "project-a-usb-root");
  assert.equal(assertPathWithin(root, path.join(root, "FROM-DEBIAN", "report.txt")), path.join(root, "FROM-DEBIAN", "report.txt"));
  assert.throws(() => assertPathWithin(root, path.resolve(root, "..", "escape.txt")), /outside the handoff root/i);
  assert.doesNotThrow(() => assertFat32CompatibleSize(FAT32_MAX_FILE_BYTES, "allowed.bin"));
  assert.throws(() => assertFat32CompatibleSize(FAT32_MAX_FILE_BYTES + 1, "too-large.bin"), /FAT32/i);
});

test("SHA-256 manifests are sorted, portable, and reject tampering", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-hash-"));
  try {
    await mkdir(path.join(root, "TO-DEBIAN"));
    await writeFile(path.join(root, "README-FIRST.txt"), "read this\n");
    await writeFile(path.join(root, "TO-DEBIAN", "collector.sh"), "#!/usr/bin/env bash\n");
    const manifestPath = path.join(root, "CHECKSUMS", "TO-DEBIAN.sha256");
    await writeSha256Manifest({
      rootPath: root,
      relativePaths: ["TO-DEBIAN/collector.sh", "README-FIRST.txt"],
      manifestPath
    });
    const manifest = await readFile(manifestPath, "utf8");
    assert.equal(manifest, [
      `${createHash("sha256").update("read this\n").digest("hex")}  README-FIRST.txt`,
      `${createHash("sha256").update("#!/usr/bin/env bash\n").digest("hex")}  TO-DEBIAN/collector.sh`,
      ""
    ].join("\n"));
    assert.equal((await verifySha256Manifest({ rootPath: root, manifestPath })).length, 2);
    await writeFile(path.join(root, "README-FIRST.txt"), "tampered\n");
    await assert.rejects(
      verifySha256Manifest({ rootPath: root, manifestPath }),
      /checksum mismatch.*README-FIRST\.txt/i
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest verification rejects absolute and parent-traversal entries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-path-"));
  try {
    await mkdir(path.join(root, "CHECKSUMS"));
    const manifestPath = path.join(root, "CHECKSUMS", "bad.sha256");
    await writeFile(manifestPath, `${"0".repeat(64)}  ../outside.txt\n`);
    await assert.rejects(
      verifySha256Manifest({ rootPath: root, manifestPath }),
      /unsafe manifest path/i
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest writing rejects a symlinked source directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-symlink-source-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-outside-"));
  try {
    await writeFile(path.join(outside, "collector.sh"), "#!/usr/bin/env bash\n");
    await symlink(outside, path.join(root, "TO-DEBIAN"), "junction");
    await assert.rejects(
      writeSha256Manifest({
        rootPath: root,
        relativePaths: ["TO-DEBIAN/collector.sh"],
        manifestPath: path.join(root, "CHECKSUMS", "TO-DEBIAN.sha256")
      }),
      /symbolic link/i
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("manifest writing rejects a symlinked destination directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-symlink-destination-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-outside-"));
  try {
    await writeFile(path.join(root, "README-FIRST.txt"), "read this\n");
    await symlink(outside, path.join(root, "CHECKSUMS"), "junction");
    await assert.rejects(
      writeSha256Manifest({
        rootPath: root,
        relativePaths: ["README-FIRST.txt"],
        manifestPath: path.join(root, "CHECKSUMS", "TO-DEBIAN.sha256")
      }),
      /symbolic link/i
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("manifest writing rejects generated output above the FAT32 artifact limit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-manifest-size-"));
  try {
    await writeFile(path.join(root, "README-FIRST.txt"), "");
    const manifestPath = path.join(root, "CHECKSUMS", "TO-DEBIAN.sha256");
    await assert.rejects(
      writeSha256Manifest({
        rootPath: root,
        relativePaths: ["README-FIRST.txt"],
        manifestPath,
        maxArtifactBytes: 64
      }),
      /FAT32/i
    );
    await assert.rejects(readFile(manifestPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returned-report screening identifies secret-shaped values without echoing them", () => {
  assert.deepEqual(scanReturnedReport("Hostname: palziv-prod\nNode: v24.8.0\n"), {
    ok: true,
    findings: []
  });
  const screened = scanReturnedReport([
    "RESEND_API_KEY=do-not-repeat-this-value",
    "Authorization: Bearer do-not-repeat-this-token",
    "-----BEGIN OPENSSH PRIVATE KEY-----"
  ].join("\n"));
  assert.equal(screened.ok, false);
  assert.deepEqual(screened.findings.map((entry) => entry.line), [1, 2, 3]);
  assert.deepEqual(screened.findings.map((entry) => entry.rule), [
    "secret-assignment",
    "authorization-value",
    "private-key-material"
  ]);
  assert.doesNotMatch(JSON.stringify(screened), /do-not-repeat-this/);
});
