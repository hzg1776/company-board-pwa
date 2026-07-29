import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
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
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

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

test("Debian collector has a fixed read-only inspection contract", async () => {
  const script = await readFile(
    new URL("../scripts/migration/collect-debian-readiness.sh", import.meta.url),
    "utf8"
  );

  assert.match(script, /^#!\/usr\/bin\/env bash/m);
  assert.match(script, /set -[A-Za-z]*u[A-Za-z]*o pipefail/);
  assert.match(script, /FROM-DEBIAN/);
  assert.match(script, /mktemp/);
  assert.match(script, /mv -- "\$REPORT_TEMP" "\$REPORT_FINAL"/);
  assert.match(script, /sha256sum/);
  assert.match(script, /ss -H -lntu/);
  assert.doesNotMatch(script, /\bss\b[^\n]*-[^\n]*p/);
  assert.doesNotMatch(script, /\b(?:sudo|apt|apt-get|systemctl\s+(?:start|stop|restart|enable|disable)|ufw\s+(?:allow|deny|enable|disable)|chmod\s+\/|chown\s+\/)\b/);
  assert.doesNotMatch(script, /(?:\/etc\/palziv\/palziv\.env|\/proc\/[^\s"']*cmdline|journalctl|\.bash_history|security\.json|push\.json|board\.json|analytics\.json)/);
  assert.doesNotMatch(script, /(?:\bprintenv\b|^\s*env(?:\s|$)|systemctl\s+cat|systemctl\s+show[^\n]*ExecStart|^\s*ps(?:\s|$))/m);
});

test("Debian collector writes only a redacted report and sidecar under FROM-DEBIAN", {
  skip: process.platform === "win32" ? "Runtime collector check runs on a POSIX host." : false
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-collector-"));
  try {
    await mkdir(path.join(root, "TO-DEBIAN"));
    await mkdir(path.join(root, "FROM-DEBIAN"));
    const collector = path.join(root, "TO-DEBIAN", "collect-debian-readiness.sh");
    await copyFile(new URL("../scripts/migration/collect-debian-readiness.sh", import.meta.url), collector);
    const result = await run("bash", [collector, "--usb-root", root], {
      env: { ...process.env, RESEND_API_KEY: "collector-must-not-read-this" }
    });
    assert.equal(result.code, 0, result.stderr);
    const rootEntries = (await readdir(root)).sort();
    assert.deepEqual(rootEntries, ["FROM-DEBIAN", "TO-DEBIAN"]);
    const returned = (await readdir(path.join(root, "FROM-DEBIAN"))).sort();
    assert.equal(returned.length, 2);
    const reportName = returned.find((name) => name.endsWith(".txt"));
    assert.ok(reportName);
    assert.ok(returned.includes(`${reportName}.sha256`));
    const report = await readFile(path.join(root, "FROM-DEBIAN", reportName), "utf8");
    assert.doesNotMatch(report, /collector-must-not-read-this/);
    assert.equal(scanReturnedReport(report).ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Debian collector fails without leaving partial files when FROM-DEBIAN is invalid", {
  skip: process.platform === "win32" ? "Runtime collector check runs on a POSIX host." : false
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-collector-fail-"));
  try {
    await mkdir(path.join(root, "TO-DEBIAN"));
    await writeFile(path.join(root, "FROM-DEBIAN"), "not a directory\n");
    const collector = path.join(root, "TO-DEBIAN", "collect-debian-readiness.sh");
    await copyFile(new URL("../scripts/migration/collect-debian-readiness.sh", import.meta.url), collector);
    const result = await run("bash", [collector, "--usb-root", root]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /FROM-DEBIAN.*directory/i);
    assert.deepEqual((await readdir(path.join(root, "TO-DEBIAN"))).sort(), ["collect-debian-readiness.sh"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
