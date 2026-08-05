import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  APPLIANCE_REQUIRED_FILES,
  APPLIANCE_SCHEMA_VERSION,
  artifactDiskName,
  validateBuildManifest,
  verifyApplianceArtifacts
} from "../scripts/appliance/appliance-lib.mjs";

const RELEASE_SHA = "a".repeat(40);
const DISK_CONTENTS = "fixture-qcow2";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sha512 = (value) => createHash("sha512").update(value).digest("hex");
const BUILD_ID = "20260805T120000Z-aaaaaaaaaaaa";
const BASE_IMAGE_NAME = "debian-13-genericcloud-amd64.qcow2";
const BASE_IMAGE_CONTENTS = "official-debian-fixture\n";
const SSH_KEYGEN_COMMAND = String.raw`eval $'exec ssh-keygen -q -t ed25519 -N \x22\x22 -f \x22\x241\x22'`;

function runProcess(command, args, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Process timed out after ${timeoutMs}ms: ${output}`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, output });
    });
  });
}

const toWslPath = (windowsPath) => {
  const resolved = path.resolve(windowsPath);
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(resolved);
  if (!match) throw new Error(`Expected an absolute Windows drive path: ${resolved}`);
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
};

async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function runWsl(command, timeoutMs = 10000) {
  return runProcess("wsl.exe", [
    "--distribution", "Ubuntu-24.04",
    "--user", "root",
    "--",
    "bash", "-c", command
  ], timeoutMs);
}

const shellQuote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;

async function writeCommandFixture(binRoot, name, contents) {
  await writeFile(path.join(binRoot, name), `#!/usr/bin/env bash\nset -Eeuo pipefail\n${contents}`);
}

async function runProvisioningHarness({
  archiveScenario = "valid",
  releaseSha = RELEASE_SHA,
  extraArguments = [],
  helperScenario = "normal"
} = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "palziv-provisioning-"));
  const releaseRoot = path.join(base, "release");
  const binRoot = path.join(base, "bin");
  const archive = path.join(base, "project-a-release.tar");
  await mkdir(path.join(releaseRoot, "scripts", "linux"), { recursive: true });
  await mkdir(path.join(releaseRoot, "deploy", "linux"), { recursive: true });
  await mkdir(binRoot, { recursive: true });
  await writeFile(path.join(releaseRoot, "package.json"), '{"name":"fixture-release"}\n');

  const prepareHost = helperScenario === "replace-cleanup-root"
    ? String.raw`#!/usr/bin/env bash
set -Eeuo pipefail
release_root="$(realpath -e -- "$(dirname "${"$"}{BASH_SOURCE[0]}")/../..")"
printf '%s\n' "$release_root" > "$PALZIV_APPLIANCE_TEST_LOG.release-root"
mv -- "$release_root" "$release_root.original"
install -d -m 0700 -- "$release_root"
/usr/bin/chown 65534:65534 "$release_root"
printf '%s\n' 'preserve-replacement' > "$release_root/operator-marker.txt"
exit 23
`
    : String.raw`#!/usr/bin/env bash
set -Eeuo pipefail
release_root="$(realpath -e -- "$(dirname "${"$"}{BASH_SOURCE[0]}")/../..")"
printf '%s\n' "$release_root" > "$PALZIV_APPLIANCE_TEST_LOG.release-root"
printf '%s\n' 'prepare-host.sh' >> "$PALZIV_APPLIANCE_TEST_LOG"
`;
  await writeFile(path.join(releaseRoot, "scripts", "linux", "prepare-host.sh"), prepareHost);
  await writeFile(path.join(releaseRoot, "scripts", "linux", "install-cloudflared.sh"), `#!/usr/bin/env bash\nset -Eeuo pipefail\nprintf '%s\\n' 'install-cloudflared.sh' >> "$PALZIV_APPLIANCE_TEST_LOG"\n`);
  await writeFile(path.join(releaseRoot, "scripts", "linux", "install-node24.sh"), String.raw`#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' 'install-node24.sh' >> "$PALZIV_APPLIANCE_TEST_LOG"
install -d -m 0755 "$PALZIV_APPLIANCE_ROOT/opt/node/bin"
printf '%s\n' '#!/usr/bin/env bash' "printf '%s\\n' 'v24.18.0'" > "$PALZIV_APPLIANCE_ROOT/opt/node/bin/node"
chmod 0755 "$PALZIV_APPLIANCE_ROOT/opt/node/bin/node"
`);
  await writeFile(path.join(releaseRoot, "scripts", "linux", "deploy-release.sh"), String.raw`#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' 'deploy-release.sh' >> "$PALZIV_APPLIANCE_TEST_LOG"
source_root="$1"
release_sha="$2"
release_dir="$PALZIV_APPLIANCE_ROOT/opt/palziv/releases/$release_sha"
install -d -m 0750 "$release_dir"
cp -- "$source_root/package.json" "$release_dir/package.json"
ln -sfn "$release_dir" "$PALZIV_APPLIANCE_ROOT/opt/palziv/current"
`);

  await writeCommandFixture(binRoot, "chown", String.raw`
printf '%s\n' "$*" >> "$PALZIV_APPLIANCE_TEST_LOG.chown"
`);
  await writeCommandFixture(binRoot, "systemctl", String.raw`
printf '%s\n' "$*" >> "$PALZIV_APPLIANCE_TEST_LOG.systemctl"
`);
  await writeCommandFixture(binRoot, "apt-get", String.raw`
printf '%s\n' "$*" >> "$PALZIV_APPLIANCE_TEST_LOG.apt-get"
`);
  await writeCommandFixture(binRoot, "age-keygen", String.raw`
output=''
while (($#)); do
  if [[ "$1" == '-o' ]]; then output="$2"; shift 2; continue; fi
  shift
done
[[ -n "$output" ]]
printf '%s\n' 'AGE-SECRET-KEY-1FIXTURE' > "$output"
printf '%s\n' 'AGE-SECRET-KEY-1FIXTURE'
printf '%s\n' 'AGE-SECRET-KEY-1FIXTURE' >&2
`);

  const linuxFixture = await runWsl("mktemp -d /tmp/palziv-provisioning-target.XXXXXXXX");
  assert.equal(linuxFixture.code, 0, linuxFixture.output);
  const fixtureRoot = linuxFixture.output.trim();
  assert.match(fixtureRoot, /^\/tmp\/palziv-provisioning-target\.[A-Za-z0-9]+$/);

  const wslReleaseRoot = toWslPath(releaseRoot);
  const wslArchive = toWslPath(archive);
  let archiveCommand = `tar -cf ${shellQuote(wslArchive)} -C ${shellQuote(wslReleaseRoot)} .`;
  if (archiveScenario === "unsafe-path") {
    archiveCommand = `tar -cf ${shellQuote(wslArchive)} --transform='s|^|../|' -C ${shellQuote(wslReleaseRoot)} package.json`;
  } else if (archiveScenario === "backslash-path") {
    archiveCommand = `tar -cf ${shellQuote(wslArchive)} --transform='s|package.json|..\\\\escape|' -C ${shellQuote(wslReleaseRoot)} package.json`;
  } else if (archiveScenario === "link") {
    const linkRoot = `/tmp/palziv-provisioning-link-${process.pid}-${Date.now()}`;
    archiveCommand = `mkdir -m 0700 -- ${shellQuote(linkRoot)}; trap 'rm -rf -- ${linkRoot}' EXIT; cp -a ${shellQuote(`${wslReleaseRoot}/.`)} ${shellQuote(`${linkRoot}/`)}; ln -s /etc/passwd ${shellQuote(`${linkRoot}/guest-link`)}; tar -cf ${shellQuote(wslArchive)} -C ${shellQuote(linkRoot)} .`;
  } else if (archiveScenario === "hard-link") {
    const hardLinkRoot = `/tmp/palziv-provisioning-hardlink-${process.pid}-${Date.now()}`;
    archiveCommand = `mkdir -m 0700 -- ${shellQuote(hardLinkRoot)}; trap 'rm -rf -- ${hardLinkRoot}' EXIT; cp -a ${shellQuote(`${wslReleaseRoot}/.`)} ${shellQuote(`${hardLinkRoot}/`)}; ln ${shellQuote(`${hardLinkRoot}/package.json`)} ${shellQuote(`${hardLinkRoot}/package-hardlink.json`)}; tar -cf ${shellQuote(wslArchive)} -C ${shellQuote(hardLinkRoot)} .`;
  } else if (archiveScenario === "fifo") {
    const fifoRoot = `/tmp/palziv-provisioning-fifo-${process.pid}-${Date.now()}`;
    archiveCommand = `mkdir -m 0700 -- ${shellQuote(fifoRoot)}; trap 'rm -rf -- ${fifoRoot}' EXIT; cp -a ${shellQuote(`${wslReleaseRoot}/.`)} ${shellQuote(`${fifoRoot}/`)}; mkfifo ${shellQuote(`${fifoRoot}/guest-fifo`)}; tar -cf ${shellQuote(wslArchive)} -C ${shellQuote(fifoRoot)} .`;
  } else if (archiveScenario === "device") {
    const deviceRoot = `/tmp/palziv-provisioning-device-${process.pid}-${Date.now()}`;
    archiveCommand = `mkdir -m 0700 -- ${shellQuote(deviceRoot)}; trap 'rm -rf -- ${deviceRoot}' EXIT; cp -a ${shellQuote(`${wslReleaseRoot}/.`)} ${shellQuote(`${deviceRoot}/`)}; mknod ${shellQuote(`${deviceRoot}/guest-device`)} c 1 3; tar -cf ${shellQuote(wslArchive)} -C ${shellQuote(deviceRoot)} .`;
  }
  const archived = await runWsl(archiveCommand);
  assert.equal(archived.code, 0, archived.output);

  const provisioner = toWslPath(path.resolve("scripts/appliance/provision-debian-appliance.sh"));
  const logPath = `${fixtureRoot}/provision.log`;
  const invoked = await runWsl([
    `export PALZIV_APPLIANCE_ROOT=${shellQuote(fixtureRoot)}`,
    `export PALZIV_APPLIANCE_TEST_LOG=${shellQuote(logPath)}`,
    `export PATH=${shellQuote(`${toWslPath(binRoot)}:/usr/bin:/bin`)}`,
    `bash ${shellQuote(provisioner)} ${shellQuote(wslArchive)} ${shellQuote(releaseSha)} ${extraArguments.map(shellQuote).join(" ")}`
  ].join("\n"), 15000);

  const readLinux = async (candidate) => {
    const result = await runWsl(`if [[ -f ${shellQuote(candidate)} ]]; then cat -- ${shellQuote(candidate)}; fi`);
    assert.equal(result.code, 0, result.output);
    return result.output;
  };
  const releaseStage = (await readLinux(`${logPath}.release-root`)).trim();
  return {
    base,
    fixtureRoot,
    logPath,
    releaseStage,
    result: invoked,
    readLinux,
    cleanup: async () => {
      if (/^\/var\/tmp\/palziv-appliance-release\.[A-Za-z0-9]+$/.test(releaseStage)) {
        await runWsl(`rm -rf -- ${shellQuote(releaseStage)} ${shellQuote(`${releaseStage}.original`)}`);
      }
      await runWsl(`case ${shellQuote(fixtureRoot)} in /tmp/palziv-provisioning-target.*) rm -rf -- ${shellQuote(fixtureRoot)} ;; *) exit 64 ;; esac`);
      await rm(base, { recursive: true, force: true });
    }
  };
}

