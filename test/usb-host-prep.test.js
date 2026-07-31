import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
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
const HOST_PREP_APPLY_SCRIPT_URL = new URL(
  "../scripts/migration/apply-host-prep.sh",
  import.meta.url
);
const HOST_PREP_NODE_ARCHIVE_SHA =
  "55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742";
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

function assertBoundedPreflightFailure(result) {
  assert.notEqual(result.code, 0);
  assert.equal(
    result.stdout,
    '{"ok":false,"phaseId":"debian-host-prep-v1","classification":"conflict","tokenCreated":false}\n'
  );
  assert.match(
    result.stderr,
    /^(?:host-prep: ufw=(?:active|inactive|unavailable)\n)?host-prep: failed step=[a-z-]+\n$/
  );
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

async function runHostPrepScript(
  fixture,
  extraEnvironment = {},
  { runAsNobody = false } = {}
) {
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
  const isolatedEnvironment = [
    "-i",
    `HOME=${runAsNobody ? "/tmp" : os.homedir()}`,
    "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
    `PALZIV_HOST_PREP_TEST_MODE=${environment.PALZIV_HOST_PREP_TEST_MODE}`,
    `PALZIV_HOST_PREP_TEST_ROOT=${environment.PALZIV_HOST_PREP_TEST_ROOT}`,
    `PALZIV_HOST_PREP_TEST_BIN=${environment.PALZIV_HOST_PREP_TEST_BIN}`,
    "/bin/bash",
    "-p",
    fixture.scriptPath
  ];
  const command = runAsNobody ? "/usr/sbin/runuser" : "/usr/bin/env";
  const commandArguments = runAsNobody
    ? ["-u", "nobody", "--", "/usr/bin/env", ...isolatedEnvironment]
    : isolatedEnvironment;

  try {
    const result = await execFile(command, commandArguments, {
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

async function makeFixtureReadableByNobody(candidate) {
  const metadata = await lstat(candidate);
  if (metadata.isSymbolicLink()) return;
  if (metadata.isDirectory()) {
    await chmod(candidate, 0o755);
    for (const child of await readdir(candidate)) {
      await makeFixtureReadableByNobody(path.join(candidate, child));
    }
    return;
  }
  if (metadata.isFile()) {
    await chmod(candidate, metadata.mode & 0o111 ? 0o755 : 0o644);
  }
}

async function prepareTraversalFailureFixture(fixture) {
  if (process.getuid?.() !== 0) return false;
  await makeFixtureReadableByNobody(fixture.base);
  return true;
}

async function runHostPrepWithDirectBash(fixture) {
  const environment = {
    HOME: os.homedir(),
    PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
    PALZIV_HOST_PREP_TEST_MODE: "1",
    PALZIV_HOST_PREP_TEST_ROOT: fixture.root,
    PALZIV_HOST_PREP_TEST_BIN: fixture.bin
  };
  try {
    const result = await execFile("/bin/bash", [fixture.scriptPath], {
      cwd: fixture.stage,
      env: environment,
      timeout: 15_000,
      maxBuffer: 1024 * 1024
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? ""
    };
  }
}

async function runExactProductionLauncherWithInvalidArgument(fixture, hostileEnvironment) {
  const argumentsList = [
    "-i",
    `HOME=${os.homedir()}`,
    "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
    "/bin/bash",
    "-p",
    fixture.scriptPath,
    "--invalid"
  ];
  try {
    const result = await execFile("/usr/bin/env", argumentsList, {
      cwd: fixture.stage,
      env: hostileEnvironment,
      timeout: 15_000,
      maxBuffer: 1024 * 1024
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? ""
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
  getentFailure = false,
  applyScriptUrl = null
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
  is-active:--quiet:palziv.service|is-active:--quiet:cloudflared.service) ${activeService ? "exit 0" : "exit 3"} ;;
  is-enabled:--quiet:palziv.service|is-enabled:--quiet:cloudflared.service) ${activeService ? "exit 0" : "exit 1"} ;;
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
      */opt/node-v24.18.0-linux-x64|*/opt/node-v24.18.0-linux-x64/bin|*/opt/node-v24.18.0-linux-x64/bin/node) printf '%s\\n' root:root:755 ;;
      */opt/palziv|*/opt/palziv/releases|*/var/backups/palziv|*/etc/palziv) printf '%s\\n' root:palziv:750 ;;
      */var/lib/palziv|*/var/lib/palziv/data) printf '%s\\n' palziv:palziv:700 ;;
      *) exit 94 ;;
    esac
    ;;
  *) exit 96 ;;
esac
`,
    jq: `if test "\${1-}" = -e; then
  test "\${2-}" = -r
  shift 2
  phase_id=
  fingerprint=
  stage=
  while test "$#" -gt 2; do
    test "$1" = --arg
    case "$2" in
      phase_id) phase_id=$3 ;;
      fingerprint) fingerprint=$3 ;;
      stage) stage=$3 ;;
      *) exit 90 ;;
    esac
    shift 3
  done
  test "$#" -eq 2
  token_path=$2
  /usr/bin/node - "$token_path" "$phase_id" "$fingerprint" "$stage" <<'NODE'
const fs = require("node:fs");
const [tokenPath, phaseId, fingerprint, stage] = process.argv.slice(2);
const token = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
const expectedKeys = [
  "classification",
  "createdAtEpoch",
  "manifestFingerprint",
  "phaseId",
  "schemaVersion",
  "stageRoot"
];
if (
  !token ||
  Array.isArray(token) ||
  Object.keys(token).sort().join("\\n") !== expectedKeys.join("\\n") ||
  token.schemaVersion !== 1 ||
  token.phaseId !== phaseId ||
  token.manifestFingerprint !== fingerprint ||
  token.stageRoot !== stage ||
  !["clean", "already-prepared"].includes(token.classification) ||
  !Number.isSafeInteger(token.createdAtEpoch)
) {
  process.exit(1);
}
process.stdout.write(\`\${token.classification}\\t\${token.createdAtEpoch}\\n\`);
NODE
  exit
fi
test "\${1-}" = -n
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
    ["TO-DEBIAN/collect-host-prep-evidence.sh", "#!/usr/bin/env bash\nexit 99\n"]
  ]);
  if (!applyScriptUrl) {
    stageContents.set("TO-DEBIAN/apply-host-prep.sh", "#!/usr/bin/env bash\nexit 99\n");
  }
  for (const [relativePath, contents] of stageContents) {
    await writeFile(path.join(stage, ...relativePath.split("/")), contents, { mode: 0o600 });
  }
  if (applyScriptUrl) {
    await copyFile(applyScriptUrl, path.join(stage, "TO-DEBIAN", "apply-host-prep.sh"));
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

async function readMutationLog(fixture) {
  try {
    return (await readFile(fixture.mutationLog, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function mutationLogger(name, logPath) {
  return `{
  printf '%s' ${shellSingleQuote(name)}
  for logged_argument do
    printf '\\t%s' "$logged_argument"
  done
  printf '\\n'
} >> ${shellSingleQuote(logPath)}
`;
}

async function createHostPrepNodeArchive(fixture, kind = "valid") {
  const archiveSource = path.join(fixture.base, `archive-source-${kind}`);
  const archiveRoot = path.join(archiveSource, "node-v24.18.0-linux-x64");
  const archivePath = path.join(fixture.base, `node-${kind}.tar.xz`);
  await mkdir(path.join(archiveRoot, "bin"), { recursive: true });
  await mkdir(path.join(archiveRoot, "lib", "node_modules", "npm", "bin"), {
    recursive: true
  });
  await writeExecutable(
    path.join(archiveRoot, "bin", "node"),
    "printf '%s\\n' v24.18.0\n"
  );
  await chmod(path.join(archiveRoot, "bin", "node"), 0o755);
  await writeExecutable(
    path.join(archiveRoot, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    "printf '%s\\n' 11.9.0\n"
  );
  await symlink(
    "../lib/node_modules/npm/bin/npm-cli.js",
    path.join(archiveRoot, "bin", "npm")
  );
  if (kind === "hard-link") {
    await link(
      path.join(archiveRoot, "bin", "node"),
      path.join(archiveRoot, "bin", "node-hard-link")
    );
  }
  if (kind === "escaping-link") {
    await symlink("../../../../outside", path.join(archiveRoot, "bin", "escape"));
  }
  if (kind === "fifo") {
    await execFile("/usr/bin/mkfifo", [path.join(archiveRoot, "hostile-fifo")]);
  }

  const transform = {
    "parent-traversal": "s|^node-v24.18.0-linux-x64|../node-v24.18.0-linux-x64|",
    "absolute-entry": "s|^node-v24.18.0-linux-x64|/node-v24.18.0-linux-x64|",
    "alternate-root": "s|^node-v24.18.0-linux-x64|unexpected-node-root|"
  }[kind];
  const args = ["-cJf", archivePath];
  if (kind === "absolute-entry") args.push("-P");
  if (transform) args.push(`--transform=${transform}`);
  args.push("-C", archiveSource, "node-v24.18.0-linux-x64");
  if (kind === "duplicate-entry") {
    const uncompressedArchive = archivePath.slice(0, -3);
    await execFile("/usr/bin/tar", [
      "-cf",
      uncompressedArchive,
      "-C",
      archiveSource,
      "node-v24.18.0-linux-x64"
    ], { timeout: 15_000 });
    await execFile("/usr/bin/tar", [
      "-rf",
      uncompressedArchive,
      "-C",
      archiveSource,
      "node-v24.18.0-linux-x64/bin/node"
    ], { timeout: 15_000 });
    await execFile("/usr/bin/xz", ["--compress", "--force", uncompressedArchive], {
      timeout: 15_000
    });
    return archivePath;
  }
  await execFile("/usr/bin/tar", args, { timeout: 15_000 });
  return archivePath;
}

async function installHostPrepApplyStubs(fixture, {
  archiveKind = "valid",
  wrongArchiveHash = false,
  postMutationTamper = false,
  replaceArchiveAfterInspection = false,
  nodePublicationRace = false,
  linkPublicationRace = false
} = {}) {
  const stateDirectory = path.join(fixture.base, "apply-state");
  const mutationLog = path.join(fixture.base, "mutation.log");
  const archivePath = await createHostPrepNodeArchive(fixture, archiveKind);
  const groupMarker = path.join(stateDirectory, "group-created");
  const userMarker = path.join(stateDirectory, "user-created");
  const replacementMarker = path.join(stateDirectory, "replace-after-inspection");
  const tamperMarker = path.join(stateDirectory, "tamper-after-publication");
  const nodeRaceMarker = path.join(stateDirectory, "race-node-publication");
  const linkRaceMarker = path.join(stateDirectory, "race-link-publication");
  await mkdir(stateDirectory);
  if (replaceArchiveAfterInspection) await writeFile(replacementMarker, "1\n");
  if (postMutationTamper) await writeFile(tamperMarker, "1\n");
  if (nodePublicationRace) await writeFile(nodeRaceMarker, "1\n");
  if (linkPublicationRace) await writeFile(linkRaceMarker, "1\n");
  if (fixture.initiallyPrepared) {
    await writeFile(groupMarker, "1\n");
    await writeFile(userMarker, "1\n");
  }

  await writeExecutable(
    path.join(fixture.bin, "getent"),
    `case "\${1-}:\${2-}" in
  passwd:palziv)
    test -f ${shellSingleQuote(userMarker)} || exit 2
    printf '%s\\n' 'palziv:x:998:998::/var/lib/palziv:/usr/sbin/nologin'
    ;;
  group:palziv)
    test -f ${shellSingleQuote(groupMarker)} || exit 2
    printf '%s\\n' 'palziv:x:998:'
    ;;
  *) exit 2 ;;
