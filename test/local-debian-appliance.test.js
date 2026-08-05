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

async function writeCommandFixture(binRoot, name, contents) {
  await writeFile(path.join(binRoot, name), `#!/usr/bin/env bash\nset -Eeuo pipefail\n${contents}`);
}

async function runBashControllerHarness({
  scenario = "success",
  precreateCacheImage,
  precreateSeed = false,
  unownedPid = ""
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
port=''
while (($#)); do
  if [[ "$1" == '-p' ]]; then port="$2"; shift 2; continue; fi
  shift
done
printf '[127.0.0.1]:%s ssh-ed25519 QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=\n' "$port"
`);
  await writeCommandFixture(binRoot, "ssh", String.raw`
printf '%s\n' "$*" >> "$FIXTURE_ROOT/ssh.log"
pid="$(<"$FIXTURE_ROOT/qemu.pid")"
kill -TERM "$pid"
exit 0
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
export FIXTURE_SCENARIO="$scenario"
export FIXTURE_UNOWNED_PID="$unowned_pid"
export FIXTURE_IMAGE_SHA512='${sha512(BASE_IMAGE_CONTENTS)}'
export PALZIV_APPLIANCE_SSH_TIMEOUT_SECONDS=2
export PATH="$fixture_root/../bin:/usr/bin:/bin"
if [[ "$scenario" == 'missing-kvm' ]]; then export PALZIV_APPLIANCE_KVM_DEVICE=/dev/palziv-missing-kvm; fi
controller_args=(bash ${shellQuote(controller)} \
  --repository ${shellQuote(wslRepository)} \
  --build-root ${shellQuote(wslBuildRoot)} \
  --release-tar ${shellQuote(`${wslBuildRoot}/project-a-release.tar`)} \
  --release-sha ${shellQuote(RELEASE_SHA)} \
  --build-id ${shellQuote(BUILD_ID)} \
  --build-public-key ${shellQuote(`${wslBuildRoot}/build_ssh_ed25519.pub`)} \
  --boot-only)
if [[ "$scenario" == 'unowned-pid' ]]; then
  set +e
  "${"$"}{controller_args[@]}"
  controller_status="$?"
  set -e
  if kill -0 "$unowned_pid" 2>/dev/null; then
    printf 'alive\n' > "$fixture_root/unowned.alive"
  fi
  kill -TERM "$unowned_pid" 2>/dev/null || true
  wait "$unowned_pid" 2>/dev/null || true
  exit "$controller_status"
fi
exec "${"$"}{controller_args[@]}"
`;
  const wrapperPath = path.join(fixtureRoot, "run-controller.sh");
  await writeFile(wrapperPath, wrapper);
  const result = await runProcess("wsl.exe", [
    "--distribution", "Ubuntu-24.04",
    "--user", "root",
    "--",
    "bash", toWslPath(wrapperPath)
  ], 15000);
  const readOptional = async (candidate) => (await pathExists(candidate)) ? readFile(candidate, "utf8") : "";
  return {
    base,
    repository,
    outputRoot,
    buildRoot,
    cacheRoot,
    fixtureRoot,
    result,
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
    if ($env:LOCAL_APPLIANCE_PS_SCENARIO -eq 'boot-only') {
      return '{"ok":true,"classification":"boot-only","buildId":"20260805T120000Z-aaaaaaaaaaaa","releaseSha":"${RELEASE_SHA}","sshPort":22001}'
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
$fixtureBootOnly = $env:LOCAL_APPLIANCE_PS_SCENARIO -eq 'boot-only'
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
    assert.match(qemuImg, /create -f qcow2 -F qcow2 -b .*debian-13-genericcloud-amd64\.qcow2 .*work-disk\.qcow2 40G/);
    assert.equal((await harness.readLog("apt-get.log")).trim(), [
      "update",
      "install -y ca-certificates cloud-image-utils curl jq openssh-client qemu-system-x86 qemu-utils"
    ].join("\n"));
    assert.match(await harness.readLog("ssh.log"), /StrictHostKeyChecking=yes/);
    assert.match(await harness.readLog("ssh.log"), /UserKnownHostsFile=/);
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
});