async function runBashControllerHarness({
  scenario = "success",
  precreateCacheImage,
  precreateSeed = false,
  unownedPid = "",
  bootOnly = true
} = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "palziv-appliance-bash-"));
  const repository = path.join(base, "repository");
  const outputRoot = path.join(repository, "artifacts", "local-debian-appliance");
  const buildRoot = path.join(outputRoot, BUILD_ID);
  const cacheRoot = path.join(outputRoot, ".cache");
  const binRoot = path.join(base, "bin");
  const fixtureRoot = path.join(base, "fixture");
  const releaseTar = path.join(buildRoot, "project-a-release.tar");
  const publicKey = path.join(buildRoot, "build_ssh_ed25519.pub");
  await mkdir(binRoot, { recursive: true });
  await mkdir(fixtureRoot, { recursive: true });
  await mkdir(cacheRoot, { recursive: true });
  await mkdir(buildRoot, { recursive: true });
  await writeFile(releaseTar, "fixture release tar\n");
  await writeFile(path.join(buildRoot, "build_ssh_ed25519"), "private fixture key\n");
  await writeFile(publicKey, "ssh-ed25519 QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE= fixture@local\n");
  await writeFile(path.join(fixtureRoot, "base-image.source"), BASE_IMAGE_CONTENTS);
  if (precreateCacheImage !== undefined) {
    await writeFile(path.join(cacheRoot, BASE_IMAGE_NAME), precreateCacheImage);
  }
  if (precreateSeed) {
    await mkdir(path.join(buildRoot, "seed"));
    await writeFile(path.join(buildRoot, "seed", "operator-marker.txt"), "preserve\n");
  }

  await writeCommandFixture(binRoot, "apt-get", String.raw`
printf '%s\n' "$*" >> "$FIXTURE_ROOT/apt-get.log"
exit 0
`);
  await writeCommandFixture(binRoot, "curl", String.raw`
printf '%s\n' "$*" >> "$FIXTURE_ROOT/curl.log"
destination=''
url="${"$"}{!#}"
while (($#)); do
  if [[ "$1" == '--output' ]]; then destination="$2"; shift 2; continue; fi
  shift
done
[[ -n "$destination" ]]
if [[ "$url" == */SHA512SUMS ]]; then
  digest="$FIXTURE_IMAGE_SHA512"
  [[ "$FIXTURE_SCENARIO" != 'bad-checksum' ]] || digest="$(printf '0%.0s' {1..128})"
  printf '%s  %s\n' "$digest" '${BASE_IMAGE_NAME}' > "$destination"
elif [[ "$url" == */${BASE_IMAGE_NAME} ]]; then
  cp -- "$FIXTURE_ROOT/base-image.source" "$destination"
else
  printf 'unexpected URL: %s\n' "$url" >&2
  exit 22
fi
`);
  await writeCommandFixture(binRoot, "qemu-img", String.raw`
if [[ "$FIXTURE_SCENARIO" == 'mutate-cache-after-snapshot' ]]; then
  printf 'mutated-after-snapshot\n' > "$FIXTURE_CACHE_ROOT/${BASE_IMAGE_NAME}"
fi
printf '%s\n' "$*" >> "$FIXTURE_ROOT/qemu-img.log"
if [[ "$1" == 'create' ]]; then
  destination="${"$"}{@: -2:1}"
  : > "$destination"
fi
`);
  await writeCommandFixture(binRoot, "cloud-localds", String.raw`
printf '%s\n' "$*" >> "$FIXTURE_ROOT/cloud-localds.log"
: > "$1"
`);
  await writeCommandFixture(binRoot, "ss", String.raw`
printf 'LISTEN 0 128 127.0.0.1:22000 0.0.0.0:*\n'
if [[ -s "$FIXTURE_ROOT/qemu.port" && "$FIXTURE_SCENARIO" != 'no-listener' ]]; then
  port="$(<"$FIXTURE_ROOT/qemu.port")"
  printf 'LISTEN 0 128 127.0.0.1:%s 0.0.0.0:*\n' "$port"
fi
`);
  await writeCommandFixture(binRoot, "ssh-keyscan", String.raw`
printf '%s\n' "$*" >> "$FIXTURE_ROOT/ssh-keyscan.log"
[[ "$FIXTURE_SCENARIO" != 'ssh-timeout' ]] || exit 1
if [[ "$FIXTURE_SCENARIO" == 'slow-keyscan' ]]; then sleep 3; fi
port=''
while (($#)); do
  if [[ "$1" == '-p' ]]; then port="$2"; shift 2; continue; fi
  shift
done
printf '[127.0.0.1]:%s ssh-ed25519 QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=\n' "$port"
`);
  await writeCommandFixture(binRoot, "ssh", String.raw`
printf '%s\n' "$*" >> "$FIXTURE_ROOT/ssh.log"
printf 'ssh %s\n' "$*" >> "$FIXTURE_ROOT/transfer-operations.log"
if [[ "$FIXTURE_SCENARIO" == 'hanging-ssh' ]]; then sleep 3; fi
if [[ "$*" == *'palziv-appliance-upload-'* && "$*" != *'bash -s'* ]]; then
  exit 0
fi
if [[ "$*" == *'provision-debian-appliance.sh'* || "$*" == *'bash -s'* ]]; then
  cat > "$FIXTURE_ROOT/provision-stdin.log"
  if [[ "$FIXTURE_SCENARIO" == 'provision-timeout' ]]; then sleep 3; fi
  printf '%s\n' 'AGE-SECRET-KEY-1CONTROLLERFIXTURE'
  printf '%s\n' 'AGE-SECRET-KEY-1CONTROLLERFIXTURE' >&2
  [[ "$FIXTURE_SCENARIO" != 'provision-failure' ]] || exit 42
  exit 0
fi
[[ "$FIXTURE_SCENARIO" != 'active-shutdown-failure' ]] || exit 43
pid="$(<"$FIXTURE_ROOT/qemu.pid")"
kill -TERM "$pid"
exit 0
`);
  await writeCommandFixture(binRoot, "scp", String.raw`
printf '%s\n' "$*" >> "$FIXTURE_ROOT/scp.log"
printf 'scp %s\n' "$*" >> "$FIXTURE_ROOT/transfer-operations.log"
if [[ "$FIXTURE_SCENARIO" == 'hanging-scp' ]]; then sleep 3; fi
[[ "$FIXTURE_SCENARIO" != 'scp-failure' ]] || exit 41
`);
  const qemuSource = path.join(fixtureRoot, "qemu-fixture.c");
  await writeFile(qemuSource, String.raw`#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <unistd.h>

static volatile sig_atomic_t running = 1;
static void stop(int signal_number) { (void)signal_number; running = 0; }

int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "--fixture-unrelated") == 0) {
    signal(SIGTERM, stop);
    signal(SIGINT, stop);
    while (running) pause();
    return 0;
  }
  const char *root = getenv("FIXTURE_ROOT");
  const char *scenario = getenv("FIXTURE_SCENARIO");
  const char *unowned = getenv("FIXTURE_UNOWNED_PID");
  char pidfile[4096] = {0};
  char port[32] = {0};
  char log_path[4096];
  snprintf(log_path, sizeof(log_path), "%s/qemu.log", root);
  FILE *log = fopen(log_path, "w");
  if (!log) return 70;
  for (int i = 1; i < argc; i++) {
    fprintf(log, "%s\n", argv[i]);
    if (strcmp(argv[i], "-pidfile") == 0 && i + 1 < argc) snprintf(pidfile, sizeof(pidfile), "%s", argv[i + 1]);
    const char *forward = strstr(argv[i], "hostfwd=tcp:127.0.0.1:");
    if (forward) sscanf(forward, "hostfwd=tcp:127.0.0.1:%31[0-9]", port);
  }
  fclose(log);
  char port_path[4096];
  snprintf(port_path, sizeof(port_path), "%s/qemu.port", root);
  FILE *port_file = fopen(port_path, "w");
  if (!port_file) return 71;
  fprintf(port_file, "%s\n", port);
  fclose(port_file);
  if (scenario && strcmp(scenario, "unowned-pid") == 0) {
    FILE *pid_file = fopen(pidfile, "w");
    if (!pid_file) return 72;
    fprintf(pid_file, "%s\n", unowned);
    fclose(pid_file);
    return 0;
  }
  if (scenario && strcmp(scenario, "substring-drive-pid") == 0) {
    const char *drive = "";
    for (int i = 1; i < argc; i++) {
      if (strcmp(argv[i], "-drive") == 0 && i + 1 < argc && strstr(argv[i + 1], "id=osdisk")) {
        drive = argv[i + 1];
        break;
      }
    }
    char substring_argument[8192];
    snprintf(substring_argument, sizeof(substring_argument), "unrelated-prefix:%s:unrelated-suffix", drive);
    pid_t child = fork();
    if (child < 0) return 79;
    if (child == 0) {
      setsid();
      char *child_argv[] = { argv[0], "--fixture-unrelated", substring_argument, NULL };
      execv("/proc/self/exe", child_argv);
      _exit(80);
    }
    FILE *pid_file = fopen(pidfile, "w");
    if (!pid_file) return 81;
    fprintf(pid_file, "%ld\n", (long)child);
    fclose(pid_file);
    char pid_path[4096];
    snprintf(pid_path, sizeof(pid_path), "%s/qemu.pid", root);
    FILE *fixture_pid = fopen(pid_path, "w");
    if (!fixture_pid) return 82;
    fprintf(fixture_pid, "%ld\n", (long)child);
    fclose(fixture_pid);
    return 0;
  }
  int ready[2];
  if (pipe(ready) != 0) return 73;
  pid_t child = fork();
  if (child < 0) return 74;
  if (child > 0) {
    close(ready[1]);
    char byte;
    if (read(ready[0], &byte, 1) != 1) return 75;
    return 0;
  }
  close(ready[0]);
  setsid();
  signal(SIGTERM, stop);
  signal(SIGINT, stop);
  FILE *pid_file = fopen(pidfile, "w");
  if (!pid_file) _exit(76);
  fprintf(pid_file, "%ld\n", (long)getpid());
  fclose(pid_file);
  char pid_path[4096];
  snprintf(pid_path, sizeof(pid_path), "%s/qemu.pid", root);
  FILE *fixture_pid = fopen(pid_path, "w");
  if (!fixture_pid) _exit(77);
  fprintf(fixture_pid, "%ld\n", (long)getpid());
  fclose(fixture_pid);
  if (write(ready[1], "1", 1) != 1) _exit(78);
  close(ready[1]);
  while (running) pause();
  return 0;
}
`);

  const wslBase = toWslPath(base);
  const compile = await runWsl(`cc -O2 -Wall -Wextra -o '${wslBase}/bin/qemu-system-x86_64' '${wslBase}/fixture/qemu-fixture.c'`);
  assert.equal(compile.code, 0, compile.output);

  const controller = toWslPath(path.resolve("scripts/appliance/build-local-debian-appliance.sh"));
  const wslRepository = toWslPath(repository);
  const wslBuildRoot = toWslPath(buildRoot);
  const shellQuote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;
  const wrapper = String.raw`#!/usr/bin/env bash
set -Eeuo pipefail
fixture_root=${shellQuote(toWslPath(fixtureRoot))}
scenario=${shellQuote(scenario)}
unowned_pid=${shellQuote(String(unownedPid || "-"))}
if [[ "$scenario" == 'unowned-pid' && "$unowned_pid" == '-' ]]; then
  sleep 60 >/dev/null 2>&1 &
  unowned_pid="$!"
  printf '%s\n' "$unowned_pid" > "$fixture_root/unowned.pid"
fi
export FIXTURE_ROOT="$fixture_root"
export FIXTURE_CACHE_ROOT=${shellQuote(toWslPath(cacheRoot))}
export FIXTURE_SCENARIO="$scenario"
export FIXTURE_UNOWNED_PID="$unowned_pid"
export FIXTURE_IMAGE_SHA512='${sha512(BASE_IMAGE_CONTENTS)}'
export PALZIV_APPLIANCE_SSH_TIMEOUT_SECONDS=2
export PALZIV_APPLIANCE_SHUTDOWN_SSH_TIMEOUT_SECONDS=1
export PALZIV_APPLIANCE_COPY_TIMEOUT_SECONDS=1
export PALZIV_APPLIANCE_PROVISION_TIMEOUT_SECONDS=1
export PATH="$fixture_root/../bin:/usr/bin:/bin"
if [[ "$scenario" == 'missing-kvm' ]]; then export PALZIV_APPLIANCE_KVM_DEVICE=/dev/palziv-missing-kvm; fi
controller_args=(bash ${shellQuote(controller)} \
  --repository ${shellQuote(wslRepository)} \
  --build-root ${shellQuote(wslBuildRoot)} \
  --release-tar ${shellQuote(`${wslBuildRoot}/project-a-release.tar`)} \
  --release-sha ${shellQuote(RELEASE_SHA)} \
  --build-id ${shellQuote(BUILD_ID)} \
  --build-public-key ${shellQuote(`${wslBuildRoot}/build_ssh_ed25519.pub`)})
if [[ ${shellQuote(bootOnly ? "yes" : "no")} == 'yes' ]]; then controller_args+=(--boot-only); fi
legacy_qga_socket="/tmp/palziv-qga-${BUILD_ID}.sock"
legacy_qga_pid=''
if [[ "$scenario" == 'preexisting-qga' ]]; then
  python3 -c 'import socket,sys,time; sock=socket.socket(socket.AF_UNIX); sock.bind(sys.argv[1]); time.sleep(60)' "$legacy_qga_socket" &
  legacy_qga_pid="$!"
  for ((attempt=0; attempt<50; attempt++)); do [[ -S "$legacy_qga_socket" ]] && break; sleep 0.02; done
  [[ -S "$legacy_qga_socket" ]]
fi
if [[ "$scenario" == 'unowned-pid' || "$scenario" == 'substring-drive-pid' || "$scenario" == 'preexisting-qga' ]]; then
  set +e
  "${"$"}{controller_args[@]}"
  controller_status="$?"
  set -e
  if [[ "$scenario" == 'unowned-pid' ]] && kill -0 "$unowned_pid" 2>/dev/null; then
    printf 'alive\n' > "$fixture_root/unowned.alive"
  fi
  if [[ "$scenario" == 'substring-drive-pid' ]]; then
    substring_pid="$(<"$fixture_root/qemu.pid")"
    if kill -0 "$substring_pid" 2>/dev/null; then printf 'alive\n' > "$fixture_root/substring.alive"; fi
    kill -TERM "$substring_pid" 2>/dev/null || true
    wait "$substring_pid" 2>/dev/null || true
  fi
  if [[ "$scenario" == 'unowned-pid' ]]; then
    kill -TERM "$unowned_pid" 2>/dev/null || true
    wait "$unowned_pid" 2>/dev/null || true
  fi
  if [[ "$scenario" == 'preexisting-qga' ]]; then
    if [[ -S "$legacy_qga_socket" ]]; then printf 'preserved\n' > "$fixture_root/preexisting-qga.preserved"; fi
    kill -TERM "$legacy_qga_pid" 2>/dev/null || true
    wait "$legacy_qga_pid" 2>/dev/null || true
    rm -f -- "$legacy_qga_socket"
  fi
  exit "$controller_status"
fi
exec "${"$"}{controller_args[@]}"
`;
  const wrapperPath = path.join(fixtureRoot, "run-controller.sh");
  await writeFile(wrapperPath, wrapper);
  const startedAt = Date.now();
  const result = await runProcess("wsl.exe", [
    "--distribution", "Ubuntu-24.04",
    "--user", "root",
    "--",
    "bash", toWslPath(wrapperPath)
  ], 15000);
  const durationMs = Date.now() - startedAt;
  const readOptional = async (candidate) => (await pathExists(candidate)) ? readFile(candidate, "utf8") : "";
  return {
    base,
    repository,
    outputRoot,
    buildRoot,
    cacheRoot,
    fixtureRoot,
    result,
    durationMs,
    readLog: (name) => readOptional(path.join(fixtureRoot, name)),
    cleanup: () => rm(base, { recursive: true, force: true })
  };
}