esac
`
  );
  await writeExecutable(
    path.join(fixture.bin, "apply-mktemp"),
    `${mutationLogger("mktemp", mutationLog)}
exec /usr/bin/mktemp "$@"
`
  );
  await writeExecutable(
    path.join(fixture.bin, "apply-apt-get"),
    `${mutationLogger("apt-get", mutationLog)}
case "$*" in
  update|'install -y --no-install-recommends ca-certificates curl git jq rsync tar xz-utils') ;;
  *) exit 91 ;;
esac
`
  );
  await writeExecutable(
    path.join(fixture.bin, "apply-curl"),
    `${mutationLogger("curl", mutationLog)}
test "$#" -eq 14
test "$1" = --disable
test "$2" = --fail
test "$3" = --silent
test "$4" = --show-error
test "$5" = --location
test "$6" = --noproxy
test "$7" = "*"
test "$8" = --proto
test "$9" = "=https"
test "\${10}" = --proto-redir
test "\${11}" = "=https"
test "\${12}" = https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz
test "\${13}" = --output
/usr/bin/cp -- ${shellSingleQuote(archivePath)} "\${14}"
`
  );
  await writeExecutable(
    path.join(fixture.bin, "apply-sha256sum"),
    `${mutationLogger("sha256sum", mutationLog)}
test "$#" -eq 1
printf '%s  %s\\n' ${
  wrongArchiveHash ? "0".repeat(64) : HOST_PREP_NODE_ARCHIVE_SHA
} "$1"
`
  );
  await writeExecutable(
    path.join(fixture.bin, "apply-tar"),
    `${mutationLogger("tar", mutationLog)}
status=0
/usr/bin/tar "$@" || status=$?
case "$*" in
  *--list*)
    if test -f ${shellSingleQuote(replacementMarker)}; then
      for downloaded_archive in ${shellSingleQuote(
        path.join(fixture.root, "var", "tmp")
      )}/project-a-host-prep.*/node-v24.18.0-linux-x64.tar.xz; do
        test -f "$downloaded_archive" || continue
        printf '%s\\n' replaced > "$downloaded_archive"
      done
    fi
    ;;
esac
exit "$status"
`
  );
  await writeExecutable(
    path.join(fixture.bin, "apply-addgroup"),
    `${mutationLogger("addgroup", mutationLog)}
test "$*" = '--system palziv'
test ! -e ${shellSingleQuote(groupMarker)}
: > ${shellSingleQuote(groupMarker)}
`
  );
  await writeExecutable(
    path.join(fixture.bin, "apply-adduser"),
    `${mutationLogger("adduser", mutationLog)}
test "$*" = '--system --ingroup palziv --home /var/lib/palziv --no-create-home --shell /usr/sbin/nologin palziv'
test -f ${shellSingleQuote(groupMarker)}
test ! -e ${shellSingleQuote(userMarker)}
: > ${shellSingleQuote(userMarker)}
`
  );
  await writeExecutable(
    path.join(fixture.bin, "apply-install"),
    `${mutationLogger("install", mutationLog)}
mode=
last=
while test "$#" -gt 0; do
  case "$1" in
    -m) mode=$2; shift 2 ;;
    -o|-g) shift 2 ;;
    -d|--) shift ;;
    *) last=$1; shift ;;
  esac
done
test -n "$mode"
test -n "$last"
/usr/bin/mkdir -- "$last"
/usr/bin/chmod "$mode" "$last"
`
  );
  await writeExecutable(
    path.join(fixture.bin, "apply-mv"),
    `${mutationLogger("mv", mutationLog)}
destination=
for destination do :; done
case "$destination" in
  */opt/node-v24.18.0-linux-x64)
    if test -f ${shellSingleQuote(nodeRaceMarker)}; then
      /usr/bin/mkdir -- "$destination"
      printf '%s\\n' caller-owned > "$destination/caller-owned"
    fi
    ;;
  */opt/node)
    if test -f ${shellSingleQuote(linkRaceMarker)}; then
      printf '%s\\n' caller-owned > "$destination"
    fi
    ;;
esac
exec /usr/bin/mv "$@"
`
  );
  await writeExecutable(
    path.join(fixture.bin, "apply-ln"),
    `${mutationLogger("ln", mutationLog)}
/usr/bin/ln "$@"
if test -f ${shellSingleQuote(tamperMarker)}; then
  /usr/bin/touch ${shellSingleQuote(
    path.join(fixture.root, "etc", "palziv", "unexpected")
  )}
fi
`
  );
  await writeExecutable(
    path.join(fixture.bin, "apply-rm"),
    `${mutationLogger("rm", mutationLog)}
