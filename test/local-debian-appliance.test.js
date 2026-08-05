import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
    return "/fixture/$([System.IO.Path]::GetFileName($Arguments[2]))"
  }
  if ($Arguments[0] -eq 'bash' -and $Arguments[1] -eq '-c') {
    if ($Arguments -contains '') { throw 'Empty native argument reached WSL.' }
    if ($Arguments.Count -ne 5 -or $Arguments[2] -ne 'exec ssh-keygen -q -t ed25519 -N "" -f "$1"' -or $Arguments[3] -ne 'build-key') {
      throw 'SSH keygen WSL argument contract was malformed.'
    }
    Set-Content -LiteralPath (Join-Path ${psQuote(buildRoot)} 'build_ssh_ed25519') -Value 'private-fixture'
    Set-Content -LiteralPath (Join-Path ${psQuote(buildRoot)} 'build_ssh_ed25519.pub') -Value 'public-fixture'
    return @()
  }
  if ($Arguments[0] -eq 'bash') { return @() }
  return @()
}
$fixtureBuildId = { return '20260805T120000Z-aaaaaaaaaaaa' }
$fixtureExport = {
  param([string]$RepositoryRoot, [string]$ReleaseSha, [string]$ReleaseTar)
  Set-Content -LiteralPath $ReleaseTar -Value "release=$ReleaseSha"
}
$fixturePreflight = $env:LOCAL_APPLIANCE_PS_SCENARIO -in @('preflight', 'invalid-release', 'low-space', 'relative-output', 'equal-artifacts', 'outside-output')
$fixtureWslRunner = $fixtureWsl
$fixtureWslExecutable = 'wsl.exe'
if ($env:LOCAL_APPLIANCE_PS_SCENARIO -eq 'native-success') {
  $fixtureWslRunner = ${"$"}{function:Invoke-WslRoot}
  $fixtureWslExecutable = ${psQuote(nativeWslPath)}
  Invoke-LocalDebianAppliance -WslDistribution 'Fixture-Ubuntu' -ReleaseRef 'fixture' -OutputRoot ${psQuote(outputRoot)} -PreflightOnly:$fixturePreflight -BootOnly:$false -RepositoryRoot ${psQuote(base)} -ResolveReleaseSha $fixtureRelease -GetFreeBytes $fixtureFree -InvokeWslRoot $fixtureWslRunner -WslExecutable $fixtureWslExecutable -GetBuildId $fixtureBuildId -ExportRelease $fixtureExport
} else {
  Invoke-LocalDebianAppliance -WslDistribution 'Fixture-Ubuntu' -ReleaseRef 'fixture' -OutputRoot ${psQuote(outputRoot)} -PreflightOnly:$fixturePreflight -BootOnly:$false -RepositoryRoot ${psQuote(base)} -ResolveReleaseSha $fixtureRelease -GetFreeBytes $fixtureFree -InvokeWslRoot $fixtureWslRunner -GetBuildId $fixtureBuildId -ExportRelease $fixtureExport
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
      'exec ssh-keygen -q -t ed25519 -N "" -f "$1"',
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
      "--",
      "bash",
      "-c",
      'exec ssh-keygen -q -t ed25519 -N "" -f "$1"',
      "build-key",
      "/fixture/build_ssh_ed25519"
    ]);
    assert.ok(keygenCall.every(Boolean));
    assert.equal(await readFile(path.join(harness.buildRoot, "build_ssh_ed25519.pub"), "utf8"), "public-fixture\r\n");
  } finally {
    await harness.cleanup();
  }
});
