# Project-A USB Two-Phase Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and publish a USB-only two-phase migration package that stages Project-A on Debian 13 while Windows remains live, then accepts an age-encrypted final payload for a controlled production cutover.

**Architecture:** A Node-based builder creates a fixed, manifest-covered USB bundle from the committed release. A root-run Debian stage script installs and verifies the target without production data or a tunnel; it generates an age recipient for the Windows intermission. A Windows final-payload tool encrypts runtime/config/tunnel material to that recipient, and a root-run Debian cutover script validates, decrypts, restores, starts, and records bounded evidence.

**Tech Stack:** Node.js ES modules and `node:test`, PowerShell 7/Windows PowerShell-compatible operator wrappers, Bash 5, Debian 13 packages, systemd, age, SHA-256 manifests, existing Project-A Linux backup/restore utilities.

## Global Constraints

- Windows remains the sole production writer during Phase 1.
- Codex does not connect to Debian or Proxmox; the operator moves the USB and runs the scripts.
- No plaintext runtime JSON, environment secret, or Cloudflare credential is written to the USB.
- The Debian age private identity never leaves Debian; only the public recipient is returned.
- The public origin remains `https://itotexpress.com` and the app binds to `127.0.0.1:3116`.
- Exactly `analytics.json`, `board.json`, `push.json`, and `security.json` form the runtime state.
- The Debian Cloudflare service stays disabled until Phase 2 loopback checks pass.
- Every failure reports the real Bash command, source line, and exit status.
- The Windows source and rollback backup remain intact for seven days after cutover.
- Existing unrelated worktree changes must not be staged or committed.

---

### Task 1: Commit the existing Linux deployment baseline

**Files:**
- Modify: `server.js`
- Create: `deploy/linux/palziv.service`
- Create: `deploy/linux/palziv.env.example`
- Create: `deploy/linux/cloudflared.service`
- Create: `deploy/linux/cloudflared-config.yml.example`
- Create: `deploy/linux/palziv-backup.service`
- Create: `deploy/linux/palziv-backup.timer`
- Create: `deploy/linux/palziv-health.service`
- Create: `deploy/linux/palziv-health.timer`
- Create: `deploy/linux/journald.conf`
- Create: `scripts/linux/prepare-host.sh`
- Create: `scripts/linux/install-node24.sh`
- Create: `scripts/linux/install-cloudflared.sh`
- Create: `scripts/linux/configure-firewall.sh`
- Create: `scripts/linux/deploy-release.sh`
- Create: `scripts/linux/runtime-backup-lib.mjs`
- Create: `scripts/linux/backup-runtime.mjs`
- Create: `scripts/linux/restore-runtime.mjs`
- Create: `scripts/linux/health-check.mjs`
- Create: `scripts/linux/run-backup.sh`
- Test: `test/server-host-binding.test.js`
- Test: `test/linux-deployment-contract.test.js`
- Test: `test/linux-migration-runtime.test.js`

**Interfaces:**
- Consumes: existing `server.js`, runtime file environment variables, and systemd.
- Produces: loopback binding through `HOST`, `createRuntimeBackup(options)`, `restoreRuntimeBackup(options)`, and deployable Linux units/scripts.

- [ ] **Step 1: Run the existing tests as a RED/characterization gate**

```powershell
node --test test/server-host-binding.test.js test/linux-deployment-contract.test.js test/linux-migration-runtime.test.js
```

Expected before all baseline files are accepted: failures identify any incomplete Linux contract.

- [ ] **Step 2: Replace Debian account aliases with regular binaries and pin Node**

Use these exact account calls in `scripts/linux/prepare-host.sh`:

```bash
getent group palziv >/dev/null || groupadd --system palziv
id palziv >/dev/null 2>&1 || useradd --system --gid palziv --home-dir /var/lib/palziv --no-create-home --shell /usr/sbin/nologin palziv
getent group cloudflared >/dev/null || groupadd --system cloudflared
id cloudflared >/dev/null 2>&1 || useradd --system --gid cloudflared --home-dir /var/lib/cloudflared --no-create-home --shell /usr/sbin/nologin cloudflared
```

Pin `install-node24.sh` to Node `v24.18.0`, archive `node-v24.18.0-linux-x64.tar.xz`, and SHA-256 `55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742`.

- [ ] **Step 3: Make release deployment idempotent**