exec /usr/bin/rm "$@"
`
  );

  fixture.archivePath = archivePath;
  fixture.mutationLog = mutationLog;
}

async function createHostPrepApplyFixture({
  prepared = false,
  applyStubOptions = {}
} = {}) {
  const fixture = await createHostPrepFixture({
    prepared,
    applyScriptUrl: HOST_PREP_APPLY_SCRIPT_URL
  });
  fixture.initiallyPrepared = prepared;
  fixture.applyScriptPath = path.join(fixture.stage, "TO-DEBIAN", "apply-host-prep.sh");
  await mkdir(path.join(fixture.root, "var", "tmp"), { recursive: true });
  await installHostPrepApplyStubs(fixture, applyStubOptions);
  const preflight = await runHostPrepScript(fixture);
  assert.equal(preflight.code, 0, preflight.stderr);
  await chmod(fixture.base, 0o711);
  await chmod(fixture.stage, 0o711);
  await chmod(path.join(fixture.stage, "TO-DEBIAN"), 0o711);
  await chmod(fixture.applyScriptPath, 0o755);
  return fixture;
}

async function runHostPrepApply(fixture, {
  args = ["--apply"],
  privilegedMode = true,
  root = true,
  environment = {}
} = {}) {
  const isolatedArguments = [
    "-i",
    "HOME=/root",
    "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
    "PALZIV_HOST_PREP_TEST_MODE=1",
    `PALZIV_HOST_PREP_TEST_ROOT=${fixture.root}`,
    `PALZIV_HOST_PREP_TEST_BIN=${fixture.bin}`,
    "/bin/bash"
  ];
  if (privilegedMode) isolatedArguments.push("-p");
  isolatedArguments.push(fixture.applyScriptPath, ...args);
  const command = root ? "/usr/bin/env" : "/usr/sbin/runuser";
  const commandArguments = root
    ? isolatedArguments
    : ["-u", "nobody", "--", "/usr/bin/env", ...isolatedArguments];
  try {
    const result = await execFile(command, commandArguments, {
      cwd: fixture.stage,
      env: { ...process.env, ...environment },
      timeout: 30_000,
      maxBuffer: 1024 * 1024
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? ""
    };
  }
}

function assertBoundedApplyFailure(result) {
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    /^Host preparation failed at step: [a-z][a-z-]*\.\n$/
  );
}

async function mutateHostPrepToken(fixture, mutate) {
  const tokenPath = path.join(fixture.stage, ".host-prep-preflight-ok");
  const token = JSON.parse(await readFile(tokenPath, "utf8"));
  await writeFile(tokenPath, `${JSON.stringify(mutate(token))}\n`, { mode: 0o600 });
  await chmod(tokenPath, 0o600);
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
  assert.equal(script.includes("\r"), false, "preflight must remain LF-only");
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

test("host prep apply is explicit pinned and excludes deployment actions", async () => {
  const script = await readFile(HOST_PREP_APPLY_SCRIPT_URL, "utf8");
  assert.equal(script.includes("\r"), false, "apply script must remain LF-only");
  assert.match(script, /^#!\/usr\/bin\/env bash/m);
  assert.match(script, /set -Eeuo pipefail/);
  assert.match(script, /EUID.*0/);
  assert.match(script, /\$-.*p|privileged/);
  assert.match(script, /--apply/);
  assert.match(script, /900/);
  assert.match(script, /55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742/);
  assert.match(script, /node-v24\.18\.0-linux-x64\.tar\.xz/);
  for (const packageName of [
    "ca-certificates",
    "curl",
    "git",
    "jq",
    "rsync",
    "tar",
    "xz-utils"
  ]) {
    assert.match(script, new RegExp(packageName.replace("-", "\\-")));
  }
  assert.match(script, /\/usr\/sbin\/nologin/);
  assert.match(script, /\/opt\/palziv\/releases/);
  assert.match(script, /\/var\/lib\/palziv\/data/);
  assert.match(script, /\/var\/backups\/palziv/);
  assert.match(script, /\/etc\/palziv/);
  assert.match(script, /preflight-host-prep\.sh/);
  assert.match(script, /host_prep_classify/);
  assert.match(script, /host_prep_verify_safety_state/);
  assert.match(script, /host_prep_manifest_fingerprint/);
  assert.doesNotMatch(
    script,
    /\b(?:systemctl|ufw|nft|iptables|cloudflared|npm|git\s+clone|rsync\s+--delete)\b/
  );
  assert.doesNotMatch(script, /\/opt\/palziv\/current|palziv\.env|itotexpress\.com/);
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
  "host prep preflight invalidates safe prior receipts before fallible validation",
  { skip: process.platform !== "linux" },
  async () => {
    const fixture = await createHostPrepFixture();
    try {
      const tokenPath = path.join(fixture.stage, ".host-prep-preflight-ok");
      await writeFile(tokenPath, '{"stale":true}\n', { mode: 0o600 });
      await writeFile(path.join(fixture.stage, "README-FIRST.txt"), "tampered\n");
      const result = await runHostPrepScript(fixture);
      assertBoundedPreflightFailure(result);
      await assert.rejects(lstat(tokenPath), { code: "ENOENT" });
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  }
);

test(
  "host prep preflight requires the isolated privileged launcher",
  { skip: process.platform !== "linux" },
  async (t) => {
    await t.test("ordinary Bash refuses and invalidates a safe prior receipt", async () => {
      const fixture = await createHostPrepFixture();
      try {
        const tokenPath = path.join(fixture.stage, ".host-prep-preflight-ok");
        await writeFile(tokenPath, '{"stale":true}\n', { mode: 0o600 });
        const result = await runHostPrepWithDirectBash(fixture);
        assertBoundedPreflightFailure(result);
        assert.match(result.stderr, /step=invocation/);
        await assert.rejects(lstat(tokenPath), { code: "ENOENT" });
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });

    await t.test("exact production launcher clears a hostile parent before Bash starts", async () => {
      const fixture = await createHostPrepFixture();
      try {
        const tokenPath = path.join(fixture.stage, ".host-prep-preflight-ok");
        const bashEnvMarker = path.join(fixture.base, "pre-start-hook-fired");
        const bashEnvPath = path.join(fixture.base, "hostile-production-bash-env");
        await writeFile(bashEnvPath, `: > ${shellSingleQuote(bashEnvMarker)}\n`, { mode: 0o600 });
        await writeFile(tokenPath, '{"stale":true}\n', { mode: 0o600 });
        const result = await runExactProductionLauncherWithInvalidArgument(fixture, {
          ...process.env,
          BASH_ENV: bashEnvPath,
          ENV: bashEnvPath,
          PATH: path.join(fixture.base, "hostile-parent-path")
        });
        assertBoundedPreflightFailure(result);
        assert.match(result.stderr, /step=arguments/);
        await assert.rejects(lstat(bashEnvMarker), { code: "ENOENT" });
        await assert.rejects(lstat(tokenPath), { code: "ENOENT" });
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });
  }
);

test(
  "host prep preflight preserves traversal producer failures",
  { skip: process.platform !== "linux" },
  async () => {
    const fixture = await createHostPrepFixture();
    const blockedDirectory = path.join(fixture.stage, "FROM-DEBIAN");
    try {
      const runAsNobody = await prepareTraversalFailureFixture(fixture);
      await chmod(blockedDirectory, 0o000);
      const result = await runHostPrepScript(fixture, {}, { runAsNobody });
      assertBoundedPreflightFailure(result);
      await assert.rejects(
        lstat(path.join(fixture.stage, ".host-prep-preflight-ok")),
        { code: "ENOENT" }
      );
    } finally {
      await chmod(blockedDirectory, 0o700).catch(() => {});
      await rm(fixture.base, { recursive: true, force: true });
    }
  }
);

test(
  "host prep preflight pins one fixture base and rejects linked or replaced fixture state",
  { skip: process.platform !== "linux" },
  async (t) => {
    await t.test("stage and mapped state from different fixture bases", async () => {
      const stageFixture = await createHostPrepFixture();
      const stateFixture = await createHostPrepFixture();
      try {
        const result = await runHostPrepScript(stageFixture, {
          PALZIV_HOST_PREP_TEST_ROOT: stateFixture.root,
          PALZIV_HOST_PREP_TEST_BIN: stateFixture.bin
        });
        assertBoundedPreflightFailure(result);
        assert.match(result.stderr, /step=fixture-routing|step=stage-path/);
      } finally {
        await rm(stageFixture.base, { recursive: true, force: true });
        await rm(stateFixture.base, { recursive: true, force: true });
      }
    });

    await t.test("linked mapped descendant", async () => {
      const fixture = await createHostPrepFixture();
      try {
        const outsideEtc = path.join(fixture.base, "outside-etc");
        await mkdir(outsideEtc);
        await copyFile(path.join(fixture.root, "etc", "os-release"), path.join(outsideEtc, "os-release"));
        await rm(path.join(fixture.root, "etc"), { recursive: true });
        await symlink(outsideEtc, path.join(fixture.root, "etc"));
        const result = await runHostPrepScript(fixture);
        assertBoundedPreflightFailure(result);
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });

    for (const boundary of ["root", "bin"]) {
      await t.test(`post-initialization ${boundary} replacement`, async () => {
        const fixture = await createHostPrepFixture();
        try {
          const target = fixture[boundary];
          const oldTarget = `${target}-old`;
          await writeExecutable(
            path.join(fixture.bin, "uname"),
            [
              `/usr/bin/mv ${shellSingleQuote(target)} ${shellSingleQuote(oldTarget)}`,
              `/usr/bin/cp -a ${shellSingleQuote(oldTarget)} ${shellSingleQuote(target)}`,
              "printf '%s\\n' x86_64"
            ].join("\n")
          );
          const result = await runHostPrepScript(fixture);
          assertBoundedPreflightFailure(result);
        } finally {
          await rm(fixture.base, { recursive: true, force: true });
        }
      });
    }

    await t.test("control character in canonical stage", async () => {
      const fixture = await createHostPrepFixture();
      try {
        const controlledStage = `${fixture.stage}\tcontrolled`;
        await rename(fixture.stage, controlledStage);
        fixture.stage = controlledStage;
        fixture.scriptPath = path.join(controlledStage, "TO-DEBIAN", "preflight-host-prep.sh");
        const result = await runHostPrepScript(fixture);
        assertBoundedPreflightFailure(result);
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });
  }
);

test(
  "host prep preflight enforces exact prepared directory child sets",
  { skip: process.platform !== "linux" },
  async (t) => {
    const extras = [
      ["opt parent", ["opt", "palziv", "extra"]],
      ["release directory", ["opt", "palziv", "releases", "extra"]],
      ["state parent", ["var", "lib", "palziv", "extra"]],
      ["data directory", ["var", "lib", "palziv", "data", "extra"]],
      ["backup directory", ["var", "backups", "palziv", "extra"]],
      ["configuration directory", ["etc", "palziv", "extra"]]
    ];
    for (const [name, components] of extras) {
      await t.test(name, async () => {
        const fixture = await createHostPrepFixture({ prepared: true });
        try {
          await writeFile(path.join(fixture.root, ...components), "unexpected\n");
          const result = await runHostPrepScript(fixture);
          assertBoundedPreflightFailure(result);
          await assert.rejects(
            lstat(path.join(fixture.stage, ".host-prep-preflight-ok")),
            { code: "ENOENT" }
          );
        } finally {
          await rm(fixture.base, { recursive: true, force: true });
        }
      });
    }

    await t.test("prepared directory traversal failure", async () => {
      const fixture = await createHostPrepFixture({ prepared: true });
      const blockedDirectory = path.join(fixture.root, "etc", "palziv");
      try {
        const runAsNobody = await prepareTraversalFailureFixture(fixture);
        await chmod(blockedDirectory, 0o000);
        const result = await runHostPrepScript(fixture, {}, { runAsNobody });
        assertBoundedPreflightFailure(result);
      } finally {
        await chmod(blockedDirectory, 0o700).catch(() => {});
        await rm(fixture.base, { recursive: true, force: true });
      }
    });
  }
);

test(
  "host prep preflight accepts only explicit quiet inactive service outcomes",
  { skip: process.platform !== "linux" },
  async (t) => {
    const cases = [
      ["wrong inactive status", "exit 1", "exit 1"],
      ["unknown enabled status", "exit 3", "exit 2"],
      ["command unavailable", "exit 127", "exit 1"],
      ["noisy inactive status", "printf '%s\\n' external-noise; exit 3", "exit 1"],
      ["multiline unknown status", "printf 'inactive\\nunknown\\n'; exit 3", "exit 1"]
    ];
    for (const [name, activeOutcome, enabledOutcome] of cases) {
      await t.test(name, async () => {
        const fixture = await createHostPrepFixture();
        try {
          await writeExecutable(
            path.join(fixture.bin, "systemctl"),
            `case "\${1-}:\${2-}:\${3-}" in
  is-active:--quiet:qemu-guest-agent.service|is-active:--quiet:systemd-timesyncd.service) exit 0 ;;
  is-active:--quiet:palziv.service) ${activeOutcome} ;;
  is-enabled:--quiet:palziv.service) ${enabledOutcome} ;;
  is-active:--quiet:cloudflared.service) exit 3 ;;
  is-enabled:--quiet:cloudflared.service) exit 1 ;;
  *) exit 97 ;;
