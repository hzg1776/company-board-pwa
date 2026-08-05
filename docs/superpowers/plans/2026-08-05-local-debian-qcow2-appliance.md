# Project-A Local Debian QCOW2 Appliance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, boot-test, seal, checksum, and document a standalone Debian 13 QCOW2 Project-A appliance locally before importing that exact disk into Proxmox.

**Architecture:** A PowerShell entrypoint performs Windows and WSL preflight, exports one explicit Git commit, and invokes a WSL 2 QEMU/KVM controller. The controller verifies the official Debian image, provisions Project-A through temporary loopback-only SSH, performs restart and reboot verification, seals the guest, and emits a standalone QCOW2 plus bounded receipts and a no-start Proxmox import script.

**Tech Stack:** PowerShell 7/Windows PowerShell, WSL 2 Ubuntu 24.04, Bash, QEMU/KVM, QCOW2, cloud-init NoCloud, Debian 13, Node.js 24.18.0, Node test runner, systemd, age, jq, Git, Proxmox `qm`.

## Global Constraints

- Build from the official Debian 13 AMD64 `genericcloud` QCOW2 image and verify it against the official SHA-512 manifest before first boot.
- Use WSL 2 KVM through `/dev/kvm`; do not silently fall back to software emulation.
- Build a standalone QCOW2 with a 40 GiB virtual size and no backing file.
- Deploy exactly one explicit 40-character Git commit beneath `/opt/palziv/releases/<release-sha>`.
- Use Node.js `v24.18.0` and its repository-pinned SHA-256.
- Bind Project-A only to `127.0.0.1:3116` with runtime data beneath `/var/lib/palziv/data`.
- Preserve `https://itotexpress.com`, `/palzivalerts`, all four role routes, `/sw.js`, and `/manifest.webmanifest`.
- Keep `cloudflared.service` disabled and inactive until the explicit final cutover.
- Do not copy production runtime JSON, production environment values, tunnel credentials, passwords, or recovery material into the base appliance.
- The Debian `age` private identity remains inside the QCOW2; only its public recipient leaves the guest.
- Do not connect to, modify, or start anything on Proxmox during the local build.
- Do not overwrite existing build directories, artifacts, destination disks, or Proxmox VMIDs.
- Preserve the dirty migration worktree's unrelated changes and do not modify `DEBIAN-HOST-PREP-EASY-INSTRUCTIONS.txt`.
- Keep generated images, keys, logs, and build state under the already ignored `artifacts/` directory.

---

## File map

- `scripts/appliance/appliance-lib.mjs`: artifact names, manifest validation, checksum verification, and stage-receipt validation shared by tests and the Windows entrypoint.
- `scripts/appliance/verify-local-appliance.mjs`: CLI wrapper that verifies a completed artifact directory without booting it.
- `scripts/appliance/build-local-debian-appliance.ps1`: Windows entrypoint, Git export, WSL/KVM preflight, WSL invocation, final verification, and Windows read-only promotion.
- `scripts/appliance/build-local-debian-appliance.sh`: WSL controller for dependencies, image acquisition, cloud-init, QEMU lifecycle, SSH orchestration, reboot testing, sealing, and QCOW2 finalization.
- `scripts/appliance/provision-debian-appliance.sh`: root-only in-guest installation and staging configuration.
- `scripts/appliance/verify-debian-appliance.sh`: bounded in-guest runtime, route, service, permission, and secret-boundary verification.
- `scripts/appliance/seal-debian-appliance.sh`: root-only deletion of build access and synthetic runtime state before shutdown.
- `scripts/appliance/IMPORT-ON-PROXMOX.sh`: checksum-gated, parameterized, no-start Proxmox disk import.
- `docs/LOCAL_DEBIAN_APPLIANCE.md`: short build, artifact, transfer, import, validation, and cutover instructions.
- `test/local-debian-appliance.test.js`: Node contract and fixture tests for every non-virtualized safety boundary.

---

### Task 1: Artifact and manifest contract

**Files:**
- Create: `scripts/appliance/appliance-lib.mjs`
- Create: `scripts/appliance/verify-local-appliance.mjs`
- Create: `test/local-debian-appliance.test.js`

**Interfaces:**
- Consumes: Node built-ins only; no new npm dependency.
- Produces: `APPLIANCE_SCHEMA_VERSION`, `APPLIANCE_REQUIRED_FILES`, `artifactDiskName(releaseSha)`, `validateBuildManifest(manifest)`, and `verifyApplianceArtifacts({ artifactRoot })`.

- [ ] **Step 1: Write failing tests for exact names, schema, no-clobber behavior, disk checksum, and stage receipt**

```js
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  APPLIANCE_SCHEMA_VERSION,
  artifactDiskName,
  verifyApplianceArtifacts
} from "../scripts/appliance/appliance-lib.mjs";

const RELEASE_SHA = "a".repeat(40);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("artifact disk name is derived only from the release SHA", () => {
  assert.equal(artifactDiskName(RELEASE_SHA), `palziv-debian13-${RELEASE_SHA}.qcow2`);
  assert.throws(() => artifactDiskName("main"), /40-character release SHA/i);
});

test("artifact verifier accepts the exact successful tree and rejects disk tampering", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "palziv-appliance-"));
  const diskName = artifactDiskName(RELEASE_SHA);
  try {
    await writeFile(path.join(root, diskName), "fixture-qcow2");
    const diskSha256 = sha256("fixture-qcow2");
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
    const stageLines = [];
    for (const name of ["STAGE-SUCCESS.json", "age-recipient.txt"]) {
      stageLines.push(`${sha256(await readFile(path.join(root, name)))}  ${name}`);
    }
    await writeFile(path.join(root, "STAGE-SUCCESS.sha256"), `${stageLines.join("\n")}\n`);
    await writeFile(path.join(root, "VERIFY-LOCAL.json"), '{"classification":"pass"}\n');
    await writeFile(path.join(root, "IMPORT-ON-PROXMOX.sh"), "#!/usr/bin/env bash\nexit 0\n");
    await writeFile(path.join(root, "README-FIRST.txt"), "fixture\n");
    await writeFile(path.join(root, "BUILD-MANIFEST.json"), `${JSON.stringify({
      schemaVersion: APPLIANCE_SCHEMA_VERSION,
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
      diskSha256,
      diskVirtualSize: 42949672960,
      diskActualSize: 15,
      completedAt: "2026-08-05T12:00:00Z",
      classification: "pass"
    })}\n`);
    const artifactNames = [
      diskName,
      "BUILD-MANIFEST.json",
      "IMPORT-ON-PROXMOX.sh",
      "README-FIRST.txt",
      "STAGE-SUCCESS.json",
      "STAGE-SUCCESS.sha256",
      "VERIFY-LOCAL.json",
      "age-recipient.txt"
    ];
    const artifactLines = [];
    for (const name of artifactNames) {
      artifactLines.push(`${sha256(await readFile(path.join(root, name)))}  ${name}`);
    }
    await writeFile(path.join(root, "ARTIFACTS.sha256"), `${artifactLines.join("\n")}\n`);

    assert.equal((await verifyApplianceArtifacts({ artifactRoot: root })).ok, true);
    await writeFile(path.join(root, diskName), "changed");
    await assert.rejects(verifyApplianceArtifacts({ artifactRoot: root }), /checksum/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the targeted test and verify the missing-module failure**

Run:

```powershell
node --test test/local-debian-appliance.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/appliance/appliance-lib.mjs`.

- [ ] **Step 3: Implement the manifest and checksum library**

```js
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