If `/opt/palziv/releases/$RELEASE_SHA` exists, verify it is a root-owned directory and reuse it instead of failing. Continue to install dependencies and atomically refresh `/opt/palziv/current`.

- [ ] **Step 4: Run the focused Linux baseline checks**

```powershell
node --check server.js
node --test test/server-host-binding.test.js test/linux-deployment-contract.test.js test/linux-migration-runtime.test.js
git diff --check -- server.js deploy/linux scripts/linux test/server-host-binding.test.js test/linux-deployment-contract.test.js test/linux-migration-runtime.test.js
```

Expected: all focused tests pass and syntax/whitespace checks exit zero.

- [ ] **Step 5: Commit only the baseline files**

```powershell
git add -- server.js deploy/linux scripts/linux test/server-host-binding.test.js test/linux-deployment-contract.test.js test/linux-migration-runtime.test.js
git commit -m "Add Debian deployment baseline"
```

---

### Task 2: Define the two-phase USB contract, builder, and verifier

**Files:**
- Create: `scripts/migration/two-phase-usb-lib.mjs`
- Create: `scripts/migration/build-two-phase-usb.mjs`
- Create: `scripts/migration/verify-two-phase-usb.mjs`
- Create: `test/usb-two-phase-migration.test.js`

**Interfaces:**
- Consumes: a clean committed repository, USB destination root, stage/cutover scripts from later tasks.
- Produces: `TWO_PHASE_ROOT_NAME`, `TWO_PHASE_INBOUND_FILES`, `writeBundleManifest()`, `verifyTwoPhaseUsb({ bundleRoot, mode })`, and `buildTwoPhaseUsb({ repositoryRoot, destinationRoot })`.

- [ ] **Step 1: Write failing contract tests**

```js
test("two-phase verifier accepts one exact outbound tree", async () => {
  const summary = await verifyTwoPhaseUsb({ bundleRoot: fixture.root, mode: "outbound" });
  assert.deepEqual(summary, {
    ok: true,
    phaseId: "project-a-two-phase-v1",
    mode: "outbound",
    inboundFiles: summary.inboundFiles,
    stageReceipt: null,
    cutoverReceipt: null
  });
});

test("two-phase verifier rejects links, extras, changed files, and plaintext final payloads", async () => {
  await writeFile(path.join(fixture.root, "FINAL-ENCRYPTED", "security.json"), "{}");
  await assert.rejects(
    verifyTwoPhaseUsb({ bundleRoot: fixture.root, mode: "outbound" }),
    /unexpected|plaintext|tree/i
  );
});
```

- [ ] **Step 2: Run the new test file and verify RED**

```powershell
node --test test/usb-two-phase-migration.test.js
```

Expected: module-not-found failure for `two-phase-usb-lib.mjs`.

- [ ] **Step 3: Implement the fixed contract**

The root name is `Project-A-Migration-Two-Phase`. Required directories are `PAYLOAD`, `FINAL-ENCRYPTED`, `FROM-DEBIAN`, and `CHECKSUMS`. Reject symlinks, junctions, device files, path escapes, duplicate manifest entries, unexpected root children, and files above the FAT32 limit.

`verifyTwoPhaseUsb` accepts modes `outbound`, `staged-return`, `cutover-ready`, and `cutover-return`. Outbound requires empty return/final directories; staged-return accepts one `STAGE-SUCCESS.json` plus checksum and one `age-recipient.txt`; cutover-ready accepts only `.age` encrypted files and authorization/manifests; cutover-return additionally accepts one bounded `CUTOVER-SUCCESS.json` plus checksum.

- [ ] **Step 4: Build the release payload from committed files**

Use `git ls-files -z` from the selected release SHA. Reject a dirty diff in any tracked file included in the release. Exclude `.git`, `.worktrees`, `node_modules`, runtime JSON, backups, local secrets, attachments, and design-only scratch content. Write a deterministic release manifest and then the whole-bundle SHA-256 manifest.

- [ ] **Step 5: Run contract tests GREEN**

```powershell
node --check scripts/migration/two-phase-usb-lib.mjs
node --check scripts/migration/build-two-phase-usb.mjs
node --check scripts/migration/verify-two-phase-usb.mjs
node --test test/usb-two-phase-migration.test.js
```

- [ ] **Step 6: Commit the USB contract**

```powershell
git add -- scripts/migration/two-phase-usb-lib.mjs scripts/migration/build-two-phase-usb.mjs scripts/migration/verify-two-phase-usb.mjs test/usb-two-phase-migration.test.js
git commit -m "Add two-phase USB bundle contract"
```