esac
`
          );
          const result = await runHostPrepScript(fixture);
          assertBoundedPreflightFailure(result);
          assert.doesNotMatch(result.stdout + result.stderr, /external-noise|unknown/);
        } finally {
          await rm(fixture.base, { recursive: true, force: true });
        }
      });
    }
  }
);

test(
  "host prep preflight rejects ambiguous bounded account records",
  { skip: process.platform !== "linux" },
  async () => {
    const fixture = await createHostPrepFixture({ prepared: true });
    try {
      await writeExecutable(
        path.join(fixture.bin, "getent"),
        `case "\${1-}:\${2-}" in
  passwd:palziv) printf '%s\\n%s\\n' 'palziv:x:998:998::/var/lib/palziv:/usr/sbin/nologin' 'palziv:x:997:998::/var/lib/palziv:/usr/sbin/nologin' ;;
  group:palziv) printf '%s\\n' 'palziv:x:998:' ;;
  *) exit 2 ;;
esac
`
      );
      const result = await runHostPrepScript(fixture);
      assertBoundedPreflightFailure(result);
      await assert.rejects(
        lstat(path.join(fixture.stage, ".host-prep-preflight-ok")),
        { code: "ENOENT" }
      );
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  }
);

test(
  "host prep preflight suppresses external noise from successful observations",
  { skip: process.platform !== "linux" },
  async () => {
    const fixture = await createHostPrepFixture();
    try {
      await writeExecutable(
        path.join(fixture.bin, "uname"),
        "printf '%s\\n' hidden-external-noise >&2\nprintf '%s\\n' x86_64\n"
      );
      const result = await runHostPrepScript(fixture);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(
        result.stdout,
        '{"ok":true,"phaseId":"debian-host-prep-v1","classification":"clean","tokenCreated":true}\n'
      );
      assert.equal(result.stderr, "host-prep: ufw=inactive\n");
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  }
);

test(
  "host prep preflight rejects persistent replacement of a pinned mapped intermediate",
  { skip: process.platform !== "linux" },
  async () => {
    const fixture = await createHostPrepFixture();
    try {
      const mappedEtc = path.join(fixture.root, "etc");
      const originalEtc = path.join(fixture.root, "etc-before-replacement");
      await writeExecutable(
        path.join(fixture.bin, "uname"),
        [
          `/usr/bin/mv ${shellSingleQuote(mappedEtc)} ${shellSingleQuote(originalEtc)}`,
          `/usr/bin/cp -a ${shellSingleQuote(originalEtc)} ${shellSingleQuote(mappedEtc)}`,
          "printf '%s\\n' x86_64"
        ].join("\n")
      );
      const result = await runHostPrepScript(fixture);
      assertBoundedPreflightFailure(result);
      await assert.rejects(
        lstat(path.join(fixture.stage, ".host-prep-preflight-ok")),
        { code: "ENOENT" }
      );
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  }
);

test(
  "host prep preflight validates and pins the complete Node executable chain",
  { skip: process.platform !== "linux" },
  async (t) => {
    await t.test("direct bin symlink is rejected before external execution", async () => {
      const fixture = await createHostPrepFixture({ prepared: true });
      try {
        const versionRoot = path.join(fixture.root, "opt", "node-v24.18.0-linux-x64");
        const outsideBin = path.join(fixture.base, "outside-node-bin");
        const externalMarker = path.join(fixture.base, "external-node-executed");
        await rm(path.join(versionRoot, "bin"), { recursive: true });
        await mkdir(outsideBin);
        await writeExecutable(
          path.join(outsideBin, "node"),
          `: > ${shellSingleQuote(externalMarker)}\nprintf '%s\\n' v24.18.0\n`
        );
        await symlink(outsideBin, path.join(versionRoot, "bin"));

        const result = await runHostPrepScript(fixture);
        assertBoundedPreflightFailure(result);
        await assert.rejects(lstat(externalMarker), { code: "ENOENT" });
        await assert.rejects(
          lstat(path.join(fixture.stage, ".host-prep-preflight-ok")),
          { code: "ENOENT" }
        );
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });

    await t.test("bin directory replacement during Node execution is rejected", async () => {
      const fixture = await createHostPrepFixture({ prepared: true });
      try {
        const versionRoot = path.join(fixture.root, "opt", "node-v24.18.0-linux-x64");
        const activeBin = path.join(versionRoot, "bin");
        const oldBin = path.join(versionRoot, "bin-before-replacement");
        const replacementBin = path.join(versionRoot, "bin-replacement");
        const nodePath = path.join(activeBin, "node");
        const executionMarker = path.join(fixture.base, "node-execution-count");
        await mkdir(replacementBin);
        await writeExecutable(
          nodePath,
          [
            `printf x >> ${shellSingleQuote(executionMarker)}`,
            `/usr/bin/mv ${shellSingleQuote(activeBin)} ${shellSingleQuote(oldBin)}`,
            `/usr/bin/mv ${shellSingleQuote(replacementBin)} ${shellSingleQuote(activeBin)}`,
            "printf '%s\\n' v24.18.0"
          ].join("\n")
        );
        await link(nodePath, path.join(replacementBin, "node"));

        const result = await runHostPrepScript(fixture);
        assertBoundedPreflightFailure(result);
        assert.equal(await readFile(executionMarker, "utf8"), "x");
        await assert.rejects(
          lstat(path.join(fixture.stage, ".host-prep-preflight-ok")),
          { code: "ENOENT" }
        );
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });

    await t.test("Node replacement during a pre-execution metadata observer is rejected before execution", async () => {
      const fixture = await createHostPrepFixture({ prepared: true });
      try {
        const nodePath = path.join(
          fixture.root,
          "opt",
          "node-v24.18.0-linux-x64",
          "bin",
          "node"
        );
        const replacementNode = path.join(fixture.base, "observer-replacement-node");
        const observerMarker = path.join(fixture.base, "pre-execution-stat-mutated");
        const executionMarker = path.join(fixture.base, "pre-execution-replacement-ran");
        await writeExecutable(
          replacementNode,
          `: > ${shellSingleQuote(executionMarker)}\nprintf '%s\\n' v24.18.0\n`
        );
        await writeExecutable(
          path.join(fixture.bin, "stat"),
          `case "\${1-}:\${2-}" in
  -c:%U:%G)
    case "\${3-}" in
      */opt/node) printf '%s\\n' root:root ;;
      *) exit 95 ;;
    esac
    ;;
  -Lc:%U:%G:%a)
    case "\${3-}" in
      */opt/node-v24.18.0-linux-x64|*/opt/node-v24.18.0-linux-x64/bin) printf '%s\\n' root:root:755 ;;
      */opt/node-v24.18.0-linux-x64/bin/node)
        printf '%s\\n' root:root:755
        if [ ! -e ${shellSingleQuote(observerMarker)} ]; then
          : > ${shellSingleQuote(observerMarker)}
          /usr/bin/cp ${shellSingleQuote(replacementNode)} ${shellSingleQuote(nodePath)}
        fi
        ;;
      *) exit 94 ;;
    esac
    ;;
  *) exit 96 ;;