function runPowerShell(args, { env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;

async function runWindowsEntrypointHarness({ scenario = "preflight" } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "palziv-appliance-powershell-"));
  const artifactRoot = path.join(base, "artifacts");
  let outputRoot = path.join(artifactRoot, "local-debian-appliance");
  const buildId = "20260805T120000Z-aaaaaaaaaaaa";
  let buildRoot = path.join(outputRoot, buildId);
  const logPath = path.join(base, "wsl.log");
  const nativeWslPath = path.join(base, "fixture-wsl.cmd");
  if (scenario === "relative-output") outputRoot = "relative-output";
  if (scenario === "equal-artifacts") outputRoot = artifactRoot;
  if (scenario === "outside-output") outputRoot = path.join(base, "outside-output");
  if (scenario === "reparse-output") {
    const outside = path.join(base, "outside-output");
    await mkdir(artifactRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(artifactRoot, "escape"), "junction");
    outputRoot = path.join(artifactRoot, "escape", "local-debian-appliance");
    buildRoot = path.join(outputRoot, buildId);
  }
  if (scenario === "existing-build") {
    await mkdir(buildRoot, { recursive: true });
    await writeFile(path.join(buildRoot, "operator-marker.txt"), "must survive\n");
  }
  if (scenario === "native-success") {
    await writeFile(nativeWslPath, String.raw`@echo off
setlocal DisableDelayedExpansion
set "command=%~6"
set "option=%~7"
set "windowsPath=%~8"
>> "%LOCAL_APPLIANCE_NATIVE_LOG%" echo --CALL--
:record
if "%~1"=="" goto recorded
>> "%LOCAL_APPLIANCE_NATIVE_LOG%" echo %~1
shift
goto record
:recorded
if /I "%command%"=="wslpath" (
  for %%I in ("%windowsPath%") do echo /fixture/%%~nxI
  exit /b 0
)
if /I "%command%"=="bash" if "%option%"=="-c" (
  > "%LOCAL_APPLIANCE_NATIVE_BUILD_ROOT%\build_ssh_ed25519" echo private-fixture
  > "%LOCAL_APPLIANCE_NATIVE_BUILD_ROOT%\build_ssh_ed25519.pub" echo public-fixture
)
exit /b 0
`);
  }

  const source = await readFile(
    new URL("../scripts/appliance/build-local-debian-appliance.ps1", import.meta.url),
    "utf8"
  );
  const invocationMarker = "Invoke-LocalDebianAppliance -WslDistribution $WslDistribution -ReleaseRef $ReleaseRef -OutputRoot $OutputRoot -PreflightOnly:$PreflightOnly -BootOnly:$BootOnly -RepositoryRoot $repositoryRoot";
  assert.equal(source.split(invocationMarker).length, 2, "entrypoint must expose one workflow invocation seam");
  const harnessInvocation = String.raw`
$fixtureRelease = {
  param([string]$RepositoryRoot, [string]$FixtureReleaseRef)
  if ($env:LOCAL_APPLIANCE_PS_SCENARIO -eq 'invalid-release') { return 'main' }
  return ('a' * 40)
}
$fixtureFree = {
  param([string]$FixtureOutputRoot)
  if ($env:LOCAL_APPLIANCE_PS_SCENARIO -eq 'low-space') { return [uint64](20GB - 1) }
  return [uint64](21GB)
}
$fixtureWsl = {
  param([string]$Distribution, [string[]]$Arguments, [string]$WslExecutable)
  Add-Content -LiteralPath ${psQuote(logPath)} -Value ("$Distribution|" + ($Arguments -join '|'))
  if ($Arguments[0] -eq 'test' -and $env:LOCAL_APPLIANCE_PS_SCENARIO -eq 'kvm-fail') {
    throw 'WSL command failed: test -c /dev/kvm'
  }
  if ($Arguments[0] -eq 'wslpath') {
    if ($env:LOCAL_APPLIANCE_PS_SCENARIO -eq 'real-wsl-keygen') {
      if ([System.IO.Path]::GetFileName($Arguments[2]) -eq 'build_ssh_ed25519') {
        return ${psQuote(`${toWslPath(buildRoot)}/build_ssh_ed25519`)}
      }
    }
    return "/fixture/$([System.IO.Path]::GetFileName($Arguments[2]))"
  }
  if ($Arguments[0] -eq 'bash' -and $Arguments[1] -eq '-c') {
    if ($env:LOCAL_APPLIANCE_PS_SCENARIO -eq 'real-wsl-keygen') {
      $nativeResult = & wsl.exe --distribution $Distribution --user root --exec @Arguments
      if ($LASTEXITCODE -ne 0) { throw 'Real WSL key generation failed.' }
      return $nativeResult
    }
    if ($Arguments -contains '') { throw 'Empty native argument reached WSL.' }
    if ($Arguments.Count -ne 5 -or $Arguments[3] -ne 'build-key') {
      throw 'SSH keygen WSL argument contract was malformed.'
    }
    Set-Content -LiteralPath (Join-Path ${psQuote(buildRoot)} 'build_ssh_ed25519') -Value 'private-fixture'
    Set-Content -LiteralPath (Join-Path ${psQuote(buildRoot)} 'build_ssh_ed25519.pub') -Value 'public-fixture'
    return @()
  }
  if ($Arguments[0] -eq 'bash') {
    switch ($env:LOCAL_APPLIANCE_PS_SCENARIO) {
      'boot-only' { return '{"ok":true,"classification":"boot-only","buildId":"20260805T120000Z-aaaaaaaaaaaa","releaseSha":"${RELEASE_SHA}","sshPort":22001}' }
      'boot-string-bool' { return '{"ok":"true","classification":"boot-only","buildId":"20260805T120000Z-aaaaaaaaaaaa","releaseSha":"${RELEASE_SHA}","sshPort":22001}' }
      'boot-bool-port' { return '{"ok":true,"classification":"boot-only","buildId":"20260805T120000Z-aaaaaaaaaaaa","releaseSha":"${RELEASE_SHA}","sshPort":true}' }
      'boot-fraction-port' { return '{"ok":true,"classification":"boot-only","buildId":"20260805T120000Z-aaaaaaaaaaaa","releaseSha":"${RELEASE_SHA}","sshPort":22000.5}' }
      'boot-port-low' { return '{"ok":true,"classification":"boot-only","buildId":"20260805T120000Z-aaaaaaaaaaaa","releaseSha":"${RELEASE_SHA}","sshPort":21999}' }
      'boot-port-high' { return '{"ok":true,"classification":"boot-only","buildId":"20260805T120000Z-aaaaaaaaaaaa","releaseSha":"${RELEASE_SHA}","sshPort":42001}' }
    }
    return @()
  }
  return @()
}
$fixtureBuildId = { return '20260805T120000Z-aaaaaaaaaaaa' }
$fixtureExport = {
  param([string]$RepositoryRoot, [string]$ReleaseSha, [string]$ReleaseTar)
  Set-Content -LiteralPath $ReleaseTar -Value "release=$ReleaseSha"
}
$fixturePreflight = $env:LOCAL_APPLIANCE_PS_SCENARIO -in @('preflight', 'invalid-release', 'low-space', 'relative-output', 'equal-artifacts', 'outside-output')
$fixtureBootOnly = $env:LOCAL_APPLIANCE_PS_SCENARIO -like 'boot-*'
$fixtureWslRunner = $fixtureWsl
$fixtureWslExecutable = 'wsl.exe'
$fixtureDistribution = 'Fixture-Ubuntu'
if ($env:LOCAL_APPLIANCE_PS_SCENARIO -eq 'real-wsl-keygen') { $fixtureDistribution = 'Ubuntu-24.04' }
if ($env:LOCAL_APPLIANCE_PS_SCENARIO -eq 'native-success') {
  $fixtureWslRunner = ${"$"}{function:Invoke-WslRoot}
  $fixtureWslExecutable = ${psQuote(nativeWslPath)}
  Invoke-LocalDebianAppliance -WslDistribution 'Fixture-Ubuntu' -ReleaseRef 'fixture' -OutputRoot ${psQuote(outputRoot)} -PreflightOnly:$fixturePreflight -BootOnly:$fixtureBootOnly -RepositoryRoot ${psQuote(base)} -ResolveReleaseSha $fixtureRelease -GetFreeBytes $fixtureFree -InvokeWslRoot $fixtureWslRunner -WslExecutable $fixtureWslExecutable -GetBuildId $fixtureBuildId -ExportRelease $fixtureExport
} else {
  Invoke-LocalDebianAppliance -WslDistribution $fixtureDistribution -ReleaseRef 'fixture' -OutputRoot ${psQuote(outputRoot)} -PreflightOnly:$fixturePreflight -BootOnly:$fixtureBootOnly -RepositoryRoot ${psQuote(base)} -ResolveReleaseSha $fixtureRelease -GetFreeBytes $fixtureFree -InvokeWslRoot $fixtureWslRunner -GetBuildId $fixtureBuildId -ExportRelease $fixtureExport
}
`;
  const harnessPath = path.join(base, "build-local-debian-appliance.ps1");
  await writeFile(harnessPath, source.replace(invocationMarker, harnessInvocation));
  const result = await runPowerShell([
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    harnessPath
  ], { env: {
    LOCAL_APPLIANCE_PS_SCENARIO: scenario,
    LOCAL_APPLIANCE_NATIVE_LOG: logPath,
    LOCAL_APPLIANCE_NATIVE_BUILD_ROOT: buildRoot
  } });
  let operations = [];
  try {
    operations = (await readFile(logPath, "utf8")).trim().split(/\r?\n/).filter(Boolean);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return {
    base,
    artifactRoot,
    outputRoot,
    buildRoot,
    cleanup: () => rm(base, { recursive: true, force: true }),
    operations,
    result
  };
}

async function writeFixture(root) {
  const diskName = `palziv-debian13-${RELEASE_SHA}.qcow2`;
  await writeFile(path.join(root, diskName), DISK_CONTENTS);
  await writeFile(path.join(root, "STAGE-SUCCESS.json"), `${JSON.stringify({
    schemaVersion: 1,
    phaseId: "project-a-two-phase-v1",
    classification: "staged",
    releaseSha: RELEASE_SHA,
    nodeVersion: "v24.18.0",
    app: "active",
    cloudflared: "disabled-inactive",
    routeCount: 8,
    completedAt: "2026-08-05T12:00:00Z"
  })}\n`);
  await writeFile(path.join(root, "age-recipient.txt"), `age1${"q".repeat(58)}\n`);
  await writeFile(path.join(root, "VERIFY-LOCAL.json"), '{"classification":"pass"}\n');
  await writeFile(path.join(root, "IMPORT-ON-PROXMOX.sh"), "#!/usr/bin/env bash\nexit 0\n");
  await writeFile(path.join(root, "README-FIRST.txt"), "fixture\n");
  await writeFile(path.join(root, "BUILD-MANIFEST.json"), `${JSON.stringify({
    schemaVersion: 1,
    buildId: "20260805T120000Z-aaaaaaaaaaaa",
    debianImage: {
      url: "https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2",
      sha512: "b".repeat(128),
      bytes: 342032384,
      retrievedAt: "2026-08-05T11:00:00Z"
    },
    releaseSha: RELEASE_SHA,
    nodeVersion: "v24.18.0",
    diskFile: diskName,
    diskSha256: sha256(DISK_CONTENTS),
    diskVirtualSize: 42949672960,
    diskActualSize: Buffer.byteLength(DISK_CONTENTS),
    completedAt: "2026-08-05T12:00:00Z",
    classification: "pass"
  })}\n`);

  const stageFiles = ["STAGE-SUCCESS.json", "age-recipient.txt"];
  await writeFile(path.join(root, "STAGE-SUCCESS.sha256"), `${(await Promise.all(stageFiles.map(async (name) => (
    `${sha256(await readFile(path.join(root, name)))}  ${name}`
  )))).join("\n")}\n`);

  const artifactFiles = [diskName, ...APPLIANCE_REQUIRED_FILES.filter((name) => name !== "ARTIFACTS.sha256")];
  await writeFile(path.join(root, "ARTIFACTS.sha256"), `${(await Promise.all(artifactFiles.map(async (name) => (
    `${sha256(await readFile(path.join(root, name)))}  ${name}`
  )))).join("\n")}\n`);
  return { diskName };
}

test("guest provisioning executes the release-owned Linux contract without production inputs", {
  skip: process.platform !== "win32" ? "WSL behavior fixture runs on Windows." : false
}, async () => {
  const harness = await runProvisioningHarness();
  try {
    assert.equal(harness.result.code, 0, harness.result.output);
    assert.doesNotMatch(harness.result.output, /AGE-SECRET-KEY|ADMIN_SETUP_TOKEN=/);
    assert.equal(await harness.readLinux(harness.logPath), [
      "prepare-host.sh",
      "install-node24.sh",
      "install-cloudflared.sh",
      "deploy-release.sh",
      ""
    ].join("\n"));

    const environment = await harness.readLinux(`${harness.fixtureRoot}/etc/palziv/palziv.env`);
    assert.match(environment, /^HOST=127\.0\.0\.1$/m);
    assert.match(environment, /^PORT=3116$/m);
    assert.match(environment, /^RUNTIME_DATA_DIR=\/var\/lib\/palziv\/data$/m);
    assert.match(environment, /^PUBLIC_BASE_URL=https:\/\/itotexpress\.com$/m);
    assert.match(environment, /^TRUST_PROXY_ADDRESSES=loopback$/m);
    assert.match(environment, /^ADMIN_MFA_ENABLED=true$/m);
    assert.match(environment, /^ADMIN_SETUP_TOKEN=[a-f0-9]{64}$/m);
    assert.match(environment, /^PUSH_ALLOWED_HOSTS=itotexpress\.com,www\.itotexpress\.com$/m);
    assert.doesNotMatch(environment, /production|password|credential|tunnel/i);

    assert.equal(await harness.readLinux(`${harness.logPath}.systemctl`), [
      "disable --now cloudflared.service",
      "enable --now palziv.service palziv-backup.timer palziv-health.timer",
      ""
    ].join("\n"));
    assert.equal(await harness.readLinux(`${harness.logPath}.apt-get`), "install -y age\n");
    const chownLog = await harness.readLinux(`${harness.logPath}.chown`);
    assert.match(chownLog, new RegExp(`^root:palziv ${harness.fixtureRoot}/etc/palziv/palziv\\.env$`, "m"));
    assert.match(chownLog, new RegExp(`^root:root ${harness.fixtureRoot}/etc/palziv/migration-age\\.key$`, "m"));

    const releaseCheck = await runWsl(`test \"$(realpath -e -- ${shellQuote(`${harness.fixtureRoot}/opt/palziv/current`)})\" = ${shellQuote(`${harness.fixtureRoot}/opt/palziv/releases/${RELEASE_SHA}`)} && stat -Lc '%u:%a' ${shellQuote(`${harness.fixtureRoot}/etc/palziv/palziv.env`)} && stat -Lc '%u:%a' ${shellQuote(`${harness.fixtureRoot}/etc/palziv/migration-age.key`)} && test ! -e ${shellQuote(harness.releaseStage)}`);
    assert.equal(releaseCheck.code, 0, releaseCheck.output);
    assert.equal(releaseCheck.output, "0:640\n0:600\n");
    assert.equal(await harness.readLinux(`${harness.fixtureRoot}/opt/palziv/releases/${RELEASE_SHA}/package.json`), '{"name":"fixture-release"}\n');
    assert.equal(await harness.readLinux(`${harness.fixtureRoot}/etc/palziv/migration-age.key`), "AGE-SECRET-KEY-1FIXTURE\n");
  } finally {
    await harness.cleanup();
  }
});

test("guest provisioning rejects invalid identity, extra inputs, and every unsafe archive member before helper execution", {
  skip: process.platform !== "win32" ? "WSL behavior fixture runs on Windows." : false
}, async (t) => {
  for (const fixture of [
    { name: "invalid release SHA", options: { releaseSha: "main" }, message: /Invalid release SHA/i },
    { name: "extra production input", options: { extraArguments: ["/tmp/production.env"] }, message: /exactly two arguments/i },
    { name: "unsafe archive path", options: { archiveScenario: "unsafe-path" }, message: /Unsafe release archive path/i },
    { name: "backslash traversal", options: { archiveScenario: "backslash-path" }, message: /Unsafe release archive path/i },
    { name: "symbolic link", options: { archiveScenario: "link" }, message: /links are not allowed/i },
    { name: "hard link", options: { archiveScenario: "hard-link" }, message: /links are not allowed/i },
    { name: "FIFO", options: { archiveScenario: "fifo" }, message: /regular files or directories/i },
    { name: "device node", options: { archiveScenario: "device" }, message: /regular files or directories/i }
  ]) {
    await t.test(fixture.name, async () => {
      const harness = await runProvisioningHarness(fixture.options);
      try {
        assert.notEqual(harness.result.code, 0);
        assert.match(harness.result.output, fixture.message);
        assert.equal(await harness.readLinux(harness.logPath), "");
        assert.equal(await pathExists(path.join(harness.base, "escaped")), false);
      } finally {
        await harness.cleanup();
      }
    });
  }

  await t.test("non-root caller", async () => {
    const provisioner = toWslPath(path.resolve("scripts/appliance/provision-debian-appliance.sh"));
    const result = await runWsl(`setpriv --reuid=65534 --regid=65534 --clear-groups bash ${shellQuote(provisioner)} /tmp/release.tar ${RELEASE_SHA}`);
    assert.notEqual(result.code, 0);
    assert.match(result.output, /Run as root/i);
  });

  await t.test("cleanup preserves a substituted non-root staging directory", async () => {
    const harness = await runProvisioningHarness({ helperScenario: "replace-cleanup-root" });
    try {
      assert.notEqual(harness.result.code, 0);
      assert.match(harness.releaseStage, /^\/var\/tmp\/palziv-appliance-release\./);
      const preserved = await runWsl(`test \"$(cat -- ${shellQuote(`${harness.releaseStage}/operator-marker.txt`)})\" = preserve-replacement && stat -Lc '%u:%a' ${shellQuote(harness.releaseStage)}`);
      assert.equal(preserved.code, 0, preserved.output);
      assert.equal(preserved.output, "65534:700\n");
    } finally {
      await harness.cleanup();
    }
  });
});

test("WSL controller provisions only outside boot-only mode over pinned SSH and records bounded failure state", {
  skip: process.platform !== "win32" ? "WSL behavior fixture runs on Windows." : false
}, async (t) => {
  await t.test("provisioning success", async (t) => {
    const harness = await runBashControllerHarness({ bootOnly: false });
    try {
      assert.equal(harness.result.code, 0, harness.result.output);
      assert.doesNotMatch(harness.result.output, /AGE-SECRET-KEY|ADMIN_SETUP_TOKEN/);
      assert.deepEqual(JSON.parse(harness.result.output), {
        ok: true,
        classification: "provisioned",
        buildId: BUILD_ID,
        releaseSha: RELEASE_SHA,
        sshPort: 22001
      });
      const scpLog = await harness.readLog("scp.log");
      assert.match(scpLog, /-P 22001/);
      assert.match(scpLog, /StrictHostKeyChecking=yes/);
      assert.match(scpLog, /UserKnownHostsFile=/);
      assert.match(scpLog, /project-a-release\.tar/);
      assert.match(scpLog, /provision-debian-appliance\.sh/);
      assert.match(scpLog, new RegExp(`palziv-build@127\\.0\\.0\\.1:/var/tmp/palziv-appliance-upload-${BUILD_ID}/$`, "m"));
      const sshLog = await harness.readLog("ssh.log");
      assert.match(sshLog, new RegExp(`mkdir -m 0700 -- /var/tmp/palziv-appliance-upload-${BUILD_ID}`));
      assert.match(sshLog, new RegExp(`sudo mkdir -m 0700 -- /var/tmp/palziv-appliance-stage-${BUILD_ID}`));
      assert.match(sshLog, /sudo bash -s --/);
      assert.match(sshLog, /StrictHostKeyChecking=yes/);
      assert.match(sshLog, new RegExp(sha256(await readFile(path.join(harness.buildRoot, "project-a-release.tar")))));
      assert.match(sshLog, new RegExp(sha256(await readFile(path.resolve("scripts/appliance/provision-debian-appliance.sh")))));
      const snapshotScript = await harness.readLog("provision-stdin.log");
      assert.match(snapshotScript, /mv -- .*project-a-release\.tar.*release\.tar/);
      assert.match(snapshotScript, /chown root:root/);
      assert.match(snapshotScript, /chmod 0600/);
      assert.match(snapshotScript, /sha256sum --check --strict/);
      assert.match(snapshotScript, /bash .*provision-debian-appliance\.sh.*release\.tar/);
      const snapshotFixtureId = `${process.pid}-${Date.now()}`;
      const snapshotScriptPath = path.join(harness.base, "root-snapshot.sh");
      const snapshotProvisionerPath = path.join(harness.base, "snapshot-provisioner.sh");
      const snapshotUpload = `/var/tmp/palziv-appliance-upload-fixture-${snapshotFixtureId}`;
      const snapshotStage = `/var/tmp/palziv-appliance-stage-fixture-${snapshotFixtureId}`;
      const snapshotMarker = `/tmp/palziv-appliance-snapshot-marker-${snapshotFixtureId}`;
      t.after(async () => {
        await runWsl(`rm -rf -- ${shellQuote(snapshotUpload)} ${shellQuote(`${snapshotUpload}-bad`)} ${shellQuote(snapshotStage)} ${shellQuote(`${snapshotStage}-bad`)}; rm -f -- ${shellQuote(snapshotMarker)} ${shellQuote(`${snapshotMarker}-bad`)}`);
      });
      await writeFile(snapshotScriptPath, snapshotScript);
      await writeFile(snapshotProvisionerPath, String.raw`#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s|%s|%s|%s\n' "$1" "$2" "$(stat -Lc '%u:%a' -- "$0")" "$(stat -Lc '%u:%a' -- "$1")" > "$PALZIV_SNAPSHOT_MARKER"
`);
      const snapshotReleaseDigest = sha256(await readFile(path.join(harness.buildRoot, "project-a-release.tar")));
      const snapshotProvisionerDigest = sha256(await readFile(snapshotProvisionerPath));
      const setupSnapshotFixture = async (upload, stage) => runWsl(`mkdir -m 0700 -- ${shellQuote(upload)}; mkdir -m 0700 -- ${shellQuote(stage)}; chown root:root ${shellQuote(stage)}; cp -- ${shellQuote(toWslPath(path.join(harness.buildRoot, "project-a-release.tar")))} ${shellQuote(`${upload}/project-a-release.tar`)}; cp -- ${shellQuote(toWslPath(snapshotProvisionerPath))} ${shellQuote(`${upload}/provision-debian-appliance.sh`)}`);
      const validSetup = await setupSnapshotFixture(snapshotUpload, snapshotStage);
      assert.equal(validSetup.code, 0, validSetup.output);
      const snapshotRun = await runWsl(`export PALZIV_SNAPSHOT_MARKER=${shellQuote(snapshotMarker)}; bash ${shellQuote(toWslPath(snapshotScriptPath))} ${shellQuote(snapshotUpload)} ${shellQuote(snapshotStage)} ${snapshotReleaseDigest} ${snapshotProvisionerDigest} ${RELEASE_SHA}`);
      assert.equal(snapshotRun.code, 0, snapshotRun.output);
      const snapshotEvidence = await runWsl(`cat -- ${shellQuote(snapshotMarker)}; test ! -e ${shellQuote(snapshotUpload)}; test ! -e ${shellQuote(snapshotStage)}`);
      assert.equal(snapshotEvidence.code, 0, snapshotEvidence.output);
      assert.equal(snapshotEvidence.output, `${snapshotStage}/release.tar|${RELEASE_SHA}|0:600|0:600\n`);

      const badUpload = `${snapshotUpload}-bad`;
      const badStage = `${snapshotStage}-bad`;
      const badMarker = `${snapshotMarker}-bad`;
      const badSetup = await setupSnapshotFixture(badUpload, badStage);
      assert.equal(badSetup.code, 0, badSetup.output);
      const rejectedSnapshot = await runWsl(`export PALZIV_SNAPSHOT_MARKER=${shellQuote(badMarker)}; bash ${shellQuote(toWslPath(snapshotScriptPath))} ${shellQuote(badUpload)} ${shellQuote(badStage)} ${"0".repeat(64)} ${snapshotProvisionerDigest} ${RELEASE_SHA}`);
      assert.notEqual(rejectedSnapshot.code, 0);
      const rejectionEvidence = await runWsl(`test ! -e ${shellQuote(badMarker)}; test ! -e ${shellQuote(badUpload)}; test ! -e ${shellQuote(badStage)}; rm -f -- ${shellQuote(snapshotMarker)}`);
      assert.equal(rejectionEvidence.code, 0, rejectionEvidence.output);
      const transferOperations = (await harness.readLog("transfer-operations.log")).trim().split(/\r?\n/);
      assert.equal(transferOperations.length, 4);
      assert.match(transferOperations[0], /^ssh .*palziv-appliance-upload-/);
      assert.match(transferOperations[1], /^scp /);
      assert.match(transferOperations[2], /^ssh .*sudo bash -s --/);
      assert.match(transferOperations[3], /^ssh .*systemctl poweroff/);
      const state = JSON.parse(await readFile(path.join(harness.buildRoot, "BUILD-STATE.json"), "utf8"));
      assert.equal(state.classification, "provisioned");
      assert.equal(await pathExists(path.join(harness.buildRoot, `palziv-debian13-${RELEASE_SHA}.qcow2`)), false);
    } finally {
      await harness.cleanup();
    }
  });

  await t.test("remote provisioning failure", async () => {
    const harness = await runBashControllerHarness({ bootOnly: false, scenario: "provision-failure" });
    try {
      assert.notEqual(harness.result.code, 0);
      assert.doesNotMatch(harness.result.output, /AGE-SECRET-KEY|ADMIN_SETUP_TOKEN/);
      const state = JSON.parse(await readFile(path.join(harness.buildRoot, "BUILD-STATE.json"), "utf8"));
      assert.equal(state.classification, "failed");
      assert.equal(state.operation, "provision-guest");
      assert.equal(state.exitCode, 42);
      assert.match(state.failedAtUtc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      assert.equal(await pathExists(path.join(harness.buildRoot, `palziv-debian13-${RELEASE_SHA}.qcow2`)), false);
    } finally {
      await harness.cleanup();
    }
  });

  await t.test("secure-copy failure", async () => {
    const harness = await runBashControllerHarness({ bootOnly: false, scenario: "scp-failure" });
    try {
      assert.notEqual(harness.result.code, 0);
      const state = JSON.parse(await readFile(path.join(harness.buildRoot, "BUILD-STATE.json"), "utf8"));
      assert.equal(state.classification, "failed");
      assert.equal(state.operation, "copy-provisioning-inputs");
      assert.equal(state.exitCode, 41);
      assert.match(state.failedAtUtc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      assert.equal(await harness.readLog("provision-stdin.log"), "", "remote provisioning must not run after a failed copy");
      assert.match(await harness.readLog("ssh.log"), /sudo mkdir -m 0700 -- \/var\/tmp\/palziv-appliance-stage-/);
      assert.equal(await pathExists(path.join(harness.buildRoot, `palziv-debian13-${RELEASE_SHA}.qcow2`)), false);
    } finally {
      await harness.cleanup();
    }
  });

  await t.test("hanging secure copy", async () => {
    const harness = await runBashControllerHarness({ bootOnly: false, scenario: "hanging-scp" });
    try {
      assert.notEqual(harness.result.code, 0);
      assert.ok(harness.durationMs < 5500, `SCP timeout took ${harness.durationMs}ms`);
      const state = JSON.parse(await readFile(path.join(harness.buildRoot, "BUILD-STATE.json"), "utf8"));
      assert.equal(state.classification, "failed");
      assert.equal(state.operation, "copy-provisioning-inputs");
      assert.ok([124, 137].includes(state.exitCode));
      assert.equal(await harness.readLog("provision-stdin.log"), "");
    } finally {
      await harness.cleanup();
    }
  });

  await t.test("provisioning timeout", async () => {
    const harness = await runBashControllerHarness({ bootOnly: false, scenario: "provision-timeout" });
    try {
      assert.notEqual(harness.result.code, 0);
      assert.ok(harness.durationMs < 5500, `provision timeout took ${harness.durationMs}ms`);
      assert.doesNotMatch(harness.result.output, /AGE-SECRET-KEY|ADMIN_SETUP_TOKEN/);
      const state = JSON.parse(await readFile(path.join(harness.buildRoot, "BUILD-STATE.json"), "utf8"));
      assert.equal(state.classification, "failed");
      assert.equal(state.operation, "provision-guest");
      assert.ok([124, 137].includes(state.exitCode));
    } finally {
      await harness.cleanup();
    }
  });

  await t.test("active-mode shutdown failure", async () => {
    const harness = await runBashControllerHarness({ bootOnly: false, scenario: "active-shutdown-failure" });
    try {
      assert.notEqual(harness.result.code, 0);
      assert.match(harness.result.output, /Provisioned guest shutdown command failed/i);
      assert.doesNotMatch(harness.result.output, /Boot-only guest shutdown/i);
      const state = JSON.parse(await readFile(path.join(harness.buildRoot, "BUILD-STATE.json"), "utf8"));
      assert.equal(state.classification, "failed");
      assert.equal(state.operation, "shutdown-provisioned-guest");
      assert.equal(state.exitCode, 43);
    } finally {
      await harness.cleanup();
    }
  });
});

test("artifact disk name is derived only from the release SHA", () => {
  assert.equal(artifactDiskName(RELEASE_SHA), `palziv-debian13-${RELEASE_SHA}.qcow2`);
  assert.throws(() => artifactDiskName("main"), /40-character release SHA/i);
});

test("build manifest accepts only the pinned appliance schema", () => {
  const manifest = {
    schemaVersion: APPLIANCE_SCHEMA_VERSION,
    buildId: "20260805T120000Z-aaaaaaaaaaaa",
    debianImage: {
      url: "https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2",
      sha512: "b".repeat(128),
      bytes: 1,
      retrievedAt: "2026-08-05T11:00:00Z"
    },
    releaseSha: RELEASE_SHA,
    nodeVersion: "v24.18.0",
    diskFile: `palziv-debian13-${RELEASE_SHA}.qcow2`,
    diskSha256: "c".repeat(64),
    diskVirtualSize: 42949672960,
    diskActualSize: 1,
    completedAt: "2026-08-05T12:00:00Z",
    classification: "pass"
  };
  assert.equal(validateBuildManifest(manifest), manifest);
  assert.throws(() => validateBuildManifest({ ...manifest, diskFile: "palziv-debian13-main.qcow2" }), /contract/i);
});

test("artifact verifier accepts the exact successful tree and rejects disk tampering", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "palziv-appliance-"));
  try {
    const { diskName } = await writeFixture(root);
    assert.deepEqual(
      await verifyApplianceArtifacts({ artifactRoot: root }),
      { ok: true, releaseSha: RELEASE_SHA, diskFile: diskName, diskSha256: sha256(DISK_CONTENTS) }
    );
    await writeFile(path.join(root, diskName), "changed-qcow2");
    await assert.rejects(verifyApplianceArtifacts({ artifactRoot: root }), /checksum/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact verifier rejects a build manifest whose diskActualSize differs from the QCOW2", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "palziv-appliance-"));
  try {
    await writeFixture(root);
    const manifestPath = path.join(root, "BUILD-MANIFEST.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.diskActualSize += 1;
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await assert.rejects(verifyApplianceArtifacts({ artifactRoot: root }), /actual size/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact verifier rejects no-clobber residue and malformed checksum manifests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "palziv-appliance-"));
  try {
    await writeFixture(root);
    await writeFile(path.join(root, ".BUILD-MANIFEST.json.partial"), "incomplete\n");
    await assert.rejects(verifyApplianceArtifacts({ artifactRoot: root }), /unexpected artifact root tree/i);
    await rm(path.join(root, ".BUILD-MANIFEST.json.partial"));
    await writeFile(path.join(root, "ARTIFACTS.sha256"), "not a manifest\n");
    await assert.rejects(verifyApplianceArtifacts({ artifactRoot: root }), /checksum manifest/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact verifier validates the bounded stage receipt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "palziv-appliance-"));
  try {
    await writeFixture(root);
    const receiptPath = path.join(root, "STAGE-SUCCESS.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    receipt.routeCount = 9;
    await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
    await assert.rejects(verifyApplianceArtifacts({ artifactRoot: root }), /stage receipt/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact verifier rejects a linked build manifest before it can be dereferenced", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "palziv-appliance-"));
  const fifo = path.join(os.tmpdir(), `palziv-appliance-manifest-${process.pid}-${Date.now()}`);
  try {
    await writeFixture(root);
    await runProcess("mkfifo", [fifo]);
    await rm(path.join(root, "BUILD-MANIFEST.json"));
    await symlink(fifo, path.join(root, "BUILD-MANIFEST.json"), "file");
    const result = await runProcess(process.execPath, ["scripts/appliance/verify-local-appliance.mjs", root]);
    assert.notEqual(result.code, 0);
    assert.match(result.output, /BUILD-MANIFEST\.json must not be a symbolic link/i);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(fifo, { force: true });
  }
});

test("Windows preflight returns bounded JSON without creating output or invoking the controller", {
  skip: process.platform !== "win32" ? "PowerShell behavior harness runs on Windows." : false
}, async () => {
  const harness = await runWindowsEntrypointHarness();
  try {
    assert.equal(harness.result.code, 0, harness.result.stderr);
    assert.equal(harness.result.stderr.trim(), "", harness.result.stderr);
    assert.deepEqual(JSON.parse(harness.result.stdout), {
      ok: true,
      distribution: "Fixture-Ubuntu",
      kvm: "available",
      freeBytes: 21 * 1024 * 1024 * 1024,
      releaseSha: RELEASE_SHA
    });
    await assert.rejects(readdir(harness.outputRoot), { code: "ENOENT" });
    assert.deepEqual(harness.operations, ["Fixture-Ubuntu|test|-c|/dev/kvm"]);
  } finally {
    await harness.cleanup();
  }
});

test("Windows entrypoint fails closed before WSL for an invalid release or insufficient space", {
  skip: process.platform !== "win32" ? "PowerShell behavior harness runs on Windows." : false
}, async (t) => {
  for (const [scenario, expectedError] of [
    ["invalid-release", /ReleaseRef did not resolve/i],
    ["low-space", /At least 20 GiB/i]
  ]) {
    await t.test(scenario, async () => {
      const harness = await runWindowsEntrypointHarness({ scenario });
      try {
        assert.notEqual(harness.result.code, 0);
        assert.match(harness.result.stderr, expectedError);
        assert.deepEqual(harness.operations, []);
        await assert.rejects(readdir(harness.outputRoot), { code: "ENOENT" });
      } finally {
        await harness.cleanup();
      }
    });
  }
});

test("Windows entrypoint preserves an existing build directory instead of clobbering it", {
  skip: process.platform !== "win32" ? "PowerShell behavior harness runs on Windows." : false
}, async () => {
  const harness = await runWindowsEntrypointHarness({ scenario: "existing-build" });
  try {
    assert.notEqual(harness.result.code, 0);
    assert.match(harness.result.stderr, /Build directory already exists/i);
    assert.equal(await readFile(path.join(harness.buildRoot, "operator-marker.txt"), "utf8"), "must survive\n");
    assert.deepEqual(harness.operations, ["Fixture-Ubuntu|test|-c|/dev/kvm"]);
  } finally {
    await harness.cleanup();
  }
});

test("Windows entrypoint rejects unsafe output roots before KVM or output creation", {
  skip: process.platform !== "win32" ? "PowerShell behavior harness runs on Windows." : false
}, async (t) => {
  for (const [scenario, expectedError] of [
    ["relative-output", /absolute.*artifacts/i],
    ["equal-artifacts", /strict descendant/i],
    ["outside-output", /strict descendant/i],
    ["reparse-output", /reparse point/i]
  ]) {
    await t.test(scenario, async () => {
      const harness = await runWindowsEntrypointHarness({ scenario });
      try {
        assert.notEqual(harness.result.code, 0);
        assert.match(harness.result.stderr, expectedError);
        assert.deepEqual(harness.operations, []);
        await assert.rejects(readdir(harness.outputRoot), { code: "ENOENT" });
      } finally {
        await harness.cleanup();
      }
    });
  }
});

test("Windows entrypoint stops before output creation when WSL KVM preflight fails", {
  skip: process.platform !== "win32" ? "PowerShell behavior harness runs on Windows." : false
}, async () => {
  const harness = await runWindowsEntrypointHarness({ scenario: "kvm-fail" });
  try {
    assert.notEqual(harness.result.code, 0);
    assert.match(harness.result.stderr, /WSL command failed: test -c \/dev\/kvm/i);
    assert.deepEqual(harness.operations, ["Fixture-Ubuntu|test|-c|/dev/kvm"]);
    await assert.rejects(readdir(harness.outputRoot), { code: "ENOENT" });
  } finally {
    await harness.cleanup();
  }
});

test("Windows entrypoint exports only the release, creates the ephemeral key, and passes exact WSL controller arguments", {
  skip: process.platform !== "win32" ? "PowerShell behavior harness runs on Windows." : false
}, async () => {
  const harness = await runWindowsEntrypointHarness({ scenario: "full-success" });
  try {
    assert.equal(harness.result.code, 0, harness.result.stderr);
    assert.equal(harness.result.stdout, "");
    assert.equal(harness.result.stderr, "");
    assert.deepEqual((await readdir(harness.buildRoot)).sort(), [
      "build_ssh_ed25519",
      "build_ssh_ed25519.pub",
      "project-a-release.tar"
    ]);
    assert.equal(await readFile(path.join(harness.buildRoot, "project-a-release.tar"), "utf8"), `release=${RELEASE_SHA}\r\n`);
    const operations = harness.operations.map((entry) => entry.split("|"));
    assert.deepEqual(operations[0], ["Fixture-Ubuntu", "test", "-c", "/dev/kvm"]);
    assert.deepEqual(operations[2], [
      "Fixture-Ubuntu",
      "bash",
      "-c",
      SSH_KEYGEN_COMMAND,
      "build-key",
      "/fixture/build_ssh_ed25519"
    ]);
    assert.ok(operations[2].every(Boolean), "PowerShell 5.1 must not pass an empty native argument");
    assert.deepEqual(operations.at(-1), [
      "Fixture-Ubuntu",
      "bash",
      "/fixture/build-local-debian-appliance.sh",
      "--repository",
      `/fixture/${path.basename(harness.base)}`,
      "--build-root",
      `/fixture/${path.basename(harness.buildRoot)}`,
      "--release-tar",
      "/fixture/project-a-release.tar",
      "--release-sha",
      RELEASE_SHA,
      "--build-id",
      "20260805T120000Z-aaaaaaaaaaaa",
      "--build-public-key",
      "/fixture/build_ssh_ed25519.pub"
    ]);
  } finally {
    await harness.cleanup();
  }
});

test("Windows boot-only entrypoint validates and returns the controller's bounded result", {
  skip: process.platform !== "win32" ? "PowerShell behavior harness runs on Windows." : false
}, async () => {
  const harness = await runWindowsEntrypointHarness({ scenario: "boot-only" });
  try {
    assert.equal(harness.result.code, 0, harness.result.stderr);
    assert.equal(harness.result.stderr, "");
    assert.deepEqual(JSON.parse(harness.result.stdout), {
      ok: true,
      classification: "boot-only",
      buildId: BUILD_ID,
      releaseSha: RELEASE_SHA,
      sshPort: 22001
    });
    assert.equal(harness.result.stdout.length < 512, true);
    assert.equal(harness.operations.at(-1).split("|").at(-1), "--boot-only");
  } finally {
    await harness.cleanup();
  }
});

test("Windows boot-only entrypoint rejects coerced JSON types and out-of-contract ports", {
  skip: process.platform !== "win32" ? "PowerShell behavior harness runs on Windows." : false
}, async (t) => {
  for (const scenario of [
    "boot-string-bool",
    "boot-bool-port",
    "boot-fraction-port",
    "boot-port-low",
    "boot-port-high"
  ]) {
    await t.test(scenario, async () => {
      const harness = await runWindowsEntrypointHarness({ scenario });
      try {
        assert.notEqual(harness.result.code, 0);
        assert.match(harness.result.stderr, /bounded schema|did not match this build/i);
      } finally {
        await harness.cleanup();
      }
    });
  }
});

test("Windows PowerShell 5.1 build IDs use UTC without unsupported Get-Date parameters", {
  skip: process.platform !== "win32" ? "PowerShell behavior harness runs on Windows." : false
}, async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "palziv-appliance-build-id-"));
  try {
    const scriptRoot = path.join(base, "scripts", "appliance");
    await mkdir(scriptRoot, { recursive: true });
    const source = await readFile(
      new URL("../scripts/appliance/build-local-debian-appliance.ps1", import.meta.url),
      "utf8"
    );
    const invocationMarker = "Invoke-LocalDebianAppliance -WslDistribution $WslDistribution -ReleaseRef $ReleaseRef -OutputRoot $OutputRoot -PreflightOnly:$PreflightOnly -BootOnly:$BootOnly -RepositoryRoot $repositoryRoot";
    const harnessPath = path.join(scriptRoot, "build-id.ps1");
    await writeFile(harnessPath, source.replace(invocationMarker, "New-LocalApplianceBuildId ('a' * 40)"));
    const result = await runPowerShell([
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harnessPath
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout.trim(), /^\d{8}T\d{6}Z-aaaaaaaaaaaa$/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("Windows PowerShell 5.1 converts a real drive path through WSL without losing separators", {
  skip: process.platform !== "win32" ? "PowerShell and WSL behavior harness runs on Windows." : false
}, async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "palziv-appliance-wslpath-"));
  try {
    const scriptRoot = path.join(base, "scripts", "appliance");
    await mkdir(scriptRoot, { recursive: true });
    const source = await readFile(
      new URL("../scripts/appliance/build-local-debian-appliance.ps1", import.meta.url),
      "utf8"
    );
    const invocationMarker = "Invoke-LocalDebianAppliance -WslDistribution $WslDistribution -ReleaseRef $ReleaseRef -OutputRoot $OutputRoot -PreflightOnly:$PreflightOnly -BootOnly:$BootOnly -RepositoryRoot $repositoryRoot";
    const invocation = `ConvertTo-WslAbsolutePath ${psQuote(base)} 'Ubuntu-24.04' ${"$"}{function:Invoke-WslRoot} 'wsl.exe'`;
    const harnessPath = path.join(scriptRoot, "wslpath.ps1");
    await writeFile(harnessPath, source.replace(invocationMarker, invocation));
    const result = await runPowerShell([
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harnessPath
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.trim(), toWslPath(base));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("Windows PowerShell 5.1 preserves Bash positional arguments through real WSL exec", {
  skip: process.platform !== "win32" ? "PowerShell and WSL behavior harness runs on Windows." : false
}, async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "palziv-appliance-real-keygen-"));
  try {
    const scriptRoot = path.join(base, "scripts", "appliance");
    await mkdir(scriptRoot, { recursive: true });
    const source = await readFile(
      new URL("../scripts/appliance/build-local-debian-appliance.ps1", import.meta.url),
      "utf8"
    );
    const invocationMarker = "Invoke-LocalDebianAppliance -WslDistribution $WslDistribution -ReleaseRef $ReleaseRef -OutputRoot $OutputRoot -PreflightOnly:$PreflightOnly -BootOnly:$BootOnly -RepositoryRoot $repositoryRoot";
    const marker = path.join(base, "positional-marker");
    const command = 'exec touch $1';
    const invocation = `Invoke-WslRoot -Distribution 'Ubuntu-24.04' -Arguments @('bash', '-c', ${psQuote(command)}, 'touch-marker', ${psQuote(toWslPath(marker))}) -WslExecutable 'wsl.exe'`;
    const harnessPath = path.join(scriptRoot, "real-keygen.ps1");
    await writeFile(harnessPath, source.replace(invocationMarker, invocation));
    const result = await runPowerShell([
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harnessPath
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(await pathExists(marker), true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("Windows PowerShell 5.1 creates the ephemeral key through real WSL without exposing an empty native argument", {
  skip: process.platform !== "win32" ? "PowerShell and WSL behavior harness runs on Windows." : false
}, async () => {
  const harness = await runWindowsEntrypointHarness({ scenario: "real-wsl-keygen" });
  try {
    assert.equal(harness.result.code, 0, `${harness.result.stderr}\n${JSON.stringify(harness.operations)}`);
    assert.equal(harness.result.stderr, "");
    assert.equal(await pathExists(path.join(harness.buildRoot, "build_ssh_ed25519")), true);
    assert.match(await readFile(path.join(harness.buildRoot, "build_ssh_ed25519.pub"), "utf8"), /^ssh-ed25519 /);
    const keygenOperation = harness.operations.map((entry) => entry.split("|")).find((entry) => entry[1] === "bash" && entry[2] === "-c");
    assert.ok(keygenOperation.every(Boolean), "PowerShell 5.1 must not pass an empty native argument");
  } finally {
    await harness.cleanup();
  }
});

test("Windows PowerShell 5.1 passes the SSH keygen shell contract to the native WSL executable without an empty argument", {
  skip: process.platform !== "win32" ? "PowerShell behavior harness runs on Windows." : false
}, async () => {
  const harness = await runWindowsEntrypointHarness({ scenario: "native-success" });
  try {
    assert.equal(harness.result.code, 0, harness.result.stderr);
    const calls = [];
    for (const entry of harness.operations) {
      if (entry === "--CALL--") calls.push([]);
      else calls.at(-1).push(entry);
    }
    const keygenCall = calls.find((call) => call[5] === "bash" && call[6] === "-c");
    assert.deepEqual(keygenCall, [
      "--distribution",
      "Fixture-Ubuntu",
      "--user",
      "root",
      "--exec",
      "bash",
      "-c",
      SSH_KEYGEN_COMMAND,
      "build-key",
      "/fixture/build_ssh_ed25519"
    ]);
    assert.ok(keygenCall.every(Boolean));
    assert.equal(await readFile(path.join(harness.buildRoot, "build_ssh_ed25519.pub"), "utf8"), "public-fixture\r\n");
  } finally {
    await harness.cleanup();
  }
});

test("WSL controller verifies Debian, boots through KVM, and exposes SSH only on loopback", {
  skip: process.platform !== "win32" ? "WSL behavior fixture runs on Windows." : false
}, async () => {
  const harness = await runBashControllerHarness();
  try {
    assert.equal(harness.result.code, 0, harness.result.output);
    assert.ok(harness.result.output.length < 2048, "controller output must remain bounded");
    assert.match(harness.result.output, /^\{"ok":true,"classification":"boot-only","buildId":"[^"]+","releaseSha":"[a-f0-9]{40}","sshPort":[0-9]+\}\r?\n?$/, "controller stdout must contain only its result JSON");
    const result = JSON.parse(harness.result.output);
    assert.deepEqual(result, {
      ok: true,
      classification: "boot-only",
      buildId: BUILD_ID,
      releaseSha: RELEASE_SHA,
      sshPort: 22001
    });

    assert.equal(await readFile(path.join(harness.cacheRoot, BASE_IMAGE_NAME), "utf8"), BASE_IMAGE_CONTENTS);
    const qemuArguments = (await harness.readLog("qemu.log")).trim().split(/\r?\n/);
    assert.ok(qemuArguments.includes("-accel") && qemuArguments.includes("kvm"));
    assert.ok(qemuArguments.includes("-machine") && qemuArguments.includes("q35"));
    assert.ok(qemuArguments.some((argument) => argument.includes("name=org.qemu.guest_agent.0")));
    assert.ok(qemuArguments.includes("user,id=net0,hostfwd=tcp:127.0.0.1:22001-:22"));
    assert.ok(qemuArguments.every((argument) => !argument.includes("hostfwd=tcp:0.0.0.0")));
    const chardev = qemuArguments.find((argument) => argument.startsWith("socket,path="));
    const qgaSocket = /path=([^,]+)/.exec(chardev)?.[1];
    assert.ok(qgaSocket, "QEMU guest-agent socket path must be explicit");
    assert.ok(Buffer.byteLength(qgaSocket) < 108, "QEMU guest-agent socket path must fit sockaddr_un");
    const qemuImg = await harness.readLog("qemu-img.log");
    assert.match(qemuImg, /create -f qcow2 -F qcow2 -b .*work\/base-image\.qcow2 .*work-disk\.qcow2 40G/);
    const curlLog = await harness.readLog("curl.log");
    for (const requiredOption of ["--connect-timeout 15", "--max-time 900", "--retry 3", "--retry-max-time 120"]) {
      assert.match(curlLog, new RegExp(requiredOption), `curl must include ${requiredOption}`);
    }
    assert.equal((await harness.readLog("apt-get.log")).trim(), [
      "update",
      "install -y ca-certificates cloud-image-utils curl jq openssh-client qemu-system-x86 qemu-utils"
    ].join("\n"));
    assert.match(await harness.readLog("ssh.log"), /StrictHostKeyChecking=yes/);
    assert.match(await harness.readLog("ssh.log"), /UserKnownHostsFile=/);
    assert.equal(await harness.readLog("scp.log"), "", "boot-only mode must not copy provisioning inputs");
    assert.match(await readFile(path.join(harness.buildRoot, "known_hosts"), "utf8"), /^\[127\.0\.0\.1\]:22001 ssh-ed25519 /);

    const state = JSON.parse(await readFile(path.join(harness.buildRoot, "BUILD-STATE.json"), "utf8"));
    assert.equal(state.classification, "boot-only");
    assert.equal(state.sshPort, 22001);
    assert.match(state.workingDisk, /\/work\/work-disk\.qcow2$/);
    assert.equal(state.qgaSocket, qgaSocket);
    const processCheck = await runWsl(`test ! -e /proc/${state.qemuPid}`);
    assert.equal(processCheck.code, 0, `owned QEMU PID ${state.qemuPid} remained alive`);
    assert.equal(await pathExists(path.join(harness.buildRoot, `palziv-debian13-${RELEASE_SHA}.qcow2`)), false);
  } finally {
    await harness.cleanup();
  }
});

test("WSL controller uses an owned, unique QGA runtime directory and preserves a pre-existing socket", {
  skip: process.platform !== "win32" ? "WSL behavior fixture runs on Windows." : false
}, async (t) => {
  await t.test("pre-existing legacy socket is preserved", async () => {
    const harness = await runBashControllerHarness({ scenario: "preexisting-qga" });
    try {
      assert.equal(harness.result.code, 0, harness.result.output);
      assert.equal(await harness.readLog("preexisting-qga.preserved"), "preserved\n");
      const state = JSON.parse(await readFile(path.join(harness.buildRoot, "BUILD-STATE.json"), "utf8"));
      assert.notEqual(state.qgaSocket, `/tmp/palziv-qga-${BUILD_ID}.sock`);
      assert.match(state.qgaSocket, /^\/tmp\/palziv-qga\.[A-Za-z0-9]+\/qga\.sock$/);
    } finally {
      await harness.cleanup();
    }
  });

  await t.test("consecutive builds never reuse a QGA socket path", async () => {
    const first = await runBashControllerHarness();
    const second = await runBashControllerHarness();
    try {
      assert.equal(first.result.code, 0, first.result.output);
      assert.equal(second.result.code, 0, second.result.output);
      const firstState = JSON.parse(await readFile(path.join(first.buildRoot, "BUILD-STATE.json"), "utf8"));
      const secondState = JSON.parse(await readFile(path.join(second.buildRoot, "BUILD-STATE.json"), "utf8"));
      assert.notEqual(firstState.qgaSocket, secondState.qgaSocket);
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });
});

test("WSL controller snapshots the verified cache before QEMU can consume it", {
  skip: process.platform !== "win32" ? "WSL behavior fixture runs on Windows." : false
}, async () => {
  const harness = await runBashControllerHarness({ scenario: "mutate-cache-after-snapshot" });
  try {
    assert.equal(harness.result.code, 0, harness.result.output);
    assert.equal(await readFile(path.join(harness.cacheRoot, BASE_IMAGE_NAME), "utf8"), "mutated-after-snapshot\n");
    const qemuImg = await harness.readLog("qemu-img.log");
    const expectedSnapshot = toWslPath(path.join(harness.buildRoot, "work", "base-image.qcow2"));
    assert.match(qemuImg, new RegExp(`-b ${expectedSnapshot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `));
    assert.equal(await readFile(path.join(harness.buildRoot, "work", "base-image.qcow2"), "utf8"), BASE_IMAGE_CONTENTS);
    const snapshotCheck = await runWsl(`cd '${toWslPath(path.join(harness.buildRoot, "work"))}' && sha512sum --check --strict '${BASE_IMAGE_NAME}.snapshot.sha512'`);
    assert.equal(snapshotCheck.code, 0, snapshotCheck.output);
  } finally {
    await harness.cleanup();
  }
});

test("WSL controller applies wall-clock deadlines to readiness and shutdown SSH", {
  skip: process.platform !== "win32" ? "WSL behavior fixture runs on Windows." : false
}, async (t) => {
  await t.test("slow keyscan cannot overrun readiness deadline", async () => {
    const harness = await runBashControllerHarness({ scenario: "slow-keyscan" });
    try {
      assert.notEqual(harness.result.code, 0);
      assert.match(harness.result.output, /SSH.*timed out/i);
      assert.ok(harness.durationMs < 6500, `readiness took ${harness.durationMs}ms`);
      const state = JSON.parse(await readFile(path.join(harness.buildRoot, "BUILD-STATE.json"), "utf8"));
      const processCheck = await runWsl(`test ! -e /proc/${state.qemuPid}`);
      assert.equal(processCheck.code, 0, `owned QEMU PID ${state.qemuPid} remained alive`);
    } finally {
      await harness.cleanup();
    }
  });

  await t.test("hanging shutdown SSH is terminated by an overall timeout", async () => {
    const harness = await runBashControllerHarness({ scenario: "hanging-ssh" });
    try {
      assert.notEqual(harness.result.code, 0);
      assert.match(harness.result.output, /shutdown.*timed out/i);
      assert.ok(harness.durationMs < 5500, `shutdown SSH took ${harness.durationMs}ms`);
      const state = JSON.parse(await readFile(path.join(harness.buildRoot, "BUILD-STATE.json"), "utf8"));
      const processCheck = await runWsl(`test ! -e /proc/${state.qemuPid}`);
      assert.equal(processCheck.code, 0, `owned QEMU PID ${state.qemuPid} remained alive`);
    } finally {
      await harness.cleanup();
    }
  });
});

test("WSL controller preserves a bad download as partial and never promotes it", {
  skip: process.platform !== "win32" ? "WSL behavior fixture runs on Windows." : false
}, async () => {
  const harness = await runBashControllerHarness({ scenario: "bad-checksum" });
  try {
    assert.notEqual(harness.result.code, 0);
    assert.ok(harness.result.output.length < 4096, "failure output must remain bounded");
    assert.match(harness.result.output, /checksum|sha512/i);
    assert.equal(await pathExists(path.join(harness.cacheRoot, BASE_IMAGE_NAME)), false);
    const cacheEntries = await readdir(harness.cacheRoot);
    const partials = cacheEntries.filter((name) => name.startsWith(`${BASE_IMAGE_NAME}.partial.`));
    assert.equal(partials.length, 1);
    assert.equal(await readFile(path.join(harness.cacheRoot, partials[0]), "utf8"), BASE_IMAGE_CONTENTS);
    assert.equal(await harness.readLog("qemu.log"), "");
  } finally {
    await harness.cleanup();
  }
});

test("WSL controller rejects a corrupted cached image without overwriting it", {
  skip: process.platform !== "win32" ? "WSL behavior fixture runs on Windows." : false
}, async () => {
  const harness = await runBashControllerHarness({ precreateCacheImage: "tampered-cache\n" });
  try {
    assert.notEqual(harness.result.code, 0);
    assert.match(harness.result.output, /checksum|sha512/i);
    assert.equal(await readFile(path.join(harness.cacheRoot, BASE_IMAGE_NAME), "utf8"), "tampered-cache\n");
    assert.equal(await harness.readLog("qemu.log"), "");
  } finally {
    await harness.cleanup();
  }
});

test("WSL controller fails before package installation when KVM is unavailable", {
  skip: process.platform !== "win32" ? "WSL behavior fixture runs on Windows." : false
}, async () => {
  const harness = await runBashControllerHarness({ scenario: "missing-kvm" });
  try {
    assert.notEqual(harness.result.code, 0);
    assert.match(harness.result.output, /KVM is required/i);
    assert.equal(await harness.readLog("apt-get.log"), "");
    assert.equal(await harness.readLog("curl.log"), "");
  } finally {
    await harness.cleanup();
  }
});

test("WSL controller preserves pre-existing named children instead of clobbering them", {
  skip: process.platform !== "win32" ? "WSL behavior fixture runs on Windows." : false
}, async () => {
  const harness = await runBashControllerHarness({ precreateSeed: true });
  try {
    assert.notEqual(harness.result.code, 0);
    assert.match(harness.result.output, /already exists|refusing to reuse/i);
    assert.equal(await readFile(path.join(harness.buildRoot, "seed", "operator-marker.txt"), "utf8"), "preserve\n");
    assert.equal(await harness.readLog("apt-get.log"), "");
  } finally {
    await harness.cleanup();
  }
});

test("WSL controller cleans up only the QEMU process owned by its exact work disk", {
  skip: process.platform !== "win32" ? "WSL behavior fixture runs on Windows." : false
}, async (t) => {
  await t.test("owned timeout process is terminated", async () => {
    const harness = await runBashControllerHarness({ scenario: "ssh-timeout" });
    try {
      assert.notEqual(harness.result.code, 0);
      assert.match(harness.result.output, /SSH.*timed out/i);
      const state = JSON.parse(await readFile(path.join(harness.buildRoot, "BUILD-STATE.json"), "utf8"));
      const processCheck = await runWsl(`test ! -e /proc/${state.qemuPid}`);
      assert.equal(processCheck.code, 0, `owned QEMU PID ${state.qemuPid} remained alive`);
    } finally {
      await harness.cleanup();
    }
  });

  await t.test("unowned recorded PID is not signaled", async () => {
    const harness = await runBashControllerHarness({ scenario: "unowned-pid" });
    let unownedPid = "";
    try {
      unownedPid = (await harness.readLog("unowned.pid")).trim();
      assert.match(unownedPid, /^\d+$/);
      assert.notEqual(harness.result.code, 0);
      assert.match(harness.result.output, /owned QEMU process/i);
      assert.equal(await harness.readLog("unowned.alive"), "alive\n", "unowned process was signaled");
    } finally {
      await harness.cleanup();
    }
  });

  await t.test("same executable with only a work-disk substring is not signaled", async () => {
    const harness = await runBashControllerHarness({ scenario: "substring-drive-pid" });
    try {
      assert.notEqual(harness.result.code, 0);
      assert.match(harness.result.output, /owned QEMU process/i);
      assert.equal(await harness.readLog("substring.alive"), "alive\n", "substring-only process was signaled");
    } finally {
      await harness.cleanup();
    }
  });
});