---

### Task 3: Implement the Debian staging script

**Files:**
- Create: `scripts/migration/1-STAGE-DEBIAN.sh`
- Modify: `test/usb-two-phase-migration.test.js`

**Interfaces:**
- Consumes: canonical bundle root, `PAYLOAD/release`, manifest, Debian 13 network/package access.
- Produces: `/opt/palziv/current`, staging `/etc/palziv/palziv.env`, disabled `cloudflared.service`, `/etc/palziv/migration-age.key`, `FROM-DEBIAN/STAGE-SUCCESS.json`, and `FROM-DEBIAN/age-recipient.txt`.

- [ ] **Step 1: Write a Debian-layout failing test**

The fixture must use the real Debian conventions `/etc/os-release -> ../usr/lib/os-release` and `/usr/sbin/addgroup -> adduser`. The test executes the real stage script against a mapped root and asserts:

```js
assert.equal(result.code, 0, result.stderr);
assert.equal(receipt.classification, "staged");
assert.equal(receipt.cloudflared, "disabled-inactive");
assert.match(await readFile(recipient, "utf8"), /^age1[ac-hj-np-z02-9]{58}\n$/);
```

- [ ] **Step 2: Run the stage tests RED**

```powershell
wsl.exe --distribution Ubuntu-24.04 --user root -- bash -lc 'cd /mnt/c/Users/admin/Documents/Codex/Project-A/.worktrees/proxmox-migration && node --test --test-name-pattern="two-phase stage" test/usb-two-phase-migration.test.js'
```

Expected: missing script or missing stage receipt.

- [ ] **Step 3: Implement explicit Bash error reporting**

Start the script with:

```bash
#!/usr/bin/env bash
set -Eeuo pipefail
trap 'rc=$?; printf "ERROR line=%s status=%s command=%q\n" "$LINENO" "$rc" "$BASH_COMMAND" >&2; exit "$rc"' ERR
```

Validate root, Debian 13, x86_64, NTP, free space, and exact manifest before mutation. Use `groupadd`, `useradd`, `apt-get`, and the pinned release scripts directly. Never suppress stderr from a failed mutator.

- [ ] **Step 4: Implement staging behavior**

Create a stage-only runtime directory, generate a random stage session secret without printing it, install `/etc/palziv/palziv.env` mode `0640`, enable/start only `palziv.service`, keep `cloudflared.service` disabled/inactive, validate loopback routes, generate the age identity if absent, and atomically write the bounded receipt and public recipient.

- [ ] **Step 5: Verify clean and idempotent stage behavior**

```powershell
wsl.exe --distribution Ubuntu-24.04 --user root -- bash -lc 'cd /mnt/c/Users/admin/Documents/Codex/Project-A/.worktrees/proxmox-migration && node --test --test-name-pattern="two-phase stage" test/usb-two-phase-migration.test.js'
bash -n scripts/migration/1-STAGE-DEBIAN.sh
```

- [ ] **Step 6: Commit the staging script**

```powershell
git add -- scripts/migration/1-STAGE-DEBIAN.sh test/usb-two-phase-migration.test.js
git commit -m "Add Debian two-phase staging"
```

---

### Task 4: Implement encrypted Windows cutover preparation

**Files:**
- Create: `scripts/migration/prepare-two-phase-cutover.mjs`
- Create: `scripts/migration/prepare-two-phase-cutover.ps1`
- Modify: `test/usb-two-phase-migration.test.js`

**Interfaces:**
- Consumes: staged-return USB, Windows runtime directory, production environment file, named-tunnel credential and config, explicit `--authorize-cutover` flag.
- Produces: `FINAL-ENCRYPTED/runtime.tar.gz.age`, `production-env.age`, `cloudflared-credential.age`, `cloudflared-config.age`, their manifests, `CUTOVER-AUTHORIZATION.json`, and `ROLLBACK-WINDOWS.ps1`.

- [ ] **Step 1: Write failing final-payload tests**

```js
await assert.rejects(
  prepareTwoPhaseCutover({ ...fixture, authorizeCutover: false }),
  /explicit cutover authorization/i
);
const result = await prepareTwoPhaseCutover({ ...fixture, authorizeCutover: true });
assert.deepEqual((await readdir(result.finalEncryptedDir)).sort(), [
  "cloudflared-config.age",
  "cloudflared-credential.age",
  "production-env.age",
  "runtime.tar.gz.age"
]);
```