esac
`
        );

        const result = await runHostPrepScript(fixture);
        assertBoundedPreflightFailure(result);
        await lstat(observerMarker);
        await assert.rejects(lstat(executionMarker), { code: "ENOENT" });
        await assert.rejects(
          lstat(path.join(fixture.stage, ".host-prep-preflight-ok")),
          { code: "ENOENT" }
        );
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });

    await t.test("Node replacement during the final metadata observer is rejected", async () => {
      const fixture = await createHostPrepFixture({ prepared: true });
      try {
        const nodePath = path.join(
          fixture.root,
          "opt",
          "node-v24.18.0-linux-x64",
          "bin",
          "node"
        );
        const replacementNode = path.join(fixture.base, "final-observer-replacement-node");
        const observerCount = path.join(fixture.base, "node-link-stat-count");
        const observerMarker = path.join(fixture.base, "final-stat-mutated");
        const executionMarker = path.join(fixture.base, "final-observer-replacement-ran");
        await writeExecutable(
          replacementNode,
          `: > ${shellSingleQuote(executionMarker)}\nprintf '%s\\n' v24.18.0\n`
        );
        await writeExecutable(
          path.join(fixture.bin, "stat"),
          `case "\${1-}:\${2-}" in
  -c:%U:%G)
    case "\${3-}" in
      */opt/node)
        count=0
        if [ -f ${shellSingleQuote(observerCount)} ]; then
          read -r count < ${shellSingleQuote(observerCount)}
        fi
        count=$((count + 1))
        printf '%s\\n' "$count" > ${shellSingleQuote(observerCount)}
        printf '%s\\n' root:root
        if [ "$count" -eq 2 ]; then
          : > ${shellSingleQuote(observerMarker)}
          /usr/bin/cp ${shellSingleQuote(replacementNode)} ${shellSingleQuote(nodePath)}
        fi
        ;;
      *) exit 95 ;;
    esac
    ;;
  -Lc:%U:%G:%a)
    case "\${3-}" in
      */opt/node-v24.18.0-linux-x64|*/opt/node-v24.18.0-linux-x64/bin|*/opt/node-v24.18.0-linux-x64/bin/node) printf '%s\\n' root:root:755 ;;
      */opt/palziv|*/opt/palziv/releases|*/var/backups/palziv|*/etc/palziv) printf '%s\\n' root:palziv:750 ;;
      */var/lib/palziv|*/var/lib/palziv/data) printf '%s\\n' palziv:palziv:700 ;;
      *) exit 94 ;;
    esac
    ;;
  *) exit 96 ;;
esac
`
        );

        const result = await runHostPrepScript(fixture);
        assertBoundedPreflightFailure(result);
        await lstat(observerMarker);
        await assert.rejects(lstat(executionMarker), { code: "ENOENT" });
        await assert.rejects(
          lstat(path.join(fixture.stage, ".host-prep-preflight-ok")),
          { code: "ENOENT" }
        );
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });
  }
);

test(
  "host prep preflight rejects NUL-normalized and non-canonical observer output",
  { skip: process.platform !== "linux" },
  async (t) => {
    const cases = [
      [
        "NUL-only quiet service output",
        (fixture) => writeExecutable(
          path.join(fixture.bin, "systemctl"),
          `case "\${1-}:\${2-}:\${3-}" in
  is-active:--quiet:qemu-guest-agent.service|is-active:--quiet:systemd-timesyncd.service) exit 0 ;;
  is-active:--quiet:palziv.service) printf '\\000'; exit 3 ;;
  is-enabled:--quiet:palziv.service) exit 1 ;;
  is-active:--quiet:cloudflared.service) exit 3 ;;
  is-enabled:--quiet:cloudflared.service) exit 1 ;;
  *) exit 97 ;;
esac
`
        )
      ],
      [
        "NUL-polluted expected architecture",
        (fixture) => writeExecutable(
          path.join(fixture.bin, "uname"),
          "printf 'x86_64\\000\\n'\n"
        )
      ],
      [
        "extra df line before the value",
        (fixture) => writeExecutable(
          path.join(fixture.bin, "df"),
          "printf 'Avail\\nunexpected\\n10737418240\\n'\n"
        )
      ]
    ];

    for (const [name, mutate] of cases) {
      await t.test(name, async () => {
        const fixture = await createHostPrepFixture();
        try {
          await mutate(fixture);
          const result = await runHostPrepScript(fixture);
          assertBoundedPreflightFailure(result);
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
  "host prep preflight detects manifest and safety changes between validation passes",
  { skip: process.platform !== "linux" },
  async (t) => {
    await t.test("manifest-covered file changes before final manifest replay", async () => {
      const fixture = await createHostPrepFixture();
      try {
        await writeExecutable(
          path.join(fixture.bin, "ufw"),
          [
            `printf '%s\\n' tampered >> ${shellSingleQuote(path.join(fixture.stage, "README-FIRST.txt"))}`,
            "printf '%s\\n' 'Status: inactive'"
          ].join("\n")
        );
        const result = await runHostPrepScript(fixture);
        assertBoundedPreflightFailure(result);
        assert.equal(
          result.stderr,
          "host-prep: ufw=inactive\nhost-prep: failed step=final-manifest\n"
        );
        await assert.rejects(
          lstat(path.join(fixture.stage, ".host-prep-preflight-ok")),
          { code: "ENOENT" }
        );
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });

    await t.test("listener appears before final safety replay", async () => {
      const fixture = await createHostPrepFixture();
      try {
        const listenerMarker = path.join(fixture.base, "listener-after-first-pass");
        await writeExecutable(
          path.join(fixture.bin, "ufw"),
          `: > ${shellSingleQuote(listenerMarker)}\nprintf '%s\\n' 'Status: inactive'\n`
        );
        await writeExecutable(
          path.join(fixture.bin, "ss"),
          `if [ -e ${shellSingleQuote(listenerMarker)} ]; then
  printf '%s\\n' 'LISTEN 0 4096 127.0.0.1:3116'
fi
`
        );
        const result = await runHostPrepScript(fixture);
        assertBoundedPreflightFailure(result);
        assert.equal(
          result.stderr,
          "host-prep: ufw=inactive\nhost-prep: failed step=final-baseline\n"
        );
        await assert.rejects(
          lstat(path.join(fixture.stage, ".host-prep-preflight-ok")),
          { code: "ENOENT" }
        );
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });

    await t.test("manifest-covered file changes during final safety replay", async () => {
      const fixture = await createHostPrepFixture();
      try {
        const firstUnameMarker = path.join(fixture.base, "first-uname-complete");
        await writeExecutable(
          path.join(fixture.bin, "uname"),
          `if [ -e ${shellSingleQuote(firstUnameMarker)} ]; then
  printf '%s\\n' tampered >> ${shellSingleQuote(path.join(fixture.stage, "README-FIRST.txt"))}
