import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
  assert.match(script, /unset CURL_HOME XDG_CONFIG_HOME CURL_CA_BUNDLE SSL_CERT_FILE SSL_CERT_DIR/);
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
for variable_name in HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy CURL_HOME XDG_CONFIG_HOME CURL_CA_BUNDLE SSL_CERT_FILE SSL_CERT_DIR; do
  if [[ -v "\$variable_name" ]]; then
    printf 'hostile curl environment survived: %s\\n' "\$variable_name" >&2
    printf 'hostile curl environment survived\\n' > "$HOSTILE_OUTPUT"
    exit 92
  fi
done
printf 'http-status=204\\n'
`);
    await chmod(fakeCurl, 0o700);
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
        HOSTILE_OUTPUT: outsideArtifact
      }
    });
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(readFile(outsideArtifact));
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