Assert that byte patterns from `security.json`, `push.json`, the environment, and the tunnel credential do not occur anywhere on the USB.

- [ ] **Step 2: Run final-payload tests RED**

```powershell
node --test --test-name-pattern="two-phase cutover preparation" test/usb-two-phase-migration.test.js
```

- [ ] **Step 3: Implement safe source freeze and backup**

The PowerShell wrapper resolves actual scheduled-task names, records their enabled states, disables only approved Project-A tasks, stops the exact Node listener and Windows cloudflared service, then invokes the Node tool. It aborts before stopping anything unless every input path is absolute, regular, and non-reparse.

The Node tool calls the existing `createRuntimeBackup`, validates the stage receipt/recipient, invokes a verified Windows age binary without logging plaintext arguments, encrypts each approved input to a partial file, hashes it, then atomically publishes it.

- [ ] **Step 4: Generate a concrete rollback script**

Embed only task/service names and prior enabled states, never secret values. The rollback script requires an explicit `-ConfirmNoTargetWrites` switch before it can restart Windows.

- [ ] **Step 5: Run preparation tests GREEN**

```powershell
node --check scripts/migration/prepare-two-phase-cutover.mjs
node --test --test-name-pattern="two-phase cutover preparation" test/usb-two-phase-migration.test.js
```

- [ ] **Step 6: Commit final-payload preparation**

```powershell
git add -- scripts/migration/prepare-two-phase-cutover.mjs scripts/migration/prepare-two-phase-cutover.ps1 test/usb-two-phase-migration.test.js
git commit -m "Add encrypted cutover preparation"
```

---

### Task 5: Implement Debian cutover and bounded rollback evidence

**Files:**
- Create: `scripts/migration/2-CUTOVER-DEBIAN.sh`
- Create: `scripts/migration/ROLLBACK-WINDOWS.ps1`
- Modify: `test/usb-two-phase-migration.test.js`

**Interfaces:**
- Consumes: staged Debian state, age private identity, cutover-ready USB.
- Produces: production data/config/tunnel installation, active `palziv.service`, active `cloudflared.service`, and `FROM-DEBIAN/CUTOVER-SUCCESS.json`.

- [ ] **Step 1: Write failing cutover tests**

Cover invalid manifest, missing authorization, wrong age recipient, decryption failure, unexpected archive entry, loopback failure before tunnel start, success, and a second invocation after success. Assert the tunnel fake is never started before all loopback probes succeed.

- [ ] **Step 2: Run cutover tests RED**

```powershell
wsl.exe --distribution Ubuntu-24.04 --user root -- bash -lc 'cd /mnt/c/Users/admin/Documents/Codex/Project-A/.worktrees/proxmox-migration && node --test --test-name-pattern="two-phase cutover" test/usb-two-phase-migration.test.js'
```

- [ ] **Step 3: Implement cutover validation and decryption**

Use the same explicit `ERR` trap as staging. Validate every encrypted hash before stopping the stage service. Decrypt to a root-owned `mktemp -d /var/tmp/project-a-cutover.XXXXXXXX` directory, validate exact files, and remove the directory via a canonical-path cleanup trap.

- [ ] **Step 4: Restore and activate in safe order**

Run `restore-runtime.mjs`, install production env/tunnel files with modes `0640`, start Project-A, probe `/api/health`, `/palzivalerts/`, all role routes, `/sw.js`, and `/manifest.webmanifest`, restart Project-A and probe again, then enable/start Cloudflare. Do not perform a public probe from the script.

- [ ] **Step 5: Write bounded success evidence**

The JSON receipt includes schema version, phase ID, classification, release SHA, runtime archive SHA, local route count, service states, and UTC timestamp. It excludes IPs, secrets, runtime content, logs, and command arguments.

- [ ] **Step 6: Run cutover tests GREEN**

```powershell
wsl.exe --distribution Ubuntu-24.04 --user root -- bash -lc 'cd /mnt/c/Users/admin/Documents/Codex/Project-A/.worktrees/proxmox-migration && node --test --test-name-pattern="two-phase cutover" test/usb-two-phase-migration.test.js'
bash -n scripts/migration/2-CUTOVER-DEBIAN.sh
```

- [ ] **Step 7: Commit cutover logic**