else
  : > ${shellSingleQuote(firstUnameMarker)}
fi
printf '%s\\n' x86_64
`
        );
        const result = await runHostPrepScript(fixture);
        assertBoundedPreflightFailure(result);
        assert.equal(
          result.stderr,
          "host-prep: ufw=inactive\nhost-prep: failed step=final-manifest\n"
        );
        await assert.rejects(
          lstat(path.join(fixture.stage, ".host-prep-preflight-ok")),
          { code: "ENOENT" }
        );
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });

    await t.test("listener appears during final classification replay", async () => {
      const fixture = await createHostPrepFixture();
      try {
        const getentCount = path.join(fixture.base, "getent-call-count");
        const listenerMarker = path.join(fixture.base, "listener-during-final-classification");
        await writeExecutable(
          path.join(fixture.bin, "getent"),
          `count=0
if [ -f ${shellSingleQuote(getentCount)} ]; then
  read -r count < ${shellSingleQuote(getentCount)}
fi
count=$((count + 1))
printf '%s\\n' "$count" > ${shellSingleQuote(getentCount)}
if [ "$count" -ge 3 ]; then
  : > ${shellSingleQuote(listenerMarker)}
fi
exit 2
`
        );
        await writeExecutable(
          path.join(fixture.bin, "ss"),
          `if [ -e ${shellSingleQuote(listenerMarker)} ]; then
  printf '%s\\n' 'LISTEN 0 4096 127.0.0.1:3116'
fi
`
        );
        const result = await runHostPrepScript(fixture);
        assertBoundedPreflightFailure(result);
        assert.equal(
          result.stderr,
          "host-prep: ufw=inactive\nhost-prep: failed step=final-baseline\n"
        );
        await assert.rejects(
          lstat(path.join(fixture.stage, ".host-prep-preflight-ok")),
          { code: "ENOENT" }
        );
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });

    await t.test("owned host state changes during the first final safety replay", async () => {
      const fixture = await createHostPrepFixture();
      try {
        const unameCount = path.join(fixture.base, "uname-call-count");
        const ownedPath = path.join(fixture.root, "etc", "palziv");
        await writeExecutable(
          path.join(fixture.bin, "uname"),
          `count=0
if [ -f ${shellSingleQuote(unameCount)} ]; then
  read -r count < ${shellSingleQuote(unameCount)}
fi
count=$((count + 1))
printf '%s\\n' "$count" > ${shellSingleQuote(unameCount)}
if [ "$count" -eq 2 ]; then
  /usr/bin/mkdir ${shellSingleQuote(ownedPath)}
fi
printf '%s\\n' x86_64
`
        );

        const result = await runHostPrepScript(fixture);
        assertBoundedPreflightFailure(result);
        assert.equal(
          result.stderr,
          "host-prep: ufw=inactive\nhost-prep: failed step=final-classification\n"
        );
        await assert.rejects(
          lstat(path.join(fixture.stage, ".host-prep-preflight-ok")),
          { code: "ENOENT" }
        );
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });

    await t.test("baseline listener changes during the following classification replay", async () => {
      const fixture = await createHostPrepFixture();
      try {
        const getentCount = path.join(fixture.base, "getent-call-count");
        const listenerMarker = path.join(fixture.base, "listener-during-third-classification");
        await writeExecutable(
          path.join(fixture.bin, "getent"),
          `count=0
if [ -f ${shellSingleQuote(getentCount)} ]; then
  read -r count < ${shellSingleQuote(getentCount)}
fi
count=$((count + 1))
printf '%s\\n' "$count" > ${shellSingleQuote(getentCount)}
if [ "$count" -ge 5 ]; then
  : > ${shellSingleQuote(listenerMarker)}
fi
exit 2
`
        );
        await writeExecutable(
          path.join(fixture.bin, "ss"),
          `if [ -e ${shellSingleQuote(listenerMarker)} ]; then
  printf '%s\\n' 'LISTEN 0 4096 127.0.0.1:3116'
fi
`
        );

        const result = await runHostPrepScript(fixture);
        assertBoundedPreflightFailure(result);
        assert.equal(
          result.stderr,
          "host-prep: ufw=inactive\nhost-prep: failed step=final-baseline\n"
        );
        await assert.rejects(
          lstat(path.join(fixture.stage, ".host-prep-preflight-ok")),
          { code: "ENOENT" }
        );
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });
  }
);

test(
  "host prep preflight enforces every fixed Debian baseline threshold",
  { skip: process.platform !== "linux" },
  async (t) => {
    const serviceBody = (failedService) => `case "\${1-}:\${2-}:\${3-}" in
  is-active:--quiet:${failedService}) exit 3 ;;
  is-active:--quiet:qemu-guest-agent.service|is-active:--quiet:systemd-timesyncd.service) exit 0 ;;
  is-active:--quiet:palziv.service|is-active:--quiet:cloudflared.service) exit 3 ;;
  is-enabled:--quiet:palziv.service|is-enabled:--quiet:cloudflared.service) exit 1 ;;
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
        "host_prep_stage_root >/dev/null",
        "stage=$HOST_PREP_STAGE_ROOT_RESULT",
        "host_prep_manifest_fingerprint >/dev/null",
        "fingerprint=$HOST_PREP_MANIFEST_FINGERPRINT_RESULT",
        "host_prep_classify >/dev/null",
        "classification=$HOST_PREP_CLASSIFICATION_RESULT",
        "host_prep_verify_safety_state",
        "safety=$HOST_PREP_SAFETY_RESULT",
        "printf '%s\\n%s\\n%s\\n%s\\n' \"$stage\" \"$fingerprint\" \"$classification\" \"$safety\""
      ].join("\n");
      const result = await execFile("/usr/bin/env", [
        "-i",
        `HOME=${os.homedir()}`,
        "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
        "PALZIV_HOST_PREP_TEST_MODE=1",
        `PALZIV_HOST_PREP_TEST_ROOT=${fixture.root}`,
        `PALZIV_HOST_PREP_TEST_BIN=${fixture.bin}`,
        "/bin/bash",
        "-p",
        "-c",
        command,
        "bash",
        fixture.scriptPath
      ], {
        timeout: 15_000,
        maxBuffer: 1024 * 1024
      });
      const manifest = await readFile(
        path.join(fixture.stage, "CHECKSUMS", "PHASE-2-HOST-PREP.sha256")
      );
      assert.equal(
        result.stdout,
        `${fixture.stage}\n${createHash("sha256").update(manifest).digest("hex")}\nclean\nsafe\n`
      );
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

