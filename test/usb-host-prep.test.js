import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
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
const HOST_PREP_SCRIPT_URL = new URL("../scripts/migration/preflight-host-prep.sh", import.meta.url);
const HOST_PREP_APPROVED_TOKEN_FIELDS = [
  "classification",
  "createdAtEpoch",
  "manifestFingerprint",
  "phaseId",
  "schemaVersion",
  "stageRoot"
];
const HOST_PREP_STAGE_FILES = [
  "ISOLATION-BOUNDARY.txt",
  "PHASE-2-INPUT.json",
  "README-FIRST.txt",
  "TO-DEBIAN/apply-host-prep.sh",
  "TO-DEBIAN/collect-host-prep-evidence.sh",
  "TO-DEBIAN/preflight-host-prep.sh"
];

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

async function writeExecutable(filePath, body) {
  await writeFile(filePath, `#!/bin/sh\nset -eu\n${body}`, { mode: 0o700 });
  await chmod(filePath, 0o700);
}

async function snapshotFixtureTree(root) {
  const entries = [];
  async function visit(directoryPath, relativeDirectory = "") {
    const children = await readdir(directoryPath, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const relativePath = path.posix.join(relativeDirectory, child.name);
      const absolutePath = path.join(directoryPath, child.name);
      const metadata = await lstat(absolutePath);
      if (child.isDirectory()) {
        entries.push([relativePath, "directory", metadata.mode & 0o777]);
        await visit(absolutePath, relativePath);
      } else if (child.isSymbolicLink()) {
        entries.push([relativePath, "symlink", await fs.promises.readlink(absolutePath)]);
      } else {
        const contents = await readFile(absolutePath);
        entries.push([
          relativePath,
          "file",
          metadata.mode & 0o777,
          createHash("sha256").update(contents).digest("hex")
        ]);
      }
    }
  }
  await visit(root);
  return entries;
}

async function runHostPrepScript(fixture, extraEnvironment = {}) {
  const hostilePath = path.join(fixture.base, "hostile-path");
  await mkdir(hostilePath, { recursive: true });
  const hostileMarker = path.join(fixture.base, "hostile-command-fired");
  await writeExecutable(
    path.join(hostilePath, "uname"),
    `: > ${shellSingleQuote(hostileMarker)}\nprintf '%s\\n' hostile\n`
  );
  const bashEnvMarker = path.join(fixture.base, "bash-env-fired");
  const bashEnvPath = path.join(fixture.base, "hostile-bash-env");
  await writeFile(bashEnvPath, `: > ${shellSingleQuote(bashEnvMarker)}\n`, { mode: 0o600 });
  const curlHome = path.join(fixture.base, "curl-home");
  await mkdir(curlHome);
  const curlConfigMarker = path.join(fixture.base, "curl-config-fired");
  await writeFile(
    path.join(curlHome, ".curlrc"),
    `output ${curlConfigMarker}\n`,
    { mode: 0o600 }
  );

  const environment = {
    ...process.env,
    PATH: hostilePath,
    BASH_ENV: bashEnvPath,
    ENV: bashEnvPath,
    CURL_HOME: curlHome,
    CURL_CA_BUNDLE: path.join(fixture.base, "hostile-ca-bundle"),
    CURL_CA_PATH: path.join(fixture.base, "hostile-ca-path"),
    CURL_SSL_BACKEND: "hostile",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "*",
    http_proxy: "http://127.0.0.1:9",
    https_proxy: "http://127.0.0.1:9",
    all_proxy: "http://127.0.0.1:9",
    no_proxy: "*",
    SSL_CERT_FILE: path.join(fixture.base, "hostile-cert"),
    SSL_CERT_DIR: path.join(fixture.base, "hostile-cert-dir"),
    SSLKEYLOGFILE: path.join(fixture.base, "ssl-key-log"),
    PALZIV_HOST_PREP_TEST_MODE: "1",
    PALZIV_HOST_PREP_TEST_ROOT: fixture.root,
    PALZIV_HOST_PREP_TEST_BIN: fixture.bin,
    ...extraEnvironment
  };

  try {
    const result = await execFile("/bin/bash", ["-p", fixture.scriptPath], {
      cwd: fixture.stage,
      env: environment,
      timeout: 15_000,
      maxBuffer: 1024 * 1024
    });
    return {
      code: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      hostileArtifacts: [hostileMarker, bashEnvMarker, curlConfigMarker, environment.SSLKEYLOGFILE]
    };
  } catch (error) {
    return {
      code: error.code,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      hostileArtifacts: [hostileMarker, bashEnvMarker, curlConfigMarker, environment.SSLKEYLOGFILE]
    };
  }
}

