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
  open,
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
import {
  approveHostPrepInboundManifest,
  readStableOpenedHostPrepReceipt,
  verifyApprovedHostPrepInboundManifest,
  verifyUsbHostPrep
} from "../scripts/migration/verify-usb-host-prep.mjs";

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
  const npmNodeMarker = path.join(base, "exact-node-received-npm-cli");
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
    await writeExecutable(
      path.join(versionRoot, "bin", "node"),
      exactNodeFixtureBody(npmNodeMarker)
    );
    if (prepared) {
      await mkdir(path.join(versionRoot, "lib", "node_modules", "npm", "bin"), {
        recursive: true
      });
      await writeFile(
        path.join(versionRoot, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
        '#!/usr/bin/env node\nprocess.stdout.write("11.9.0\\n");\n',
        { mode: 0o755 }
      );
      await symlink(
        "../lib/node_modules/npm/bin/npm-cli.js",
        path.join(versionRoot, "bin", "npm")
      );
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
      */opt/node-v24.18.0-linux-x64/bin/npm) printf '%s\\n' root:root ;;
      *) exit 95 ;;
    esac
    ;;
  -Lc:%U:%G:%a)
    case "\${3-}" in
      */opt/node-v24.18.0-linux-x64|*/opt/node-v24.18.0-linux-x64/bin|*/opt/node-v24.18.0-linux-x64/bin/node|*/opt/node-v24.18.0-linux-x64/lib|*/opt/node-v24.18.0-linux-x64/lib/node_modules|*/opt/node-v24.18.0-linux-x64/lib/node_modules/npm|*/opt/node-v24.18.0-linux-x64/lib/node_modules/npm/bin|*/opt/node-v24.18.0-linux-x64/lib/node_modules/npm/bin/npm-cli.js) printf '%s\\n' root:root:755 ;;
      */opt/palziv|*/opt/palziv/releases|*/var/backups/palziv|*/etc/palziv) printf '%s\\n' root:palziv:750 ;;
      */var/lib/palziv|*/var/lib/palziv/data) printf '%s\\n' palziv:palziv:700 ;;
      *) exit 94 ;;
    esac
    ;;
  *) exit 96 ;;
esac
`,
    jq: `if test "\${1-}" = --stream; then
  test "$#" -eq 5
  test "$2" = -s
  test "$3" = -e
  token_path=$5
  /usr/bin/node - "$token_path" <<'NODE'
const fs = require("node:fs");
const raw = fs.readFileSync(process.argv[2], "utf8");
const token = JSON.parse(raw);
const approved = [
  "classification",
  "createdAtEpoch",
  "manifestFingerprint",
  "phaseId",
  "schemaVersion",
  "stageRoot"
];
const occurrences = [...raw.matchAll(/"(classification|createdAtEpoch|manifestFingerprint|phaseId|schemaVersion|stageRoot)"\\s*:/g)]
  .map((match) => match[1])
  .sort();
if (
  !token ||
  Array.isArray(token) ||
  occurrences.join("\\n") !== approved.slice().sort().join("\\n")
) {
  process.exit(1);
}
process.stdout.write("true\\n");
NODE
  exit
fi
if test "\${1-}" = -s; then
  test "\${2-}" = -e
  test "\${3-}" = -r
  shift 3
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
  return { base, root, bin, stage, scriptPath, npmNodeMarker };
}

async function readMutationLog(fixture) {
  return readHostPrepLog(fixture.mutationLog);
}

async function readHostPrepLog(logPath) {
  try {
    return (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function normalizeHostPrepBootstrapLog(log, fixture) {
  return log.map((line) => {
    const fields = line.split("\t");
    return fields.map((field, index) => {
      let normalized = field;
      if (field === fixture.base || field.startsWith(`${fixture.base}/`)) {
        normalized = `<fixture>${field.slice(fixture.base.length)}`;
      }
      if (!(fields[0] === "mktemp" && index === 2)) {
        normalized = normalized.replace(
          /project-a-host-prep-bootstrap\.[A-Za-z0-9]{8}(?=\/|$)/g,
          "project-a-host-prep-bootstrap.<owned>"
        );
      }
      return normalized;
    }).join("\t");
  });
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

function exactNodeFixtureBody(npmMarker) {
  return `case "$#" in
  1)
    test "$1" = --version
    printf '%s\\n' v24.18.0
    ;;
  2)
    case "$1" in
      */lib/node_modules/npm/bin/npm-cli.js) ;;
      *) exit 94 ;;
    esac
    test "$2" = --version
    : > ${shellSingleQuote(npmMarker)}
    printf '%s\\n' 11.9.0
    ;;
  *) exit 93 ;;
esac
`;
}

function sameSizeSourceRacePayload(byteLength, markerPath) {
  const prefix = [
    "#!/usr/bin/env bash",
    `: > ${shellSingleQuote(markerPath)}`,
    "return 97 2>/dev/null || exit 97",
    "#"
  ].join("\n");
  const suffixLength = byteLength - Buffer.byteLength(prefix) - 1;
  assert.ok(suffixLength >= 0);
  const payload = `${prefix}${"x".repeat(suffixLength)}\n`;
  assert.equal(Buffer.byteLength(payload), byteLength);
  return payload;
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
    exactNodeFixtureBody(fixture.npmNodeMarker)
  );
  await chmod(path.join(archiveRoot, "bin", "node"), 0o755);
  await writeFile(
    path.join(archiveRoot, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    '#!/usr/bin/env node\nprocess.stdout.write("11.9.0\\n");\n',
    { mode: 0o755 }
  );
  await chmod(
    path.join(archiveRoot, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    0o755
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
  linkPublicationRace = false,
  sourceRace = "",
  curlOutcome = "success"
} = {}) {
  const stateDirectory = path.join(fixture.base, "apply-state");
  const mutationLog = path.join(fixture.base, "mutation.log");
  const bootstrapLog = path.join(fixture.base, "bootstrap.log");
  const archivePath = await createHostPrepNodeArchive(fixture, archiveKind);
  const expectedArchiveSize = (await stat(archivePath)).size;
  const groupMarker = path.join(stateDirectory, "group-created");
  const userMarker = path.join(stateDirectory, "user-created");
  const replacementMarker = path.join(stateDirectory, "replace-after-inspection");
  const tamperMarker = path.join(stateDirectory, "tamper-after-publication");
  const nodeRaceMarker = path.join(stateDirectory, "race-node-publication");
  const linkRaceMarker = path.join(stateDirectory, "race-link-publication");
  const sourceRaceMarker = path.join(stateDirectory, "race-stage-source");
  const sourceRacePayload = path.join(stateDirectory, "stage-source-payload");
  const sourceRaceExecutedMarker = path.join(fixture.base, "stage-source-executed");
  await mkdir(stateDirectory);
  if (replaceArchiveAfterInspection) await writeFile(replacementMarker, "1\n");
  if (postMutationTamper) await writeFile(tamperMarker, "1\n");
  if (nodePublicationRace) await writeFile(nodeRaceMarker, "1\n");
  if (linkPublicationRace) await writeFile(linkRaceMarker, "1\n");
  if (sourceRace) {
    assert.match(sourceRace, /^(?:overwrite|replace)$/);
    const originalPreflight = await readFile(fixture.scriptPath);
    await writeFile(
      sourceRacePayload,
      sameSizeSourceRacePayload(originalPreflight.length, sourceRaceExecutedMarker),
      { mode: 0o700 }
    );
    await writeFile(sourceRaceMarker, `${sourceRace}\n`);
  }
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
case "$#" in
  14)
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
    output_path=\${14}
    ;;
  24)
    test "$1" = --disable
    test "$2" = --fail
    test "$3" = --silent
    test "$4" = --show-error
    test "$5" = --location
    test "$6" = --connect-timeout
    test "$7" = 15
    test "$8" = --max-time
    test "$9" = 300
    test "\${10}" = --speed-limit
    test "\${11}" = 1024
    test "\${12}" = --speed-time
    test "\${13}" = 30
    test "\${14}" = --max-filesize
    test "\${15}" = 31511588
    test "\${16}" = --noproxy
    test "\${17}" = "*"
    test "\${18}" = --proto
    test "\${19}" = "=https"
    test "\${20}" = --proto-redir
    test "\${21}" = "=https"
    test "\${22}" = https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz
    test "\${23}" = --output
    output_path=\${24}
    ;;
  *) exit 87 ;;
esac
case ${shellSingleQuote(curlOutcome)} in
  success)
    /usr/bin/cp -- ${shellSingleQuote(archivePath)} "$output_path"
    ;;
  oversized)
    /usr/bin/cp -- ${shellSingleQuote(archivePath)} "$output_path"
    printf x >> "$output_path"
    ;;
  truncated)
    /usr/bin/head -c -1 -- ${shellSingleQuote(archivePath)} > "$output_path"
    ;;
  timeout)
    exit 28
    ;;
  never-ending)
    if test "$(/bin/bash -c 'ulimit -f')" = unlimited; then
      /usr/bin/cp -- ${shellSingleQuote(archivePath)} "$output_path"
      exit 0
    fi
    exec /usr/bin/dd if=/dev/zero of="$output_path" bs=65536 count=700 status=none
    ;;
  *) exit 89 ;;
esac
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
owner=
group=
last=
while test "$#" -gt 0; do
  case "$1" in
    -m) mode=$2; shift 2 ;;
    -o) owner=$2; shift 2 ;;
    -g) group=$2; shift 2 ;;
    -d|--) shift ;;
    *) last=$1; shift ;;
  esac
done
test -n "$mode"
test -n "$owner"
test -n "$group"
test -n "$last"
case "$last" in
  */opt/palziv|*/opt/palziv/releases|*/var/backups/palziv|*/etc/palziv)
    test "$owner:$group:$mode" = root:palziv:0750
    ;;
  */var/lib/palziv|*/var/lib/palziv/data)
    test "$owner:$group:$mode" = palziv:palziv:0700
    ;;
  *) exit 86 ;;
esac
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
destination=
for destination do :; done
case "$destination" in
  */opt/node)
    if test -f ${shellSingleQuote(linkRaceMarker)}; then
      printf '%s\\n' caller-owned > "$destination"
    fi
    ;;
esac
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
  await writeExecutable(
    path.join(fixture.bin, "apply-bootstrap-mktemp"),
    `${mutationLogger("mktemp", bootstrapLog)}
test "$#" -eq 2
test "$1" = -d
test "$2" = ${shellSingleQuote(
  path.join(fixture.base, "project-a-host-prep-bootstrap.XXXXXXXX")
)}
exec /usr/bin/mktemp "$@"
`
  );
  await writeExecutable(
    path.join(fixture.bin, "apply-bootstrap-install"),
    `${mutationLogger("install", bootstrapLog)}
test "$#" -eq 9
test "$1" = -o
test "$2" = root
test "$3" = -g
test "$4" = root
test "$5" = -m
test "$6" = 0600
test "$7" = --
test "$8" = ${shellSingleQuote(fixture.scriptPath)}
case "$9" in
  ${shellSingleQuote(fixture.base)}/project-a-host-prep-bootstrap.[A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9]/preflight-host-prep.sh) ;;
  *) exit 85 ;;
esac
exec /usr/bin/install "$@"
`
  );
  await writeExecutable(
    path.join(fixture.bin, "apply-bootstrap-rm"),
    `${mutationLogger("rm", bootstrapLog)}
test "$#" -eq 3
test "$1" = -rf
test "$2" = --
case "$3" in
  ${shellSingleQuote(fixture.base)}/project-a-host-prep-bootstrap.[A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9]) ;;
  *) exit 84 ;;
esac
exec /usr/bin/rm "$@"
`
  );
  await writeExecutable(
    path.join(fixture.bin, "apply-bootstrap-sha256sum"),
    `${mutationLogger("sha256sum", bootstrapLog)}
test "$#" -eq 2
test "$1" = --
case "$2" in
  ${shellSingleQuote(fixture.base)}/project-a-host-prep-bootstrap.[A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9]/preflight-host-prep.sh) ;;
  *) exit 83 ;;
esac
result=$(/usr/bin/sha256sum "$@")
status=$?
test "$status" -eq 0 || exit "$status"
printf '%s\\n' "$result"
snapshot_argument=
for snapshot_argument do :; done
case "$snapshot_argument" in
  */project-a-host-prep-bootstrap.*/preflight-host-prep.sh)
    if test -f ${shellSingleQuote(sourceRaceMarker)}; then
      read -r source_race_mode < ${shellSingleQuote(sourceRaceMarker)}
      /usr/bin/rm -f -- ${shellSingleQuote(sourceRaceMarker)}
      case "$source_race_mode" in
        overwrite)
          /usr/bin/cp -- ${shellSingleQuote(sourceRacePayload)} ${shellSingleQuote(
            fixture.scriptPath
          )}
          ;;
        replace)
          /usr/bin/mv -- ${shellSingleQuote(sourceRacePayload)} ${shellSingleQuote(
            fixture.scriptPath
          )}
          ;;
        *) exit 88 ;;
      esac
    fi
    ;;
esac
`
  );

  fixture.archivePath = archivePath;
  fixture.expectedArchiveSize = expectedArchiveSize;
  fixture.mutationLog = mutationLog;
  fixture.bootstrapLog = bootstrapLog;
  fixture.sourceRaceExecutedMarker = sourceRaceExecutedMarker;
  fixture.nodeRaceMarker = nodeRaceMarker;
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
  await rm(fixture.npmNodeMarker, { force: true });
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
    `PALZIV_HOST_PREP_TEST_ARCHIVE_SIZE=${fixture.expectedArchiveSize}`,
    `PALZIV_HOST_PREP_TEST_MUTATION_LOG=${fixture.mutationLog}`,
    `PALZIV_HOST_PREP_TEST_BOOTSTRAP_LOG=${fixture.bootstrapLog}`,
    `PALZIV_HOST_PREP_TEST_NODE_RACE_MARKER=${fixture.nodeRaceMarker}`,
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

async function writeRawHostPrepToken(fixture, contents) {
  const tokenPath = path.join(fixture.stage, ".host-prep-preflight-ok");
  await writeFile(tokenPath, contents, { mode: 0o600 });
  await chmod(tokenPath, 0o600);
}