```powershell
git add -- scripts/migration/2-CUTOVER-DEBIAN.sh scripts/migration/ROLLBACK-WINDOWS.ps1 test/usb-two-phase-migration.test.js
git commit -m "Add Debian production cutover"
```

---

### Task 6: Validate against actual Debian 13 package layouts

**Files:**
- Create: `scripts/migration/validate-debian13-two-phase.ps1`
- Modify: `test/usb-two-phase-migration.test.js`

**Interfaces:**
- Consumes: official Debian 13 container/root filesystem and built test bundle.
- Produces: a machine-readable validation summary with exact Debian package versions and stage/cutover results.

- [ ] **Step 1: Write the validation contract test**

Assert the validator refuses non-Debian-13 images and records these facts from Debian 13:

```json
{
  "os": "debian",
  "version": "13",
  "addgroupType": "symbolic link",
  "groupaddType": "regular file",
  "stage": "pass",
  "cutover": "pass"
}
```

- [ ] **Step 2: Implement the disposable validation runner**

Use Docker when available; otherwise import the official Debian 13 rootfs into a temporary WSL distribution. Verify the downloaded image digest or archive SHA, run the scripts with real Debian package binaries, collect only the bounded summary, and delete the exact temporary container/distribution afterward.

- [ ] **Step 3: Run Debian validation**

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\migration\validate-debian13-two-phase.ps1
```

Expected: summary reports Debian 13 and both phases `pass`.

- [ ] **Step 4: Run focused repository verification**

```powershell
node --test test/server-host-binding.test.js test/linux-deployment-contract.test.js test/linux-migration-runtime.test.js test/usb-two-phase-migration.test.js
git diff --check
```

- [ ] **Step 5: Commit the validator**

```powershell
git add -- scripts/migration/validate-debian13-two-phase.ps1 test/usb-two-phase-migration.test.js
git commit -m "Validate migration on Debian 13"
```

---

### Task 7: Publish the clean Phase 1 USB package

**Files:**
- Create: `docs/USB-TWO-PHASE-MIGRATION-EASY-INSTRUCTIONS.txt`
- Modify: `scripts/migration/build-two-phase-usb.mjs`
- Test: `test/usb-two-phase-migration.test.js`

**Interfaces:**
- Consumes: approved removable FAT32 USB, committed release, passing Debian validation.
- Produces: `D:\Project-A-Migration-Two-Phase`, an out-of-band manifest fingerprint, and a local no-clobber backup of any prior migration package.

- [ ] **Step 1: Write operator-document contract tests**

Assert the document contains only short mount/script commands, the exact USB root, the manifest fingerprint placeholder replaced by the builder, the return-to-Windows boundary, and explicit `STOP; do not rerun` handling. Assert it does not embed function definitions or heredocs.

- [ ] **Step 2: Implement the concise operator document**

The Phase 1 Debian action is presented as a mount command followed by:

```bash
sudo bash /mnt/project-a-migration/Project-A-Migration-Two-Phase/1-STAGE-DEBIAN.sh
```

The Phase 2 command is present but marked unavailable until Codex verifies the stage receipt and creates `FINAL-ENCRYPTED` after explicit cutover authorization.

- [ ] **Step 3: Back up and replace the USB package without clobbering**

Verify the current removable FAT32 device identity and serial `FC073954481A1`. Move the superseded Phase 2 package into `C:\Users\admin\Documents\Project-A-Migration-USB-Backups` under a timestamped parent, build to a partial USB parent, verify outbound mode, then atomically rename to `D:\Project-A-Migration-Two-Phase`.

- [ ] **Step 4: Final verification**

```powershell
node .\scripts\migration\verify-two-phase-usb.mjs --bundle-root 'D:\Project-A-Migration-Two-Phase' --mode outbound
Get-FileHash -Algorithm SHA256 -LiteralPath 'D:\Project-A-Migration-Two-Phase\CHECKSUMS\TWO-PHASE.sha256'
```

Confirm `FROM-DEBIAN` and `FINAL-ENCRYPTED` are empty and no `.partial` paths remain.

- [ ] **Step 5: Commit and push documentation/builder changes**

```powershell
git add -- docs/USB-TWO-PHASE-MIGRATION-EASY-INSTRUCTIONS.txt scripts/migration/build-two-phase-usb.mjs test/usb-two-phase-migration.test.js
git commit -m "Publish USB two-phase migration"
git push
```

The operator receives the Phase 1 fingerprint and the exact two short Debian commands only after these checks pass.