async function createHostPrepFixture({
  prepared = false,
  partialNode = false,
  unexpectedPalzivPath = false,
  listener = false,
  activeService = false,
  missingHttps = false,
  badNodeLinkOwner = false,
  getentFailure = false
} = {}) {
  const base = await mkdtemp("/tmp/project-a-host-prep-test.");
  const root = path.join(base, "root");
  const bin = path.join(base, "bin");
  const stage = path.join(base, "stage");
  const scriptPath = path.join(stage, "TO-DEBIAN", "preflight-host-prep.sh");
  await Promise.all([
    mkdir(path.join(root, "etc"), { recursive: true }),
    mkdir(path.join(root, "proc"), { recursive: true }),
    mkdir(path.join(root, "opt"), { recursive: true }),
    mkdir(path.join(root, "var", "lib"), { recursive: true }),
    mkdir(path.join(root, "var", "backups"), { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(path.join(stage, "CHECKSUMS"), { recursive: true }),
    mkdir(path.join(stage, "TO-DEBIAN"), { recursive: true }),
    mkdir(path.join(stage, "FROM-DEBIAN"), { recursive: true }),
    mkdir(path.join(stage, "SECRETS-ENCRYPTED"), { recursive: true })
  ]);
  await writeFile(
    path.join(root, "etc", "os-release"),
    'ID=debian\nVERSION_ID="13"\n',
    { mode: 0o644 }
  );
  await writeFile(
    path.join(root, "proc", "meminfo"),
    "MemTotal:        3584000 kB\n",
    { mode: 0o444 }
  );

  if (prepared || partialNode) {
    const versionRoot = path.join(root, "opt", "node-v24.18.0-linux-x64");
    await mkdir(path.join(versionRoot, "bin"), { recursive: true });
    await writeExecutable(path.join(versionRoot, "bin", "node"), "printf '%s\\n' v24.18.0\n");
    if (prepared) {
      await symlink("/opt/node-v24.18.0-linux-x64", path.join(root, "opt", "node"));
    }
  }
  if (prepared) {
    await Promise.all([
      mkdir(path.join(root, "opt", "palziv", "releases"), { recursive: true }),
      mkdir(path.join(root, "var", "lib", "palziv", "data"), { recursive: true }),
      mkdir(path.join(root, "var", "backups", "palziv"), { recursive: true }),
      mkdir(path.join(root, "etc", "palziv"), { recursive: true })
    ]);
  }
  if (unexpectedPalzivPath) {
    await symlink(path.join(root, "etc"), path.join(root, "opt", "palziv"));
  }

  const commandBodies = {
    uname: "test \"${1-}\" = -m\nprintf '%s\\n' x86_64\n",
    "systemd-detect-virt": "test \"$#\" -eq 0\nprintf '%s\\n' kvm\n",
    nproc: "test \"$#\" -eq 0\nprintf '%s\\n' 2\n",
    df: "test \"$#\" -eq 3\ntest \"$1\" = -B1\ntest \"$2\" = --output=avail\nprintf 'Avail\\n10737418240\\n'\n",
    timedatectl:
      "test \"$#\" -eq 3\ntest \"$1\" = show\ntest \"$2\" = --property=NTPSynchronized\ntest \"$3\" = --value\nprintf '%s\\n' yes\n",
    systemctl: `case "\${1-}:\${2-}:\${3-}" in
  is-active:--quiet:qemu-guest-agent.service|is-active:--quiet:systemd-timesyncd.service) exit 0 ;;
  is-active:--quiet:palziv.service|is-enabled:--quiet:palziv.service|is-active:--quiet:cloudflared.service|is-enabled:--quiet:cloudflared.service) ${activeService ? "exit 0" : "exit 3"} ;;
  *) exit 97 ;;
esac
`,
    curl: `test "$#" -eq 13
test "$1" = --disable
test "$2" = --silent
test "$3" = --show-error
test "$4" = --fail
test "$5" = --max-time
test "$6" = 10
test "$7" = --noproxy
test "$8" = "*"
test "$9" = --proto
test "\${10}" = "=https"
test "\${11}" = --proto-redir
test "\${12}" = "=https"
case "\${13-}" in
  https://deb.debian.org/) exit 0 ;;
  https://nodejs.org/) ${missingHttps ? "exit 22" : "exit 0"} ;;
  *) exit 96 ;;
esac
`,
    ss: `${listener ? "printf '%s\\n' 'LISTEN 0 4096 127.0.0.1:3116'" : ":"}\n`,
    getent: getentFailure
      ? "exit 70\n"
      : prepared
      ? `case "\${1-}:\${2-}" in
  passwd:palziv) printf '%s\\n' 'palziv:x:998:998::/var/lib/palziv:/usr/sbin/nologin' ;;
  group:palziv) printf '%s\\n' 'palziv:x:998:' ;;
  *) exit 2 ;;
esac
`
      : "exit 2\n",
    stat: `case "\${1-}:\${2-}" in
  -c:%U:%G)
    case "\${3-}" in
      */opt/node) printf '%s\\n' ${badNodeLinkOwner ? "fixture:fixture" : "root:root"} ;;
      *) exit 95 ;;
    esac
    ;;
  -Lc:%U:%G:%a)
    case "\${3-}" in
      */opt/node-v24.18.0-linux-x64|*/opt/node-v24.18.0-linux-x64/bin/node) printf '%s\\n' root:root:755 ;;
      */opt/palziv|*/opt/palziv/releases|*/var/backups/palziv|*/etc/palziv) printf '%s\\n' root:palziv:750 ;;
      */var/lib/palziv|*/var/lib/palziv/data) printf '%s\\n' palziv:palziv:700 ;;
      *) exit 94 ;;
    esac
    ;;
  *) exit 96 ;;
esac
`,
    jq: `test "\${1-}" = -n
shift
phase_id=
manifest_fingerprint=
stage_root=
classification=
created_at_epoch=
while test "$#" -gt 0; do
  case "$1" in
    --arg)
      test "$#" -ge 3
      case "$2" in
        phase_id) phase_id=$3 ;;
        manifest_fingerprint) manifest_fingerprint=$3 ;;
        stage_root) stage_root=$3 ;;
        classification) classification=$3 ;;
        *) exit 93 ;;
      esac
      shift 3
      ;;
    --argjson)
      test "$#" -ge 3
      test "$2" = created_at_epoch
      created_at_epoch=$3
      shift 3
      ;;
    *)
      test "$#" -eq 1
      shift
      ;;
  esac
done
test "$phase_id" = debian-host-prep-v1
test "\${#manifest_fingerprint}" -eq 64
test -n "$stage_root"
case "$classification" in clean|already-prepared) ;; *) exit 92 ;; esac
case "$created_at_epoch" in *[!0-9]*|'') exit 91 ;; esac
printf '{"schemaVersion":1,"phaseId":"%s","manifestFingerprint":"%s","stageRoot":"%s","classification":"%s","createdAtEpoch":%s}\\n' "$phase_id" "$manifest_fingerprint" "$stage_root" "$classification" "$created_at_epoch"
`,
    ufw: "test \"${1-}\" = status\nprintf '%s\\n' 'Status: inactive'\n"
  };
  for (const [name, body] of Object.entries(commandBodies)) {
    await writeExecutable(path.join(bin, name), body);
  }

  const stageContents = new Map([
    ["ISOLATION-BOUNDARY.txt", "fixture isolation boundary\n"],
    ["PHASE-2-INPUT.json", '{"schemaVersion":1,"phaseId":"debian-host-prep-v1"}\n'],
    ["README-FIRST.txt", "fixture operator instructions\n"],
    ["TO-DEBIAN/apply-host-prep.sh", "#!/usr/bin/env bash\nexit 99\n"],
    ["TO-DEBIAN/collect-host-prep-evidence.sh", "#!/usr/bin/env bash\nexit 99\n"]
  ]);
  for (const [relativePath, contents] of stageContents) {
    await writeFile(path.join(stage, ...relativePath.split("/")), contents, { mode: 0o600 });
  }
  await copyFile(HOST_PREP_SCRIPT_URL, scriptPath);
  await chmod(scriptPath, 0o700);
  const manifestLines = [];
  for (const relativePath of HOST_PREP_STAGE_FILES) {
    const contents = await readFile(path.join(stage, ...relativePath.split("/")));
    manifestLines.push(`${createHash("sha256").update(contents).digest("hex")}  ${relativePath}`);
  }
  await writeFile(
    path.join(stage, "CHECKSUMS", "PHASE-2-HOST-PREP.sha256"),
    `${manifestLines.join("\n")}\n`,
    { mode: 0o600 }
  );
  return { base, root, bin, stage, scriptPath };
}

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

test("host prep preflight has an explicit read-only contract", async () => {
  const script = await readFile(HOST_PREP_SCRIPT_URL, "utf8");
  assert.match(script, /^#!\/usr\/bin\/env bash/m);
  assert.match(script, /set -Eeuo pipefail/);
  assert.match(script, /VERSION_ID.*13/);
  assert.match(script, /x86_64/);
  assert.match(script, /3500/);
  assert.match(script, /10.*GiB|10737418240/);
  assert.match(script, /qemu-guest-agent\.service/);
  assert.match(script, /systemd-timesyncd\.service/);
  assert.match(script, /127\.0\.0\.1|3116/);
  assert.match(script, /\.host-prep-preflight-ok/);
  assert.doesNotMatch(
    script,
    /\b(?:apt-get|apt|adduser|addgroup|useradd|groupadd|install\s+-d|systemctl\s+(?:enable|start|stop|restart)|ufw|nft|iptables|cloudflared|npm)\b/
  );
  assert.doesNotMatch(
    script,
    /(?:printenv|\/proc\/[^\s"']*cmdline|journalctl|\.bash_history|security\.json|push\.json|board\.json|analytics\.json|\/etc\/palziv\/palziv\.env)/
  );
});

test(
  "host prep preflight creates one restricted six-field token only for reusable states",
  { skip: process.platform !== "linux" },
  async (t) => {
    for (const expectedClassification of ["clean", "already-prepared"]) {
      await t.test(expectedClassification, async () => {
        const fixture = await createHostPrepFixture({
          prepared: expectedClassification === "already-prepared"
        });
        try {
          const before = await snapshotFixtureTree(fixture.root);
          const result = await runHostPrepScript(fixture);
          assert.equal(result.code, 0, result.stderr);
          assert.deepEqual(JSON.parse(result.stdout.trim()), {
            ok: true,
            phaseId: HOST_PREP_PHASE_ID,
            classification: expectedClassification,
            tokenCreated: true
          });
          assert.match(result.stderr, /ufw=inactive/);
          for (const hostileArtifact of result.hostileArtifacts) {
            await assert.rejects(lstat(hostileArtifact), { code: "ENOENT" });
          }
          assert.deepEqual(await snapshotFixtureTree(fixture.root), before);

          const stageEntries = await readdir(fixture.stage);
          assert.deepEqual(
            stageEntries.filter((name) => name === ".host-prep-preflight-ok"),
            [".host-prep-preflight-ok"]
          );
          const tokenPath = path.join(fixture.stage, ".host-prep-preflight-ok");
          const tokenMetadata = await stat(tokenPath);
          assert.equal(tokenMetadata.mode & 0o777, 0o600);
          const token = JSON.parse(await readFile(tokenPath, "utf8"));
          assert.deepEqual(Object.keys(token).sort(), HOST_PREP_APPROVED_TOKEN_FIELDS);
          const manifestPath = path.join(
            fixture.stage,
            "CHECKSUMS",
            "PHASE-2-HOST-PREP.sha256"
          );
          assert.deepEqual(token, {
            schemaVersion: 1,
            phaseId: HOST_PREP_PHASE_ID,
            manifestFingerprint: createHash("sha256")
              .update(await readFile(manifestPath))
              .digest("hex"),
            stageRoot: await realpath(fixture.stage),
            classification: expectedClassification,
            createdAtEpoch: token.createdAtEpoch
          });
          assert.equal(Number.isInteger(token.createdAtEpoch), true);
          assert.ok(token.createdAtEpoch > 1_785_436_800);
        } finally {
          await rm(fixture.base, { recursive: true, force: true });
        }
      });
    }
  }
);

test(
  "host prep preflight fails closed for every conflicting reusable state",
  { skip: process.platform !== "linux" },
  async (t) => {
    const cases = [
      ["partial Node state", { partialNode: true }],
      ["unexpected Palziv path", { unexpectedPalzivPath: true }],
      ["port 3116 listener", { listener: true }],
      ["active managed service", { activeService: true }],
      ["missing HTTPS reachability", { missingHttps: true }],
      ["wrong Node symlink owner", { prepared: true, badNodeLinkOwner: true }],
      ["account lookup failure", { getentFailure: true }]
    ];
    for (const [name, options] of cases) {
      await t.test(name, async () => {
        const fixture = await createHostPrepFixture(options);
        try {
          const tokenPath = path.join(fixture.stage, ".host-prep-preflight-ok");
          if (name === "missing HTTPS reachability") {
            await writeFile(tokenPath, '{"stale":true}\n', { mode: 0o600 });
          }
          const before = await snapshotFixtureTree(fixture.root);
          const result = await runHostPrepScript(fixture);
          assert.notEqual(result.code, 0);
          assert.deepEqual(JSON.parse(result.stdout.trim()), {
            ok: false,
            phaseId: HOST_PREP_PHASE_ID,
            classification: "conflict",
            tokenCreated: false
          });
          await assert.rejects(lstat(tokenPath), { code: "ENOENT" });
          assert.deepEqual(await snapshotFixtureTree(fixture.root), before);
          for (const hostileArtifact of result.hostileArtifacts) {
            await assert.rejects(lstat(hostileArtifact), { code: "ENOENT" });
          }
        } finally {
          await rm(fixture.base, { recursive: true, force: true });
        }
      });
    }
  }
);

test(
  "host prep preflight authenticates exact stage content before host inspection",
  { skip: process.platform !== "linux" },
  async (t) => {
    const cases = [
      {
        name: "changed inbound file",
        mutate: (fixture) => writeFile(path.join(fixture.stage, "README-FIRST.txt"), "tampered\n")
      },
      {
        name: "extra inbound file",
        mutate: (fixture) => writeFile(path.join(fixture.stage, "TO-DEBIAN", "extra.sh"), "extra\n")
      },
      {
        name: "linked manifest",
        mutate: async (fixture) => {
          const manifestPath = path.join(
            fixture.stage,
            "CHECKSUMS",
            "PHASE-2-HOST-PREP.sha256"
          );
          const linkedTarget = path.join(fixture.base, "linked-manifest");
          await copyFile(manifestPath, linkedTarget);
          await rm(manifestPath);
          await symlink(linkedTarget, manifestPath);
        }
      }
    ];
    for (const { name, mutate } of cases) {
      await t.test(name, async () => {
        const fixture = await createHostPrepFixture();
        try {
          await mutate(fixture);
          const result = await runHostPrepScript(fixture);
          assert.notEqual(result.code, 0);
          assert.deepEqual(JSON.parse(result.stdout.trim()), {
            ok: false,
            phaseId: HOST_PREP_PHASE_ID,
            classification: "conflict",
            tokenCreated: false
          });
          await assert.rejects(
            lstat(path.join(fixture.stage, ".host-prep-preflight-ok")),
            { code: "ENOENT" }
          );
        } finally {
          await rm(fixture.base, { recursive: true, force: true });
        }
      });
    }
  }
);

test(
  "host prep preflight enforces every fixed Debian baseline threshold",
  { skip: process.platform !== "linux" },
  async (t) => {
    const serviceBody = (failedService) => `case "\${1-}:\${2-}:\${3-}" in
  is-active:--quiet:${failedService}) exit 3 ;;
  is-active:--quiet:qemu-guest-agent.service|is-active:--quiet:systemd-timesyncd.service) exit 0 ;;
  is-active:--quiet:palziv.service|is-enabled:--quiet:palziv.service|is-active:--quiet:cloudflared.service|is-enabled:--quiet:cloudflared.service) exit 3 ;;
  *) exit 97 ;;
esac
`;
    const cases = [
      [
        "Debian release",
        (fixture) => writeFile(path.join(fixture.root, "etc", "os-release"), 'ID=debian\nVERSION_ID="12"\n')
      ],
      ["architecture", (fixture) => writeExecutable(path.join(fixture.bin, "uname"), "printf '%s\\n' aarch64\n")],
      [
        "virtualization",
        (fixture) => writeExecutable(path.join(fixture.bin, "systemd-detect-virt"), "printf '%s\\n' docker\n")
      ],
      ["processor count", (fixture) => writeExecutable(path.join(fixture.bin, "nproc"), "printf '%s\\n' 1\n")],
      [
        "memory",
        async (fixture) => {
          const meminfoPath = path.join(fixture.root, "proc", "meminfo");
          await chmod(meminfoPath, 0o600);
          await writeFile(meminfoPath, "MemTotal:        3583999 kB\n");
          await chmod(meminfoPath, 0o444);
        }
      ],
      [
        "free root bytes",
        (fixture) => writeExecutable(path.join(fixture.bin, "df"), "printf 'Avail\\n10737418239\\n'\n")
      ],
      [
        "time synchronization",
        (fixture) => writeExecutable(path.join(fixture.bin, "timedatectl"), "printf '%s\\n' no\n")
      ],
      [
        "QEMU guest agent",
        (fixture) => writeExecutable(path.join(fixture.bin, "systemctl"), serviceBody("qemu-guest-agent.service"))
      ],
      [
        "time synchronization service",
        (fixture) => writeExecutable(path.join(fixture.bin, "systemctl"), serviceBody("systemd-timesyncd.service"))
      ]
    ];
    for (const [name, mutate] of cases) {
      await t.test(name, async () => {
        const fixture = await createHostPrepFixture();
        try {
          await mutate(fixture);
          const before = await snapshotFixtureTree(fixture.root);
          const result = await runHostPrepScript(fixture);
          assert.notEqual(result.code, 0);
          assert.deepEqual(JSON.parse(result.stdout.trim()), {
            ok: false,
            phaseId: HOST_PREP_PHASE_ID,
            classification: "conflict",
            tokenCreated: false
          });
          assert.deepEqual(await snapshotFixtureTree(fixture.root), before);
          await assert.rejects(
            lstat(path.join(fixture.stage, ".host-prep-preflight-ok")),
            { code: "ENOENT" }
          );
        } finally {
          await rm(fixture.base, { recursive: true, force: true });
        }
      });
    }
  }
);

test(
  "host prep preflight rejects partial broad escaped and linked fixture routing",
  { skip: process.platform !== "linux" },
  async (t) => {
    const fixtureCases = [
      ["partial", (fixture) => ({ PALZIV_HOST_PREP_TEST_BIN: "" })],
      ["broad", () => ({ PALZIV_HOST_PREP_TEST_ROOT: "/tmp" })],
      ["escaped", () => ({ PALZIV_HOST_PREP_TEST_ROOT: "/var/tmp" })],
      [
        "linked",
        async (fixture) => {
          const linkedRoot = path.join(fixture.base, "linked-root");
          await symlink(fixture.root, linkedRoot);
          return { PALZIV_HOST_PREP_TEST_ROOT: linkedRoot };
        }
      ]
    ];
    for (const [name, environmentFactory] of fixtureCases) {
      await t.test(name, async () => {
        const fixture = await createHostPrepFixture();
        try {
          const environment = await environmentFactory(fixture);
          const before = await snapshotFixtureTree(fixture.root);
          const result = await runHostPrepScript(fixture, environment);
          assert.notEqual(result.code, 0);
          assert.deepEqual(JSON.parse(result.stdout.trim()), {
            ok: false,
            phaseId: HOST_PREP_PHASE_ID,
            classification: "conflict",
            tokenCreated: false
          });
          assert.deepEqual(await snapshotFixtureTree(fixture.root), before);
          await assert.rejects(
            lstat(path.join(fixture.stage, ".host-prep-preflight-ok")),
            { code: "ENOENT" }
          );
        } finally {
          await rm(fixture.base, { recursive: true, force: true });
        }
      });
    }
  }
);

test(
  "host prep preflight atomically replaces its stale regular token and cleans failed publication",
  { skip: process.platform !== "linux" },
  async (t) => {
    await t.test("successful replacement", async () => {
      const fixture = await createHostPrepFixture();
      try {
        const tokenPath = path.join(fixture.stage, ".host-prep-preflight-ok");
        await writeFile(tokenPath, '{"stale":true}\n', { mode: 0o600 });
        const result = await runHostPrepScript(fixture);
        assert.equal(result.code, 0, result.stderr);
        const token = JSON.parse(await readFile(tokenPath, "utf8"));
        assert.deepEqual(Object.keys(token).sort(), HOST_PREP_APPROVED_TOKEN_FIELDS);
        assert.equal(token.classification, "clean");
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });

    await t.test("failed publication cleanup", async () => {
      const fixture = await createHostPrepFixture();
      try {
        await writeExecutable(path.join(fixture.bin, "jq"), "exit 73\n");
        const result = await runHostPrepScript(fixture);
        assert.notEqual(result.code, 0);
        const tokenArtifacts = (await readdir(fixture.stage))
          .filter((name) => name.startsWith(".host-prep-preflight-ok"));
        assert.deepEqual(tokenArtifacts, []);
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });
  }
);

test(
  "host prep preflight refuses an unsafe stale-token target",
  { skip: process.platform !== "linux" },
  async () => {
    const fixture = await createHostPrepFixture();
    try {
      const outside = path.join(fixture.base, "outside-token-target");
      await writeFile(outside, "must remain\n", { mode: 0o600 });
      await symlink(outside, path.join(fixture.stage, ".host-prep-preflight-ok"));
      const result = await runHostPrepScript(fixture);
      assert.notEqual(result.code, 0);
      assert.equal(await readFile(outside, "utf8"), "must remain\n");
      assert.equal((await lstat(path.join(fixture.stage, ".host-prep-preflight-ok"))).isSymbolicLink(), true);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  }
);

test(
  "host prep preflight exposes guarded functions without executing main when sourced",
  { skip: process.platform !== "linux" },
  async () => {
    const fixture = await createHostPrepFixture();
    try {
      const command = [
        ". \"$1\"",
        "type host_prep_stage_root >/dev/null",
        "type host_prep_manifest_fingerprint >/dev/null",
        "type host_prep_classify >/dev/null",
        "type host_prep_verify_safety_state >/dev/null"
      ].join("\n");
      const result = await execFile("/bin/bash", ["-p", "-c", command, "bash", fixture.scriptPath], {
        env: {
          ...process.env,
          PALZIV_HOST_PREP_TEST_MODE: "1",
          PALZIV_HOST_PREP_TEST_ROOT: fixture.root,
          PALZIV_HOST_PREP_TEST_BIN: fixture.bin
        },
        timeout: 15_000
      });
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
      await assert.rejects(
        lstat(path.join(fixture.stage, ".host-prep-preflight-ok")),
        { code: "ENOENT" }
      );
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  }
);
