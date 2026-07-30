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

const COLLECTOR_SYSTEM_PATH =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

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

function replaceRequired(source, expected, replacement) {
  assert.equal(
    source.split(expected).length,
    2,
    `Expected exactly one test transformation target: ${expected}`
  );
  return source.replace(expected, replacement);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function writeExecutable(filePath, contents) {
  await writeFile(filePath, contents);
  await chmod(filePath, 0o700);
}

async function copyCollectorWithFixedTestPath(destination, fixedPath) {
  const source = await readFile(
    new URL("../scripts/migration/collect-debian-readiness.sh", import.meta.url),
    "utf8"
  );
  const transformed = replaceRequired(
    source,
    `readonly SYSTEM_PATH='${COLLECTOR_SYSTEM_PATH}'`,
    `readonly SYSTEM_PATH=${shellQuote(fixedPath)}`
  );
  await writeFile(destination, transformed);
}

function extractReadmeDebianScript(readme) {
  const match = readme.match(
    /<<'PROJECT_A_USB_MOUNT'\r?\n([\s\S]*?)\r?\nPROJECT_A_USB_MOUNT/
  );
  assert.ok(match, "README copy-ready Debian heredoc was not found");
  return match[1];
}

async function createReadmeMountHarness(scenario = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-mount-block-"));
  const fakeBin = path.join(root, "bin");
  const deviceDir = path.join(root, "devices");
  const device = path.join(deviceDir, "usb-partition");
  const mountPoint = path.join(root, "mount");
  const handoffDir = path.join(mountPoint, "Project-A-Migration");
  const symlinkDestination = path.join(root, "mount-symlink-destination");
  const ttyInput = path.join(root, "tty-input");
  const stateFile = path.join(root, "mounted.state");
  const logFile = path.join(root, "commands.log");
  const scriptPath = path.join(root, "mount-block.sh");

  await mkdir(fakeBin);
  await mkdir(deviceDir);
  await writeFile(device, "test-only partition placeholder\n");
  await writeFile(ttyInput, `${device}\n`);
  if (scenario.mountPointSymlink) {
    await mkdir(symlinkDestination);
    await writeFile(
      path.join(symlinkDestination, "operator-file.txt"),
      "preserve symlink destination\n"
    );
    await symlink(symlinkDestination, mountPoint, "dir");
  } else if (scenario.mountPointFile) {
    await writeFile(mountPoint, "preserve non-directory mountpoint\n");
  } else if (scenario.handoffExists !== false) {
    await mkdir(path.join(handoffDir, "CHECKSUMS"), { recursive: true });
    await mkdir(path.join(handoffDir, "TO-DEBIAN"), { recursive: true });
    await writeFile(
      path.join(handoffDir, "CHECKSUMS", "TO-DEBIAN.sha256"),
      `${"0".repeat(64)}  README-FIRST.txt\n`
    );
    await writeFile(
      path.join(handoffDir, "TO-DEBIAN", "collect-debian-readiness.sh"),
      `printf 'collector\\n' >> ${shellQuote(logFile)}\n`
    );
  }

  await writeExecutable(path.join(fakeBin, "sudo"), `#!/bin/bash
printf 'sudo:%s\\n' "$*" >> ${shellQuote(logFile)}
exec "$@"
`);
  await writeExecutable(path.join(fakeBin, "mount"), `#!/bin/bash
printf 'mount:%s\\n' "$*" >> ${shellQuote(logFile)}
if [[ "\${FAKE_MOUNT_FAIL:-0}" == "1" ]]; then
  exit 71
fi
: > ${shellQuote(stateFile)}
if [[ "\${FAKE_SIGNAL_AFTER_MOUNT:-0}" == "1" ]]; then
  kill -TERM "$PPID"
fi
`);
  await writeExecutable(path.join(fakeBin, "umount"), `#!/bin/bash
printf 'umount:%s\\n' "$*" >> ${shellQuote(logFile)}
if [[ "\${FAKE_UMOUNT_FAIL:-0}" == "1" ]]; then
  exit 72
fi
rm -f -- ${shellQuote(stateFile)}
`);
  await writeExecutable(path.join(fakeBin, "findmnt"), `#!/bin/bash
field=''
previous=''
for argument in "$@"; do
  if [[ "$previous" == "-o" ]]; then
    field="$argument"
  fi
  previous="$argument"
done
if [[ -z "$field" ]]; then
  if [[ "\${FAKE_STALE_MOUNT:-0}" == "1" || -e ${shellQuote(stateFile)} ]]; then
    exit 0
  fi
  exit 1
fi
[[ -e ${shellQuote(stateFile)} ]] || exit 1
case "$field" in
  SOURCE) printf '%s\\n' "\${FAKE_MOUNT_SOURCE:-${device}}" ;;
  FSTYPE) printf '%s\\n' "\${FAKE_MOUNT_FSTYPE:-vfat}" ;;
  OPTIONS) printf '%s\\n' "\${FAKE_MOUNT_OPTIONS:-rw,nodev,nosuid,noexec,uid=1001,gid=1002,umask=0077}" ;;
  *) exit 73 ;;
esac
`);
  await writeExecutable(path.join(fakeBin, "lsblk"), `#!/bin/bash
case " $* " in
  *" TYPE "*) printf 'part\\n' ;;
  *" FSTYPE "*) printf '%s\\n' "\${FAKE_DEVICE_FSTYPE:-vfat}" ;;
  *) printf 'usb-partition vfat\\n' ;;
esac
`);
  await writeExecutable(path.join(fakeBin, "id"), `#!/bin/bash
case "\${1:-}" in
  -u) printf '1001\\n' ;;
  -g) printf '1002\\n' ;;
  *) exit 74 ;;
esac
`);
  await writeExecutable(path.join(fakeBin, "sha256sum"), `#!/bin/bash
printf 'checksum:%s\\n' "$*" >> ${shellQuote(logFile)}
if [[ "\${FAKE_CHECKSUM_FAIL:-0}" == "1" ]]; then
  exit 75
fi
`);
  await writeExecutable(path.join(fakeBin, "sync"), `#!/bin/bash
printf 'sync\\n' >> ${shellQuote(logFile)}
if [[ "\${FAKE_SYNC_FAIL:-0}" == "1" ]]; then
  exit 76
fi
`);

  const readme = await readFile(
    new URL("../deploy/usb-migration/README-FIRST.txt", import.meta.url),
    "utf8"
  );
  let script = extractReadmeDebianScript(readme);
  script = replaceRequired(
    script,
    `readonly SYSTEM_PATH='${COLLECTOR_SYSTEM_PATH}'`,
    `readonly SYSTEM_PATH=${shellQuote(`${fakeBin}:/usr/bin:/bin`)}`
  );
  script = replaceRequired(
    script,
    "readonly MOUNT_POINT='/mnt/project-a-usb'",
    `readonly MOUNT_POINT=${shellQuote(mountPoint)}`
  );
  script = replaceRequired(script, "< /dev/tty", `< ${shellQuote(ttyInput)}`);
  script = replaceRequired(
    script,
    '[[ "$USB_DEVICE" == /dev/* ]]',
    `[[ "$USB_DEVICE" == ${shellQuote(deviceDir)}/* ]]`
  );
  script = replaceRequired(
    script,
    '[[ -b "$USB_DEVICE" ]]',
    '[[ -e "$USB_DEVICE" ]]'
  );
  await writeFile(scriptPath, script);

  const result = await run("/bin/bash", ["--noprofile", "--norc", scriptPath], {
    env: {
      ...process.env,
      FAKE_STALE_MOUNT: scenario.staleMount ? "1" : "0",
      FAKE_MOUNT_FAIL: scenario.mountFails ? "1" : "0",
      FAKE_SIGNAL_AFTER_MOUNT: scenario.signalAfterMount ? "1" : "0",
      FAKE_DEVICE_FSTYPE: scenario.deviceFsType || "vfat",
      FAKE_MOUNT_SOURCE: scenario.mountedSource || device,
      FAKE_MOUNT_FSTYPE: scenario.mountedFsType || "vfat",
      FAKE_MOUNT_OPTIONS:
        scenario.mountOptions ||
        "rw,nodev,nosuid,noexec,uid=1001,gid=1002,umask=0077",
      FAKE_CHECKSUM_FAIL: scenario.checksumFails ? "1" : "0",
      FAKE_SYNC_FAIL: scenario.syncFails ? "1" : "0",
      FAKE_UMOUNT_FAIL: scenario.unmountFails ? "1" : "0"
    }
  });
  let log = "";
  try {
    log = await readFile(logFile, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return {
    cleanup: () => rm(root, { recursive: true, force: true }),
    device,
    log,
    mountPoint,
    result,
    stateFile,
    symlinkDestination
  };
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

test("Debian collector replaces inherited command and startup resolution before external commands", async () => {
  const script = await readFile(
    new URL("../scripts/migration/collect-debian-readiness.sh", import.meta.url),
    "utf8"
  );
  const firstExternalCommand = script.indexOf('SCRIPT_PATH="$(readlink -f --');
  assert.notEqual(firstExternalCommand, -1);
  const fixedEnvironment = script.slice(0, firstExternalCommand);

  assert.match(
    fixedEnvironment,
    new RegExp(
      `readonly SYSTEM_PATH='${COLLECTOR_SYSTEM_PATH.replaceAll("/", "\\/")}'`
    )
  );
  assert.match(fixedEnvironment, /export PATH="\$SYSTEM_PATH"/);
  assert.match(fixedEnvironment, /export LC_ALL=C/);
  assert.match(fixedEnvironment, /unset BASH_ENV ENV CDPATH/);
  assert.match(fixedEnvironment, /unset LD_PRELOAD LD_LIBRARY_PATH/);
  assert.match(fixedEnvironment, /unset NODE_OPTIONS NODE_PATH/);
  assert.match(
    fixedEnvironment,
    /unset NPM_CONFIG_USERCONFIG npm_config_userconfig NPM_CONFIG_GLOBALCONFIG npm_config_globalconfig/
  );
  assert.match(
    fixedEnvironment,
    /unset NPM_CONFIG_PREFIX npm_config_prefix NPM_CONFIG_CACHE npm_config_cache/
  );
  assert.match(
    fixedEnvironment,
    /unset NPM_CONFIG_SCRIPT_SHELL npm_config_script_shell NPM_CONFIG_NODE_OPTIONS npm_config_node_options/
  );
  assert.match(fixedEnvironment, /hash -r/);
  assert.doesNotMatch(script, /(?:TEST|OVERRIDE|HOSTILE)_[A-Z_]*PATH/);
  assert.doesNotMatch(script, /\$\{[A-Z_]*(?:TEST|OVERRIDE)[A-Z_]*:-/);
});

test("Debian collector ignores an inherited hostile PATH executable", {
  skip: process.platform === "win32" ? "Runtime collector check runs on a POSIX host." : false
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-hostile-path-"));
  try {
    const fromDir = path.join(root, "FROM-DEBIAN");
    const toDir = path.join(root, "TO-DEBIAN");
    const hostileBin = path.join(root, "hostile-bin");
    const sentinel = path.join(root, "hostile-path-executed");
    await mkdir(fromDir);
    await mkdir(toDir);
    await mkdir(hostileBin);
    const collector = path.join(toDir, "collect-debian-readiness.sh");
    await copyFile(
      new URL("../scripts/migration/collect-debian-readiness.sh", import.meta.url),
      collector
    );
    await writeExecutable(path.join(hostileBin, "hostname"), `#!/bin/bash
printf 'HOSTILE_PATH_SECRET\\n'
: > ${shellQuote(sentinel)}
`);

    const result = await run(
      "/bin/bash",
      ["--noprofile", "--norc", collector, "--usb-root", root],
      {
        env: {
          ...process.env,
          PATH: `${hostileBin}:${COLLECTOR_SYSTEM_PATH}`,
          ENV: path.join(root, "hostile-env"),
          CDPATH: hostileBin,
          NODE_OPTIONS: "--require=/nonexistent/hostile-node-startup.cjs",
          NPM_CONFIG_USERCONFIG: path.join(root, "hostile-npmrc")
        }
      }
    );
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(readFile(sentinel));
    const reportName = (await readdir(fromDir)).find((name) =>
      name.endsWith(".txt")
    );
    assert.ok(reportName);
    const report = await readFile(path.join(fromDir, reportName), "utf8");
    assert.doesNotMatch(report, /HOSTILE_PATH_SECRET/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
    await copyCollectorWithFixedTestPath(
      collector,
      `${binDir}:${COLLECTOR_SYSTEM_PATH}`
    );
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
    await copyCollectorWithFixedTestPath(
      collector,
      `${binDir}:${COLLECTOR_SYSTEM_PATH}`
    );
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
    await copyCollectorWithFixedTestPath(
      collector,
      `${binDir}:${COLLECTOR_SYSTEM_PATH}`
    );
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
  assert.match(
    readme,
    /\/usr\/bin\/env -i[\s\S]*\/bin\/bash --noprofile --norc\s*\\?\s*TO-DEBIAN\/collect-debian-readiness\.sh/
  );
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

test("USB instructions define a clean fail-closed mount and collector flow", async () => {
  const readme = await readFile(
    new URL("../deploy/usb-migration/README-FIRST.txt", import.meta.url),
    "utf8"
  );
  const script = extractReadmeDebianScript(readme);

  assert.match(
    readme,
    new RegExp(
      `/usr/bin/env -i[\\\\\\s\\S]*PATH='${COLLECTOR_SYSTEM_PATH.replaceAll("/", "\\/")}'[\\\\\\s\\S]*LC_ALL=C[\\\\\\s\\S]*/bin/bash --noprofile --norc`
    )
  );
  assert.match(script, /^set -Eeuo pipefail/m);
  assert.match(script, /IFS= read -r -p [^\n]+ < \/dev\/tty/);
  assert.match(script, /USB_DEVICE="\$\(readlink -e -- "\$USB_DEVICE"\)"/);
  assert.match(script, /\[\[ "\$USB_DEVICE" == \/dev\/\* \]\]/);
  assert.match(script, /\[\[ -b "\$USB_DEVICE" \]\]/);
  assert.match(script, /lsblk[^\n]+TYPE/);
  assert.match(script, /lsblk[^\n]+FSTYPE/);
  assert.match(script, /findmnt[^\n]+--mountpoint[^\n]+"\$MOUNT_POINT"/);
  assert.match(script, /mount -t vfat -o "\$REQUESTED_OPTIONS"/);
  assert.match(script, /SOURCE/);
  assert.match(script, /FSTYPE/);
  assert.match(script, /OPTIONS/);
  assert.match(script, /nodev/);
  assert.match(script, /nosuid/);
  assert.match(script, /noexec/);
  assert.match(script, /uid=\$OPERATOR_UID/);
  assert.match(script, /gid=\$OPERATOR_GID/);
  assert.match(script, /umask=077/);
  assert.match(script, /trap cleanup EXIT/);
  assert.match(script, /sync/);
  assert.match(script, /umount/);
  assert.match(
    script,
    /\/usr\/bin\/env -i PATH="\$SYSTEM_PATH" LC_ALL=C \/bin\/bash --noprofile --norc/
  );
  assert.match(
    readme,
    /power loss or SIGKILL[\s\S]*\.debian-readiness-\*\.lock[\s\S]*\.tmp[\s\S]*stop and return the USB\s+for\s+inspection/i
  );
  assert.doesNotMatch(readme, /rm\s+-[^\n]*\s+\.debian-readiness-\*/i);
});

test("USB instructions reject redirected mountpoints and track mount attempts before mounting", async () => {
  const readme = await readFile(
    new URL("../deploy/usb-migration/README-FIRST.txt", import.meta.url),
    "utf8"
  );
  const script = extractReadmeDebianScript(readme);
  const mkdirIndex = script.indexOf('sudo mkdir -p -- "$MOUNT_POINT"');
  const mountIndex = script.indexOf(
    'sudo mount -t vfat -o "$REQUESTED_OPTIONS" -- "$USB_DEVICE" "$MOUNT_POINT"'
  );
  const attemptIndex = script.indexOf("MOUNT_ATTEMPTED=1");

  assert.notEqual(mkdirIndex, -1);
  assert.notEqual(mountIndex, -1);
  assert.notEqual(attemptIndex, -1);
  assert.match(
    script.slice(0, mkdirIndex),
    /\[\[ ! -L "\$MOUNT_POINT" \]\][\s\S]*\[\[ ! -e "\$MOUNT_POINT" \|\| -d "\$MOUNT_POINT" \]\]/
  );
  assert.equal(
    script.match(/^require_literal_mount_directory$/gm)?.length,
    2,
    "mountpoint must be validated after mkdir and immediately before mount"
  );
  assert.match(
    script,
    /require_literal_mount_directory\(\)[\s\S]*\[\[ -d "\$MOUNT_POINT" && ! -L "\$MOUNT_POINT" \]\][\s\S]*readlink -e -- "\$MOUNT_POINT"[\s\S]*== "\$MOUNT_POINT"/
  );
  assert.ok(attemptIndex < mountIndex);
  assert.equal(
    script.slice(attemptIndex, mountIndex).trim(),
    "MOUNT_ATTEMPTED=1",
    "only the mount-attempt state assignment may occur between final validation and mount"
  );
  assert.match(
    script,
    /cleanup\(\)[\s\S]*\[\[ "\$MOUNT_ATTEMPTED" -eq 1 \]\][\s\S]*findmnt[^\n]+SOURCE/
  );
});

test("README clean collector launcher ignores inherited Bash startup and PATH state", {
  skip: process.platform === "win32" ? "Runtime collector check runs on a POSIX host." : false
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-clean-launch-"));
  try {
    const fromDir = path.join(root, "FROM-DEBIAN");
    const toDir = path.join(root, "TO-DEBIAN");
    const hostileBin = path.join(root, "hostile-bin");
    const sentinel = path.join(root, "hostile-startup-executed");
    const startupFile = path.join(root, "hostile-startup.sh");
    await mkdir(fromDir);
    await mkdir(toDir);
    await mkdir(hostileBin);
    const collector = path.join(toDir, "collect-debian-readiness.sh");
    await copyFile(
      new URL("../scripts/migration/collect-debian-readiness.sh", import.meta.url),
      collector
    );
    await writeFile(
      startupFile,
      `printf 'HOSTILE_STARTUP_SECRET\\n'\n: > ${shellQuote(sentinel)}\n`
    );
    await writeExecutable(path.join(hostileBin, "bash"), `#!/bin/bash
printf 'HOSTILE_BASH_SECRET\\n'
: > ${shellQuote(sentinel)}
exit 91
`);

    const result = await run(
      "/usr/bin/env",
      [
        "-i",
        `PATH=${COLLECTOR_SYSTEM_PATH}`,
        "LC_ALL=C",
        "/bin/bash",
        "--noprofile",
        "--norc",
        collector,
        "--usb-root",
        root
      ],
      {
        env: {
          ...process.env,
          PATH: `${hostileBin}:${COLLECTOR_SYSTEM_PATH}`,
          BASH_ENV: startupFile,
          ENV: startupFile,
          NODE_OPTIONS: "--require=/nonexistent/hostile-node-startup.cjs"
        }
      }
    );
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(readFile(sentinel));
    const reportName = (await readdir(fromDir)).find((name) =>
      name.endsWith(".txt")
    );
    assert.ok(reportName);
    const report = await readFile(path.join(fromDir, reportName), "utf8");
    assert.doesNotMatch(report, /HOSTILE_(?:STARTUP|BASH)_SECRET/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const README_MOUNT_FAILURE_CASES = [
  {
    name: "an unmounted symbolic-link target",
    scenario: { mountPointSymlink: true },
    expected: /symbolic link/i,
    included: [],
    excluded: [
      "sudo:mkdir",
      "mount:",
      "checksum:",
      "collector",
      "sync",
      "umount:"
    ]
  },
  {
    name: "an existing non-directory target",
    scenario: { mountPointFile: true },
    expected: /not a directory/i,
    included: [],
    excluded: [
      "sudo:mkdir",
      "mount:",
      "checksum:",
      "collector",
      "sync",
      "umount:"
    ]
  },
  {
    name: "an already-mounted target",
    scenario: { staleMount: true },
    expected: /already mounted/i,
    included: [],
    excluded: ["mount:", "checksum:", "collector", "sync", "umount:"]
  },
  {
    name: "a non-vfat selected partition",
    scenario: { deviceFsType: "ext4" },
    expected: /filesystem.*vfat/i,
    included: [],
    excluded: ["mount:", "checksum:", "collector", "sync", "umount:"]
  },
  {
    name: "a failed mount",
    scenario: { mountFails: true },
    expected: /mount/i,
    included: ["mount:"],
    excluded: ["checksum:", "collector", "sync", "umount:"]
  },
  {
    name: "a failed handoff cd",
    scenario: { handoffExists: false },
    expected: /handoff directory/i,
    included: ["mount:", "umount:"],
    excluded: ["checksum:", "collector", "sync"]
  },
  {
    name: "the wrong mounted source",
    scenario: { mountedSource: "/wrong/source" },
    expected: /mounted source/i,
    included: ["mount:"],
    excluded: ["checksum:", "collector", "sync"]
  },
  {
    name: "a non-vfat effective mount",
    scenario: { mountedFsType: "ext4" },
    expected: /effective mounted filesystem.*vfat/i,
    included: ["mount:", "umount:"],
    excluded: ["checksum:", "collector", "sync"]
  },
  {
    name: "missing effective mount options",
    scenario: {
      mountOptions: "rw,nodev,nosuid,uid=1001,gid=1002,umask=0077"
    },
    expected: /mount options/i,
    included: ["mount:", "umount:"],
    excluded: ["checksum:", "collector", "sync"]
  },
  {
    name: "a failed sync",
    scenario: { syncFails: true },
    expected: /sync/i,
    included: ["mount:", "checksum:", "collector", "sync", "umount:"],
    excluded: []
  },
  {
    name: "a failed explicit unmount",
    scenario: { unmountFails: true },
    expected: /unmount/i,
    included: ["mount:", "checksum:", "collector", "sync", "umount:"],
    excluded: []
  }
];

for (const failureCase of README_MOUNT_FAILURE_CASES) {
  test(`README mount block fails closed for ${failureCase.name}`, {
    skip: process.platform === "win32" ? "Mount-block behavior runs on a POSIX host." : false
  }, async () => {
    const harness = await createReadmeMountHarness(failureCase.scenario);
    try {
      assert.notEqual(harness.result.code, 0);
      assert.match(harness.result.stderr, failureCase.expected);
      for (const marker of failureCase.included) {
        assert.match(harness.log, new RegExp(marker));
      }
      for (const marker of failureCase.excluded) {
        assert.doesNotMatch(harness.log, new RegExp(marker));
      }
      if (failureCase.scenario.unmountFails) {
        assert.ok(
          harness.log.match(/^umount:/gm)?.length >= 2,
          "explicit unmount failure should trigger one bounded cleanup retry"
        );
      }
      if (failureCase.scenario.mountPointSymlink) {
        assert.deepEqual(
          await readdir(harness.symlinkDestination),
          ["operator-file.txt"]
        );
        assert.equal(
          await readFile(
            path.join(harness.symlinkDestination, "operator-file.txt"),
            "utf8"
          ),
          "preserve symlink destination\n"
        );
      }
      if (failureCase.scenario.mountPointFile) {
        assert.equal(
          await readFile(harness.mountPoint, "utf8"),
          "preserve non-directory mountpoint\n"
        );
      }
    } finally {
      await harness.cleanup();
    }
  });
}

test("README cleanup unmounts a verified source when signaled after mount success", {
  skip: process.platform === "win32" ? "Mount-block behavior runs on a POSIX host." : false
}, async () => {
  const harness = await createReadmeMountHarness({ signalAfterMount: true });
  try {
    assert.notEqual(harness.result.code, 0);
    assert.match(harness.log, /^mount:/m);
    assert.equal(harness.log.match(/^umount:/gm)?.length, 1);
    assert.doesNotMatch(harness.log, /checksum:|collector|sync/);
    await assert.rejects(readFile(harness.stateFile));
  } finally {
    await harness.cleanup();
  }
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

test("inbound verification rejects a manifest replaced after bounded approval", async () => {
  const usbRoot = await mkdtemp(path.join(os.tmpdir(), "project-a-usb-manifest-race-"));
  let replacementHandle;
  try {
    const built = await run(process.execPath, [
      "scripts/migration/build-usb-handoff.mjs",
      "--usb-root", usbRoot
    ]);
    assert.equal(built.code, 0, built.stderr);
    const handoff = path.join(usbRoot, "Project-A-Migration");
    const manifestPath = path.join(handoff, "CHECKSUMS", "TO-DEBIAN.sha256");
    const approvedPath = `${manifestPath}.approved`;
    const {
      approveInboundManifest,
      verifyApprovedInboundManifest
    } = await import("../scripts/migration/verify-usb-handoff.mjs");

    const approval = await approveInboundManifest(manifestPath);
    await rename(manifestPath, approvedPath);
    replacementHandle = await open(manifestPath, "w");
    await replacementHandle.truncate(4 * 1024 * 1024);
    await replacementHandle.close();
    replacementHandle = undefined;
    assert.equal((await lstat(manifestPath)).size, 4 * 1024 * 1024);

    await assert.rejects(
      verifyApprovedInboundManifest({
        root: handoff,
        manifestPath,
        approval
      }),
      (error) => {
        assert.equal(
          error.message,
          "Inbound checksum manifest changed during verification."
        );
        assert.doesNotMatch(error.message, /TO-DEBIAN|Project-A-Migration/i);
        return true;
      }
    );
  } finally {
    await replacementHandle?.close();
    await rm(usbRoot, { recursive: true, force: true });
  }
});