export const APPLIANCE_SCHEMA_VERSION = 1;
export const APPLIANCE_REQUIRED_FILES = Object.freeze([
  "ARTIFACTS.sha256",
  "BUILD-MANIFEST.json",
  "IMPORT-ON-PROXMOX.sh",
  "README-FIRST.txt",
  "STAGE-SUCCESS.json",
  "STAGE-SUCCESS.sha256",
  "VERIFY-LOCAL.json",
  "age-recipient.txt"
]);

const RELEASE_SHA = /^[a-f0-9]{40}$/;
const DISK_SHA = /^[a-f0-9]{64}$/;
const IMAGE_SHA = /^[a-f0-9]{128}$/;
const AGE_RECIPIENT = /^age1[ac-hj-np-z02-9]{58}$/;
const BUILD_ID = /^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/;
const DEBIAN_IMAGE_URL = "https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2";

export function artifactDiskName(releaseSha) {
  if (!RELEASE_SHA.test(releaseSha)) throw new Error("Expected a 40-character release SHA.");
  return `palziv-debian13-${releaseSha}.qcow2`;
}

export function validateBuildManifest(manifest) {
  if (manifest?.schemaVersion !== APPLIANCE_SCHEMA_VERSION ||
      !BUILD_ID.test(manifest.buildId ?? "") ||
      manifest.debianImage?.url !== DEBIAN_IMAGE_URL ||
      !IMAGE_SHA.test(manifest.debianImage?.sha512 ?? "") ||
      !Number.isSafeInteger(manifest.debianImage?.bytes) || manifest.debianImage.bytes < 1 ||
      !RELEASE_SHA.test(manifest.releaseSha ?? "") ||
      manifest.nodeVersion !== "v24.18.0" ||
      manifest.diskFile !== artifactDiskName(manifest.releaseSha) ||
      !DISK_SHA.test(manifest.diskSha256 ?? "") ||
      manifest.diskVirtualSize !== 42949672960 ||
      !Number.isSafeInteger(manifest.diskActualSize) || manifest.diskActualSize < 1 ||
      manifest.classification !== "pass") {
    throw new Error("Build manifest does not satisfy the appliance contract.");
  }
  return manifest;
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyApplianceArtifacts({ artifactRoot }) {
  const root = await realpath(artifactRoot);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Artifact root must be a real directory.");
  const manifest = validateBuildManifest(JSON.parse(await readFile(path.join(root, "BUILD-MANIFEST.json"), "utf8")));
  const diskPath = path.join(root, manifest.diskFile);
  const diskStat = await lstat(diskPath);
  if (!diskStat.isFile() || diskStat.isSymbolicLink()) throw new Error("QCOW2 must be a regular file.");
  const diskDigest = await hashFile(diskPath);
  if (diskDigest !== manifest.diskSha256) throw new Error("QCOW2 checksum mismatch.");
  const recipient = (await readFile(path.join(root, "age-recipient.txt"), "utf8")).trim();
  if (!AGE_RECIPIENT.test(recipient)) throw new Error("Invalid age recipient.");
  return { ok: true, releaseSha: manifest.releaseSha, diskFile: manifest.diskFile, diskSha256: diskDigest };
}
```

Parse `ARTIFACTS.sha256` and `STAGE-SUCCESS.sha256` with exact two-space separators, validate the stage receipt fields, reject symbolic links, and reject unexpected root children other than the one derived QCOW2 filename plus `APPLIANCE_REQUIRED_FILES`.

- [ ] **Step 4: Add the verification CLI and rerun tests**

```js
#!/usr/bin/env node
import path from "node:path";
import { verifyApplianceArtifacts } from "./appliance-lib.mjs";

const artifactRoot = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: verify-local-appliance.mjs <artifact-directory>");
process.stdout.write(`${JSON.stringify(await verifyApplianceArtifacts({ artifactRoot }))}\n`);
```

Run:

```powershell
node --check scripts/appliance/appliance-lib.mjs
node --check scripts/appliance/verify-local-appliance.mjs
node --test test/local-debian-appliance.test.js
```

Expected: syntax checks succeed and targeted tests PASS.

- [ ] **Step 5: Commit the artifact contract**

```powershell
git add scripts/appliance/appliance-lib.mjs scripts/appliance/verify-local-appliance.mjs test/local-debian-appliance.test.js
git commit -m "test: define local appliance artifact contract"
```

---

### Task 2: Windows and WSL preflight entrypoint

**Files:**
- Create: `scripts/appliance/build-local-debian-appliance.ps1`
- Modify: `test/local-debian-appliance.test.js`

**Interfaces:**
- Consumes: `verify-local-appliance.mjs`, `wsl.exe`, Git, an explicit `-ReleaseRef`, and an ignored output root.
- Produces: a clean release tar, ephemeral build SSH keypair, JSON preflight summary, and WSL controller invocation arguments.

- [ ] **Step 1: Add failing contract tests for parameterization and safety gates**

```js
test("Windows entrypoint requires KVM, free space, a real commit, and no-clobber output", async () => {
  const script = await readFile(new URL("../scripts/appliance/build-local-debian-appliance.ps1", import.meta.url), "utf8");
  assert.match(script, /\[string\]\$WslDistribution = 'Ubuntu-24\.04'/);
  assert.match(script, /\[string\]\$ReleaseRef = 'HEAD'/);
  assert.match(script, /20GB/);
  assert.match(script, /test', '-c', '\/dev\/kvm'/);
  assert.match(script, /git.+rev-parse.+\^\{commit\}/s);
  assert.match(script, /git.+archive.+--format=tar/s);
  assert.match(script, /Test-Path.+throw/s);
  assert.doesNotMatch(script, /Remove-Item.+-Recurse.+\$OutputRoot/s);
});
```

- [ ] **Step 2: Run the targeted test and verify failure**

Run:

```powershell
node --test test/local-debian-appliance.test.js
```

Expected: FAIL because the PowerShell entrypoint is absent.

- [ ] **Step 3: Implement the safe preflight and release export**

```powershell
[CmdletBinding()]
param(
  [string]$WslDistribution = 'Ubuntu-24.04',
  [string]$ReleaseRef = 'HEAD',
  [string]$OutputRoot = (Join-Path (Resolve-Path "$PSScriptRoot\..\..") 'artifacts\local-debian-appliance'),
  [switch]$PreflightOnly,
  [switch]$BootOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
$releaseSha = (& git -C $repositoryRoot rev-parse "$ReleaseRef`^{commit}").Trim()
if ($LASTEXITCODE -ne 0 -or $releaseSha -notmatch '^[a-f0-9]{40}$') {
  throw "ReleaseRef did not resolve to one commit: $ReleaseRef"
}

$outputParent = [System.IO.Path]::GetFullPath($OutputRoot)
$drive = Get-PSDrive -Name ([System.IO.Path]::GetPathRoot($outputParent).Substring(0, 1))
if ($drive.Free -lt 20GB) { throw 'At least 20 GiB of free output space is required.' }

function Invoke-WslRoot([string[]]$Arguments) {
  $result = & wsl.exe --distribution $WslDistribution --user root -- @Arguments
  if ($LASTEXITCODE -ne 0) { throw "WSL command failed: $($Arguments -join ' ')" }
  return $result
}

Invoke-WslRoot @('test', '-c', '/dev/kvm') | Out-Null
if ($PreflightOnly) {
  [ordered]@{
    ok = $true
    distribution = $WslDistribution
    kvm = 'available'
    freeBytes = $drive.Free
    releaseSha = $releaseSha
  } | ConvertTo-Json -Compress
  return
}
$buildId = "$(Get-Date -AsUTC -Format 'yyyyMMddTHHmmssZ')-$($releaseSha.Substring(0, 12))"
$buildRoot = Join-Path $outputParent $buildId
if (Test-Path -LiteralPath $buildRoot) { throw "Build directory already exists: $buildRoot" }
New-Item -ItemType Directory -Path $buildRoot | Out-Null

$releaseTar = Join-Path $buildRoot 'project-a-release.tar'
& git -C $repositoryRoot archive --format=tar --output=$releaseTar $releaseSha
if ($LASTEXITCODE -ne 0) { throw 'Git release export failed.' }
```

Before creating `$buildRoot`, walk the existing parent components and reject any `ReparsePoint`. Generate the SSH key with WSL `ssh-keygen -t ed25519 -N ''`; never print or copy the private key into the guest seed. Translate paths with `wslpath -a` and pass explicit `--repository`, `--build-root`, `--release-tar`, `--release-sha`, and `--build-id` arguments to the WSL controller. `-PreflightOnly` must stop after returning bounded JSON and must not install packages or download images.

- [ ] **Step 4: Run syntax, static contract, and live preflight checks**

Run:

```powershell
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path scripts/appliance/build-local-debian-appliance.ps1),
  [ref]$null,
  [ref]$errors
) | Out-Null
if ($errors.Count) { $errors | Format-List | Out-String | Write-Error }
node --test test/local-debian-appliance.test.js
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/appliance/build-local-debian-appliance.ps1 -PreflightOnly -ReleaseRef HEAD
```

Expected: parser and tests PASS; preflight JSON reports WSL `Ubuntu-24.04`, `/dev/kvm` available, at least 20 GiB free, and the resolved 40-character release SHA. No artifact disk exists.

- [ ] **Step 5: Commit the preflight entrypoint**

```powershell
git add scripts/appliance/build-local-debian-appliance.ps1 test/local-debian-appliance.test.js
git commit -m "feat: add local appliance preflight"
```

---

### Task 3: Verified Debian image acquisition and local QEMU boot

**Files:**
- Create: `scripts/appliance/build-local-debian-appliance.sh`
- Modify: `scripts/appliance/build-local-debian-appliance.ps1`
- Modify: `test/local-debian-appliance.test.js`

**Interfaces:**
- Consumes: Task 2 arguments, release tar, ephemeral public key, WSL `/dev/kvm`, and official Debian HTTPS endpoints.
- Produces: verified cached base image, 40 GiB working overlay, NoCloud seed, loopback SSH endpoint, PID file, and bounded build state.

- [ ] **Step 1: Add failing tests for image trust, KVM-only execution, private networking, and owned cleanup**

```js
test("WSL controller verifies Debian and exposes SSH only on loopback", async () => {
  const script = await readFile(new URL("../scripts/appliance/build-local-debian-appliance.sh", import.meta.url), "utf8");
  assert.match(script, /debian-13-genericcloud-amd64\.qcow2/);
  assert.match(script, /SHA512SUMS/);
  assert.match(script, /sha512sum --check/);
  assert.match(script, /test -c \/dev\/kvm/);
  assert.match(script, /-accel kvm/);
  assert.match(script, /hostfwd=tcp:127\.0\.0\.1:/);
  assert.match(script, /qemu-img create.+40G/s);
  assert.match(script, /-machine q35/);
  assert.match(script, /org\.qemu\.guest_agent\.0/);
  assert.doesNotMatch(script, /hostfwd=tcp:0\.0\.0\.0/);
  assert.doesNotMatch(script, /rm -rf.+\$BUILD_ROOT/);
});
```

- [ ] **Step 2: Run the targeted test and verify failure**

Run:

```powershell
node --test test/local-debian-appliance.test.js
```

Expected: FAIL because the WSL controller is absent.

- [ ] **Step 3: Implement strict arguments, build dependencies, and verified download**

```bash
#!/usr/bin/env bash
set -Eeuo pipefail
trap 'rc=$?; printf "ERROR line=%s status=%s command=%q\n" "$LINENO" "$rc" "$BASH_COMMAND" >&2; exit "$rc"' ERR

readonly IMAGE_NAME='debian-13-genericcloud-amd64.qcow2'
readonly IMAGE_URL="https://cloud.debian.org/images/cloud/trixie/latest/${IMAGE_NAME}"
readonly SUMS_URL='https://cloud.debian.org/images/cloud/trixie/latest/SHA512SUMS'
readonly DISK_VIRTUAL_SIZE='40G'

[[ -c /dev/kvm ]] || { printf '%s\n' 'KVM is required at /dev/kvm.' >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates cloud-image-utils curl jq openssh-client qemu-system-x86 qemu-utils

download_atomic() {
  local url="$1" destination="$2" partial="${2}.partial.$$"
  [[ ! -e "$partial" ]] || exit 1
  curl --fail --location --proto '=https' --proto-redir '=https' --output "$partial" "$url"
  mv -T -- "$partial" "$destination"
}

download_atomic "$SUMS_URL" "$CACHE_ROOT/SHA512SUMS"
if [[ ! -f "$CACHE_ROOT/$IMAGE_NAME" ]]; then
  download_atomic "$IMAGE_URL" "$CACHE_ROOT/$IMAGE_NAME"
fi
(
  cd -- "$CACHE_ROOT"
  grep -E "^[a-f0-9]{128}  ${IMAGE_NAME}$" SHA512SUMS > "${IMAGE_NAME}.sha512"
  [[ "$(wc -l < "${IMAGE_NAME}.sha512")" -eq 1 ]]
  sha512sum --check --strict "${IMAGE_NAME}.sha512"
)
```

Parse every argument with a `while (($#)); do case ...` loop, require absolute paths, reject linked build/cache/release paths, confirm the build ID and release SHA regexes, and create only named child paths that do not exist. Preserve partial downloads after failure for diagnostics but never promote them.

- [ ] **Step 4: Implement cloud-init seed and QEMU startup**

```bash
qemu-img create -f qcow2 -F qcow2 -b "$CACHE_ROOT/$IMAGE_NAME" "$WORK_DISK" "$DISK_VIRTUAL_SIZE"

cat > "$SEED_ROOT/meta-data" <<EOF
instance-id: palziv-build-${BUILD_ID}
local-hostname: palziv-build
EOF

jq -nr --arg key "$(<"$BUILD_PUBLIC_KEY")" '
  "#cloud-config\nusers:\n  - name: palziv-build\n    groups: [sudo]\n    sudo: ALL=(ALL) NOPASSWD:ALL\n    shell: /bin/bash\n    ssh_authorized_keys:\n      - \($key)\nssh_pwauth: false\ndisable_root: true\npackages: [openssh-server]\n"
' > "$SEED_ROOT/user-data"
cloud-localds "$SEED_IMAGE" "$SEED_ROOT/user-data" "$SEED_ROOT/meta-data"

SSH_PORT="$(choose_unused_port 22000 42000)"
qemu-system-x86_64 \
  -accel kvm \
  -machine q35 \
  -cpu host \
  -smp 2 \
  -m 4096 \
  -device virtio-scsi-pci,id=scsi0 \
  -drive "file=${WORK_DISK},if=none,format=qcow2,id=osdisk" \
  -device scsi-hd,drive=osdisk \
  -drive "file=${SEED_IMAGE},if=virtio,format=raw,readonly=on" \
  -device virtio-serial-pci \
  -chardev "socket,path=${BUILD_ROOT}/qemu-guest-agent.sock,server=on,wait=off,id=qga0" \
  -device virtserialport,chardev=qga0,name=org.qemu.guest_agent.0 \
  -device virtio-net-pci,netdev=net0 \
  -netdev "user,id=net0,hostfwd=tcp:127.0.0.1:${SSH_PORT}-:22" \
  -display none -serial "file:${CONSOLE_LOG}" -monitor none \
  -pidfile "$QEMU_PID_FILE" -daemonize
```

Implement `choose_unused_port` with `ss -H -ltn`, record the selected port and QEMU PID atomically in `BUILD-STATE.json`, and wait up to 300 seconds for SSH. Obtain the first host key with `ssh-keyscan -p "$SSH_PORT" 127.0.0.1` only after confirming the recorded QEMU PID and loopback listener; atomically store it in the build-local `known_hosts`, then require `StrictHostKeyChecking=yes` for every SSH and SCP call. Cleanup may signal only the PID recorded for this build after verifying `/proc/<pid>/exe` resolves to QEMU and `/proc/<pid>/cmdline` contains the exact working disk path.

- [ ] **Step 5: Run syntax, static tests, and a boot-only smoke test**

Run:

```powershell
wsl.exe --distribution Ubuntu-24.04 --user root -- bash -n /mnt/c/Users/admin/Documents/Codex/Project-A/.worktrees/proxmox-migration/scripts/appliance/build-local-debian-appliance.sh
node --test test/local-debian-appliance.test.js
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/appliance/build-local-debian-appliance.ps1 -ReleaseRef HEAD -BootOnly
```

Expected: Bash syntax and Node tests PASS; the smoke test downloads or reuses a checksum-valid Debian image, boots with KVM, reaches SSH only through a loopback-forwarded port, shuts down cleanly, and leaves no final QCOW2.

- [ ] **Step 6: Commit verified local boot support**

```powershell
git add scripts/appliance/build-local-debian-appliance.sh scripts/appliance/build-local-debian-appliance.ps1 test/local-debian-appliance.test.js
git commit -m "feat: boot verified Debian appliance locally"
```

---

### Task 4: In-guest Project-A provisioning

**Files:**
- Create: `scripts/appliance/provision-debian-appliance.sh`
- Modify: `scripts/appliance/build-local-debian-appliance.sh`
- Modify: `test/local-debian-appliance.test.js`

**Interfaces:**
- Consumes: release tar, 40-character release SHA, and repository-owned `scripts/linux/*` plus `deploy/linux/*` inside that release.
- Produces: staged Project-A release, Node 24.18.0, staging environment, systemd services/timers, disabled Cloudflare service, and Debian-only age identity.

- [ ] **Step 1: Add failing provisioning-contract tests**

```js
test("guest provisioning reuses Linux installers and never accepts production inputs", async () => {
  const script = await readFile(new URL("../scripts/appliance/provision-debian-appliance.sh", import.meta.url), "utf8");
  for (const helper of ["prepare-host.sh", "install-node24.sh", "install-cloudflared.sh", "deploy-release.sh"]) {
    assert.match(script, new RegExp(helper.replace(".", "\\.")));
  }
  assert.match(script, /HOST=127\.0\.0\.1/);
  assert.match(script, /PORT=3116/);
  assert.match(script, /RUNTIME_DATA_DIR=\/var\/lib\/palziv\/data/);
  assert.match(script, /PUBLIC_BASE_URL=https:\/\/itotexpress\.com/);
  assert.match(script, /systemctl disable --now cloudflared\.service/);
  assert.match(script, /age-keygen -o/);
  assert.doesNotMatch(script, /security\.json|board\.json|push\.json|analytics\.json/);
  assert.doesNotMatch(script, /credentials\.json|config\.yml/);
});
```

- [ ] **Step 2: Run the targeted test and verify failure**

Run:

```powershell
node --test test/local-debian-appliance.test.js
```

Expected: FAIL because the provisioning script is absent.

- [ ] **Step 3: Implement root-only provisioning with exact release identity**

```bash
#!/usr/bin/env bash
set -Eeuo pipefail
trap 'rc=$?; printf "ERROR line=%s status=%s command=%q\n" "$LINENO" "$rc" "$BASH_COMMAND" >&2; exit "$rc"' ERR

readonly RELEASE_TAR="${1:?release tar required}"
readonly RELEASE_SHA="${2:?release SHA required}"
readonly RELEASE_ROOT="$(mktemp -d /var/tmp/palziv-appliance-release.XXXXXX)"
[[ "$EUID" -eq 0 ]] || { printf '%s\n' 'Run as root.' >&2; exit 1; }
[[ "$RELEASE_SHA" =~ ^[a-f0-9]{40}$ ]] || { printf '%s\n' 'Invalid release SHA.' >&2; exit 1; }

tar -tf "$RELEASE_TAR" | grep -Eq '(^/|(^|/)\.\.(/|$)|\\)' && {
  printf '%s\n' 'Unsafe release archive path.' >&2
  exit 1
}
tar -xf "$RELEASE_TAR" -C "$RELEASE_ROOT"

bash "$RELEASE_ROOT/scripts/linux/prepare-host.sh"
bash "$RELEASE_ROOT/scripts/linux/install-node24.sh"
[[ "$(/opt/node/bin/node --version)" == 'v24.18.0' ]]
bash "$RELEASE_ROOT/scripts/linux/install-cloudflared.sh"
bash "$RELEASE_ROOT/scripts/linux/deploy-release.sh" "$RELEASE_ROOT" "$RELEASE_SHA"

setup_token="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
umask 077
cat > /etc/palziv/palziv.env <<EOF
HOST=127.0.0.1
PORT=3116
RUNTIME_DATA_DIR=/var/lib/palziv/data
PUBLIC_BASE_URL=https://itotexpress.com
TRUST_PROXY_ADDRESSES=loopback
ADMIN_MFA_ENABLED=true
ADMIN_SETUP_TOKEN=${setup_token}
PUSH_ALLOWED_HOSTS=itotexpress.com,www.itotexpress.com
EOF
chown root:palziv /etc/palziv/palziv.env
chmod 0640 /etc/palziv/palziv.env

install -d -o root -g palziv -m 0750 /etc/palziv
if [[ ! -s /etc/palziv/migration-age.key ]]; then
  age-keygen -o /etc/palziv/migration-age.key
fi
chown root:root /etc/palziv/migration-age.key
chmod 0600 /etc/palziv/migration-age.key
systemctl disable --now cloudflared.service
systemctl enable --now palziv.service palziv-backup.timer palziv-health.timer
```

Use a cleanup trap that deletes only the resolved `/var/tmp/palziv-appliance-release.*` directory. Validate the archive entry set before extraction, reject links after extraction, verify `/opt/palziv/current` resolves to `/opt/palziv/releases/$RELEASE_SHA`, and never print the setup token or age private key.

- [ ] **Step 4: Wire secure copy and remote provisioning into the controller**

```bash
scp -P "$SSH_PORT" -i "$BUILD_PRIVATE_KEY" \
  -o UserKnownHostsFile="$KNOWN_HOSTS" -o StrictHostKeyChecking=yes \
  "$RELEASE_TAR" "$SCRIPT_ROOT/provision-debian-appliance.sh" \
  "palziv-build@127.0.0.1:/var/tmp/"

ssh -p "$SSH_PORT" -i "$BUILD_PRIVATE_KEY" \
  -o UserKnownHostsFile="$KNOWN_HOSTS" -o StrictHostKeyChecking=yes \
  palziv-build@127.0.0.1 \
  "sudo bash /var/tmp/provision-debian-appliance.sh /var/tmp/project-a-release.tar '$RELEASE_SHA'"
```

Capture command status but not remote stdout containing security-sensitive tool output. On failure, write `classification=failed` plus operation, UTC time, and exit code into the build state; do not promote the disk.

- [ ] **Step 5: Run syntax and contract tests**

Run:

```powershell
wsl.exe --distribution Ubuntu-24.04 --user root -- bash -n /mnt/c/Users/admin/Documents/Codex/Project-A/.worktrees/proxmox-migration/scripts/appliance/provision-debian-appliance.sh
node --test test/local-debian-appliance.test.js
```

Expected: syntax and tests PASS.

- [ ] **Step 6: Commit guest provisioning**

```powershell
git add scripts/appliance/provision-debian-appliance.sh scripts/appliance/build-local-debian-appliance.sh test/local-debian-appliance.test.js
git commit -m "feat: provision Project-A appliance guest"
```

---

### Task 5: Runtime verification, reboot verification, and bounded stage receipt

**Files:**
- Create: `scripts/appliance/verify-debian-appliance.sh`
- Modify: `scripts/appliance/build-local-debian-appliance.sh`
- Modify: `test/local-debian-appliance.test.js`

**Interfaces:**
- Consumes: expected release SHA and a writable receipt directory inside the guest.
- Produces: `VERIFY-LOCAL.json`, `STAGE-SUCCESS.json`, `STAGE-SUCCESS.sha256`, and `age-recipient.txt` with no secret content.

- [ ] **Step 1: Add failing tests for routes, listener, service state, permissions, reboot phase, and bounded output**

```js
test("guest verifier checks the complete local production contract", async () => {
  const script = await readFile(new URL("../scripts/appliance/verify-debian-appliance.sh", import.meta.url), "utf8");
  for (const route of [
    "/api/health", "/palzivalerts/", "/palzivalerts/employee",
    "/palzivalerts/hr", "/palzivalerts/webmaster", "/palzivalerts/it",
    "/sw.js", "/manifest.webmanifest"
  ]) assert.match(script, new RegExp(route.replaceAll("/", "\\/")));
  assert.match(script, /127\.0\.0\.1:3116/);
  assert.match(script, /systemctl is-enabled --quiet cloudflared\.service/);
  assert.match(script, /systemctl is-active --quiet cloudflared\.service/);
  assert.match(script, /\/opt\/palziv\/current/);
  assert.match(script, /classification:"pass"/);
  assert.doesNotMatch(script, /journalctl|ip addr|ip route|resolv\.conf/);
  assert.doesNotMatch(script, /cat \/etc\/palziv\/palziv\.env/);
});
```

- [ ] **Step 2: Run the targeted test and verify failure**

Run:

```powershell
node --test test/local-debian-appliance.test.js
```

Expected: FAIL because the verifier is absent.

- [ ] **Step 3: Implement metadata-only verification**

```bash
readonly RELEASE_SHA="${1:?release SHA required}"
readonly PHASE="${2:?verification phase required}"
readonly RECEIPT_ROOT="${3:?receipt root required}"
readonly ORIGIN='http://127.0.0.1:3116'
readonly -a ROUTES=(
  '/api/health' '/palzivalerts/' '/palzivalerts/employee'
  '/palzivalerts/hr' '/palzivalerts/webmaster' '/palzivalerts/it'
  '/sw.js' '/manifest.webmanifest'
)

[[ "$PHASE" == pre-reboot || "$PHASE" == post-reboot ]]
[[ "$(. /etc/os-release; printf '%s:%s' "$ID" "$VERSION_ID")" == 'debian:13' ]]
[[ "$(uname -m)" == 'x86_64' ]]
[[ "$(/opt/node/bin/node --version)" == 'v24.18.0' ]]
[[ "$(readlink -f /opt/palziv/current)" == "/opt/palziv/releases/$RELEASE_SHA" ]]
systemctl is-active --quiet qemu-guest-agent.service
systemctl is-active --quiet systemd-timesyncd.service
systemctl is-active --quiet palziv.service
! systemctl is-enabled --quiet cloudflared.service
! systemctl is-active --quiet cloudflared.service

listener="$(ss -H -ltn 'sport = :3116')"
[[ "$listener" == *'127.0.0.1:3116'* ]]
[[ "$listener" != *'0.0.0.0:3116'* && "$listener" != *'[::]:3116'* ]]
for route in "${ROUTES[@]}"; do
  curl --fail --silent --show-error --max-time 15 "$ORIGIN$route" >/dev/null
done
```

Add exact `stat` assertions for service configuration and data paths. Search only the known staging locations for forbidden source paths and production filenames; report a classification rather than matching contents. Generate JSON with `jq -n`, cap it at 16 KiB, reject control characters, and include only schema version, phase, classification, release SHA, Node version, route count, service classifications, and UTC timestamp.

- [ ] **Step 4: Generate the compatible stage receipt and run both verification phases**

```bash
age-keygen -y /etc/palziv/migration-age.key > "$RECEIPT_ROOT/age-recipient.txt.partial"
jq -n \
  --arg phaseId 'project-a-two-phase-v1' \
  --arg releaseSha "$RELEASE_SHA" \
  --arg nodeVersion 'v24.18.0' \
  --arg completedAt "$(date --utc +'%Y-%m-%dT%H:%M:%SZ')" \
  '{schemaVersion:1,phaseId:$phaseId,classification:"staged",releaseSha:$releaseSha,nodeVersion:$nodeVersion,app:"active",cloudflared:"disabled-inactive",routeCount:8,completedAt:$completedAt}' \
  > "$RECEIPT_ROOT/STAGE-SUCCESS.json.partial"
mv -T "$RECEIPT_ROOT/age-recipient.txt.partial" "$RECEIPT_ROOT/age-recipient.txt"
mv -T "$RECEIPT_ROOT/STAGE-SUCCESS.json.partial" "$RECEIPT_ROOT/STAGE-SUCCESS.json"
(
  cd "$RECEIPT_ROOT"
  sha256sum STAGE-SUCCESS.json age-recipient.txt > STAGE-SUCCESS.sha256.partial
  mv -T STAGE-SUCCESS.sha256.partial STAGE-SUCCESS.sha256
)
```

The WSL controller calls the verifier as `pre-reboot`, restarts `palziv.service`, verifies health, issues `sudo systemctl reboot`, waits for SSH to disappear and return within 300 seconds, then calls the same verifier as `post-reboot`. Only the post-reboot pass becomes `VERIFY-LOCAL.json` and the stage receipt, with `routeCount:8`. Copy receipts out with strict SSH host-key checking.

- [ ] **Step 5: Run syntax and compatibility tests**

Run:

```powershell
wsl.exe --distribution Ubuntu-24.04 --user root -- bash -n /mnt/c/Users/admin/Documents/Codex/Project-A/.worktrees/proxmox-migration/scripts/appliance/verify-debian-appliance.sh
node --test test/local-debian-appliance.test.js test/usb-two-phase-migration.test.js
```

Expected: appliance and existing two-phase receipt tests PASS.

- [ ] **Step 6: Commit runtime verification**

```powershell
git add scripts/appliance/verify-debian-appliance.sh scripts/appliance/build-local-debian-appliance.sh test/local-debian-appliance.test.js
git commit -m "feat: verify appliance runtime and reboot"
```

---

### Task 6: Guest sealing and standalone QCOW2 promotion

**Files:**
- Create: `scripts/appliance/seal-debian-appliance.sh`
- Modify: `scripts/appliance/build-local-debian-appliance.sh`
- Modify: `scripts/appliance/build-local-debian-appliance.ps1`
- Modify: `test/local-debian-appliance.test.js`

**Interfaces:**
- Consumes: a twice-verified running guest, build username, expected release SHA, and Task 5 receipts.
- Produces: clean shutdown, standalone checked QCOW2, manifest, exact checksum tree, and Windows read-only final disk.

- [ ] **Step 1: Add failing tests for synthetic-data removal, identity reset, standalone conversion, and post-build verifier invocation**

```js
test("sealing removes build identity and finalization rejects backing files", async () => {
  const seal = await readFile(new URL("../scripts/appliance/seal-debian-appliance.sh", import.meta.url), "utf8");
  const build = await readFile(new URL("../scripts/appliance/build-local-debian-appliance.sh", import.meta.url), "utf8");
  const windows = await readFile(new URL("../scripts/appliance/build-local-debian-appliance.ps1", import.meta.url), "utf8");
  assert.match(seal, /systemctl stop palziv\.service/);
  assert.match(seal, /systemctl disable --now cloudflared\.service/);
  assert.match(seal, /realpath.+\/var\/lib\/palziv\/data/s);
  assert.match(seal, /find.+-xdev.+-delete/s);
  assert.match(seal, /userdel.+palziv-build/);
  assert.match(seal, /rm -f -- \/etc\/ssh\/ssh_host_/);
  assert.match(seal, /cloud-init clean.+--machine-id/);
  assert.match(build, /systemd-run.+palziv-appliance-seal/s);
  assert.match(build, /qemu-img convert.+-O qcow2/s);
  assert.match(build, /qemu-img check/);
  assert.match(build, /backing-filename/);
  assert.match(windows, /verify-local-appliance\.mjs/);
  assert.match(windows, /IsReadOnly = \$true/);
});
```

- [ ] **Step 2: Run the targeted test and verify failure**

Run:

```powershell
node --test test/local-debian-appliance.test.js
```

Expected: FAIL because the sealing contract is absent.

- [ ] **Step 3: Implement root-only sealing and clean shutdown**

```bash
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$EUID" -eq 0 ]] || { printf '%s\n' 'Run as root.' >&2; exit 1; }
systemctl stop palziv.service
systemctl disable --now cloudflared.service

data_dir="$(realpath -e /var/lib/palziv/data)"
[[ "$data_dir" == '/var/lib/palziv/data' && ! -L "$data_dir" ]]
find "$data_dir" -xdev -mindepth 1 -delete
chown palziv:palziv "$data_dir"
chmod 0700 "$data_dir"

rm -f -- /var/tmp/project-a-release.tar /var/tmp/provision-debian-appliance.sh
rm -f -- /var/tmp/verify-debian-appliance.sh /var/tmp/seal-debian-appliance.sh
loginctl terminate-user palziv-build || true
pkill -KILL -u palziv-build || true
userdel --remove palziv-build
cloud_root="$(realpath -e /var/lib/cloud)"
[[ "$cloud_root" == '/var/lib/cloud' && ! -L "$cloud_root" ]]
find "$cloud_root/instances" -xdev -mindepth 1 -delete
rm -f -- "$cloud_root/instance"
cloud-init clean --logs --machine-id --seed
apt-get clean
find /var/lib/apt/lists -xdev -type f -delete
rm -f -- /etc/ssh/ssh_host_*
sync
systemctl poweroff
```

Install the sealer at a fixed root-owned path, then launch it outside the active SSH process with `sudo systemd-run --unit=palziv-appliance-seal --collect --on-active=3s /usr/local/sbin/palziv-seal-debian-appliance`. The controller ends its SSH session before the service terminates and removes `palziv-build`. Use fixed path checks for every cleanup target. Preserve `/etc/palziv/migration-age.key`, installed releases, systemd units, staging environment, and receipt files. Confirm no build-private-key fingerprint is present before shutdown. Treat `userdel` failure as fatal unless the user is already absent.

- [ ] **Step 4: Implement standalone conversion, image checks, and manifest publication**

```bash
wait_for_qemu_exit "$QEMU_PID_FILE" 180
qemu-img check "$WORK_DISK"
qemu-img convert -p -O qcow2 -o compat=1.1,lazy_refcounts=on "$WORK_DISK" "$FINAL_DISK_PARTIAL"
qemu-img check "$FINAL_DISK_PARTIAL"
qemu-img info --output=json "$FINAL_DISK_PARTIAL" > "$BUILD_ROOT/qemu-info.json"

jq -e '
  .format == "qcow2" and
  .["virtual-size"] == 42949672960 and
  (has("backing-filename") | not)
' "$BUILD_ROOT/qemu-info.json" >/dev/null

disk_sha256="$(sha256sum "$FINAL_DISK_PARTIAL" | awk '{print $1}')"
mv -T -- "$FINAL_DISK_PARTIAL" "$FINAL_DISK"
```

Write `BUILD-MANIFEST.json.partial` with all required schema fields and atomically promote it. Copy the exact Task 5 receipts and static import/readme files, generate `ARTIFACTS.sha256` for every final artifact except itself, then call `node scripts/appliance/verify-local-appliance.mjs <artifact-root>` from PowerShell. Only after verification succeeds set `(Get-Item -LiteralPath $finalDisk).IsReadOnly = $true`. Never delete a failed working disk automatically.

- [ ] **Step 5: Run syntax and contract tests**

Run:

```powershell
wsl.exe --distribution Ubuntu-24.04 --user root -- bash -n /mnt/c/Users/admin/Documents/Codex/Project-A/.worktrees/proxmox-migration/scripts/appliance/seal-debian-appliance.sh
wsl.exe --distribution Ubuntu-24.04 --user root -- bash -n /mnt/c/Users/admin/Documents/Codex/Project-A/.worktrees/proxmox-migration/scripts/appliance/build-local-debian-appliance.sh
node --test test/local-debian-appliance.test.js
```

Expected: syntax and tests PASS.

- [ ] **Step 6: Commit sealing and promotion**

```powershell
git add scripts/appliance/seal-debian-appliance.sh scripts/appliance/build-local-debian-appliance.sh scripts/appliance/build-local-debian-appliance.ps1 test/local-debian-appliance.test.js
git commit -m "feat: seal and publish standalone QCOW2"
```

---

### Task 7: Proxmox import and operator documentation

**Files:**
- Create: `scripts/appliance/IMPORT-ON-PROXMOX.sh`
- Create: `docs/LOCAL_DEBIAN_APPLIANCE.md`
- Modify: `test/local-debian-appliance.test.js`

**Interfaces:**
- Consumes: final QCOW2, `ARTIFACTS.sha256`, root access on the destination Proxmox node, VMID, storage, bridge, SSH public key, and IP configuration.
- Produces: a stopped Proxmox VM definition with imported boot disk and cloud-init disk; no automatic VM start or production cutover.

- [ ] **Step 1: Add failing tests for exact import gates and no-start behavior**

```js
test("Proxmox import verifies inputs, attaches imported volume, and never starts the VM", async () => {
  const script = await readFile(new URL("../scripts/appliance/IMPORT-ON-PROXMOX.sh", import.meta.url), "utf8");
  for (const name of ["VMID", "IMAGE_PATH", "STORAGE", "BRIDGE", "SSH_KEY_FILE"]) {
    assert.match(script, new RegExp(`\\$\\{${name}:\\?`));
  }
  assert.match(script, /sha256sum --check --strict/);
  assert.match(script, /qm status/);
  assert.match(script, /qm create/);
  assert.match(script, /qm disk import/);
  assert.match(script, /qm config.+unused/s);
  assert.match(script, /virtio-scsi-single/);
  assert.match(script, /cloudinit/);
  assert.match(script, /--onboot 1/);
  assert.doesNotMatch(script, /qm start/);
  assert.doesNotMatch(script, /qm destroy/);
});
```

- [ ] **Step 2: Run the targeted test and verify failure**

Run:

```powershell
node --test test/local-debian-appliance.test.js
```

Expected: FAIL because the import script is absent.

- [ ] **Step 3: Implement checksum-gated, parameterized import without automatic start**

```bash
#!/usr/bin/env bash
set -Eeuo pipefail
trap 'rc=$?; printf "STOP: import failed line=%s status=%s command=%q; preserve VM state and do not retry blindly.\n" "$LINENO" "$rc" "$BASH_COMMAND" >&2; exit "$rc"' ERR

readonly VMID="${VMID:?Set VMID}"
readonly IMAGE_PATH="${IMAGE_PATH:?Set IMAGE_PATH}"
readonly STORAGE="${STORAGE:?Set STORAGE}"
readonly BRIDGE="${BRIDGE:?Set BRIDGE}"
readonly SSH_KEY_FILE="${SSH_KEY_FILE:?Set SSH_KEY_FILE}"
readonly IP_CONFIG="${IP_CONFIG:-ip=dhcp}"
readonly VM_NAME="${VM_NAME:-palziv-prod}"

[[ "$EUID" -eq 0 ]]
[[ "$VMID" =~ ^[1-9][0-9]{2,8}$ ]]
[[ -f "$IMAGE_PATH" && ! -L "$IMAGE_PATH" ]]
[[ -f "$SSH_KEY_FILE" && ! -L "$SSH_KEY_FILE" ]]
command -v qm >/dev/null
if qm status "$VMID" >/dev/null 2>&1; then
  printf 'VMID %s already exists; refusing to modify it.\n' "$VMID" >&2
  exit 1
fi

(
  cd -- "$(dirname -- "$IMAGE_PATH")"
  sha256sum --check --strict ARTIFACTS.sha256
)

qm create "$VMID" --name "$VM_NAME" --ostype l26 --machine q35 --cpu host \
  --cores 2 --memory 4096 --scsihw virtio-scsi-single \
  --agent enabled=1,fstrim_cloned_disks=1 \
  --net0 "virtio,bridge=${BRIDGE},firewall=1" --serial0 socket --vga serial0
qm disk import "$VMID" "$IMAGE_PATH" "$STORAGE" --format qcow2
imported="$(qm config "$VMID" | awk -F': ' '/^unused[0-9]+:/ {sub(/,.*/, "", $2); print $2}' | tail -n1)"
[[ -n "$imported" ]]
qm set "$VMID" --scsi0 "${imported},discard=on,iothread=1,ssd=1"
qm set "$VMID" --ide2 "${STORAGE}:cloudinit" --boot order=scsi0
qm set "$VMID" --ciuser palziv-admin --sshkeys "$SSH_KEY_FILE" --ipconfig0 "$IP_CONFIG"
qm set "$VMID" --onboot 1 --tags 'production;palziv'
qm config "$VMID"
printf '%s\n' 'IMPORT COMPLETE: VM remains stopped. Review configuration and firewall before first boot.'
```

Also reject `/`, `/etc`, `/var`, `/var/lib`, `/root`, and the Proxmox storage root as direct image or key paths. Validate storage and bridge tokens against bounded character sets. Require that `ARTIFACTS.sha256` contains exactly one entry for the selected QCOW2 with the manifest digest. If import fails after `qm create`, preserve the stopped partial VM for explicit operator inspection; do not destroy it automatically.

- [ ] **Step 4: Write short operator documentation with exact boundaries**

````markdown
# Local Debian Appliance

Build locally:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/appliance/build-local-debian-appliance.ps1 -ReleaseRef HEAD
```

The successful artifact is under `artifacts/local-debian-appliance/<build-id>/final/`.
Transfer that final directory over encrypted media or an authenticated encrypted channel. On Proxmox, verify the checksum, set `VMID`, `IMAGE_PATH`, `STORAGE`, `BRIDGE`, `SSH_KEY_FILE`, and `IP_CONFIG`, then run `IMPORT-ON-PROXMOX.sh` as root. The import script leaves the VM stopped.
````

Document the local build, artifact meanings, encrypted transport requirement, Proxmox import variables, pre-start review, first-boot loopback verification, stage-receipt handoff into the existing two-phase cutover package, rollback boundary, and seven-day stabilization rule. Do not include server-specific VMID, IP, bridge, storage, credential path, or secret examples that look authoritative.

- [ ] **Step 5: Run syntax, contract, and documentation checks**

Run:

```powershell
wsl.exe --distribution Ubuntu-24.04 --user root -- bash -n /mnt/c/Users/admin/Documents/Codex/Project-A/.worktrees/proxmox-migration/scripts/appliance/IMPORT-ON-PROXMOX.sh
node --test test/local-debian-appliance.test.js
git diff --check
```

Expected: syntax, tests, and whitespace checks PASS.

- [ ] **Step 6: Commit import support and documentation**

```powershell
git add scripts/appliance/IMPORT-ON-PROXMOX.sh docs/LOCAL_DEBIAN_APPLIANCE.md test/local-debian-appliance.test.js
git commit -m "docs: add Proxmox appliance import handoff"
```

---

### Task 8: Full verification and real local appliance build

**Files:**
- Modify only if failures identify an implementation defect: files created in Tasks 1-7.
- Generate ignored artifacts: `artifacts/local-debian-appliance/<build-id>/`

**Interfaces:**
- Consumes: completed Tasks 1-7 and one explicit release commit.
- Produces: a locally booted, reboot-tested, sealed, standalone QCOW2 artifact with verified hashes and bounded receipts.

- [ ] **Step 1: Run all static syntax checks**

```powershell
node --check scripts/appliance/appliance-lib.mjs
node --check scripts/appliance/verify-local-appliance.mjs
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path scripts/appliance/build-local-debian-appliance.ps1),
  [ref]$null,
  [ref]$errors
) | Out-Null
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($script in Get-ChildItem scripts/appliance -Filter *.sh) {
  $wslPath = (& wsl.exe --distribution Ubuntu-24.04 -- wslpath -a $script.FullName).Trim()
  & wsl.exe --distribution Ubuntu-24.04 --user root -- bash -n $wslPath
  if ($LASTEXITCODE -ne 0) { throw "Bash syntax failed: $($script.Name)" }
}
```

Expected: all syntax checks succeed.

- [ ] **Step 2: Run targeted and migration regression tests**

```powershell
node --test test/local-debian-appliance.test.js
node --test test/linux-migration-runtime.test.js test/usb-two-phase-migration.test.js test/proxmox-runbook-contract.test.js
```

Expected: all selected tests PASS. If the untracked runbook contract test depends on uncommitted files, record that boundary and run it without staging or changing those files.

- [ ] **Step 3: Run the full repository suite and patch hygiene**

```powershell
npm test
git diff --check
```

Expected: full suite and whitespace checks PASS. Preserve expected platform skips and report them exactly.

- [ ] **Step 4: Resolve the exact release commit and run the real builder**

```powershell
$releaseSha = (git rev-parse 'HEAD^{commit}').Trim()
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/appliance/build-local-debian-appliance.ps1 -ReleaseRef $releaseSha
```

Expected: the builder may install only the declared packages inside `Ubuntu-24.04`; it verifies the official Debian image, boots with KVM, provisions Project-A, passes pre-reboot and post-reboot verification, seals and powers off the guest, converts to standalone QCOW2, and prints the ignored final artifact directory. It does not contact Proxmox, start Cloudflare, or read production data.

- [ ] **Step 5: Independently verify the final artifact and image metadata**

```powershell
$finalRoot = Get-ChildItem artifacts/local-debian-appliance -Recurse -Filter BUILD-MANIFEST.json -File |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -First 1 |
  ForEach-Object { $_.Directory.FullName }
node scripts/appliance/verify-local-appliance.mjs $finalRoot
$finalWsl = (& wsl.exe --distribution Ubuntu-24.04 -- wslpath -a $finalRoot).Trim()
wsl.exe --distribution Ubuntu-24.04 --user root -- bash -lc "cd '$finalWsl'; sha256sum --check --strict ARTIFACTS.sha256; qemu-img check palziv-debian13-*.qcow2; qemu-img info --output=json palziv-debian13-*.qcow2"
```

Expected: artifact verifier returns `ok:true`; all hashes pass; `qemu-img check` reports no errors; image metadata reports `qcow2`, virtual size `42949672960`, and no backing filename.

- [ ] **Step 6: Inspect bounded receipts and confirm secret exclusion**

```powershell
Get-Content -LiteralPath (Join-Path $finalRoot 'BUILD-MANIFEST.json')
Get-Content -LiteralPath (Join-Path $finalRoot 'VERIFY-LOCAL.json')
Get-Content -LiteralPath (Join-Path $finalRoot 'STAGE-SUCCESS.json')
Get-Content -LiteralPath (Join-Path $finalRoot 'age-recipient.txt')
```

Expected: outputs contain only documented metadata and the public age recipient. They contain no environment values, setup token, runtime JSON, tunnel credential, passwords, IP configuration, Windows paths, or logs.

- [ ] **Step 7: Commit any evidence-driven fixes, then record the final immutable revision**

If Tasks 1-7 required no correction during the real build, make no empty commit. If a defect was fixed, rerun Steps 1-6 and commit only the affected implementation and tests:

```powershell
git add scripts/appliance docs/LOCAL_DEBIAN_APPLIANCE.md test/local-debian-appliance.test.js
git commit -m "fix: complete local appliance verification"
```

Record the final Git SHA, build ID, QCOW2 SHA-256, actual file size, virtual size, verification result, test totals, and exact artifact path in the task handoff. Do not commit ignored QCOW2 images, keys, build state, or logs.

---

## Plan self-review map

- Local Windows/WSL preflight and safe paths: Task 2.
- Official image trust, KVM-only boot, private networking, 40 GiB disk: Task 3.
- Exact release, Node 24.18.0, Linux helper reuse, systemd, age identity: Task 4.
- Routes, listener, service/timer state, reboot, bounded receipts: Task 5.
- Synthetic-data removal, identity cleanup, standalone conversion, manifest and checksums: Task 6.
- No-start Proxmox import, encrypted transfer guidance, cutover handoff: Task 7.
- Real Debian boot proof, complete regression suite, independent final verification: Task 8.