async function runSourcedHostPrepWithOverride(fixture, snapshotPath, originalPath) {
  const argumentsList = [
    "-i",
    "HOME=/root",
    "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
    "PALZIV_HOST_PREP_TEST_MODE=1",
    `PALZIV_HOST_PREP_TEST_ROOT=${fixture.root}`,
    `PALZIV_HOST_PREP_TEST_BIN=${fixture.bin}`,
    `PALZIV_HOST_PREP_ORIGINAL_SOURCE=${originalPath}`,
    "/bin/bash",
    "-p",
    "-c",
    '. "$1"',
    "bash",
    snapshotPath
  ];
  try {
    const result = await execFile("/usr/bin/env", argumentsList, {
      cwd: fixture.stage,
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
      */opt/node-v24.18.0-linux-x64/bin/npm) printf '%s\\n' root:root ;;
      *) exit 95 ;;
    esac
    ;;
  -Lc:%U:%G:%a)
    case "\${3-}" in
      */opt/node-v24.18.0-linux-x64|*/opt/node-v24.18.0-linux-x64/bin|*/opt/node-v24.18.0-linux-x64/bin/node|*/opt/node-v24.18.0-linux-x64/lib|*/opt/node-v24.18.0-linux-x64/lib/node_modules|*/opt/node-v24.18.0-linux-x64/lib/node_modules/npm|*/opt/node-v24.18.0-linux-x64/lib/node_modules/npm/bin|*/opt/node-v24.18.0-linux-x64/lib/node_modules/npm/bin/npm-cli.js) printf '%s\\n' root:root:755 ;;
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
  "host prep preflight override accepts only a verified privileged bootstrap snapshot",
  { skip: process.platform !== "linux" },
  async (t) => {
    await t.test("the stage preflight cannot declare itself as a bootstrap snapshot", async () => {
      const fixture = await createHostPrepFixture();
      try {
        const result = await runSourcedHostPrepWithOverride(
          fixture,
          fixture.scriptPath,
          fixture.scriptPath
        );
        assert.notEqual(result.code, 0);
        assert.equal(result.stdout, "");
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });

    await t.test("a root-owned 0600 copy outside the bootstrap directory is rejected", async () => {
      const fixture = await createHostPrepFixture();
      const invalidSnapshot = path.join(fixture.base, "preflight-host-prep.snapshot");
      try {
        await copyFile(fixture.scriptPath, invalidSnapshot);
        await chmod(invalidSnapshot, 0o600);
        const result = await runSourcedHostPrepWithOverride(
          fixture,
          invalidSnapshot,
          fixture.scriptPath
        );
        assert.notEqual(result.code, 0);
        assert.equal(result.stdout, "");
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });
  }
);

test(
  "host prep apply sources only a verified snapshot across original-source races",
  { skip: process.platform !== "linux" },
  async (t) => {
    for (const sourceRace of ["overwrite", "replace"]) {
      await t.test(sourceRace, async () => {
        const fixture = await createHostPrepApplyFixture({
          applyStubOptions: { sourceRace }
        });
        try {
          const result = await runHostPrepApply(fixture);
          assertBoundedApplyFailure(result);
          await assert.rejects(lstat(fixture.sourceRaceExecutedMarker), {
            code: "ENOENT"
          });
          assert.deepEqual(await readMutationLog(fixture), []);
          assert.equal(
            (await readdir(fixture.base))
              .filter((name) => name.startsWith("project-a-host-prep-bootstrap."))
              .length,
            0
          );
        } finally {
          await rm(fixture.base, { recursive: true, force: true });
        }
      });
    }
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
  "host prep apply receipt parser is bounded duplicate-aware and single-document",
  { skip: process.platform !== "linux" },
  async (t) => {
    const cases = [
      [
        "duplicate top-level key",
        (valid) =>
          valid.replace(
            '{"schemaVersion":1,',
            '{"phaseId":"debian-host-prep-v1","schemaVersion":1,'
          )
      ],
      ["multiple JSON documents", (valid) => `${valid.trim()}\n${valid}`],
      ["oversized otherwise-valid receipt", (valid) => `${valid.trim()}${" ".repeat(4097)}\n`],
      ["missing final LF", (valid) => valid.trimEnd()],
      ["carriage return", (valid) => valid.replace(/\n$/, "\r\n")],
      [
        "NUL byte",
        (valid) => Buffer.concat([Buffer.from(valid.trimEnd()), Buffer.from([0]), Buffer.from("\n")])
      ],
      ["malformed JSON", () => '{"schemaVersion":1,\n']
    ];

    for (const [name, mutate] of cases) {
      await t.test(name, async () => {
        const fixture = await createHostPrepApplyFixture();
        try {
          const valid = await readFile(
            path.join(fixture.stage, ".host-prep-preflight-ok"),
            "utf8"
          );
          await writeRawHostPrepToken(fixture, mutate(valid));
          const result = await runHostPrepApply(fixture);
          assertBoundedApplyFailure(result);
          assert.deepEqual(await readMutationLog(fixture), []);
        } finally {
          await rm(fixture.base, { recursive: true, force: true });
        }
      });
    }
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
      await lstat(fixture.npmNodeMarker);

      const log = await readMutationLog(fixture);
      const escapedRoot = fixture.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const exactLogPatterns = [
        new RegExp(`^mktemp\\t-d\\t${escapedRoot}/var/tmp/project-a-host-prep\\.XXXXXXXX$`),
        /^apt-get\tupdate$/,
        /^apt-get\tinstall\t-y\t--no-install-recommends\tca-certificates\tcurl\tgit\tjq\trsync\ttar\txz-utils$/,
        new RegExp(
          `^curl\\t--disable\\t--fail\\t--silent\\t--show-error\\t--location\\t--connect-timeout\\t15\\t--max-time\\t300\\t--speed-limit\\t1024\\t--speed-time\\t30\\t--max-filesize\\t31511588\\t--noproxy\\t\\*\\t--proto\\t=https\\t--proto-redir\\t=https\\thttps://nodejs\\.org/dist/v24\\.18\\.0/node-v24\\.18\\.0-linux-x64\\.tar\\.xz\\t--output\\t${escapedRoot}/var/tmp/project-a-host-prep\\.[A-Za-z0-9]+/node-v24\\.18\\.0-linux-x64\\.tar\\.xz$`
        ),
        /^sha256sum\t\/proc\/[0-9]+\/fd\/[0-9]+$/,
        /^tar\t--list\t--verbose\t--numeric-owner\t--full-time\t--quoting-style=escape\t--file=\/proc\/[0-9]+\/fd\/[0-9]+$/,
        new RegExp(`^mktemp\\t-d\\t${escapedRoot}/opt/\\.node-v24\\.18\\.0-linux-x64\\.partial\\.XXXXXXXX$`),
        new RegExp(
          `^tar\\t--extract\\t--file=/proc/[0-9]+/fd/[0-9]+\\t--directory=${escapedRoot}/opt/\\.node-v24\\.18\\.0-linux-x64\\.partial\\.[A-Za-z0-9]+\\t--no-same-owner\\t--no-same-permissions\\t--delay-directory-restore$`
        ),
        /^addgroup\t--system\tpalziv$/,
        /^adduser\t--system\t--ingroup\tpalziv\t--home\t\/var\/lib\/palziv\t--no-create-home\t--shell\t\/usr\/sbin\/nologin\tpalziv$/,
        new RegExp(`^install\\t-d\\t-o\\troot\\t-g\\tpalziv\\t-m\\t0750\\t--\\t${escapedRoot}/opt/palziv$`),
        new RegExp(`^install\\t-d\\t-o\\troot\\t-g\\tpalziv\\t-m\\t0750\\t--\\t${escapedRoot}/opt/palziv/releases$`),
        new RegExp(`^install\\t-d\\t-o\\tpalziv\\t-g\\tpalziv\\t-m\\t0700\\t--\\t${escapedRoot}/var/lib/palziv$`),
        new RegExp(`^install\\t-d\\t-o\\tpalziv\\t-g\\tpalziv\\t-m\\t0700\\t--\\t${escapedRoot}/var/lib/palziv/data$`),
        new RegExp(`^install\\t-d\\t-o\\troot\\t-g\\tpalziv\\t-m\\t0750\\t--\\t${escapedRoot}/var/backups/palziv$`),
        new RegExp(`^install\\t-d\\t-o\\troot\\t-g\\tpalziv\\t-m\\t0750\\t--\\t${escapedRoot}/etc/palziv$`),
        new RegExp(
          `^renameat2\\t${escapedRoot}/opt/\\.node-v24\\.18\\.0-linux-x64\\.partial\\.[A-Za-z0-9]+/node-v24\\.18\\.0-linux-x64\\t${escapedRoot}/opt/node-v24\\.18\\.0-linux-x64$`
        ),
        new RegExp(`^ln\\t-s\\t--\\t/opt/node-v24\\.18\\.0-linux-x64\\t${escapedRoot}/opt/node$`),
        new RegExp(`^rm\\t-rf\\t--\\t${escapedRoot}/opt/\\.node-v24\\.18\\.0-linux-x64\\.partial\\.[A-Za-z0-9]+$`),
        new RegExp(`^rm\\t-rf\\t--\\t${escapedRoot}/var/tmp/project-a-host-prep\\.[A-Za-z0-9]+$`)
      ];
      assert.equal(log.length, exactLogPatterns.length, log.join("\n"));
      for (let index = 0; index < exactLogPatterns.length; index += 1) {
        assert.match(log[index], exactLogPatterns[index]);
      }
      assert.doesNotMatch(
        log.join("\n"),
        /systemctl|firewall|cloudflare|npm(?:\tinstall|\tci)|server\.js|palzivalerts|itotexpress|proxmox|\tmv(?:\t|$)/i
      );
      const rawBootstrapLog = await readHostPrepLog(fixture.bootstrapLog);
      const bootstrapLog = normalizeHostPrepBootstrapLog(rawBootstrapLog, fixture);
      assert.deepEqual(bootstrapLog, [
        "mktemp\t-d\t<fixture>/project-a-host-prep-bootstrap.XXXXXXXX",
        "install\t-o\troot\t-g\troot\t-m\t0600\t--\t<fixture>/stage/TO-DEBIAN/preflight-host-prep.sh\t<fixture>/project-a-host-prep-bootstrap.<owned>/preflight-host-prep.sh",
        "sha256sum\t--\t<fixture>/project-a-host-prep-bootstrap.<owned>/preflight-host-prep.sh",
        "sha256sum\t--\t<fixture>/project-a-host-prep-bootstrap.<owned>/preflight-host-prep.sh",
        "sha256sum\t--\t<fixture>/project-a-host-prep-bootstrap.<owned>/preflight-host-prep.sh",
        "sha256sum\t--\t<fixture>/project-a-host-prep-bootstrap.<owned>/preflight-host-prep.sh",
        "sha256sum\t--\t<fixture>/project-a-host-prep-bootstrap.<owned>/preflight-host-prep.sh",
        "rm\t-rf\t--\t<fixture>/project-a-host-prep-bootstrap.<owned>"
      ]);
      assert.equal(
        log.some((line) => line.includes(`${fixture.base}/project-a-host-prep-bootstrap.`)),
        false,
        log.join("\n")
      );
      assert.equal(
        rawBootstrapLog.some((line) =>
          /^(?:apt-get|curl|tar|addgroup|adduser|renameat2|ln)\t/.test(line) ||
          line.includes(`${fixture.root}/var/tmp/project-a-host-prep.`) ||
          line.includes(`${fixture.root}/opt/.node-`)
        ),
        false,
        rawBootstrapLog.join("\n")
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
      await lstat(fixture.npmNodeMarker);
      assert.deepEqual(await readdir(path.join(fixture.root, "var", "tmp")), []);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  }
);

test(
  "host prep apply independently rejects drift from the prepared Node and npm topology",
  { skip: process.platform !== "linux" },
  async (t) => {
    const cases = [
      [
        "missing npm CLI",
        (fixture) =>
          rm(
            path.join(
              fixture.root,
              "opt",
              "node-v24.18.0-linux-x64",
              "lib",
              "node_modules",
              "npm",
              "bin",
              "npm-cli.js"
            )
          )
      ],
      [
        "npm launcher is no longer the exact symlink",
        async (fixture) => {
          const npmPath = path.join(
            fixture.root,
            "opt",
            "node-v24.18.0-linux-x64",
            "bin",
            "npm"
          );
          await rm(npmPath);
          await writeFile(npmPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        }
      ]
    ];
    for (const [name, mutate] of cases) {
      await t.test(name, async () => {
        const fixture = await createHostPrepApplyFixture({ prepared: true });
        try {
          await mutate(fixture);
          const result = await runHostPrepApply(fixture);
          assertBoundedApplyFailure(result);
          assert.deepEqual(await readMutationLog(fixture), []);
          await assert.rejects(lstat(fixture.npmNodeMarker), { code: "ENOENT" });
        } finally {
          await rm(fixture.base, { recursive: true, force: true });
        }
      });
    }
  }
);

test(
  "host prep apply enforces exact download size and resource bounds before hashing",
  { skip: process.platform !== "linux" },
  async (t) => {
    for (const curlOutcome of ["oversized", "truncated", "timeout", "never-ending"]) {
      await t.test(curlOutcome, async () => {
        const fixture = await createHostPrepApplyFixture({
          applyStubOptions: { curlOutcome }
        });
        try {
          const result = await runHostPrepApply(fixture);
          assertBoundedApplyFailure(result);
          const log = await readMutationLog(fixture);
          assert.equal(log.filter((line) => line.startsWith("curl\t")).length, 1);
          assert.equal(log.filter((line) => line.startsWith("sha256sum\t")).length, 0);
          assert.equal(log.filter((line) => line.startsWith("tar\t")).length, 0);
          assert.equal(log.filter((line) => line.startsWith("addgroup\t")).length, 0);
          assert.deepEqual(await readdir(path.join(fixture.root, "var", "tmp")), []);
        } finally {
          await rm(fixture.base, { recursive: true, force: true });
        }
      });
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
        const publicationIndex = log.findLastIndex((line) => line.startsWith("ln\t"));
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

const HOST_PREP_EVIDENCE_SCRIPT_URL = new URL(
  "../scripts/migration/collect-host-prep-evidence.sh",
  import.meta.url
);
const HOST_PREP_EVIDENCE_TIMESTAMP = "20260731T123456Z";
const HOST_PREP_EVIDENCE_HOST = "fixture-host";
const HOST_PREP_EVIDENCE_REPORT =
  `debian-host-prep-${HOST_PREP_EVIDENCE_TIMESTAMP}-${HOST_PREP_EVIDENCE_HOST}.txt`;

function expectedHostPrepEvidenceReport(state) {
  const values = {
    clean: {
      package: "absent",
      node: "absent",
      npm: "absent",
      account: "absent",
      directories: [
        "Directory /opt/palziv: type=absent owner=- group=- mode=-",
        "Directory /opt/palziv/releases: type=absent owner=- group=- mode=-",
        "Directory /var/lib/palziv: type=absent owner=- group=- mode=-",
        "Directory /var/lib/palziv/data: type=absent owner=- group=- mode=-",
        "Directory /var/backups/palziv: type=absent owner=- group=- mode=-",
        "Directory /etc/palziv: type=absent owner=- group=- mode=-"
      ],
      listener: "absent",
      classification: "not-applied"
    },
    prepared: {
      package: "installed 1.2.3-fixture",
      node: "v24.18.0",
      npm: "11.9.0",
      account: "present",
      directories: [
        "Directory /opt/palziv: type=directory owner=root group=palziv mode=750",
        "Directory /opt/palziv/releases: type=directory owner=root group=palziv mode=750",
        "Directory /var/lib/palziv: type=directory owner=palziv group=palziv mode=700",
        "Directory /var/lib/palziv/data: type=directory owner=palziv group=palziv mode=700",
        "Directory /var/backups/palziv: type=directory owner=root group=palziv mode=750",
        "Directory /etc/palziv: type=directory owner=root group=palziv mode=750"
      ],
      listener: "present",
      classification: "prepared"
    },
    partial: {
      package: "absent",
      node: "other",
      npm: "absent",
      account: "present",
      directories: [
        "Directory /opt/palziv: type=directory owner=root group=palziv mode=750",
        "Directory /opt/palziv/releases: type=absent owner=- group=- mode=-",
        "Directory /var/lib/palziv: type=absent owner=- group=- mode=-",
        "Directory /var/lib/palziv/data: type=absent owner=- group=- mode=-",
        "Directory /var/backups/palziv: type=absent owner=- group=- mode=-",
        "Directory /etc/palziv: type=absent owner=- group=- mode=-"
      ],
      listener: "absent",
      classification: "partial"
    }
  }[state];
  return [
    "Project-A Debian Host Preparation Receipt",
    "Collection UTC: 2026-07-31T12:34:56Z",
    "OS: Debian 13",
    "Architecture: x86_64",
    "CPU threshold: pass",
    "Memory threshold: pass",
    "Root free-space threshold: pass",
    `Package ca-certificates: ${values.package}`,
    `Package curl: ${values.package}`,
    `Package git: ${values.package}`,
    `Package jq: ${values.package}`,
    `Package rsync: ${values.package}`,
    `Package tar: ${values.package}`,
    `Package xz-utils: ${values.package}`,
    `Node: ${values.node}`,
    `npm: ${values.npm}`,
    `Palziv user: ${values.account}`,
    `Palziv group: ${values.account}`,
    ...values.directories,
    "Service palziv: enabled=not-found active=not-found",
    "Service cloudflared: enabled=not-found active=not-found",
    "Timer palziv-backup: enabled=not-found active=not-found",
    "Timer palziv-health: enabled=not-found active=not-found",
    "UFW: inactive",
    `TCP 3116 listener: ${values.listener}`,
    `Classification: ${values.classification}`,
    ""
  ].join("\n");
}

async function createHostPrepEvidenceFixture({
  state = "clean",
  sensitiveOutput = false,
  packageStatus = "installed"
} = {}) {
  const base = await mkdtemp("/tmp/project-a-host-prep-evidence-test.");
  const usbRoot = path.join(base, HOST_PREP_ROOT_NAME);
  const systemRoot = path.join(base, "system-root");
  const bin = path.join(base, "bin");
  const fromDir = path.join(usbRoot, "FROM-DEBIAN");
  const scriptPath = path.join(usbRoot, "TO-DEBIAN", "collect-host-prep-evidence.sh");
  const npmNodeMarker = path.join(base, "npm-resolved-through-pinned-node");
  await Promise.all([
    mkdir(path.join(usbRoot, "CHECKSUMS"), { recursive: true }),
    mkdir(fromDir, { recursive: true }),
    mkdir(path.join(usbRoot, "SECRETS-ENCRYPTED"), { recursive: true }),
    mkdir(path.dirname(scriptPath), { recursive: true }),
    mkdir(path.join(systemRoot, "etc"), { recursive: true }),
    mkdir(path.join(systemRoot, "proc", "self"), { recursive: true }),
    mkdir(path.join(systemRoot, "var", "log"), { recursive: true }),
    mkdir(bin, { recursive: true })
  ]);
  await Promise.all([
    writeFile(path.join(usbRoot, "ISOLATION-BOUNDARY.txt"), "fixture\n"),
    writeFile(
      path.join(usbRoot, "PHASE-2-INPUT.json"),
      '{"schemaVersion":1,"phaseId":"debian-host-prep-v1"}\n'
    ),
    writeFile(path.join(usbRoot, "README-FIRST.txt"), "fixture\n"),
    writeFile(
      path.join(systemRoot, "etc", "os-release"),
      'ID=debian\nVERSION_ID="13"\n'
    ),
    writeFile(path.join(systemRoot, "proc", "meminfo"), "MemTotal:        3584000 kB\n"),
    writeFile(path.join(systemRoot, "proc", "self", "cmdline"), "secret-process-argument\0"),
    writeFile(path.join(systemRoot, "etc", "resolv.conf"), "nameserver 10.77.66.1\n"),
    writeFile(path.join(systemRoot, "var", "log", "fixture.log"), "seeded-log-text\n")
  ]);
  await copyFile(HOST_PREP_EVIDENCE_SCRIPT_URL, scriptPath);
  await chmod(scriptPath, 0o700);

  const prepared = state === "prepared";
  const partial = state === "partial";
  const directorySpecs = [
    ["opt/palziv", "root", "palziv", "750"],
    ["opt/palziv/releases", "root", "palziv", "750"],
    ["var/lib/palziv", "palziv", "palziv", "700"],
    ["var/lib/palziv/data", "palziv", "palziv", "700"],
    ["var/backups/palziv", "root", "palziv", "750"],
    ["etc/palziv", "root", "palziv", "750"]
  ];
  if (prepared) {
    for (const [relativePath] of directorySpecs) {
      await mkdir(path.join(systemRoot, ...relativePath.split("/")), { recursive: true });
    }
  } else if (partial) {
    await mkdir(path.join(systemRoot, "opt", "palziv"), { recursive: true });
  }
  if (sensitiveOutput) {
    await writeFile(
      path.join(systemRoot, "etc", "palziv", "security.json"),
      "seeded-secret-value\n"
    );
  }

  const packageBody = prepared
    ? `test "$1" = --show
test "$2" = '--showformat=\${Status}\\t\${Version}'
case "$3" in
  ca-certificates|curl|git|jq|rsync|tar|xz-utils)
    printf '%b\\n' '${packageStatus === "installed"
      ? "install ok installed\\t1.2.3-fixture"
      : "deinstall ok config-files\\t1.2.3-fixture"}'
    ;;
  *) exit 1 ;;
esac
`
    : "exit 1\n";
  const accountBody = prepared || partial
    ? `case "\${1-}:\${2-}" in
  passwd:palziv) printf '%s\\n' 'palziv:x:998:998::/var/lib/palziv:/usr/sbin/nologin' ;;
  group:palziv) printf '%s\\n' 'palziv:x:998:' ;;
  *) exit 2 ;;
esac
`
    : "exit 2\n";
  const statCases = directorySpecs.map(([relativePath, owner, group, mode]) =>
    `      */${relativePath}) printf '%s\\n' 'directory|${owner}|${group}|${mode}' ;;`
  ).join("\n");
  const commandBodies = {
    date: `case "\${1-}:\${2-}" in
  -u:+%Y%m%dT%H%M%SZ) printf '%s\\n' '${HOST_PREP_EVIDENCE_TIMESTAMP}' ;;
  -u:+%Y-%m-%dT%H:%M:%SZ) printf '%s\\n' '2026-07-31T12:34:56Z' ;;
  *) exit 90 ;;
esac
`,
    hostname: `test "$#" -eq 0
test -z "\${PALZIV_SECRET_FIXTURE-}"
test -z "\${PALZIV_BASH_ENV_SECRET-}"
printf '%s\\n' '${HOST_PREP_EVIDENCE_HOST}'
`,
    uname: "test \"${1-}\" = -m\nprintf '%s\\n' x86_64\n",
    nproc: "test \"$#\" -eq 0\nprintf '%s\\n' 2\n",
    df: "test \"$#\" -eq 3\ntest \"$1\" = -B1\ntest \"$2\" = --output=avail\nprintf 'Avail\\n10737418240\\n'\n",
    "dpkg-query": packageBody,
    node: prepared
      ? "case \"$#:${1-}:${2-}\" in\n  1:--version:) printf '%s\\n' v24.18.0 ;;\n  2:*/bin/npm:--version) : > \"${0%/bin/node}/npm-resolved-through-pinned-node\"; printf '%s\\n' 11.9.0 ;;\n  *) exit 94 ;;\nesac\n"
      : partial
      ? "test \"${1-}\" = --version\nprintf '%s\\n' v23.0.0\n"
      : "exit 127\n",
    npm: prepared
      ? "test \"${1-}\" = --version\nprintf '%s\\n' 11.9.0\n"
      : "exit 127\n",
    getent: accountBody,
    stat: `test "$1" = -c
test "$2" = '%F|%U|%G|%a'
case "\${3-}" in
${prepared ? statCases : partial ? "      */opt/palziv) printf '%s\\n' 'directory|root|palziv|750' ;;" : ""}
  *) exit 1 ;;
esac
`,
    systemctl: `case "\${1-}:\${2-}:\${3-}" in
  is-enabled:--quiet:palziv.service|is-enabled:--quiet:cloudflared.service|is-enabled:--quiet:palziv-backup.timer|is-enabled:--quiet:palziv-health.timer) exit 4 ;;
  is-active:--quiet:palziv.service|is-active:--quiet:cloudflared.service|is-active:--quiet:palziv-backup.timer|is-active:--quiet:palziv-health.timer) exit 4 ;;
  *) exit 91 ;;
esac
`,
    ufw: sensitiveOutput
      ? "test \"${1-}\" = status\nprintf '%s\\n' 'Status: inactive' 'seeded-secret-value 10.77.66.1 nameserver seeded-log-text'\n"
      : "test \"${1-}\" = status\nprintf '%s\\n' 'Status: inactive'\n",
    ss: sensitiveOutput
      ? "printf '%s\\n' 'LISTEN 0 4096 10.77.66.2:3116 0.0.0.0:* users:((seeded-process-argument))'\n"
      : ":\n",
    sha256sum: `test -z "\${PALZIV_SECRET_FIXTURE-}"
test -z "\${PALZIV_BASH_ENV_SECRET-}"
exec /usr/bin/sha256sum "$@"
`
  };
  for (const [name, body] of Object.entries(commandBodies)) {
    await writeExecutable(path.join(bin, name), body);
  }
  if (prepared) {
    await writeFile(path.join(bin, "npm"), "#!/usr/bin/env node\n");
    await chmod(path.join(bin, "npm"), 0o700);
  }
  return { base, usbRoot, systemRoot, bin, fromDir, scriptPath, npmNodeMarker };
}

async function runHostPrepEvidence(fixture, extraEnvironment = {}, usbRoot = fixture.usbRoot) {
  const hostileMarker = path.join(fixture.base, "hostile-bash-env-fired");
  const hostileCommandMarker = path.join(fixture.base, "hostile-command-fired");
  const hostileBashEnv = path.join(fixture.base, "hostile-bash-env");
  const hostilePath = path.join(fixture.base, "hostile-path");
  await mkdir(hostilePath, { recursive: true });
  await writeExecutable(
    path.join(hostilePath, "date"),
    `: > ${shellSingleQuote(hostileCommandMarker)}
printf '%s\\n' hostile
`
  );
  await writeFile(
    hostileBashEnv,
    `: > ${shellSingleQuote(hostileMarker)}
export PALZIV_BASH_ENV_SECRET='seeded-bash-env-value'
export PATH=${shellSingleQuote(hostilePath)}
`
  );
  try {
    const result = await execFile("/bin/bash", [
      fixture.scriptPath,
      "--usb-root",
      usbRoot
    ], {
      cwd: fixture.usbRoot,
      env: {
        ...process.env,
        HOME: "/tmp",
        PATH: hostilePath,
        BASH_ENV: hostileBashEnv,
        ENV: hostileBashEnv,
        PALZIV_SECRET_FIXTURE: "seeded-environment-value",
        PALZIV_HOST_PREP_EVIDENCE_TEST_MODE: "1",
        PALZIV_HOST_PREP_EVIDENCE_TEST_ROOT: fixture.systemRoot,
        PALZIV_HOST_PREP_EVIDENCE_TEST_BIN: fixture.bin,
        ...extraEnvironment
      },
      timeout: 20_000,
      maxBuffer: 1024 * 1024
    });
    return {
      code: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      hostileMarker,
      hostileCommandMarker
    };
  } catch (error) {
    return {
      code: error.code,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      hostileMarker,
      hostileCommandMarker
    };
  }
}

test("host prep evidence collector source keeps a fixed metadata-only contract", async () => {
  const source = await readFile(HOST_PREP_EVIDENCE_SCRIPT_URL, "utf8");
  assert.match(source, /^#!\/usr\/bin\/env bash\nset -Eeuo pipefail\n/);
  assert.match(source, /readonly EVIDENCE_PHASE_ID="debian-host-prep-v1"/);
  assert.match(source, /readonly EVIDENCE_MAX_REPORT_BYTES="67108864"/);
  assert.match(source, /unset BASH_ENV ENV CDPATH/);
  assert.match(source, /mv -T -n/);
  assert.match(source, /sha256sum/);
  for (const field of [
    "Project-A Debian Host Preparation Receipt",
    "Collection UTC:", "OS:", "Architecture:", "CPU threshold:",
    "Memory threshold:", "Root free-space threshold:", "Package ca-certificates:",
    "Package curl:", "Package git:", "Package jq:", "Package rsync:", "Package tar:",
    "Package xz-utils:", "Node:", "npm:", "Palziv user:", "Palziv group:",
    "Directory ", "Service palziv:", "Service cloudflared:", "Timer palziv-backup:",
    "Timer palziv-health:", "UFW:", "TCP 3116 listener:", "Classification:"
  ]) {
    assert.ok(source.includes(field), `missing approved receipt field ${field}`);
  }
  for (const forbidden of [
    "ip address", "ip route", "resolv.conf", "printenv", "journalctl", "cmdline",
    ".bash_history", "security.json", "push.json", "board.json", "analytics.json",
    "/etc/palziv/palziv.env", "/etc/cloudflared", "systemctl start", "systemctl stop",
    "systemctl enable", "ufw enable", "apt-get"
  ]) {
    assert.equal(source.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }
});

test(
  "host prep evidence classifies fixed fixtures and publishes one redacted verified pair",
  { skip: process.platform !== "linux" },
  async (t) => {
    for (const [state, expected] of [
      ["clean", "not-applied"],
      ["prepared", "prepared"],
      ["partial", "partial"]
    ]) {
      await t.test(state, async () => {
        const fixture = await createHostPrepEvidenceFixture({
          state,
          sensitiveOutput: state === "prepared"
        });
        try {
          const result = await runHostPrepEvidence(fixture);
          assert.equal(result.code, 0, result.stderr);
          assert.equal(
            result.stdout,
            `${HOST_PREP_EVIDENCE_REPORT}\n${HOST_PREP_EVIDENCE_REPORT}.sha256\n`
          );
          assert.equal(result.stderr, "");
          const entries = (await readdir(fixture.fromDir)).sort();
          assert.deepEqual(entries, [
            HOST_PREP_EVIDENCE_REPORT,
            `${HOST_PREP_EVIDENCE_REPORT}.sha256`
          ]);
          const report = await readFile(
            path.join(fixture.fromDir, HOST_PREP_EVIDENCE_REPORT),
            "utf8"
          );
          assert.equal(expectedHostPrepEvidenceReport(state).endsWith(`Classification: ${expected}\n`), true);
          assert.equal(report, expectedHostPrepEvidenceReport(state));
          assert.equal(report.split("\n").length - 1, 31);
          for (const sensitive of [
            "seeded-secret-value", "10.77.66.1", "10.77.66.2", "nameserver",
            "seeded-process-argument", "seeded-environment-value", "seeded-bash-env-value",
            "seeded-log-text",
            "security.json", "resolv.conf", "cmdline", "fixture.log"
          ]) {
            assert.equal(report.includes(sensitive), false, sensitive);
          }
          const expectedHash = createHash("sha256").update(report).digest("hex");
          assert.equal(
            await readFile(
              path.join(fixture.fromDir, `${HOST_PREP_EVIDENCE_REPORT}.sha256`),
              "utf8"
            ),
            `${expectedHash}  ${HOST_PREP_EVIDENCE_REPORT}\n`
          );
          await lstat(result.hostileMarker);
          await assert.rejects(lstat(result.hostileCommandMarker), { code: "ENOENT" });
          if (state === "prepared") {
            await lstat(fixture.npmNodeMarker);
          }
        } finally {
          await rm(fixture.base, { recursive: true, force: true });
        }
      });
    }
  }
);

test(
  "host prep evidence fails closed without clobbering or deleting caller-owned output",
  { skip: process.platform !== "linux" },
  async (t) => {
    await t.test("checksum failure removes only its owned report", async () => {
      const fixture = await createHostPrepEvidenceFixture({ state: "prepared" });
      try {
        const result = await runHostPrepEvidence(fixture, {
          PALZIV_HOST_PREP_EVIDENCE_TEST_SHA256_FAIL: "1"
        });
        assert.notEqual(result.code, 0);
        assert.deepEqual(await readdir(fixture.fromDir), []);
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });

    await t.test("same-second contention preserves the completed pair", async () => {
      const fixture = await createHostPrepEvidenceFixture({ state: "prepared" });
      try {
        const runs = await Promise.all([
          runHostPrepEvidence(fixture, { PALZIV_HOST_PREP_EVIDENCE_TEST_DELAY: "1" }),
          runHostPrepEvidence(fixture, { PALZIV_HOST_PREP_EVIDENCE_TEST_DELAY: "1" })
        ]);
        assert.deepEqual(runs.map((result) => result.code === 0).sort(), [false, true]);
        assert.deepEqual(
          (await readdir(fixture.fromDir)).sort(),
          [HOST_PREP_EVIDENCE_REPORT, `${HOST_PREP_EVIDENCE_REPORT}.sha256`]
        );
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });

    await t.test("wrong and linked roots fail", async () => {
      const fixture = await createHostPrepEvidenceFixture();
      const aliasBase = await mkdtemp("/tmp/project-a-host-prep-evidence-test.");
      const linkedRoot = path.join(aliasBase, HOST_PREP_ROOT_NAME);
      try {
        const wrongRoot = await runHostPrepEvidence(fixture, {}, fixture.base);
        assert.notEqual(wrongRoot.code, 0);
        await symlink(fixture.usbRoot, linkedRoot, "dir");
        const linked = await runHostPrepEvidence(fixture, {}, linkedRoot);
        assert.notEqual(linked.code, 0);
        assert.deepEqual(await readdir(fixture.fromDir), []);
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
        await rm(aliasBase, { recursive: true, force: true });
      }
    });

    await t.test("phase metadata is bounded and binds the exact phase ID", async () => {
      const wrongPhaseFixture = await createHostPrepEvidenceFixture();
      const spacedValueFixture = await createHostPrepEvidenceFixture();
      const structuralWhitespaceFixture = await createHostPrepEvidenceFixture();
      const oversizedFixture = await createHostPrepEvidenceFixture();
      try {
        await writeFile(
          path.join(wrongPhaseFixture.usbRoot, "PHASE-2-INPUT.json"),
          '{"schemaVersion":1,"phaseId":"wrong-phase"}\n'
        );
        const wrongPhase = await runHostPrepEvidence(wrongPhaseFixture);
        assert.notEqual(wrongPhase.code, 0);
        assert.deepEqual(await readdir(wrongPhaseFixture.fromDir), []);

        await writeFile(
          path.join(spacedValueFixture.usbRoot, "PHASE-2-INPUT.json"),
          '{"schemaVersion":1,"phaseId":"debian-host- prep-v1"}\n'
        );
        const spacedValue = await runHostPrepEvidence(spacedValueFixture);
        assert.notEqual(spacedValue.code, 0);
        assert.deepEqual(await readdir(spacedValueFixture.fromDir), []);

        await writeFile(
          path.join(structuralWhitespaceFixture.usbRoot, "PHASE-2-INPUT.json"),
          '{\n  "schemaVersion": 1,\n  "phaseId"\n    :\n  "debian-host-prep-v1"\n}\n'
        );
        const structuralWhitespace = await runHostPrepEvidence(structuralWhitespaceFixture);
        assert.equal(structuralWhitespace.code, 0, structuralWhitespace.stderr);

        await writeFile(
          path.join(oversizedFixture.usbRoot, "PHASE-2-INPUT.json"),
          `{"phaseId":"debian-host-prep-v1","padding":"${"x".repeat(65_536)}"}\n`
        );
        const oversized = await runHostPrepEvidence(oversizedFixture);
        assert.notEqual(oversized.code, 0);
        assert.deepEqual(await readdir(oversizedFixture.fromDir), []);
      } finally {
        await rm(wrongPhaseFixture.base, { recursive: true, force: true });
        await rm(spacedValueFixture.base, { recursive: true, force: true });
        await rm(structuralWhitespaceFixture.base, { recursive: true, force: true });
        await rm(oversizedFixture.base, { recursive: true, force: true });
      }
    });

    await t.test("a two-dot unexpected root entry fails closed", async () => {
      const fixture = await createHostPrepEvidenceFixture();
      try {
        await writeFile(path.join(fixture.usbRoot, "..unexpected"), "caller-owned\n");
        const result = await runHostPrepEvidence(fixture);
        assert.notEqual(result.code, 0);
        assert.deepEqual(await readdir(fixture.fromDir), []);
        assert.equal(
          await readFile(path.join(fixture.usbRoot, "..unexpected"), "utf8"),
          "caller-owned\n"
        );
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });

    await t.test("a configured but uninstalled package is reported absent", async () => {
      const fixture = await createHostPrepEvidenceFixture({
        state: "prepared",
        packageStatus: "config-files"
      });
      try {
        const result = await runHostPrepEvidence(fixture);
        assert.equal(result.code, 0, result.stderr);
        const report = await readFile(
          path.join(fixture.fromDir, HOST_PREP_EVIDENCE_REPORT),
          "utf8"
        );
        for (const packageName of [
          "ca-certificates", "curl", "git", "jq", "rsync", "tar", "xz-utils"
        ]) {
          assert.match(report, new RegExp(`^Package ${packageName}: absent$`, "m"));
          assert.equal(report.includes(`Package ${packageName}: installed`), false);
        }
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });

    await t.test("linked return directory fails", async () => {
      const fixture = await createHostPrepEvidenceFixture();
      const callerDirectory = path.join(fixture.base, "caller-return");
      try {
        await rm(fixture.fromDir, { recursive: true });
        await mkdir(callerDirectory);
        await symlink(callerDirectory, fixture.fromDir, "dir");
        const result = await runHostPrepEvidence(fixture);
        assert.notEqual(result.code, 0);
        assert.deepEqual(await readdir(callerDirectory), []);
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });

    await t.test("pre-existing report and oversized temporary output fail", async () => {
      const existingFixture = await createHostPrepEvidenceFixture();
      const oversizedFixture = await createHostPrepEvidenceFixture();
      try {
        const existingPath = path.join(existingFixture.fromDir, HOST_PREP_EVIDENCE_REPORT);
        await writeFile(existingPath, "caller-owned\n");
        const existing = await runHostPrepEvidence(existingFixture);
        assert.notEqual(existing.code, 0);
        assert.equal(await readFile(existingPath, "utf8"), "caller-owned\n");

        const oversized = await runHostPrepEvidence(oversizedFixture, {
          PALZIV_HOST_PREP_EVIDENCE_TEST_FORCE_OVERSIZE: "1"
        });
        assert.notEqual(oversized.code, 0);
        assert.deepEqual(await readdir(oversizedFixture.fromDir), []);
      } finally {
        await rm(existingFixture.base, { recursive: true, force: true });
        await rm(oversizedFixture.base, { recursive: true, force: true });
      }
    });
  }
);

const HOST_PREP_VERIFIER_PATH = path.resolve(
  "scripts/migration/verify-usb-host-prep.mjs"
);
const HOST_PREP_RECEIPT_NAME =
  "debian-host-prep-20260731T123456Z-fixture-host.txt";

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeHostPrepVerifierManifest(fixture) {
  const lines = [];
  for (const relativePath of HOST_PREP_INBOUND_FILES) {
    const bytes = await readFile(path.join(fixture.root, ...relativePath.split("/")));
    lines.push(`${sha256Bytes(bytes)}  ${relativePath}`);
  }
  await writeFile(fixture.manifestPath, `${lines.join("\n")}\n`);
}

async function createHostPrepVerifierFixture({ returned = false } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "project-a-host-prep-verifier-"));
  const root = path.join(base, HOST_PREP_ROOT_NAME);
  const checksumDir = path.join(root, "CHECKSUMS");
  const fromDir = path.join(root, "FROM-DEBIAN");
  const secretsDir = path.join(root, "SECRETS-ENCRYPTED");
  const toDir = path.join(root, "TO-DEBIAN");
  await Promise.all([
    mkdir(checksumDir, { recursive: true }),
    mkdir(fromDir, { recursive: true }),
    mkdir(secretsDir, { recursive: true }),
    mkdir(toDir, { recursive: true })
  ]);

  const phase2Input = createPhase2Input({
    reportFileName: PHASE1_REPORT,
    reportSha256: PHASE1_REPORT_SHA,
    phase1ManifestSha256: PHASE1_MANIFEST_SHA
  });
  const inputBytes = Buffer.from(`${JSON.stringify(phase2Input, null, 2)}\n`, "utf8");
  const files = new Map([
    ["ISOLATION-BOUNDARY.txt", "No secrets. Metadata-only transfer.\n"],
    ["PHASE-2-INPUT.json", inputBytes],
    ["README-FIRST.txt", "Run the Phase 2 host-prep scripts offline.\n"],
    ["TO-DEBIAN/apply-host-prep.sh", "#!/usr/bin/env bash\nexit 0\n"],
    ["TO-DEBIAN/collect-host-prep-evidence.sh", "#!/usr/bin/env bash\nexit 0\n"],
    ["TO-DEBIAN/preflight-host-prep.sh", "#!/usr/bin/env bash\nexit 0\n"]
  ]);
  for (const [relativePath, contents] of files) {
    await writeFile(path.join(root, ...relativePath.split("/")), contents);
  }

  const fixture = {
    base,
    root,
    checksumDir,
    fromDir,
    secretsDir,
    toDir,
    manifestPath: path.join(root, ...HOST_PREP_MANIFEST_PATH.split("/")),
    inputPath: path.join(root, "PHASE-2-INPUT.json"),
    inputBytes,
    receiptName: HOST_PREP_RECEIPT_NAME,
    receiptPath: path.join(fromDir, HOST_PREP_RECEIPT_NAME)
  };
  await writeHostPrepVerifierManifest(fixture);
  if (returned) await addHostPrepReceipt(fixture);
  return fixture;
}

async function addHostPrepReceipt(
  fixture,
  contents = "Project-A Debian Host Preparation Receipt\nClassification: prepared\n"
) {
  await writeFile(fixture.receiptPath, contents);
  const hash = sha256Bytes(Buffer.from(contents));
  await writeFile(
    `${fixture.receiptPath}.sha256`,
    `${hash}  ${fixture.receiptName}\n`
  );
  return hash;
}

async function rewriteHostPrepInput(fixture, mutate, { updateManifest = true } = {}) {
  const input = JSON.parse(await readFile(fixture.inputPath, "utf8"));
  mutate(input);
  const bytes = Buffer.from(`${JSON.stringify(input)}\n`, "utf8");
  await writeFile(fixture.inputPath, bytes);
  if (updateManifest) await writeHostPrepVerifierManifest(fixture);
  return bytes;
}

async function runHostPrepVerifierCli(args) {
  try {
    const result = await execFile(process.execPath, [HOST_PREP_VERIFIER_PATH, ...args], {
      cwd: path.resolve("."),
      timeout: 20_000,
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

test("host prep verifier accepts only the exact outbound and returned contracts", async (t) => {
  await t.test("exact outbound tree passes without exposing input metadata", async () => {
    const fixture = await createHostPrepVerifierFixture();
    try {
      const expectedInputHash = sha256Bytes(fixture.inputBytes);
      assert.deepEqual(
        await verifyUsbHostPrep({ handoffRoot: fixture.root, mode: "outbound" }),
        {
          ok: true,
          phaseId: HOST_PREP_PHASE_ID,
          mode: "outbound",
          inputReferenceSha256: expectedInputHash,
          inboundFiles: 6,
          receipt: null
        }
      );
      const cli = await runHostPrepVerifierCli([
        "--handoff-root", fixture.root,
        "--mode", "outbound"
      ]);
      assert.equal(cli.code, 0, cli.stderr);
      assert.deepEqual(JSON.parse(cli.stdout), {
        ok: true,
        phaseId: HOST_PREP_PHASE_ID,
        mode: "outbound",
        inputReferenceSha256: expectedInputHash,
        inboundFiles: 6,
        receipt: null
      });
      assert.equal(cli.stderr, "");
      assert.doesNotMatch(cli.stdout, /Project-A-Migration|node-v24|reportFileName/);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  await t.test("exact returned one-pair tree passes and returns only its fingerprint", async () => {
    const fixture = await createHostPrepVerifierFixture({ returned: true });
    try {
      const receiptSha256 = sha256Bytes(await readFile(fixture.receiptPath));
      assert.deepEqual(
        await verifyUsbHostPrep({ handoffRoot: fixture.root, mode: "returned" }),
        {
          ok: true,
          phaseId: HOST_PREP_PHASE_ID,
          mode: "returned",
          inputReferenceSha256: sha256Bytes(fixture.inputBytes),
          inboundFiles: 6,
          receipt: { fileName: fixture.receiptName, sha256: receiptSha256 }
        }
      );
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });
});

test("host prep verifier rejects checksum tampering and screens receipts without echoing media", async (t) => {
  await t.test("receipt and sidecar checksum mismatches fail", async () => {
    for (const mutation of ["receipt", "sidecar"]) {
      const fixture = await createHostPrepVerifierFixture({ returned: true });
      try {
        if (mutation === "receipt") {
          await writeFile(fixture.receiptPath, "tampered receipt\n");
        } else {
          await writeFile(
            `${fixture.receiptPath}.sha256`,
            `${"0".repeat(64)}  ${fixture.receiptName}\n`
          );
        }
        await assert.rejects(
          verifyUsbHostPrep({ handoffRoot: fixture.root, mode: "returned" }),
          /checksum mismatch/i
        );
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    }
  });

  await t.test("secret-shaped content produces the fixed line-and-rule warning only", async () => {
    const fixture = await createHostPrepVerifierFixture();
    const sentinel = "must-never-be-echoed-receipt-secret";
    try {
      await addHostPrepReceipt(fixture, `Receipt\nRESEND_API_KEY=${sentinel}\n`);
      await assert.rejects(
        verifyUsbHostPrep({ handoffRoot: fixture.root, mode: "returned" }),
        (error) => {
          assert.equal(
            error.message,
            "Potential secret material detected at line 2 (secret-assignment); do not open or share this receipt."
          );
          assert.doesNotMatch(error.message, new RegExp(sentinel, "i"));
          return true;
        }
      );
      const cli = await runHostPrepVerifierCli([
        "--handoff-root", fixture.root,
        "--mode", "returned"
      ]);
      assert.equal(cli.code, 1);
      assert.equal(cli.stdout, "");
      assert.equal(
        cli.stderr,
        "Potential secret material detected at line 2 (secret-assignment); do not open or share this receipt.\n"
      );
      assert.doesNotMatch(cli.stderr, new RegExp(sentinel, "i"));
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });
});

test("host prep verifier rejects every extra fixed-tree entry", async (t) => {
  const scenarios = [
    ["top-level", (fixture) => writeFile(path.join(fixture.root, "attacker-top-level"), "x")],
    ["checksum", (fixture) => writeFile(path.join(fixture.checksumDir, "attacker.sha256"), "x")],
    ["TO-DEBIAN", (fixture) => writeFile(path.join(fixture.toDir, "attacker.sh"), "x")],
    ["secret", (fixture) => writeFile(path.join(fixture.secretsDir, "secret.bin"), "x")],
    ["return", (fixture) => writeFile(path.join(fixture.fromDir, "attacker-return"), "x")]
  ];
  for (const [name, mutate] of scenarios) {
    await t.test(name, async () => {
      const fixture = await createHostPrepVerifierFixture();
      try {
        await mutate(fixture);
        await assert.rejects(
          verifyUsbHostPrep({ handoffRoot: fixture.root, mode: "outbound" }),
          (error) => {
            assert.doesNotMatch(error.message, /attacker/i);
            return true;
          }
        );
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });
  }
});

test("host prep verifier rejects wrong entry types and linked components", async (t) => {
  await t.test("directory in a file slot", async () => {
    const fixture = await createHostPrepVerifierFixture();
    try {
      await rm(fixture.inputPath);
      await mkdir(fixture.inputPath);
      await assert.rejects(
        verifyUsbHostPrep({ handoffRoot: fixture.root, mode: "outbound" }),
        /top-level layout/i
      );
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  await t.test("file in a directory slot", async () => {
    const fixture = await createHostPrepVerifierFixture();
    try {
      await rm(fixture.secretsDir, { recursive: true });
      await writeFile(fixture.secretsDir, "not a directory\n");
      await assert.rejects(
        verifyUsbHostPrep({ handoffRoot: fixture.root, mode: "outbound" }),
        /top-level layout/i
      );
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  await t.test("wrong regular entry type", async () => {
    const fixture = await createHostPrepVerifierFixture();
    try {
      await rm(path.join(fixture.toDir, "apply-host-prep.sh"));
      await mkdir(path.join(fixture.toDir, "apply-host-prep.sh"));
      await assert.rejects(
        verifyUsbHostPrep({ handoffRoot: fixture.root, mode: "outbound" }),
        /inbound layout/i
      );
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  await t.test("POSIX symbolic link", { skip: process.platform === "win32" }, async () => {
    const fixture = await createHostPrepVerifierFixture();
    try {
      const target = path.join(fixture.base, "outside-input");
      await writeFile(target, await readFile(fixture.inputPath));
      await rm(fixture.inputPath);
      await symlink(target, fixture.inputPath);
      await assert.rejects(
        verifyUsbHostPrep({ handoffRoot: fixture.root, mode: "outbound" }),
        /top-level layout|symbolic link/i
      );
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  await t.test("Windows junction", { skip: process.platform !== "win32" }, async () => {
    const fixture = await createHostPrepVerifierFixture();
    const outside = path.join(fixture.base, "outside-return");
    try {
      await mkdir(outside);
      await rm(fixture.fromDir, { recursive: true });
      await symlink(outside, fixture.fromDir, "junction");
      await assert.rejects(
        verifyUsbHostPrep({ handoffRoot: fixture.root, mode: "outbound" }),
        /top-level layout|symbolic link|junction/i
      );
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  await t.test("linked ancestor", async () => {
    const fixture = await createHostPrepVerifierFixture();
    const alias = path.join(path.dirname(fixture.base), `${path.basename(fixture.base)}-alias`);
    try {
      await symlink(fixture.base, alias, process.platform === "win32" ? "junction" : "dir");
      await assert.rejects(
        verifyUsbHostPrep({
          handoffRoot: path.join(alias, HOST_PREP_ROOT_NAME),
          mode: "outbound"
        }),
        /ancestor.*(?:symbolic link|junction)/i
      );
    } finally {
      await rm(alias, { recursive: true, force: true });
      await rm(fixture.base, { recursive: true, force: true });
    }
  });
});

test("host prep verifier validates manifested Phase 2 metadata before use", async (t) => {
  const invalidInputs = [
    ["extra field", (input) => { input.attacker = true; }],
    ["missing field", (input) => { delete input.node; }],
    ["invalid field", (input) => { input.schemaVersion = 2; }],
    ["Node provenance", (input) => { input.node.version = "v24.18.1"; }],
    ["Phase 1 report hash", (input) => { input.phase1.reportSha256 = "not-a-hash"; }],
    ["Phase 1 report reference", (input) => { input.phase1.reportFileName = "report.txt"; }]
  ];
  for (const [name, mutate] of invalidInputs) {
    await t.test(name, async () => {
      const fixture = await createHostPrepVerifierFixture();
      try {
        await rewriteHostPrepInput(fixture, mutate);
        await assert.rejects(
          verifyUsbHostPrep({ handoffRoot: fixture.root, mode: "outbound" }),
          /Phase 2 input|Phase 1|Node provenance/i
        );
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });
  }

  await t.test("unmanifested Phase 1 hash tampering fails before JSON validation", async () => {
    const fixture = await createHostPrepVerifierFixture();
    try {
      const sentinel = "must-never-be-echoed-input-tamper";
      await rewriteHostPrepInput(
        fixture,
        (input) => { input.phase1.reportSha256 = sentinel; },
        { updateManifest: false }
      );
      await assert.rejects(
        verifyUsbHostPrep({ handoffRoot: fixture.root, mode: "outbound" }),
        (error) => {
          assert.equal(error.message, "Inbound checksum verification failed.");
          assert.doesNotMatch(error.message, new RegExp(sentinel, "i"));
          return true;
        }
      );
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });
});

test("host prep verifier requires exactly one safe receipt and sidecar", async (t) => {
  const scenarios = [
    ["missing receipt", async (fixture) => {
      await addHostPrepReceipt(fixture);
      await rm(fixture.receiptPath);
    }],
    ["missing sidecar", async (fixture) => {
      await addHostPrepReceipt(fixture);
      await rm(`${fixture.receiptPath}.sha256`);
    }],
    ["duplicate report", async (fixture) => {
      await addHostPrepReceipt(fixture);
      await writeFile(
        path.join(fixture.fromDir, "debian-host-prep-20260731T123457Z-other.txt"),
        "second report\n"
      );
    }],
    ["duplicate sidecar", async (fixture) => {
      await addHostPrepReceipt(fixture);
      await writeFile(
        path.join(fixture.fromDir, "debian-host-prep-20260731T123457Z-other.txt.sha256"),
        `${"0".repeat(64)}  debian-host-prep-20260731T123457Z-other.txt\n`
      );
    }],
    ["unsafe sidecar path", async (fixture) => {
      await addHostPrepReceipt(fixture);
      await writeFile(
        `${fixture.receiptPath}.sha256`,
        `${"0".repeat(64)}  ../must-never-be-echoed.txt\n`
      );
    }],
    ["multiple sidecar lines", async (fixture) => {
      await addHostPrepReceipt(fixture);
      await writeFile(
        `${fixture.receiptPath}.sha256`,
        `${"0".repeat(64)}  ${fixture.receiptName}\n${"1".repeat(64)}  ${fixture.receiptName}\n`
      );
    }],
    ["wrong filename grammar", async (fixture) => {
      await writeFile(path.join(fixture.fromDir, "host-prep.txt"), "x\n");
      await writeFile(path.join(fixture.fromDir, "host-prep.txt.sha256"), `${"0".repeat(64)}  host-prep.txt\n`);
    }],
    ["temporary file", async (fixture) => {
      await writeFile(path.join(fixture.fromDir, `${fixture.receiptName}.partial`), "x\n");
    }]
  ];
  for (const [name, mutate] of scenarios) {
    await t.test(name, async () => {
      const fixture = await createHostPrepVerifierFixture();
      try {
        await mutate(fixture);
        await assert.rejects(
          verifyUsbHostPrep({ handoffRoot: fixture.root, mode: "returned" }),
          (error) => {
            assert.doesNotMatch(error.message, /must-never-be-echoed|host-prep\.txt/i);
            return true;
          }
        );
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    });
  }

  await t.test("oversized checksum", async () => {
    const fixture = await createHostPrepVerifierFixture({ returned: true });
    let handle;
    try {
      handle = await open(`${fixture.receiptPath}.sha256`, "w");
      await handle.truncate(2048);
      await handle.close();
      handle = undefined;
      await assert.rejects(
        verifyUsbHostPrep({ handoffRoot: fixture.root, mode: "returned" }),
        /sidecar is too large/i
      );
    } finally {
      await handle?.close();
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  await t.test("oversized receipt", async () => {
    const fixture = await createHostPrepVerifierFixture({ returned: true });
    let handle;
    try {
      handle = await open(fixture.receiptPath, "w");
      await handle.truncate(64 * 1024 * 1024 + 1);
      await handle.close();
      handle = undefined;
      await assert.rejects(
        verifyUsbHostPrep({ handoffRoot: fixture.root, mode: "returned" }),
        /safe verification size limit/i
      );
    } finally {
      await handle?.close();
      await rm(fixture.base, { recursive: true, force: true });
    }
  });
});

test("host prep verifier rejects manifest and receipt replacement races", async (t) => {
  await t.test("manifest replacement after bounded approval", async () => {
    const fixture = await createHostPrepVerifierFixture();
    try {
      const approval = await approveHostPrepInboundManifest(fixture.manifestPath);
      await rename(fixture.manifestPath, `${fixture.manifestPath}.approved`);
      await writeFile(fixture.manifestPath, "replacement\n");
      await assert.rejects(
        verifyApprovedHostPrepInboundManifest({
          root: fixture.root,
          manifestPath: fixture.manifestPath,
          approval
        }),
        /manifest changed during verification/i
      );
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  await t.test("receipt basename replacement after approval and open", async () => {
    const fixture = await createHostPrepVerifierFixture({ returned: true });
    let handle;
    try {
      const approvedMetadata = await lstat(fixture.receiptPath, { bigint: true });
      const approvedBytes = await readFile(fixture.receiptPath);
      handle = await open(fixture.receiptPath, "r");
      await rename(fixture.receiptPath, `${fixture.receiptPath}.approved`);
      await writeFile(fixture.receiptPath, "replacement that must not be screened\n");
      await assert.rejects(
        readStableOpenedHostPrepReceipt({
          handle,
          receiptPath: fixture.receiptPath,
          approvedMetadata,
          expectedSha256: sha256Bytes(approvedBytes)
        }),
        /receipt changed during verification/i
      );
    } finally {
      await handle?.close();
      await rm(fixture.base, { recursive: true, force: true });
    }
  });
});

test("host prep verifier CLI rejects ambiguous roots, modes, and arguments", async () => {
  const fixture = await createHostPrepVerifierFixture();
  try {
    const usage = `Usage: node scripts/migration/verify-usb-host-prep.mjs --handoff-root <absolute path> --mode outbound|returned\n`;
    const scenarios = [
      [["--handoff-root", HOST_PREP_ROOT_NAME, "--mode", "outbound"], /absolute/i],
      [["--mode", "outbound", "--mode", "returned"], new RegExp(usage.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))],
      [["--handoff-root", fixture.root, "--mode", "unknown"], /outbound or returned/i],
      [["--handoff-root", fixture.root, "--mode", "outbound", "extra"], new RegExp(usage.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))]
    ];
    for (const [args, expected] of scenarios) {
      const result = await runHostPrepVerifierCli(args);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, expected);
    }

    const wrongRoot = path.join(fixture.base, "wrong-root-name");
    await rename(fixture.root, wrongRoot);
    await assert.rejects(
      verifyUsbHostPrep({ handoffRoot: wrongRoot, mode: "outbound" }),
      /root name/i
    );
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("host prep verifier preserves acceptance of the unchanged returned Phase 1 fixture", async () => {
  const usbRoot = await mkdtemp(path.join(os.tmpdir(), "project-a-phase1-verifier-regression-"));
  try {
    const built = await runHostPrepVerifierCliForScript(
      path.resolve("scripts/migration/build-usb-handoff.mjs"),
      ["--usb-root", usbRoot]
    );
    assert.equal(built.code, 0, built.stderr);
    const handoff = path.join(usbRoot, "Project-A-Migration");
    const reportName = "debian-readiness-20260729T160000Z-palziv-prod.txt";
    const reportPath = path.join(handoff, "FROM-DEBIAN", reportName);
    const report = "## Collection\nHostname: palziv-prod\nNode: v24.18.0\n";
    await writeFile(reportPath, report);
    await writeFile(`${reportPath}.sha256`, `${sha256Bytes(report)}  ${reportName}\n`);
    const verified = await runHostPrepVerifierCliForScript(
      path.resolve("scripts/migration/verify-usb-handoff.mjs"),
      ["--handoff-root", handoff, "--mode", "returned"]
    );
    assert.equal(verified.code, 0, verified.stderr);
    assert.equal(JSON.parse(verified.stdout).reports.length, 1);
  } finally {
    await rm(usbRoot, { recursive: true, force: true });
  }
});

async function runHostPrepVerifierCliForScript(script, args) {
  try {
    const result = await execFile(process.execPath, [script, ...args], {
      cwd: path.resolve("."),
      timeout: 20_000,
      maxBuffer: 1024 * 1024
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

async function createReturnedPhase1Fixture() {
  const usbRoot = await mkdtemp(path.join(os.tmpdir(), "project-a-host-prep-builder-"));
  const built = await runHostPrepVerifierCliForScript(
    path.resolve("scripts/migration/build-usb-handoff.mjs"),
    ["--usb-root", usbRoot]
  );
  assert.equal(built.code, 0, built.stderr);
  const phase1Root = path.join(usbRoot, "Project-A-Migration");
  const reportFileName = "debian-readiness-20260730T192552Z-palziv-prod.txt";
  const reportPath = path.join(phase1Root, "FROM-DEBIAN", reportFileName);
  const reportBody = "## Collection\nHostname: palziv-prod\nNode: v24.18.0\n";
  await writeFile(reportPath, reportBody);
  await writeFile(
    `${reportPath}.sha256`,
    `${sha256Bytes(reportBody)}  ${reportFileName}\n`
  );
  return { usbRoot, phase1Root, reportFileName, reportPath, reportBody };
}

test("host prep builder creates the exact sibling without changing returned Phase 1", async () => {
  const fixture = await createReturnedPhase1Fixture();
  try {
    await writeFile(path.join(fixture.usbRoot, "operator-note.txt"), "unrelated preserve marker\n");
    const before = await snapshotFixtureTree(fixture.phase1Root);
    const expectedPhase1ManifestSha256 = await manifestFingerprint(
      path.join(fixture.phase1Root, "CHECKSUMS", "TO-DEBIAN.sha256")
    );
    const result = await runHostPrepVerifierCliForScript(
      path.resolve("scripts/migration/build-usb-host-prep.mjs"),
      ["--usb-root", fixture.usbRoot]
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    const summary = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(summary).sort(), [
      "fileCount",
      "manifestFingerprint",
      "phase1ReportFileName",
      "phase1ReportSha256",
      "phase1Unchanged",
      "rootName"
    ]);
    assert.equal(summary.rootName, HOST_PREP_ROOT_NAME);
    assert.equal(summary.fileCount, 6);
    assert.equal(summary.phase1ReportFileName, fixture.reportFileName);
    assert.equal(summary.phase1ReportSha256, sha256Bytes(fixture.reportBody));
    assert.equal(summary.phase1Unchanged, true);
    assert.match(summary.manifestFingerprint, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(result.stdout, /Hostname:|unrelated preserve marker|admin|must-never/i);

    const phase2Root = path.join(fixture.usbRoot, HOST_PREP_ROOT_NAME);
    assert.deepEqual((await readdir(phase2Root)).sort(), [
      "CHECKSUMS",
      "FROM-DEBIAN",
      "ISOLATION-BOUNDARY.txt",
      "PHASE-2-INPUT.json",
      "README-FIRST.txt",
      "SECRETS-ENCRYPTED",
      "TO-DEBIAN"
    ]);
    assert.deepEqual((await readdir(path.join(phase2Root, "TO-DEBIAN"))).sort(), [
      "apply-host-prep.sh",
      "collect-host-prep-evidence.sh",
      "preflight-host-prep.sh"
    ]);
    assert.deepEqual(await readdir(path.join(phase2Root, "FROM-DEBIAN")), []);
    assert.deepEqual(await readdir(path.join(phase2Root, "SECRETS-ENCRYPTED")), []);
    assert.deepEqual(await verifyUsbHostPrep({ handoffRoot: phase2Root, mode: "outbound" }), {
      ok: true,
      phaseId: HOST_PREP_PHASE_ID,
      mode: "outbound",
      inputReferenceSha256: sha256Bytes(await readFile(path.join(phase2Root, "PHASE-2-INPUT.json"))),
      inboundFiles: 6,
      receipt: null
    });
    const input = JSON.parse(await readFile(path.join(phase2Root, "PHASE-2-INPUT.json"), "utf8"));
    assert.deepEqual(input, createPhase2Input({
      reportFileName: fixture.reportFileName,
      reportSha256: sha256Bytes(fixture.reportBody),
      phase1ManifestSha256: expectedPhase1ManifestSha256
    }));
    assert.deepEqual(await snapshotFixtureTree(fixture.phase1Root), before);
  } finally {
    await rm(fixture.usbRoot, { recursive: true, force: true });
  }
});

test("host prep builder blocks unsafe Phase 1 and no-clobber failures without staging residue", async (t) => {
  await t.test("secret-bearing returned report", async () => {
    const fixture = await createReturnedPhase1Fixture();
    try {
      const secret = "must-never-be-echoed-builder-secret";
      await writeFile(fixture.reportPath, `RESEND_API_KEY=${secret}\n`);
      await writeFile(
        `${fixture.reportPath}.sha256`,
        `${sha256Bytes(`RESEND_API_KEY=${secret}\n`)}  ${fixture.reportFileName}\n`
      );
      const result = await runHostPrepVerifierCliForScript(
        path.resolve("scripts/migration/build-usb-host-prep.mjs"),
        ["--usb-root", fixture.usbRoot]
      );
      assert.notEqual(result.code, 0);
      assert.equal(result.stdout, "");
      assert.doesNotMatch(result.stderr, new RegExp(secret, "i"));
      assert.equal((await readdir(fixture.usbRoot)).some((name) => name.startsWith(`${HOST_PREP_ROOT_NAME}.partial-`)), false);
      await assert.rejects(lstat(path.join(fixture.usbRoot, HOST_PREP_ROOT_NAME)));
    } finally {
      await rm(fixture.usbRoot, { recursive: true, force: true });
    }
  });

  await t.test("existing exact Phase 2 target", async () => {
    const fixture = await createReturnedPhase1Fixture();
    const target = path.join(fixture.usbRoot, HOST_PREP_ROOT_NAME);
    try {
      await mkdir(target);
      await writeFile(path.join(target, "preserve.txt"), "preserve\n");
      const result = await runHostPrepVerifierCliForScript(
        path.resolve("scripts/migration/build-usb-host-prep.mjs"),
        ["--usb-root", fixture.usbRoot]
      );
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /already exists.*will not overwrite/i);
      assert.equal(await readFile(path.join(target, "preserve.txt"), "utf8"), "preserve\n");
    } finally {
      await rm(fixture.usbRoot, { recursive: true, force: true });
    }
  });

  await t.test("publish-time empty target remains untouched", async () => {
    const usbRoot = await mkdtemp(path.join(os.tmpdir(), "project-a-host-prep-publish-race-"));
    const stagingPath = path.join(usbRoot, `${HOST_PREP_ROOT_NAME}.partial-test`);
    const finalRoot = path.join(usbRoot, HOST_PREP_ROOT_NAME);
    try {
      await mkdir(stagingPath);
      await writeFile(path.join(stagingPath, "staged.txt"), "staged\n");
      await mkdir(finalRoot);
      const { publishHostPrepStagingNoClobber } = await import(
        "../scripts/migration/build-usb-host-prep.mjs"
      );
      await assert.rejects(
        publishHostPrepStagingNoClobber({ usbRoot, stagingPath, finalRoot }),
        /already exists.*will not overwrite/i
      );
      assert.deepEqual(await readdir(finalRoot), []);
      assert.deepEqual(await readdir(stagingPath), ["staged.txt"]);
    } finally {
      await rm(usbRoot, { recursive: true, force: true });
    }
  });

  await t.test("linked Phase 2 target is rejected without touching its destination", async () => {
    const fixture = await createReturnedPhase1Fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "project-a-host-prep-linked-target-"));
    const finalRoot = path.join(fixture.usbRoot, HOST_PREP_ROOT_NAME);
    try {
      await writeFile(path.join(outside, "preserve.txt"), "preserve linked destination\n");
      await symlink(outside, finalRoot, process.platform === "win32" ? "junction" : "dir");
      const { buildUsbHostPrep } = await import("../scripts/migration/build-usb-host-prep.mjs");
      await assert.rejects(
        buildUsbHostPrep({ usbRoot: fixture.usbRoot }),
        /symbolic link|junction/i
      );
      assert.equal(
        await readFile(path.join(outside, "preserve.txt"), "utf8"),
        "preserve linked destination\n"
      );
    } finally {
      await rm(fixture.usbRoot, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  await t.test("insufficient space fails before creating staging", async () => {
    const fixture = await createReturnedPhase1Fixture();
    try {
      const { buildUsbHostPrep } = await import("../scripts/migration/build-usb-host-prep.mjs");
      await assert.rejects(
        buildUsbHostPrep({ usbRoot: fixture.usbRoot, availableBytes: 0 }),
        /enough free space/i
      );
      assert.deepEqual((await readdir(fixture.usbRoot)).sort(), ["Project-A-Migration"]);
    } finally {
      await rm(fixture.usbRoot, { recursive: true, force: true });
    }
  });

  await t.test("CLI does not echo a caller-controlled local path", async () => {
    const sentinel = "must-never-echo-local-username";
    const missingRoot = path.join(os.tmpdir(), sentinel, "missing-usb-root");
    const result = await runHostPrepVerifierCliForScript(
      path.resolve("scripts/migration/build-usb-host-prep.mjs"),
      ["--usb-root", missingRoot]
    );
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Host-prep bundle creation failed safely.\n");
    assert.doesNotMatch(result.stderr, new RegExp(sentinel, "i"));
  });
});

async function createHostPrepBuilderSourceFixture() {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "project-a-host-prep-source-"));
  const relativePaths = [
    "deploy/usb-host-prep/ISOLATION-BOUNDARY.txt",
    "deploy/usb-host-prep/README-FIRST.txt",
    "scripts/migration/apply-host-prep.sh",
    "scripts/migration/collect-host-prep-evidence.sh",
    "scripts/migration/preflight-host-prep.sh"
  ];
  for (const relativePath of relativePaths) {
    const destination = path.join(sourceRoot, ...relativePath.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.resolve(...relativePath.split("/")), destination);
  }
  return sourceRoot;
}

async function waitForHostPrepStagingFile(usbRoot, relativePath) {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const stagingName = (await readdir(usbRoot)).find((name) =>
      name.startsWith(`${HOST_PREP_ROOT_NAME}.partial-`)
    );
    if (stagingName) {
      const candidate = path.join(
        usbRoot,
        stagingName,
        HOST_PREP_ROOT_NAME,
        ...relativePath.split("/")
      );
      try {
        await lstat(candidate);
        return candidate;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Timed out waiting for host-prep staging file ${relativePath}`);
}

test("host prep builder rejects linked, oversized, and replaced repository sources", async (t) => {
  await t.test("linked source ancestor", async () => {
    const fixture = await createReturnedPhase1Fixture();
    const sourceRoot = await createHostPrepBuilderSourceFixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "project-a-host-prep-source-outside-"));
    const linkedDirectory = path.join(sourceRoot, "deploy", "usb-host-prep");
    try {
      await copyFile(
        path.resolve("deploy/usb-host-prep/README-FIRST.txt"),
        path.join(outside, "README-FIRST.txt")
      );
      await copyFile(
        path.resolve("deploy/usb-host-prep/ISOLATION-BOUNDARY.txt"),
        path.join(outside, "ISOLATION-BOUNDARY.txt")
      );
      await rm(linkedDirectory, { recursive: true });
      await symlink(outside, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
      const { buildUsbHostPrep } = await import("../scripts/migration/build-usb-host-prep.mjs");
      await assert.rejects(
        buildUsbHostPrep({ usbRoot: fixture.usbRoot, sourceRoot }),
        /symbolic link|junction/i
      );
      await assert.rejects(lstat(path.join(fixture.usbRoot, HOST_PREP_ROOT_NAME)));
    } finally {
      await rm(fixture.usbRoot, { recursive: true, force: true });
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  await t.test("FAT32-incompatible source", async () => {
    const fixture = await createReturnedPhase1Fixture();
    const sourceRoot = await createHostPrepBuilderSourceFixture();
    let handle;
    try {
      const { FAT32_MAX_FILE_BYTES } = await import("../scripts/migration/usb-handoff-lib.mjs");
      handle = await open(path.join(sourceRoot, "deploy", "usb-host-prep", "README-FIRST.txt"), "w");
      await handle.truncate(FAT32_MAX_FILE_BYTES + 1);
      await handle.close();
      handle = undefined;
      const { buildUsbHostPrep } = await import("../scripts/migration/build-usb-host-prep.mjs");
      await assert.rejects(
        buildUsbHostPrep({ usbRoot: fixture.usbRoot, sourceRoot }),
        /FAT32/i
      );
      assert.equal((await readdir(fixture.usbRoot)).some((name) => name.includes(".partial-")), false);
    } finally {
      await handle?.close();
      await rm(fixture.usbRoot, { recursive: true, force: true });
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  await t.test("source replacement after approval", async () => {
    const fixture = await createReturnedPhase1Fixture();
    const sourceRoot = await createHostPrepBuilderSourceFixture();
    const preflight = path.join(sourceRoot, "scripts", "migration", "preflight-host-prep.sh");
    try {
      await writeFile(
        path.join(sourceRoot, "deploy", "usb-host-prep", "README-FIRST.txt"),
        Buffer.alloc(32 * 1024 * 1024, 0x52)
      );
      const phase1Before = await snapshotFixtureTree(fixture.phase1Root);
      const { buildUsbHostPrep } = await import("../scripts/migration/build-usb-host-prep.mjs");
      const build = buildUsbHostPrep({ usbRoot: fixture.usbRoot, sourceRoot });
      await waitForHostPrepStagingFile(fixture.usbRoot, "ISOLATION-BOUNDARY.txt");
      await rename(preflight, `${preflight}.approved`);
      await writeFile(preflight, "must-never-be-copied replacement\n");
      await assert.rejects(build, /source changed during the build/i);
      assert.equal((await readdir(fixture.usbRoot)).some((name) => name.includes(".partial-")), false);
      await assert.rejects(lstat(path.join(fixture.usbRoot, HOST_PREP_ROOT_NAME)));
      assert.deepEqual(await snapshotFixtureTree(fixture.phase1Root), phase1Before);
    } finally {
      await rm(fixture.usbRoot, { recursive: true, force: true });
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  await t.test("cleanup refuses a substituted predictable staging path", {
    skip: process.platform === "win32"
      ? "Windows prevents renaming the staging directory while its destination file is open."
      : false
  }, async () => {
    const fixture = await createReturnedPhase1Fixture();
    const sourceRoot = await createHostPrepBuilderSourceFixture();
    const readmeSource = path.join(sourceRoot, "deploy", "usb-host-prep", "README-FIRST.txt");
    const phase1Before = await snapshotFixtureTree(fixture.phase1Root);
    let displacedStaging;
    try {
      await writeFile(readmeSource, Buffer.alloc(64 * 1024 * 1024, 0x52));
      const { buildUsbHostPrep } = await import("../scripts/migration/build-usb-host-prep.mjs");
      const build = buildUsbHostPrep({ usbRoot: fixture.usbRoot, sourceRoot });
      build.catch(() => {});
      const copiedReadme = await waitForHostPrepStagingFile(
        fixture.usbRoot,
        "README-FIRST.txt"
      );
      const stagingPath = path.dirname(path.dirname(copiedReadme));
      displacedStaging = path.join(fixture.usbRoot, "displaced-builder-owned-staging");

      await rename(readmeSource, `${readmeSource}.approved`);
      await writeFile(readmeSource, "replacement source\n");
      await rename(stagingPath, displacedStaging);
      await mkdir(path.join(stagingPath, "Project-A-Migration"), { recursive: true });
      const callerMarker = path.join(
        stagingPath,
        "Project-A-Migration",
        "caller-owned-phase1-like-data.txt"
      );
      await writeFile(callerMarker, "caller-owned and must survive\n");

      await assert.rejects(build, /cleanup|staging.*changed|source changed/i);
      assert.equal(
        await readFile(callerMarker, "utf8"),
        "caller-owned and must survive\n"
      );
      assert.deepEqual(await snapshotFixtureTree(fixture.phase1Root), phase1Before);
      assert.ok((await readdir(displacedStaging)).includes(HOST_PREP_ROOT_NAME));
    } finally {
      await rm(fixture.usbRoot, { recursive: true, force: true });
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });
});

test("host prep PowerShell wrapper is a guarded verify-build-verify handoff", {
  skip: process.platform !== "win32" ? "PowerShell wrapper check runs on Windows." : false
}, async () => {
  const wrapper = await readFile(
    new URL("../scripts/migration/prepare-usb-host-prep.ps1", import.meta.url),
    "utf8"
  );
  assert.match(wrapper, /ValidatePattern\('\^\[A-Za-z\]:\$'\)/);
  assert.match(wrapper, /Win32_LogicalDisk/);
  assert.match(wrapper, /DriveType\s*-ne\s*2/);
  assert.match(wrapper, /FileSystem\s*-ne\s*['"]FAT32['"]/);
  assert.match(wrapper, /104857600|100MB/);
  assert.match(wrapper, /build-usb-host-prep\.mjs/);
  assert.match(wrapper, /verify-usb-host-prep\.mjs/);
  assert.match(wrapper, /verify-usb-handoff\.mjs/);
  const validationOrder = [
    wrapper.indexOf("QueryDosDevice"),
    wrapper.indexOf("Get-PSDrive"),
    wrapper.indexOf("Get-Item -LiteralPath $usbRoot"),
    wrapper.indexOf("Get-CimInstance Win32_LogicalDisk"),
    wrapper.indexOf("Get-Command node.exe"),
    wrapper.indexOf("$phase1Root ="),
    wrapper.indexOf("build-usb-host-prep.mjs"),
    wrapper.indexOf("verify-usb-host-prep.mjs"),
    wrapper.indexOf("verify-usb-handoff.mjs")
  ];
  assert.ok(validationOrder.every((index) => index >= 0));
  assert.deepEqual(validationOrder, [...validationOrder].sort((left, right) => left - right));
  assert.equal(wrapper.match(/build-usb-host-prep\.mjs/g)?.length, 1);
  assert.doesNotMatch(wrapper, /Format-Volume|Remove-Item|Clear-Disk|Repair-Volume|Dismount-Volume|Invoke-WebRequest|Invoke-RestMethod/);
});

async function runHostPrepPowerShellHarness({
  scenario = "success",
  usbDrive = "Q:"
} = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "project-a-host-prep-powershell-"));
  const mediaRoot = path.join(base, "media");
  const phase1Root = path.join(mediaRoot, "Project-A-Migration");
  const wrapperPath = path.join(base, "prepare-usb-host-prep.ps1");
  const logPath = path.join(base, "node-boundary.log");
  await mkdir(phase1Root, { recursive: true });
  const wrapperSource = await readFile(
    new URL("../scripts/migration/prepare-usb-host-prep.ps1", import.meta.url),
    "utf8"
  );
  const invocationMarker = "Invoke-HostPrepWorkflow -UsbDrive $UsbDrive";
  assert.equal(
    wrapperSource.split(invocationMarker).length,
    2,
    "wrapper must expose one workflow invocation seam"
  );
  const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const harnessInvocation = String.raw`
$script:FixtureSnapshotCount = 0
$fixtureSnapshot = {
    param([string]$Drive)
    $script:FixtureSnapshotCount += 1
    $scenario = $env:HOST_PREP_PS_SCENARIO
    $dosTarget = '\Device\HarddiskVolume99'
    $provider = 'FileSystem'
    $displayRoot = $null
    $rootIsReparse = $false
    $driveType = 2
    $fileSystem = 'FAT32'
    [uint64]$freeSpace = 209715200
    $serial = 'A1B2C3D4'
    $volumeDeviceId = '\\?\Volume{11111111-2222-3333-4444-555555555555}\'
    switch ($scenario) {
        'network' { $dosTarget = '\Device\Mup\server\share' }
        'subst' { $dosTarget = '\??\C:\fixture' }
        'reparse' { $rootIsReparse = $true }
        'non-removable' { $driveType = 3 }
        'non-fat32' { $fileSystem = 'NTFS' }
        'low-space' { [uint64]$freeSpace = 104857599 }
    }
    if (
        ($scenario -eq 'replace-prewrite' -and $script:FixtureSnapshotCount -ge 2) -or
        ($scenario -eq 'replace-postbuild' -and $script:FixtureSnapshotCount -ge 3) -or
        ($scenario -eq 'replace-after-phase2' -and $script:FixtureSnapshotCount -ge 4) -or
        ($scenario -eq 'replace-after-phase1' -and $script:FixtureSnapshotCount -ge 5)
    ) {
        $serial = 'DEADBEEF'
        $dosTarget = '\Device\HarddiskVolume100'
        $volumeDeviceId = '\\?\Volume{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\'
    }
    [pscustomobject]@{
        Drive = $Drive
        DosDeviceTarget = $dosTarget
        PsProviderName = $provider
        PsDisplayRoot = $displayRoot
        RootIsReparse = $rootIsReparse
        LogicalDeviceId = $Drive
        DriveType = $driveType
        FileSystem = $fileSystem
        FreeSpace = $freeSpace
        VolumeSerialNumber = $serial
        VolumeDeviceId = $volumeDeviceId
    }
}
$fixtureNode = {
    param([string]$NodePath, [string[]]$Arguments)
    $operation = if ($Arguments.Count -eq 1 -and $Arguments[0] -eq '--version') {
        'node-version'
    } elseif ($Arguments[0] -like '*build-usb-host-prep.mjs') {
        'builder'
    } elseif ($Arguments[0] -like '*verify-usb-host-prep.mjs') {
        'phase2-verifier'
    } elseif ($Arguments[0] -like '*verify-usb-handoff.mjs') {
        'phase1-verifier'
    } else {
        'unexpected-node-call'
    }
    Add-Content -LiteralPath ${psQuote(logPath)} -Value $operation
    if ($operation -eq 'node-version') {
        $version = if ($env:HOST_PREP_PS_SCENARIO -eq 'old-node') { 'v21.9.0' } else { 'v24.18.0' }
        return [pscustomobject]@{ ExitCode = 0; Lines = @($version) }
    }
    if ($operation -eq 'builder') {
        New-Item -ItemType Directory -Path (Join-Path ${psQuote(mediaRoot)} 'Project-A-Migration-Phase-2-Host-Prep') -ErrorAction Stop | Out-Null
        $json = [ordered]@{
            rootName = 'Project-A-Migration-Phase-2-Host-Prep'
            fileCount = 6
            manifestFingerprint = ('a' * 64)
            phase1ReportFileName = 'debian-readiness-20260730T192552Z-palziv-prod.txt'
            phase1ReportSha256 = ('b' * 64)
            phase1Unchanged = $true
        } | ConvertTo-Json -Compress
        return [pscustomobject]@{ ExitCode = 0; Lines = @($json) }
    }
    return [pscustomobject]@{ ExitCode = 0; Lines = @('{}') }
}
Invoke-HostPrepWorkflow -UsbDrive $UsbDrive -GetDeviceSnapshot $fixtureSnapshot -InvokeNode $fixtureNode
`;
  await writeFile(wrapperPath, wrapperSource.replace(invocationMarker, harnessInvocation));

  const driveName = usbDrive.match(/^[A-Za-z]:$/) ? usbDrive[0].toUpperCase() : "Q";
  const command = [
    `$existing = Get-PSDrive -Name ${driveName} -ErrorAction SilentlyContinue`,
    `if ($existing) { throw 'Fixture drive ${driveName}: is already in use.' }`,
    `New-PSDrive -Name ${driveName} -PSProvider FileSystem -Root ${psQuote(mediaRoot)} | Out-Null`,
    `try { & ${psQuote(wrapperPath)} -UsbDrive ${psQuote(usbDrive)} } finally { Remove-PSDrive -Name ${driveName} -Force -ErrorAction SilentlyContinue }`
  ].join("\n");
  let result;
  try {
    const output = await execFile("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command
    ], {
      env: { ...process.env, HOST_PREP_PS_SCENARIO: scenario },
      timeout: 20_000,
      maxBuffer: 1024 * 1024
    });
    result = { code: 0, stdout: output.stdout, stderr: output.stderr };
  } catch (error) {
    result = { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
  let operations = [];
  try {
    operations = (await readFile(logPath, "utf8")).trim().split(/\r?\n/).filter(Boolean);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return {
    base,
    cleanup: () => rm(base, { recursive: true, force: true }),
    operations,
    result
  };
}

test("host prep PowerShell behavior rejects unsafe destinations before Node and pins device identity", {
  skip: process.platform !== "win32" ? "PowerShell behavior harness runs on Windows." : false
}, async (t) => {
  const preNodeScenarios = [
    ["UNC", "success", "\\\\server\\share"],
    ["relative", "success", "Q"],
    ["non-root", "success", "Q:\\folder"],
    ["network", "network", "Q:"],
    ["SUBST", "subst", "Q:"],
    ["reparse", "reparse", "Q:"],
    ["non-removable", "non-removable", "Q:"],
    ["non-FAT32", "non-fat32", "Q:"],
    ["low-space", "low-space", "Q:"]
  ];
  for (const [name, scenario, usbDrive] of preNodeScenarios) {
    await t.test(name, async () => {
      const harness = await runHostPrepPowerShellHarness({ scenario, usbDrive });
      try {
        assert.notEqual(harness.result.code, 0);
        assert.deepEqual(harness.operations, []);
      } finally {
        await harness.cleanup();
      }
    });
  }

  await t.test("old Node stops before builder", async () => {
    const harness = await runHostPrepPowerShellHarness({ scenario: "old-node" });
    try {
      assert.notEqual(harness.result.code, 0);
      assert.deepEqual(harness.operations, ["node-version"]);
    } finally {
      await harness.cleanup();
    }
  });

  await t.test("success builds once then verifies Phase 2 and Phase 1 in order", async () => {
    const harness = await runHostPrepPowerShellHarness();
    try {
      assert.equal(harness.result.code, 0, harness.result.stderr);
      assert.deepEqual(harness.operations, [
        "node-version",
        "builder",
        "phase2-verifier",
        "phase1-verifier"
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  for (const [name, expectedOperations] of [
    ["replace-prewrite", ["node-version"]],
    ["replace-postbuild", ["node-version", "builder"]],
    ["replace-after-phase2", ["node-version", "builder", "phase2-verifier"]],
    ["replace-after-phase1", ["node-version", "builder", "phase2-verifier", "phase1-verifier"]]
  ]) {
    await t.test(name, async () => {
      const harness = await runHostPrepPowerShellHarness({ scenario: name });
      try {
        assert.notEqual(harness.result.code, 0);
        assert.deepEqual(harness.operations, expectedOperations);
        assert.match(harness.result.stderr, /device|volume|identity|changed/i);
      } finally {
        await harness.cleanup();
      }
    });
  }
});

test("host prep instructions provide the stand-alone fail-closed local operator flow", async () => {
  const readme = await readFile(
    new URL("../deploy/usb-host-prep/README-FIRST.txt", import.meta.url),
    "utf8"
  );
  const boundary = await readFile(
    new URL("../deploy/usb-host-prep/ISOLATION-BOUNDARY.txt", import.meta.url),
    "utf8"
  );
  assert.match(readme, /Project-A-Migration-Phase-2-Host-Prep/);
  assert.doesNotMatch(readme, /Project-A-Migration(?:\s|["'\/])/);
  assert.match(readme, /before-project-a-host-prep-YYYYMMDD-HHMM/);
  assert.match(readme, /mount -t vfat -o "\$REQUESTED_OPTIONS"/);
  assert.match(readme, /nodev,nosuid,noexec/);
  assert.match(readme, /sha256sum CHECKSUMS\/PHASE-2-HOST-PREP\.sha256/);
  assert.match(readme, /sha256sum --check CHECKSUMS\/PHASE-2-HOST-PREP\.sha256/g);
  assert.ok((readme.match(/sha256sum --check CHECKSUMS\/PHASE-2-HOST-PREP\.sha256/g) ?? []).length >= 2);
  assert.match(readme, /mktemp -d "\$HOME\/project-a-host-prep\.XXXXXX"/);
  assert.match(readme, /\/usr\/bin\/env -i[\s\S]*preflight-host-prep\.sh/);
  assert.match(readme, /apply-host-prep\.sh --apply/);
  assert.match(readme, /collect-host-prep-evidence\.sh[\s\\]*--usb-root "\$HANDOFF_ROOT"/);
  assert.match(readme, /noexec[^\n]+does not block \/bin\/bash/i);
  assert.match(readme, /out-of-band fingerprint/i);
  assert.match(readme, /sync/);
  assert.match(readme, /umount -- "\$MOUNT_POINT"/);
  assert.match(readme, /Do not retry|do not retry/i);
  assert.doesNotMatch(readme, /\b(?:ssh|scp)\b|Proxmox API|Cloudflare|firewall|\bnpm\b|cutover/i);
  assert.match(boundary, /Codex has no remote access to Debian or Proxmox/);
  assert.match(boundary, /Stop on any checksum, fingerprint, mount, preflight, apply, collector, sync, or unmount error\. Do not retry\./);
});

function extractHostPrepReadmeScript(readme) {
  const match = readme.match(
    /<<'PROJECT_A_HOST_PREP_LOCAL'\r?\n([\s\S]*?)\r?\nPROJECT_A_HOST_PREP_LOCAL/
  );
  assert.ok(match, "Phase 2 README command block was not found");
  return match[1];
}

async function writeHostPrepReadmeExecutable(filePath, contents) {
  await writeFile(filePath, contents, { mode: 0o700 });
  await chmod(filePath, 0o700);
}

async function createHostPrepReadmeHarness(scenario = {}) {
  const base = await mkdtemp("/tmp/project-a-host-prep-readme-test.");
  const fakeBin = path.join(base, "bin");
  const home = path.join(base, "home");
  const deviceDirectory = path.join(base, "devices");
  const device = path.join(deviceDirectory, "usb-partition");
  const mountPoint = path.join(base, "mount");
  const handoffRoot = path.join(mountPoint, HOST_PREP_ROOT_NAME);
  const stateFile = path.join(base, "mounted.state");
  const logFile = path.join(base, "commands.log");
  const checksumCount = path.join(base, "checksum.count");
  const deviceInput = path.join(base, "device-input");
  const fingerprintInput = path.join(base, "fingerprint-input");
  const applyInput = path.join(base, "apply-input");
  const scriptPath = path.join(base, "operator.sh");
  const fingerprint = sha256Bytes("fixture manifest\n");
  await Promise.all([
    mkdir(fakeBin),
    mkdir(home),
    mkdir(deviceDirectory)
  ]);
  await writeFile(device, "fixture device\n");
  await writeFile(deviceInput, `${device}\n`);
  await writeFile(fingerprintInput, `${fingerprint}\n`);
  await writeFile(applyInput, "APPLY\n");
  if (scenario.redirectedMount) {
    const outside = path.join(base, "redirected");
    await mkdir(outside);
    await writeFile(path.join(outside, "preserve.txt"), "preserve\n");
    await symlink(outside, mountPoint, "dir");
  } else if (scenario.mountPointFile) {
    await writeFile(mountPoint, "preserve file\n");
  } else {
    await Promise.all([
      mkdir(path.join(handoffRoot, "CHECKSUMS"), { recursive: true }),
      mkdir(path.join(handoffRoot, "TO-DEBIAN"), { recursive: true }),
      mkdir(path.join(handoffRoot, "FROM-DEBIAN"), { recursive: true }),
      mkdir(path.join(handoffRoot, "SECRETS-ENCRYPTED"), { recursive: true })
    ]);
    await writeFile(path.join(handoffRoot, "CHECKSUMS", "PHASE-2-HOST-PREP.sha256"), "fixture manifest\n");
    for (const [name, marker, failureVariable] of [
      ["preflight-host-prep.sh", "preflight", "FAKE_PREFLIGHT_FAIL"],
      ["apply-host-prep.sh", "apply", "FAKE_APPLY_FAIL"],
      ["collect-host-prep-evidence.sh", "collector", "FAKE_COLLECTOR_FAIL"]
    ]) {
      await writeHostPrepReadmeExecutable(path.join(handoffRoot, "TO-DEBIAN", name), `#!/bin/bash
printf '${marker}:%s\\n' "$*" >> ${shellSingleQuote(logFile)}
${scenario[`${marker}Fails`] ? "exit 81" : ":"}
`);
    }
  }

  await writeHostPrepReadmeExecutable(path.join(fakeBin, "sudo"), `#!/bin/bash
printf 'sudo:%s\\n' "$*" >> ${shellSingleQuote(logFile)}
exec "$@"
`);
  await writeHostPrepReadmeExecutable(path.join(fakeBin, "mount"), `#!/bin/bash
printf 'mount:%s\\n' "$*" >> ${shellSingleQuote(logFile)}
[[ "\${FAKE_MOUNT_FAIL:-0}" != 1 ]] || exit 71
: > ${shellSingleQuote(stateFile)}
[[ "\${FAKE_SIGNAL_AFTER_MOUNT:-0}" != 1 ]] || kill -TERM "$PPID"
`);
  await writeHostPrepReadmeExecutable(path.join(fakeBin, "umount"), `#!/bin/bash
printf 'umount:%s\\n' "$*" >> ${shellSingleQuote(logFile)}
[[ "\${FAKE_UNMOUNT_FAIL:-0}" != 1 ]] || exit 72
rm -f -- ${shellSingleQuote(stateFile)}
`);
  await writeHostPrepReadmeExecutable(path.join(fakeBin, "findmnt"), `#!/bin/bash
field=''
previous=''
for argument in "$@"; do
  [[ "$previous" != -o ]] || field="$argument"
  previous="$argument"
done
if [[ -z "$field" ]]; then
  [[ "\${FAKE_ALREADY_MOUNTED:-0}" == 1 || -e ${shellSingleQuote(stateFile)} ]] && exit 0
  exit 1
fi
[[ -e ${shellSingleQuote(stateFile)} ]] || exit 1
case "$field" in
  SOURCE) printf '%s\\n' "\${FAKE_MOUNT_SOURCE:-${device}}" ;;
  FSTYPE) printf '%s\\n' "\${FAKE_MOUNT_FSTYPE:-vfat}" ;;
  OPTIONS) printf '%s\\n' "\${FAKE_MOUNT_OPTIONS:-rw,nodev,nosuid,noexec,uid=1001,gid=1002,umask=0077}" ;;
  *) exit 73 ;;
esac
`);
  await writeHostPrepReadmeExecutable(path.join(fakeBin, "lsblk"), `#!/bin/bash
case " $* " in
  *' TYPE '*) printf 'part\\n' ;;
  *' FSTYPE '*) printf '%s\\n' "\${FAKE_DEVICE_FSTYPE:-vfat}" ;;
  *) printf 'fixture vfat\\n' ;;
esac
`);
  await writeHostPrepReadmeExecutable(path.join(fakeBin, "id"), `#!/bin/bash
case "\${1:-}" in -u) printf '1001\\n' ;; -g) printf '1002\\n' ;; *) exit 74 ;; esac
`);
  await writeHostPrepReadmeExecutable(path.join(fakeBin, "sha256sum"), `#!/bin/bash
printf 'checksum:%s\\n' "$*" >> ${shellSingleQuote(logFile)}
if [[ "\${1:-}" == --check ]]; then
  count=0
  [[ ! -f ${shellSingleQuote(checksumCount)} ]] || count="$(cat ${shellSingleQuote(checksumCount)})"
  count=$((count + 1))
  printf '%s\\n' "$count" > ${shellSingleQuote(checksumCount)}
  [[ "\${FAKE_CHECKSUM_FAIL_AT:-0}" != "$count" ]] || exit 75
  exit 0
fi
exec /usr/bin/sha256sum "$@"
`);
  await writeHostPrepReadmeExecutable(path.join(fakeBin, "cp"), `#!/bin/bash
printf 'copy:%s\\n' "$*" >> ${shellSingleQuote(logFile)}
[[ "\${FAKE_COPY_FAIL:-0}" != 1 ]] || exit 76
/usr/bin/cp "$@"
if [[ "\${FAKE_COPY_MANIFEST_SUBSTITUTION:-0}" == 1 ]]; then
  destination="\${@: -1}"
  printf 'substituted copied manifest\\n' > "$destination/CHECKSUMS/PHASE-2-HOST-PREP.sha256"
fi
`);
  await writeHostPrepReadmeExecutable(path.join(fakeBin, "sync"), `#!/bin/bash
printf 'sync\\n' >> ${shellSingleQuote(logFile)}
[[ "\${FAKE_SYNC_FAIL:-0}" != 1 ]]
`);

  const readme = await readFile(
    new URL("../deploy/usb-host-prep/README-FIRST.txt", import.meta.url),
    "utf8"
  );
  let script = extractHostPrepReadmeScript(readme);
  script = script.replace(
    "readonly SYSTEM_PATH='/usr/sbin:/usr/bin:/sbin:/bin'",
    `readonly SYSTEM_PATH=${shellSingleQuote(`${fakeBin}:/usr/bin:/bin`)}`
  );
  script = script.replace(
    "readonly MOUNT_POINT='/mnt/project-a-host-prep-usb'",
    `readonly MOUNT_POINT=${shellSingleQuote(mountPoint)}`
  );
  script = script.replace("< /dev/tty", `< ${shellSingleQuote(deviceInput)}`);
  script = script.replace("< /dev/tty", `< ${shellSingleQuote(fingerprintInput)}`);
  script = script.replace("< /dev/tty", `< ${shellSingleQuote(applyInput)}`);
  script = script.replace(
    '[[ "$USB_DEVICE" == /dev/* && -b "$USB_DEVICE" ]]',
    `[[ "$USB_DEVICE" == ${shellSingleQuote(deviceDirectory)}/* && -e "$USB_DEVICE" ]]`
  );
  await writeFile(scriptPath, script);

  let result;
  try {
    const output = await execFile("/bin/bash", ["--noprofile", "--norc", scriptPath], {
      cwd: base,
      env: {
        ...process.env,
        HOME: home,
        FAKE_ALREADY_MOUNTED: scenario.alreadyMounted ? "1" : "0",
        FAKE_MOUNT_FAIL: scenario.mountFails ? "1" : "0",
        FAKE_SIGNAL_AFTER_MOUNT: scenario.signalAfterMount ? "1" : "0",
        FAKE_MOUNT_SOURCE: scenario.mountedSource || device,
        FAKE_MOUNT_FSTYPE: scenario.mountedFsType || "vfat",
        FAKE_MOUNT_OPTIONS: scenario.mountOptions || "rw,nodev,nosuid,noexec,uid=1001,gid=1002,umask=0077",
        FAKE_CHECKSUM_FAIL_AT: scenario.checksumFailAt || "0",
        FAKE_COPY_FAIL: scenario.copyFails ? "1" : "0",
        FAKE_COPY_MANIFEST_SUBSTITUTION: scenario.copyManifestSubstitution ? "1" : "0",
        FAKE_SYNC_FAIL: scenario.syncFails ? "1" : "0",
        FAKE_UNMOUNT_FAIL: scenario.unmountFails ? "1" : "0"
      },
      timeout: 20_000,
      maxBuffer: 1024 * 1024
    });
    result = { code: 0, stdout: output.stdout, stderr: output.stderr };
  } catch (error) {
    result = {
      code: error.code,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? ""
    };
  }
  let log = "";
  try {
    log = await readFile(logFile, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { base, home, log, mountPoint, result, stateFile };
}

test("host prep instructions fail closed across mount, copy, command, sync, unmount, and signal windows", {
  skip: process.platform === "win32" ? "Runtime operator-flow checks run on POSIX." : false
}, async (t) => {
  await t.test("successful one-pass local flow", async () => {
    const harness = await createHostPrepReadmeHarness();
    try {
      assert.equal(harness.result.code, 0, harness.result.stderr);
      assert.equal(harness.log.match(/^preflight:/gm)?.length, 1);
      assert.equal(harness.log.match(/^apply:/gm)?.length, 1);
      assert.equal(harness.log.match(/^collector:/gm)?.length, 1);
      assert.equal(harness.log.match(/^sync$/gm)?.length, 1);
      assert.equal(harness.log.match(/^umount:/gm)?.length, 1);
      await assert.rejects(lstat(harness.stateFile));
      assert.deepEqual(
        (await readdir(harness.home)).filter((name) => name.startsWith("project-a-host-prep.")),
        []
      );
    } finally {
      await rm(harness.base, { recursive: true, force: true });
    }
  });
  const scenarios = [
    ["redirected mountpoint", { redirectedMount: true }, /mountpoint/i],
    ["non-directory mountpoint", { mountPointFile: true }, /mountpoint/i],
    ["already-mounted target", { alreadyMounted: true }, /already mounted/i],
    ["failed mount", { mountFails: true }, /mount/i],
    ["wrong mounted source", { mountedSource: "/wrong/source" }, /mounted source/i],
    ["wrong mounted filesystem", { mountedFsType: "ext4" }, /filesystem/i],
    ["missing mount option", { mountOptions: "rw,nodev,nosuid,uid=1001,gid=1002,umask=0077" }, /mount options/i],
    ["failed media checksum", { checksumFailAt: "1" }, /checksum/i],
    ["failed copy", { copyFails: true }, /staging copy/i],
    ["copied manifest substitution", { copyManifestSubstitution: true }, /copied manifest fingerprint/i],
    ["failed local checksum", { checksumFailAt: "2" }, /local checksum/i],
    ["failed preflight", { preflightFails: true }, /preflight/i],
    ["failed apply", { applyFails: true }, /apply failed/i],
    ["failed collector", { collectorFails: true }, /evidence collection failed/i],
    ["failed sync", { syncFails: true }, /sync/i],
    ["failed unmount", { unmountFails: true }, /unmount/i],
    ["signal after mount", { signalAfterMount: true }, /(?:STOP|$)/i]
  ];
  for (const [name, scenario, expected] of scenarios) {
    await t.test(name, async () => {
      const harness = await createHostPrepReadmeHarness(scenario);
      try {
        assert.notEqual(harness.result.code, 0);
        assert.match(harness.result.stderr, expected);
        if (scenario.applyFails) {
          assert.equal(harness.log.match(/^apply:/gm)?.length, 1);
          assert.equal(harness.log.match(/^collector:/gm)?.length, 1);
        }
        if (scenario.unmountFails) {
          assert.equal(harness.log.match(/^umount:/gm)?.length, 1);
        }
      } finally {
        await rm(harness.base, { recursive: true, force: true });
      }
    });
  }
});