test(
  "host prep sourced stateful functions fail closed in subshells and retain current-shell pins",
  { skip: process.platform !== "linux" },
  async (t) => {
    await t.test("command substitutions cannot masquerade as valid stateful results", async () => {
      const fixture = await createHostPrepFixture();
      try {
        const command = [
          ". \"$1\"",
          "for function_name in host_prep_stage_root host_prep_manifest_fingerprint host_prep_classify host_prep_verify_safety_state; do",
          "  result=$($function_name 2>&1) && exit 80",
          "  test \"$result\" = 'host-prep: rejected stateful subshell'",
          "done",
          "test -z \"$HOST_PREP_STAGE_ROOT_RESULT\"",
          "test -z \"$HOST_PREP_MANIFEST_FINGERPRINT_RESULT\"",
          "test -z \"$HOST_PREP_CLASSIFICATION_RESULT\"",
          "test -z \"$HOST_PREP_SAFETY_RESULT\"",
          "printf '%s\\n' rejected"
        ].join("\n");
        const result = await execFile("/usr/bin/env", [
          "-i",
          `HOME=${os.homedir()}`,
          "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
          "PALZIV_HOST_PREP_TEST_MODE=1",
          `PALZIV_HOST_PREP_TEST_ROOT=${fixture.root}`,
          `PALZIV_HOST_PREP_TEST_BIN=${fixture.bin}`,
          "/bin/bash",
          "-p",
          "-c",
          command,
          "bash",
          fixture.scriptPath
        ], {
          timeout: 15_000,
          maxBuffer: 1024 * 1024
        });
        assert.equal(result.stdout, "rejected\n");
        assert.equal(result.stderr, "");
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });

    await t.test("classification pins persist into a direct safety call", async () => {
      const fixture = await createHostPrepFixture();
      try {
        const mappedEtc = path.join(fixture.root, "etc");
        const originalEtc = path.join(fixture.root, "etc-before-sourced-replacement");
        const command = [
          ". \"$1\"",
          "host_prep_stage_root >/dev/null",
          "host_prep_manifest_fingerprint >/dev/null",
          "host_prep_classify >/dev/null",
          `/usr/bin/mv ${shellSingleQuote(mappedEtc)} ${shellSingleQuote(originalEtc)}`,
          `/usr/bin/cp -a ${shellSingleQuote(originalEtc)} ${shellSingleQuote(mappedEtc)}`,
          "if host_prep_verify_safety_state; then exit 81; fi",
          "test -z \"$HOST_PREP_SAFETY_RESULT\"",
          "printf '%s\\n' pinned"
        ].join("\n");
        const result = await execFile("/usr/bin/env", [
          "-i",
          `HOME=${os.homedir()}`,
          "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
          "PALZIV_HOST_PREP_TEST_MODE=1",
          `PALZIV_HOST_PREP_TEST_ROOT=${fixture.root}`,
          `PALZIV_HOST_PREP_TEST_BIN=${fixture.bin}`,
          "/bin/bash",
          "-p",
          "-c",
          command,
          "bash",
          fixture.scriptPath
        ], {
          timeout: 15_000,
          maxBuffer: 1024 * 1024
        });
        assert.equal(result.stdout, "pinned\n");
        assert.equal(result.stderr, "");
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });
  }
);

test(
  "host prep apply rejects invocation token bundle and changed-host failures before mutation",
  { skip: process.platform !== "linux" },
  async (t) => {
    const cases = [
      ["non-root caller", null, { root: false }],
      ["non-privileged Bash", null, { privilegedMode: false }],
      ["missing argument", null, { args: [] }],
      ["extra argument", null, { args: ["--apply", "extra"] }],
      [
        "missing token",
        (fixture) => rm(path.join(fixture.stage, ".host-prep-preflight-ok")),
        {}
      ],
      [
        "token older than 900 seconds",
        (fixture) => mutateHostPrepToken(fixture, (token) => ({
          ...token,
          createdAtEpoch: Math.floor(Date.now() / 1000) - 901
        })),
        {}
      ],
      [
        "token from the future",
        (fixture) => mutateHostPrepToken(fixture, (token) => ({
          ...token,
          createdAtEpoch: Math.floor(Date.now() / 1000) + 3600
        })),
        {}
      ],
      [
        "token with an extra field",
        (fixture) => mutateHostPrepToken(fixture, (token) => ({
          ...token,
          unexpected: true
        })),
        {}
      ],
      [
        "token with changed stage",
        (fixture) => mutateHostPrepToken(fixture, (token) => ({
          ...token,
          stageRoot: `${token.stageRoot}-other`
        })),
        {}
      ],
      [
        "token with changed fingerprint",
        (fixture) => mutateHostPrepToken(fixture, (token) => ({
          ...token,
          manifestFingerprint: "0".repeat(64)
        })),
        {}
      ],
      [
        "token classification cannot authorize changed host state",
        async (fixture) => {
          await mutateHostPrepToken(fixture, (token) => ({
            ...token,
            classification: "already-prepared"
          }));
          await mkdir(path.join(fixture.root, "etc", "palziv"));
        },
        {}
      ],
      [
        "changed manifest-covered content",
        (fixture) => writeFile(path.join(fixture.stage, "README-FIRST.txt"), "changed\n"),
        {}
      ]
    ];

    for (const [name, mutate, invocation] of cases) {
      await t.test(name, async () => {
        const fixture = await createHostPrepApplyFixture();
        try {
          if (mutate) await mutate(fixture);
          const result = await runHostPrepApply(fixture, invocation);
          assertBoundedApplyFailure(result);
          assert.deepEqual(await readMutationLog(fixture), []);
        } finally {
          await rm(fixture.base, { recursive: true, force: true });
        }
      });
    }

    await t.test("tampered preflight is rejected before root sources it", async () => {
      const fixture = await createHostPrepApplyFixture();
      const marker = path.join(fixture.base, "tampered-preflight-sourced");
      try {
        await writeFile(
          fixture.scriptPath,
          `#!/usr/bin/env bash\n: > ${shellSingleQuote(marker)}\n`,
          { mode: 0o700 }
        );
        const result = await runHostPrepApply(fixture);
        assertBoundedApplyFailure(result);
        await assert.rejects(lstat(marker), { code: "ENOENT" });
        assert.deepEqual(await readMutationLog(fixture), []);
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });
  }
);

test(
  "host prep apply performs only the exact clean-host mutation allowlist",
  { skip: process.platform !== "linux" },
  async () => {
    const fixture = await createHostPrepApplyFixture();
    try {
      const result = await runHostPrepApply(fixture);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(
        result.stdout,
        '{"ok":true,"phaseId":"debian-host-prep-v1","classification":"prepared","changed":true}\n'
      );
      assert.equal(result.stderr, "");

      const log = await readMutationLog(fixture);
      assert.equal(log.filter((line) => line === "apt-get\tupdate").length, 1);
      assert.equal(
        log.filter((line) =>
          line ===
          "apt-get\tinstall\t-y\t--no-install-recommends\tca-certificates\tcurl\tgit\tjq\trsync\ttar\txz-utils"
        ).length,
        1
      );
      assert.equal(log.filter((line) => line.startsWith("curl\t")).length, 1);
      assert.match(log.find((line) => line.startsWith("curl\t")), /--noproxy\t\*\t/);
      assert.equal(log.filter((line) => line.startsWith("sha256sum\t")).length, 1);
      assert.equal(log.filter((line) => line.startsWith("tar\t") && line.includes("--list")).length, 1);
      assert.equal(log.filter((line) => line.startsWith("tar\t") && line.includes("--extract")).length, 1);
      assert.deepEqual(
        log.filter((line) => line.startsWith("addgroup\t")),
        ["addgroup\t--system\tpalziv"]
      );
      assert.deepEqual(
        log.filter((line) => line.startsWith("adduser\t")),
        [
          "adduser\t--system\t--ingroup\tpalziv\t--home\t/var/lib/palziv\t--no-create-home\t--shell\t/usr/sbin/nologin\tpalziv"
        ]
      );
      const installs = log.filter((line) => line.startsWith("install\t"));
      assert.equal(installs.length, 6);
      for (const suffix of [
        "/opt/palziv",
        "/opt/palziv/releases",
        "/var/lib/palziv",
        "/var/lib/palziv/data",
        "/var/backups/palziv",
        "/etc/palziv"
      ]) {
        assert.equal(installs.filter((line) => line.endsWith(suffix)).length, 1);
      }
      assert.equal(log.filter((line) => line.startsWith("mv\t")).length, 2);
      assert.equal(log.filter((line) => line.startsWith("ln\t")).length, 1);
      assert.doesNotMatch(
        log.join("\n"),
        /systemctl|firewall|cloudflare|npm(?:\tinstall|\tci)|server\.js|palzivalerts|itotexpress|proxmox/i
      );

      const nodeTarget = path.join(fixture.root, "opt", "node-v24.18.0-linux-x64");
      assert.equal((await lstat(nodeTarget)).isDirectory(), true);
      assert.equal(
        await fs.promises.readlink(path.join(fixture.root, "opt", "node")),
        "/opt/node-v24.18.0-linux-x64"
      );
      for (const [relativePath, mode] of [
        [["opt", "palziv"], 0o750],
        [["opt", "palziv", "releases"], 0o750],
        [["var", "lib", "palziv"], 0o700],
        [["var", "lib", "palziv", "data"], 0o700],
        [["var", "backups", "palziv"], 0o750],
        [["etc", "palziv"], 0o750]
      ]) {
        assert.equal((await stat(path.join(fixture.root, ...relativePath))).mode & 0o777, mode);
      }
      assert.deepEqual(await readdir(path.join(fixture.root, "var", "tmp")), []);
      assert.equal(
        (await readdir(path.join(fixture.root, "opt")))
          .filter((name) => name.startsWith(".node-")).length,
        0
      );
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  }
);

test(
  "host prep apply exits unchanged before work-root creation for exact prepared state",
  { skip: process.platform !== "linux" },
  async () => {
    const fixture = await createHostPrepApplyFixture({ prepared: true });
    try {
      const result = await runHostPrepApply(fixture);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(
        result.stdout,
        '{"ok":true,"phaseId":"debian-host-prep-v1","classification":"already-prepared","changed":false}\n'
      );
      assert.equal(result.stderr, "");
      assert.deepEqual(await readMutationLog(fixture), []);
      assert.deepEqual(await readdir(path.join(fixture.root, "var", "tmp")), []);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  }
);

test(
  "host prep apply blocks hash and hostile archive states before extraction or publication",
  { skip: process.platform !== "linux" },
  async (t) => {
    const cases = [
      ["wrong archive digest", { wrongArchiveHash: true }, 0],
      ["parent traversal", { archiveKind: "parent-traversal" }, 1],
      ["absolute archive entry", { archiveKind: "absolute-entry" }, 1],
      ["alternate top-level entry", { archiveKind: "alternate-root" }, 1],
      ["escaping symbolic link", { archiveKind: "escaping-link" }, 1],
      ["hard-link archive entry", { archiveKind: "hard-link" }, 1],
      ["duplicate archive entry", { archiveKind: "duplicate-entry" }, 1],
      ["FIFO archive entry", { archiveKind: "fifo" }, 1]
    ];
    for (const [name, applyStubOptions, expectedListings] of cases) {
      await t.test(name, async () => {
        const fixture = await createHostPrepApplyFixture({ applyStubOptions });
        try {
          const result = await runHostPrepApply(fixture);
          assertBoundedApplyFailure(result);
          const log = await readMutationLog(fixture);
          assert.equal(
            log.filter((line) => line.startsWith("tar\t") && line.includes("--list")).length,
            expectedListings
          );
          assert.equal(
            log.filter((line) => line.startsWith("tar\t") && line.includes("--extract")).length,
            0
          );
          assert.equal(log.filter((line) => line.startsWith("addgroup\t")).length, 0);
          assert.equal(log.filter((line) => line.startsWith("mv\t")).length, 0);
          await assert.rejects(
            lstat(path.join(fixture.root, "opt", "node-v24.18.0-linux-x64")),
            { code: "ENOENT" }
          );
          assert.deepEqual(await readdir(path.join(fixture.root, "var", "tmp")), []);
        } finally {
          await rm(fixture.base, { recursive: true, force: true });
        }
      });
    }
  }
);

test(
  "host prep apply preserves replay pins and catches one-time cross-domain changes",
  { skip: process.platform !== "linux" },
  async (t) => {
    await t.test("old trust epoch rejects an intentional clean to partial transition", async () => {
      const fixture = await createHostPrepFixture();
      try {
        const command = [
          ". \"$1\"",
          "host_prep_stage_root >/dev/null",
          "host_prep_manifest_fingerprint >/dev/null",
          "host_prep_classify >/dev/null",
          "test \"$HOST_PREP_CLASSIFICATION_RESULT\" = clean",
          `/usr/bin/mkdir ${shellSingleQuote(path.join(fixture.root, "etc", "palziv"))}`,
          "host_prep_classify >/dev/null",
          "test \"$HOST_PREP_CLASSIFICATION_RESULT\" = conflict"
        ].join("\n");
        await execFile("/usr/bin/env", [
          "-i",
          "HOME=/root",
          "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
          "PALZIV_HOST_PREP_TEST_MODE=1",
          `PALZIV_HOST_PREP_TEST_ROOT=${fixture.root}`,
          `PALZIV_HOST_PREP_TEST_BIN=${fixture.bin}`,
          "/bin/bash",
          "-p",
          "-c",
          command,
          "bash",
          fixture.scriptPath
        ]);
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });

    await t.test("host classification changes during stable replay", async () => {
      const fixture = await createHostPrepApplyFixture();
      try {
        const countPath = path.join(fixture.base, "apply-getent-count");
        await writeExecutable(
          path.join(fixture.bin, "getent"),
          `count=0
test ! -f ${shellSingleQuote(countPath)} || read -r count < ${shellSingleQuote(countPath)}
count=$((count + 1))
printf '%s\\n' "$count" > ${shellSingleQuote(countPath)}
if test "$count" -eq 3; then
  /usr/bin/mkdir ${shellSingleQuote(path.join(fixture.root, "etc", "palziv"))}
fi
exit 2
`
        );
        const result = await runHostPrepApply(fixture);
        assertBoundedApplyFailure(result);
        assert.deepEqual(await readMutationLog(fixture), []);
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });

    await t.test("listener changes during stable replay", async () => {
      const fixture = await createHostPrepApplyFixture();
      try {
        const countPath = path.join(fixture.base, "apply-ss-count");
        await writeExecutable(
          path.join(fixture.bin, "ss"),
          `count=0
test ! -f ${shellSingleQuote(countPath)} || read -r count < ${shellSingleQuote(countPath)}
count=$((count + 1))
printf '%s\\n' "$count" > ${shellSingleQuote(countPath)}
if test "$count" -ge 2; then
  printf '%s\\n' 'LISTEN 0 4096 127.0.0.1:3116'
fi
`
        );
        const result = await runHostPrepApply(fixture);
        assertBoundedApplyFailure(result);
        assert.deepEqual(await readMutationLog(fixture), []);
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });

    await t.test("download path replacement after archive inspection", async () => {
      const fixture = await createHostPrepApplyFixture({
        applyStubOptions: { replaceArchiveAfterInspection: true }
      });
      try {
        const result = await runHostPrepApply(fixture);
        assertBoundedApplyFailure(result);
        const log = await readMutationLog(fixture);
        assert.equal(
          log.filter((line) => line.startsWith("tar\t") && line.includes("--list")).length,
          1
        );
        assert.equal(
          log.filter((line) => line.startsWith("tar\t") && line.includes("--extract")).length,
          0
        );
        assert.equal(log.filter((line) => line.startsWith("mv\t")).length, 0);
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });
  }
);

test(
  "host prep apply publication races preserve caller paths and remove only owned staging",
  { skip: process.platform !== "linux" },
  async (t) => {
    await t.test("Node directory destination race", async () => {
      const fixture = await createHostPrepApplyFixture({
        applyStubOptions: { nodePublicationRace: true }
      });
      try {
        const result = await runHostPrepApply(fixture);
        assertBoundedApplyFailure(result);
        const racedTarget = path.join(
          fixture.root,
          "opt",
          "node-v24.18.0-linux-x64"
        );
        assert.equal(
          await readFile(path.join(racedTarget, "caller-owned"), "utf8"),
          "caller-owned\n"
        );
        await assert.rejects(lstat(path.join(fixture.root, "opt", "node")), {
          code: "ENOENT"
        });
        assert.deepEqual(await readdir(path.join(fixture.root, "var", "tmp")), []);
        assert.equal(
          (await readdir(path.join(fixture.root, "opt")))
            .filter((name) => name.startsWith(".node-")).length,
          0
        );
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });

    await t.test("stable-link destination race", async () => {
      const fixture = await createHostPrepApplyFixture({
        applyStubOptions: { linkPublicationRace: true }
      });
      try {
        const result = await runHostPrepApply(fixture);
        assertBoundedApplyFailure(result);
        assert.equal(
          await readFile(path.join(fixture.root, "opt", "node"), "utf8"),
          "caller-owned\n"
        );
        await lstat(path.join(fixture.root, "opt", "node-v24.18.0-linux-x64"));
        assert.deepEqual(await readdir(path.join(fixture.root, "var", "tmp")), []);
        assert.equal(
          (await readdir(path.join(fixture.root, "opt")))
            .filter((name) => name.startsWith(".node-")).length,
          0
        );
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });
  }
);

test(
  "host prep apply final trust epoch rejects partial state and escaped fixture routing",
  { skip: process.platform !== "linux" },
  async (t) => {
    await t.test("post-publication owned-path tamper fails without a second mutator set", async () => {
      const fixture = await createHostPrepApplyFixture({
        applyStubOptions: { postMutationTamper: true }
      });
      try {
        const result = await runHostPrepApply(fixture);
        assertBoundedApplyFailure(result);
        const log = await readMutationLog(fixture);
        const publicationIndex = log.findLastIndex((line) => line.startsWith("mv\t"));
        assert.ok(publicationIndex >= 0);
        assert.equal(
          log.slice(publicationIndex + 1).every((line) => line.startsWith("rm\t")),
          true
        );
        await lstat(path.join(fixture.root, "etc", "palziv", "unexpected"));
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });

    await t.test("stage and fixture state from different canonical bases", async () => {
      const stageFixture = await createHostPrepApplyFixture();
      const otherFixture = await createHostPrepFixture();
      try {
        const result = await runHostPrepApply({
          ...stageFixture,
          root: otherFixture.root
        });
        assertBoundedApplyFailure(result);
        assert.deepEqual(await readMutationLog(stageFixture), []);
      } finally {
        await rm(stageFixture.base, { recursive: true, force: true });
        await rm(otherFixture.base, { recursive: true, force: true });
      }
    });
  }
);
