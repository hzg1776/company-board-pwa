import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
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

async function waitForFile(filePath) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await readFile(filePath);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForStagingFile(usbRoot, relativePath) {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const stagingName = (await readdir(usbRoot))
      .find((name) => name.startsWith("Project-A-Migration.partial-"));
    if (stagingName) {
      const candidate = path.join(usbRoot, stagingName, ...relativePath.split("/"));
      try {
        await lstat(candidate);
        return candidate;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Timed out waiting for staging file ${relativePath}`);
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

test("Debian collector fixes curl transport state for approved outbound probes", async () => {
  const script = await readFile(
    new URL("../scripts/migration/collect-debian-readiness.sh", import.meta.url),
    "utf8"
  );
  const curlCalls = script.match(/^\s*run_safe "[^"]+ HTTPS" curl .+$/gm) || [];

  assert.equal(curlCalls.length, 4);
  for (const call of curlCalls) {
    assert.match(call, /curl --disable --noproxy '\*' --proto =https --proto-redir =https/);
  }
  assert.match(script, /unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy/);
  assert.match(script, /unset CURL_HOME XDG_CONFIG_HOME CURL_CA_BUNDLE SSL_CERT_FILE SSL_CERT_DIR SSLKEYLOGFILE/);
});

test("Debian collector contains hostile curl config and proxy state", {
  skip: process.platform === "win32" ? "Runtime collector check runs on a POSIX host." : false
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-curl-containment-"));
  try {
    const fromDir = path.join(root, "FROM-DEBIAN");
    const toDir = path.join(root, "TO-DEBIAN");
    const binDir = path.join(root, "bin");
    const curlHome = path.join(root, "hostile-curl-home");
    const outsideArtifact = path.join(root, "hostile-output.txt");
    await mkdir(toDir);
    await mkdir(fromDir);
    await mkdir(binDir);
    await mkdir(curlHome);
    await writeFile(path.join(curlHome, ".curlrc"), [
      `output = "${outsideArtifact}"`,
      "url = \"file:///etc/hostname\"",
      "header = \"Authorization: Bearer hostile-curlrc-token\""
    ].join("\n"));
    const collector = path.join(toDir, "collect-debian-readiness.sh");
    await copyFile(new URL("../scripts/migration/collect-debian-readiness.sh", import.meta.url), collector);
    const fakeCurl = path.join(binDir, "curl");
    await writeFile(fakeCurl, `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  printf 'curl test version\\n'
  exit 0
fi
if [[ "\${1:-}" != "--disable" || "\${2:-}" != "--noproxy" || "\${3:-}" != "*" || "\${4:-}" != "--proto" || "\${5:-}" != "=https" || "\${6:-}" != "--proto-redir" || "\${7:-}" != "=https" ]]; then
  printf 'hostile curl config was not disabled\\n' >&2
  printf 'hostile curl config was not disabled\\n' > "$HOSTILE_OUTPUT"
  exit 91
fi
if [[ -v SSLKEYLOGFILE ]]; then
  printf 'tls-key-log-secret\\n' > "$SSLKEYLOGFILE"
  exit 93
fi
for variable_name in HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy CURL_HOME XDG_CONFIG_HOME CURL_CA_BUNDLE SSL_CERT_FILE SSL_CERT_DIR SSLKEYLOGFILE; do
  if [[ -v "\$variable_name" ]]; then
    printf 'hostile curl environment survived: %s\\n' "\$variable_name" >&2
    printf 'hostile curl environment survived\\n' > "$HOSTILE_OUTPUT"
    exit 92
  fi
done
printf 'http-status=204\\n'
`);
    await chmod(fakeCurl, 0o700);
    const tlsKeyLog = path.join(root, "hostile-tls-keys.log");
    const result = await run("bash", [collector, "--usb-root", root], {
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        HOME: curlHome,
        CURL_HOME: curlHome,
        XDG_CONFIG_HOME: curlHome,
        HTTP_PROXY: "http://127.0.0.1:9",
        HTTPS_PROXY: "http://127.0.0.1:9",
        ALL_PROXY: "http://127.0.0.1:9",
        http_proxy: "http://127.0.0.1:9",
        https_proxy: "http://127.0.0.1:9",
        all_proxy: "http://127.0.0.1:9",
        CURL_CA_BUNDLE: "/nonexistent/hostile-ca.pem",
        SSL_CERT_FILE: "/nonexistent/hostile-cert.pem",
        SSL_CERT_DIR: "/nonexistent/hostile-cert-dir",
        SSLKEYLOGFILE: tlsKeyLog,
        HOSTILE_OUTPUT: outsideArtifact
      }
    });
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(readFile(outsideArtifact));
    await assert.rejects(readFile(tlsKeyLog));
    const returned = await readdir(fromDir);
    const reportName = returned.find((name) => name.endsWith(".txt"));
    assert.ok(reportName);
    const report = await readFile(path.join(fromDir, reportName), "utf8");
    assert.doesNotMatch(report, /hostile-curlrc-token|hostile curl/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Debian collector removes its final report when checksum creation fails", {
  skip: process.platform === "win32" ? "Runtime collector check runs on a POSIX host." : false
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-checksum-cleanup-"));
  try {
    const fromDir = path.join(root, "FROM-DEBIAN");
    const toDir = path.join(root, "TO-DEBIAN");
    const binDir = path.join(root, "bin");
    await mkdir(toDir);
    await mkdir(fromDir);
    await mkdir(binDir);
    const collector = path.join(toDir, "collect-debian-readiness.sh");
    await copyFile(new URL("../scripts/migration/collect-debian-readiness.sh", import.meta.url), collector);
    const fakeSha256sum = path.join(binDir, "sha256sum");
    await writeFile(fakeSha256sum, `#!/usr/bin/env bash
if [[ "\${2:-}" == debian-readiness-*.txt ]]; then
  printf 'forced checksum failure after report publication\\n' >&2
  exit 93
fi
exec /usr/bin/sha256sum "$@"
`);
    const fakeCurl = path.join(binDir, "curl");
    await writeFile(fakeCurl, `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  printf 'curl test version\\n'
else
  printf 'http-status=204\\n'
fi
`);
    await chmod(fakeSha256sum, 0o700);
    await chmod(fakeCurl, 0o700);
    const result = await run("bash", [collector, "--usb-root", root], {
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` }
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /forced checksum failure/i);
    assert.deepEqual(await readdir(fromDir), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Debian collector does not let a concurrent same-second failure delete the completed pair", {
  skip: process.platform === "win32" ? "Runtime collector check runs on a POSIX host." : false
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-concurrent-output-"));
  try {
    const fromDir = path.join(root, "FROM-DEBIAN");
    const toDir = path.join(root, "TO-DEBIAN");
    const binDir = path.join(root, "bin");
    const syncDir = path.join(root, "sync");
    await mkdir(toDir);
    await mkdir(fromDir);
    await mkdir(binDir);
    await mkdir(syncDir);
    const collector = path.join(toDir, "collect-debian-readiness.sh");
    await copyFile(new URL("../scripts/migration/collect-debian-readiness.sh", import.meta.url), collector);
    await writeFile(path.join(binDir, "date"), "#!/usr/bin/env bash\nprintf '20260729T120000Z\\n'\n");
    await writeFile(path.join(binDir, "hostname"), "#!/usr/bin/env bash\nprintf 'same-host\\n'\n");
    await writeFile(path.join(binDir, "curl"), `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  printf 'curl test version\\n'
else
  printf 'http-status=204\\n'
fi
`);
    await writeFile(path.join(binDir, "sha256sum"), `#!/usr/bin/env bash
if [[ "\${2:-}" == debian-readiness-*.txt && "\${COLLECTOR_MODE:-}" == "success" ]]; then
  : > "$SYNC_DIR/success-checksum-started"
  while [[ ! -e "$SYNC_DIR/release-success" ]]; do
    sleep 0.01
  done
fi
exec /usr/bin/sha256sum "$@"
`);
    await Promise.all([
      chmod(path.join(binDir, "date"), 0o700),
      chmod(path.join(binDir, "hostname"), 0o700),
      chmod(path.join(binDir, "curl"), 0o700),
      chmod(path.join(binDir, "sha256sum"), 0o700)
    ]);
    const environment = {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      SYNC_DIR: syncDir
    };
    const successfulRun = run("bash", [collector, "--usb-root", root], {
      env: { ...environment, COLLECTOR_MODE: "success" }
    });
    await waitForFile(path.join(syncDir, "success-checksum-started"));
    const failedRun = await run("bash", [collector, "--usb-root", root], {
      env: { ...environment, COLLECTOR_MODE: "failure" }
    });
    assert.notEqual(failedRun.code, 0);
    await writeFile(path.join(syncDir, "release-success"), "release\n");
    const success = await successfulRun;
    assert.equal(success.code, 0, success.stderr);
    const returned = (await readdir(fromDir)).sort();
    const reportName = "debian-readiness-20260729T120000Z-same-host.txt";
    assert.deepEqual(returned, [reportName, `${reportName}.sha256`]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Debian collector cleanup recognizes its FAT32-compatible output reservation", async () => {
  const script = await readFile(
    new URL("../scripts/migration/collect-debian-readiness.sh", import.meta.url),
    "utf8"
  );

  assert.match(script, /RESERVATION_DIR="\$FROM_DIR\/\.debian-readiness-\$TIMESTAMP-\$SAFE_HOSTNAME\.lock"/);
  assert.match(script, /if ! mkdir -- "\$RESERVATION_DIR"/);
  assert.match(script, /rmdir -- "\$RESERVATION_DIR"/);
});

test("USB builder creates the exact handoff atomically with valid hashes", async () => {
  const usbRoot = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-build-"));
  try {
    const result = await run(process.execPath, [
      "scripts/migration/build-usb-handoff.mjs",
      "--usb-root", usbRoot
    ]);
    assert.equal(result.code, 0, result.stderr);
    const handoff = path.join(usbRoot, "Project-A-Migration");
    assert.deepEqual((await readdir(handoff)).sort(), [
      "CHECKSUMS",
      "FROM-DEBIAN",
      "ISOLATION-BOUNDARY.txt",
      "README-FIRST.txt",
      "SECRETS-ENCRYPTED",
      "TO-DEBIAN"
    ]);
    assert.deepEqual(await readdir(path.join(handoff, "FROM-DEBIAN")), []);
    assert.deepEqual(await readdir(path.join(handoff, "SECRETS-ENCRYPTED")), []);
    assert.deepEqual(await readdir(path.join(handoff, "TO-DEBIAN")), [
      "collect-debian-readiness.sh"
    ]);
    assert.deepEqual(await readdir(path.join(handoff, "CHECKSUMS")), [
      "TO-DEBIAN.sha256"
    ]);
    const verified = await verifySha256Manifest({
      rootPath: handoff,
      manifestPath: path.join(handoff, "CHECKSUMS", "TO-DEBIAN.sha256")
    });
    assert.deepEqual(verified.map((entry) => entry.path), [
      "ISOLATION-BOUNDARY.txt",
      "README-FIRST.txt",
      "TO-DEBIAN/collect-debian-readiness.sh"
    ]);
    assert.equal((await readdir(usbRoot)).some((name) => name.includes(".partial-")), false);
  } finally {
    await rm(usbRoot, { recursive: true, force: true });
  }
});

test("USB builder refuses to overwrite an existing handoff", async () => {
  const usbRoot = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-existing-"));
  try {
    const handoff = path.join(usbRoot, "Project-A-Migration");
    await mkdir(handoff);
    await writeFile(path.join(handoff, "keep.txt"), "preserve\n");
    const result = await run(process.execPath, [
      "scripts/migration/build-usb-handoff.mjs",
      "--usb-root", usbRoot
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /already exists.*will not overwrite/i);
    assert.equal(await readFile(path.join(handoff, "keep.txt"), "utf8"), "preserve\n");
    assert.deepEqual(await readdir(usbRoot), ["Project-A-Migration"]);
  } finally {
    await rm(usbRoot, { recursive: true, force: true });
  }
});

test("USB publication refuses an empty destination appearing at publish time", async () => {
  const usbRoot = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-publish-race-"));
  const stagingPath = path.join(usbRoot, "Project-A-Migration.partial-test");
  const handoffRoot = path.join(usbRoot, "Project-A-Migration");
  try {
    await mkdir(stagingPath);
    await writeFile(path.join(stagingPath, "staged.txt"), "staged\n");
    await mkdir(handoffRoot);
    const { publishStagingNoClobber } = await import("../scripts/migration/build-usb-handoff.mjs");
    await assert.rejects(
      publishStagingNoClobber({ usbRoot, stagingPath, handoffRoot }),
      /already exists.*will not overwrite/i
    );
    assert.deepEqual(await readdir(handoffRoot), []);
    assert.deepEqual(await readdir(stagingPath), ["staged.txt"]);
  } finally {
    await rm(usbRoot, { recursive: true, force: true });
  }
});

test("USB builder rejects a source replaced between approval and copy", async () => {
  const usbRoot = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-source-race-"));
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-source-"));
  const secretRoot = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-secret-"));
  try {
    const deployDirectory = path.join(sourceRoot, "deploy", "usb-migration");
    const migrationDirectory = path.join(sourceRoot, "scripts", "migration");
    await mkdir(deployDirectory, { recursive: true });
    await mkdir(migrationDirectory, { recursive: true });
    await writeFile(
      path.join(deployDirectory, "README-FIRST.txt"),
      Buffer.alloc(64 * 1024 * 1024, 0x52)
    );
    await writeFile(
      path.join(deployDirectory, "ISOLATION-BOUNDARY.txt"),
      Buffer.alloc(64 * 1024 * 1024, 0x49)
    );
    const collectorPath = path.join(migrationDirectory, "collect-debian-readiness.sh");
    await writeFile(collectorPath, "#!/usr/bin/env bash\nprintf 'approved\\n'\n");
    const secretPath = path.join(secretRoot, "private-token.txt");
    await writeFile(secretPath, "API_TOKEN=must-never-be-published\n");

    const { buildUsbHandoff } = await import("../scripts/migration/build-usb-handoff.mjs");
    const build = buildUsbHandoff({ usbRoot, sourceRoot });
    await waitForStagingFile(usbRoot, "ISOLATION-BOUNDARY.txt");
    await rename(collectorPath, `${collectorPath}.approved`);
    await copyFile(secretPath, collectorPath);

    await assert.rejects(
      build,
      /source.*(?:changed|symbolic link)/i
    );
    assert.deepEqual(await readdir(usbRoot), []);
  } finally {
    await rm(usbRoot, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(secretRoot, { recursive: true, force: true });
  }
});

test("USB builder cleans only its staging directory after a failed build", async () => {
  const usbRoot = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-failed-build-"));
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-missing-source-"));
  try {
    await writeFile(path.join(usbRoot, "operator-file.txt"), "preserve\n");
    const { buildUsbHandoff } = await import("../scripts/migration/build-usb-handoff.mjs");
    await assert.rejects(
      buildUsbHandoff({ usbRoot, sourceRoot }),
      /README-FIRST\.txt/
    );
    assert.deepEqual(await readdir(usbRoot), ["operator-file.txt"]);
    assert.equal(await readFile(path.join(usbRoot, "operator-file.txt"), "utf8"), "preserve\n");
  } finally {
    await rm(usbRoot, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
  }
});

test("USB instructions preserve the approved operator and isolation boundary", async () => {
  const readme = await readFile(new URL("../deploy/usb-migration/README-FIRST.txt", import.meta.url), "utf8");
  const boundary = await readFile(new URL("../deploy/usb-migration/ISOLATION-BOUNDARY.txt", import.meta.url), "utf8");
  const wrapper = await readFile(new URL("../scripts/migration/prepare-usb-handoff.ps1", import.meta.url), "utf8");

  assert.match(readme, /mount -o nodev,nosuid,noexec/);
  assert.match(readme, /sha256sum --check CHECKSUMS\/TO-DEBIAN\.sha256/);
  assert.match(readme, /bash TO-DEBIAN\/collect-debian-readiness\.sh/);
  assert.match(readme, /umount/);
  assert.match(readme, /verify-usb-handoff\.mjs.*--mode returned/);
  assert.match(boundary, /Codex has no remote access/i);
  assert.match(boundary, /Debian remains internet-connected/i);
  assert.match(boundary, /never.*passwords.*private SSH keys.*tokens/i);
  assert.match(wrapper, /Win32_LogicalDisk/);
  assert.match(wrapper, /DriveType\s*-ne\s*2/);
  assert.match(wrapper, /FileSystem\s*-ne\s*['"]FAT32['"]/);
  assert.doesNotMatch(wrapper, /Remove-Item[^\n]*Project-A-Migration/);
});

test("PowerShell wrapper rejects a network destination before drive inspection", {
  skip: process.platform !== "win32" ? "PowerShell wrapper check runs on Windows." : false
}, async () => {
  const wrapperPath = path.resolve("scripts/migration/prepare-usb-handoff.ps1");
  const result = await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", wrapperPath,
      "-UsbDrive", "\\\\server\\share"
    ]
  );
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /ValidatePattern|validation script|does not match/i);
  assert.doesNotMatch(result.stderr, /Win32_LogicalDisk|Get-CimInstance/i);
});

test("handoff verifier accepts a built outbound bundle and a safe returned report", async () => {
  const usbRoot = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-verify-"));
  try {
    const built = await run(process.execPath, [
      "scripts/migration/build-usb-handoff.mjs",
      "--usb-root", usbRoot
    ]);
    assert.equal(built.code, 0, built.stderr);
    const handoff = path.join(usbRoot, "Project-A-Migration");

    const outbound = await run(process.execPath, [
      "scripts/migration/verify-usb-handoff.mjs",
      "--handoff-root", handoff,
      "--mode", "outbound"
    ]);
    assert.equal(outbound.code, 0, outbound.stderr);
    assert.deepEqual(JSON.parse(outbound.stdout), {
      ok: true,
      mode: "outbound",
      inboundFiles: 3,
      reports: []
    });

    const reportName = "debian-readiness-20260729T160000Z-palziv-prod.txt";
    const reportPath = path.join(handoff, "FROM-DEBIAN", reportName);
    const reportContents = "## Collection\nHostname: palziv-prod\nNode: v24.8.0\n";
    await writeFile(reportPath, reportContents);
    await writeFile(
      `${reportPath}.sha256`,
      `${await sha256File(reportPath)}  ${reportName}\n`
    );
    const returned = await run(process.execPath, [
      "scripts/migration/verify-usb-handoff.mjs",
      "--handoff-root", handoff,
      "--mode", "returned"
    ]);
    assert.equal(returned.code, 0, returned.stderr);
    const summary = JSON.parse(returned.stdout);
    assert.deepEqual(Object.keys(summary).sort(), ["inboundFiles", "mode", "ok", "reports"]);
    assert.equal(summary.ok, true);
    assert.equal(summary.mode, "returned");
    assert.equal(summary.inboundFiles, 3);
    assert.deepEqual(summary.reports, [{
      fileName: reportName,
      sha256: await sha256File(reportPath)
    }]);
    assert.doesNotMatch(returned.stdout, /Hostname:|Node:/);
  } finally {
    await rm(usbRoot, { recursive: true, force: true });
  }
});

test("returned verification rejects tampering and secret material without echoing values", async () => {
  const usbRoot = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-secret-"));
  try {
    const built = await run(process.execPath, [
      "scripts/migration/build-usb-handoff.mjs",
      "--usb-root", usbRoot
    ]);
    assert.equal(built.code, 0, built.stderr);
    const handoff = path.join(usbRoot, "Project-A-Migration");
    const reportName = "debian-readiness-20260729T160000Z-palziv-prod.txt";
    const reportPath = path.join(handoff, "FROM-DEBIAN", reportName);
    await writeFile(reportPath, "RESEND_API_KEY=must-never-be-echoed\n");
    await writeFile(`${reportPath}.sha256`, `${await sha256File(reportPath)}  ${reportName}\n`);

    const secretResult = await run(process.execPath, [
      "scripts/migration/verify-usb-handoff.mjs",
      "--handoff-root", handoff,
      "--mode", "returned"
    ]);
    assert.notEqual(secretResult.code, 0);
    assert.equal(
      secretResult.stderr,
      "Potential secret material detected at line 1 (secret-assignment); do not open or share this report.\n"
    );
    assert.doesNotMatch(`${secretResult.stdout}${secretResult.stderr}`, /must-never-be-echoed/);

    await writeFile(reportPath, "API_TOKEN=changed-after-hashing-and-never-echoed\n");
    const tamperResult = await run(process.execPath, [
      "scripts/migration/verify-usb-handoff.mjs",
      "--handoff-root", handoff,
      "--mode", "returned"
    ]);
    assert.notEqual(tamperResult.code, 0);
    assert.match(tamperResult.stderr, /checksum mismatch/i);
    assert.doesNotMatch(
      `${tamperResult.stdout}${tamperResult.stderr}`,
      /changed-after-hashing-and-never-echoed/
    );
    assert.doesNotMatch(tamperResult.stderr, /potential secret material/i);
  } finally {
    await rm(usbRoot, { recursive: true, force: true });
  }
});

const RETURN_FAILURE_CASES = [
  {
    name: "empty return directory",
    expected: /at least one returned report/i,
    arrange: async () => {}
  },
  {
    name: "temporary return file",
    expected: /unexpected return file/i,
    arrange: async (returnDir) => {
      await writeFile(path.join(returnDir, ".debian-readiness.tmp"), "partial\n");
    }
  },
  {
    name: "report without sidecar",
    expected: /missing checksum sidecar/i,
    arrange: async (returnDir, reportName) => {
      await writeFile(path.join(returnDir, reportName), "safe\n");
    }
  },
  {
    name: "sidecar without report",
    expected: /missing returned report/i,
    arrange: async (returnDir, reportName) => {
      await writeFile(
        path.join(returnDir, `${reportName}.sha256`),
        `${"0".repeat(64)}  ${reportName}\n`
      );
    }
  },
  {
    name: "unsafe filename inside sidecar",
    expected: /returned checksum sidecar is invalid/i,
    arrange: async (returnDir, reportName) => {
      const reportPath = path.join(returnDir, reportName);
      await writeFile(reportPath, "safe\n");
      await writeFile(
        `${reportPath}.sha256`,
        `${await sha256File(reportPath)}  ../${reportName}\n`
      );
    }
  },
  {
    name: "sidecar containing two entries",
    expected: /returned checksum sidecar is invalid/i,
    arrange: async (returnDir, reportName) => {
      const otherName = "debian-readiness-20260729T170000Z-palziv-prod.txt";
      const reportPath = path.join(returnDir, reportName);
      const otherPath = path.join(returnDir, otherName);
      await writeFile(reportPath, "safe one\n");
      await writeFile(otherPath, "safe two\n");
      await writeFile(
        `${reportPath}.sha256`,
        [
          `${await sha256File(reportPath)}  ${reportName}`,
          `${await sha256File(otherPath)}  ${otherName}`,
          ""
        ].join("\n")
      );
      await writeFile(
        `${otherPath}.sha256`,
        `${await sha256File(otherPath)}  ${otherName}\n`
      );
    }
  },
  {
    name: "valid-looking report directory",
    expected: /not a regular file/i,
    arrange: async (returnDir, reportName) => {
      await mkdir(path.join(returnDir, reportName));
      await writeFile(
        path.join(returnDir, `${reportName}.sha256`),
        `${"0".repeat(64)}  ${reportName}\n`
      );
    }
  }
];

for (const scenario of RETURN_FAILURE_CASES) {
  test(`returned verification rejects ${scenario.name}`, async () => {
    const usbRoot = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-return-invalid-"));
    try {
      const built = await run(process.execPath, [
        "scripts/migration/build-usb-handoff.mjs",
        "--usb-root", usbRoot
      ]);
      assert.equal(built.code, 0, built.stderr);
      const handoff = path.join(usbRoot, "Project-A-Migration");
      const returnDir = path.join(handoff, "FROM-DEBIAN");
      const reportName = "debian-readiness-20260729T160000Z-palziv-prod.txt";
      await scenario.arrange(returnDir, reportName);
      const result = await run(process.execPath, [
        "scripts/migration/verify-usb-handoff.mjs",
        "--handoff-root", handoff,
        "--mode", "returned"
      ]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, scenario.expected);
    } finally {
      await rm(usbRoot, { recursive: true, force: true });
    }
  });
}

test("outbound verification requires an empty return directory", async () => {
  const usbRoot = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-outbound-returned-"));
  try {
    const built = await run(process.execPath, [
      "scripts/migration/build-usb-handoff.mjs",
      "--usb-root", usbRoot
    ]);
    assert.equal(built.code, 0, built.stderr);
    const handoff = path.join(usbRoot, "Project-A-Migration");
    await writeFile(path.join(handoff, "FROM-DEBIAN", "operator-note.txt"), "preserve\n");
    const result = await run(process.execPath, [
      "scripts/migration/verify-usb-handoff.mjs",
      "--handoff-root", handoff,
      "--mode", "outbound"
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /outbound handoff already contains returned files/i);
  } finally {
    await rm(usbRoot, { recursive: true, force: true });
  }
});

test("handoff verification requires exact entry names, types, and inbound manifest files", async () => {
  const usbRoot = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-exact-tree-"));
  try {
    const built = await run(process.execPath, [
      "scripts/migration/build-usb-handoff.mjs",
      "--usb-root", usbRoot
    ]);
    assert.equal(built.code, 0, built.stderr);
    const handoff = path.join(usbRoot, "Project-A-Migration");

    await writeFile(path.join(handoff, "unexpected.txt"), "unexpected\n");
    let result = await run(process.execPath, [
      "scripts/migration/verify-usb-handoff.mjs",
      "--handoff-root", handoff,
      "--mode", "outbound"
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /top-level layout/i);
    await rm(path.join(handoff, "unexpected.txt"));

    await rm(path.join(handoff, "FROM-DEBIAN"), { recursive: true });
    await writeFile(path.join(handoff, "FROM-DEBIAN"), "not a directory\n");
    result = await run(process.execPath, [
      "scripts/migration/verify-usb-handoff.mjs",
      "--handoff-root", handoff,
      "--mode", "outbound"
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /top-level layout/i);
    await rm(path.join(handoff, "FROM-DEBIAN"));
    await mkdir(path.join(handoff, "FROM-DEBIAN"));

    const extraPath = path.join(handoff, "TO-DEBIAN", "extra.txt");
    await writeFile(extraPath, "extra inbound file\n");
    result = await run(process.execPath, [
      "scripts/migration/verify-usb-handoff.mjs",
      "--handoff-root", handoff,
      "--mode", "outbound"
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /inbound layout/i);

    await rm(extraPath);
    await writeFile(
      path.join(handoff, "CHECKSUMS", "TO-DEBIAN.sha256"),
      [
        `${await sha256File(path.join(handoff, "ISOLATION-BOUNDARY.txt"))}  ISOLATION-BOUNDARY.txt`,
        `${await sha256File(path.join(handoff, "README-FIRST.txt"))}  README-FIRST.txt`,
        ""
      ].join("\n")
    );
    result = await run(process.execPath, [
      "scripts/migration/verify-usb-handoff.mjs",
      "--handoff-root", handoff,
      "--mode", "outbound"
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /approved files/i);

    await writeFile(path.join(handoff, "SECRETS-ENCRYPTED", "secret.bin"), "not approved\n");
    result = await run(process.execPath, [
      "scripts/migration/verify-usb-handoff.mjs",
      "--handoff-root", handoff,
      "--mode", "outbound"
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /inbound layout/i);
  } finally {
    await rm(usbRoot, { recursive: true, force: true });
  }
});

test("handoff verification rejects a symlinked return directory", async () => {
  const usbRoot = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-return-symlink-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-return-outside-"));
  try {
    const built = await run(process.execPath, [
      "scripts/migration/build-usb-handoff.mjs",
      "--usb-root", usbRoot
    ]);
    assert.equal(built.code, 0, built.stderr);
    const handoff = path.join(usbRoot, "Project-A-Migration");
    await rm(path.join(handoff, "FROM-DEBIAN"), { recursive: true });
    await symlink(outside, path.join(handoff, "FROM-DEBIAN"), "junction");
    const result = await run(process.execPath, [
      "scripts/migration/verify-usb-handoff.mjs",
      "--handoff-root", handoff,
      "--mode", "outbound"
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /top-level layout|symbolic link/i);
  } finally {
    await rm(usbRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("handoff verifier CLI rejects relative roots and unsupported arguments", async () => {
  const relative = await run(process.execPath, [
    "scripts/migration/verify-usb-handoff.mjs",
    "--handoff-root", "Project-A-Migration",
    "--mode", "outbound"
  ]);
  assert.notEqual(relative.code, 0);
  assert.match(relative.stderr, /absolute/i);

  const unsupported = await run(process.execPath, [
    "scripts/migration/verify-usb-handoff.mjs",
    "--handoff-root", path.resolve("Project-A-Migration"),
    "--mode", "outbound",
    "--verbose"
  ]);
  assert.notEqual(unsupported.code, 0);
  assert.match(unsupported.stderr, /usage|unsupported/i);
});

test("stable report verification rejects a basename replaced after approval and open", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-report-race-"));
  let reportHandle;
  try {
    const pathSentinel = "must-never-be-echoed-filesystem-path";
    const reportName =
      `debian-readiness-20260730T120000Z-${pathSentinel}.txt`;
    const reportPath = path.join(root, reportName);
    const approvedPath = path.join(root, `${reportName}.approved`);
    const approvedContents = "approved readiness report\n";
    await writeFile(reportPath, approvedContents);
    const approvedMetadata = await lstat(reportPath, { bigint: true });
    reportHandle = await open(reportPath, "r");

    await rename(reportPath, approvedPath);
    await writeFile(reportPath, "replacement report that must not be screened\n");

    const { readStableOpenedReport } = await import(
      "../scripts/migration/verify-usb-handoff.mjs"
    );
    await assert.rejects(
      readStableOpenedReport({
        handle: reportHandle,
        reportPath,
        approvedMetadata,
        expectedSha256: createHash("sha256").update(approvedContents).digest("hex")
      }),
      /report changed during verification/i
    );

    await rm(reportPath);
    await assert.rejects(
      readStableOpenedReport({
        handle: reportHandle,
        reportPath,
        approvedMetadata,
        expectedSha256: createHash("sha256").update(approvedContents).digest("hex")
      }),
      (error) => {
        assert.match(error.message, /report changed during verification/i);
        assert.doesNotMatch(error.message, new RegExp(pathSentinel, "i"));
        return true;
      }
    );
  } finally {
    await reportHandle?.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function assertAncestorLinkRejected(linkType) {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-ancestor-link-"));
  try {
    const usbRoot = path.join(root, "actual-usb");
    const aliasRoot = path.join(root, "aliased-usb");
    await mkdir(usbRoot);
    const built = await run(process.execPath, [
      "scripts/migration/build-usb-handoff.mjs",
      "--usb-root", usbRoot
    ]);
    assert.equal(built.code, 0, built.stderr);
    await symlink(usbRoot, aliasRoot, linkType);

    const result = await run(process.execPath, [
      "scripts/migration/verify-usb-handoff.mjs",
      "--handoff-root", path.join(aliasRoot, "Project-A-Migration"),
      "--mode", "outbound"
    ]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /ancestor.*(?:symbolic link|junction)/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("handoff verification rejects a Windows ancestor junction", {
  skip: process.platform !== "win32" ? "Windows junction check runs on Windows." : false
}, async () => {
  await assertAncestorLinkRejected("junction");
});

test("handoff verification rejects a POSIX ancestor symbolic link", {
  skip: process.platform === "win32" ? "POSIX symbolic-link check runs outside Windows." : false
}, async () => {
  await assertAncestorLinkRejected("dir");
});

test("returned verification never echoes attacker-controlled media text", async () => {
  const usbRoot = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-safe-errors-"));
  try {
    const built = await run(process.execPath, [
      "scripts/migration/build-usb-handoff.mjs",
      "--usb-root", usbRoot
    ]);
    assert.equal(built.code, 0, built.stderr);
    const handoff = path.join(usbRoot, "Project-A-Migration");
    const returnDir = path.join(handoff, "FROM-DEBIAN");
    const { verifyUsbHandoff } = await import(
      "../scripts/migration/verify-usb-handoff.mjs"
    );

    const assertApiFailure = async (expectedMessage, sentinel) => {
      await assert.rejects(
        verifyUsbHandoff({ handoffRoot: handoff, mode: "returned" }),
        (error) => {
          assert.equal(error.message, expectedMessage);
          assert.doesNotMatch(error.message, new RegExp(sentinel, "i"));
          return true;
        }
      );
    };
    const assertCliFailure = async (expectedStderr, sentinel) => {
      const result = await run(process.execPath, [
        "scripts/migration/verify-usb-handoff.mjs",
        "--handoff-root", handoff,
        "--mode", "returned"
      ]);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, `${expectedStderr}\n`);
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(sentinel, "i"));
    };

    const filenameSentinel = "must-never-be-echoed-filename";
    await writeFile(
      path.join(returnDir, `RESEND_API_KEY=${filenameSentinel}`),
      "hostile filename\n"
    );
    await assertApiFailure("Unexpected return file.", filenameSentinel);
    await assertCliFailure("Unexpected return file.", filenameSentinel);
    await rm(path.join(returnDir, `RESEND_API_KEY=${filenameSentinel}`));

    const reportName = "debian-readiness-20260730T120000Z-palziv-prod.txt";
    const reportPath = path.join(returnDir, reportName);
    const manifestSentinel = "must-never-be-echoed-manifest";
    await writeFile(reportPath, "safe report\n");
    await writeFile(
      `${reportPath}.sha256`,
      `${await sha256File(reportPath)}  ../${manifestSentinel}\n`
    );
    await assertApiFailure("Returned checksum sidecar is invalid.", manifestSentinel);
    await assertCliFailure("Returned checksum sidecar is invalid.", manifestSentinel);
    await rm(reportPath);
    await rm(`${reportPath}.sha256`);

    const pathSentinel = "must-never-be-echoed-path";
    const hostileReportName =
      `debian-readiness-20260730T130000Z-${pathSentinel}.txt`;
    await mkdir(path.join(returnDir, hostileReportName));
    await writeFile(
      path.join(returnDir, `${hostileReportName}.sha256`),
      `${"0".repeat(64)}  ${hostileReportName}\n`
    );
    await assertApiFailure("Returned entry is not a regular file.", pathSentinel);
    await assertCliFailure("Returned entry is not a regular file.", pathSentinel);
  } finally {
    await rm(usbRoot, { recursive: true, force: true });
  }
});

test("handoff verification rejects oversized checksum text before loading it", async () => {
  const usbRoot = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-checksum-bound-"));
  try {
    const built = await run(process.execPath, [
      "scripts/migration/build-usb-handoff.mjs",
      "--usb-root", usbRoot
    ]);
    assert.equal(built.code, 0, built.stderr);
    const handoff = path.join(usbRoot, "Project-A-Migration");
    const manifestPath = path.join(handoff, "CHECKSUMS", "TO-DEBIAN.sha256");
    const approvedManifest = await readFile(manifestPath);

    await writeFile(manifestPath, Buffer.alloc(1025, 0x61));
    let result = await run(process.execPath, [
      "scripts/migration/verify-usb-handoff.mjs",
      "--handoff-root", handoff,
      "--mode", "outbound"
    ]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Inbound checksum manifest is too large.\n");

    await writeFile(manifestPath, approvedManifest);
    const reportName = "debian-readiness-20260730T120000Z-palziv-prod.txt";
    const reportPath = path.join(handoff, "FROM-DEBIAN", reportName);
    await writeFile(reportPath, "safe report\n");
    await writeFile(`${reportPath}.sha256`, Buffer.alloc(1025, 0x62));
    result = await run(process.execPath, [
      "scripts/migration/verify-usb-handoff.mjs",
      "--handoff-root", handoff,
      "--mode", "returned"
    ]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Returned checksum sidecar is too large.\n");
  } finally {
    await rm(usbRoot, { recursive: true, force: true });
  }
});

test("handoff verifier CLI enforces the complete deterministic argument contract", async () => {
  const usbRoot = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-cli-contract-"));
  try {
    const built = await run(process.execPath, [
      "scripts/migration/build-usb-handoff.mjs",
      "--usb-root", usbRoot
    ]);
    assert.equal(built.code, 0, built.stderr);
    const handoff = path.join(usbRoot, "Project-A-Migration");
    const verifier = "scripts/migration/verify-usb-handoff.mjs";
    const usage =
      "Usage: node scripts/migration/verify-usb-handoff.mjs --handoff-root <absolute path> --mode outbound|returned\n";

    const reversed = await run(process.execPath, [
      verifier,
      "--mode", "outbound",
      "--handoff-root", handoff
    ]);
    assert.equal(reversed.code, 0, reversed.stderr);
    assert.equal(reversed.stderr, "");
    assert.equal(JSON.parse(reversed.stdout).mode, "outbound");

    const failures = [
      {
        name: "duplicate named options",
        args: ["--mode", "outbound", "--mode", "returned"],
        stderr: usage
      },
      {
        name: "missing option token",
        args: ["--handoff-root", handoff, "--mode"],
        stderr: usage
      },
      {
        name: "missing option value before another option",
        args: ["--handoff-root", "--mode", "--mode", "outbound"],
        stderr: usage
      },
      {
        name: "invalid mode",
        args: ["--handoff-root", handoff, "--mode", "invalid"],
        stderr: "--mode must be outbound or returned\n"
      },
      {
        name: "hostile unsupported option",
        args: [
          "--handoff-root", handoff,
          "--RESEND_API_KEY=must-never-be-echoed", "outbound"
        ],
        stderr: usage
      }
    ];

    for (const scenario of failures) {
      const result = await run(process.execPath, [verifier, ...scenario.args]);
      assert.equal(result.code, 1, scenario.name);
      assert.equal(result.stdout, "", scenario.name);
      assert.equal(result.stderr, scenario.stderr, scenario.name);
      assert.doesNotMatch(
        `${result.stdout}${result.stderr}`,
        /must-never-be-echoed/i,
        scenario.name
      );
    }
  } finally {
    await rm(usbRoot, { recursive: true, force: true });
  }
});
