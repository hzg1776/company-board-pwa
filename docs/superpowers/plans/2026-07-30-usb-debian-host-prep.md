# USB Debian Host Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and physically publish a second, independently verified USB bundle that prepares the clean Debian 13 VM with a pinned Node.js runtime, an unprivileged account, and empty restricted directories while preserving Phase 1 evidence and avoiding application, secret, service, firewall, Cloudflare, data, and cutover changes.

**Architecture:** Keep `D:\Project-A-Migration` immutable and atomically publish `D:\Project-A-Migration-Phase-2-Host-Prep` beside it. A dedicated builder links the verified Phase 1 receipt to a strict Phase 2 manifest, three Debian scripts perform preflight/apply/evidence collection through a bounded local staging copy, and a dedicated verifier authenticates returned metadata before it is read.

**Tech Stack:** Node.js 22+ ES modules and built-in `node:test`, Windows PowerShell 5.1+, Bash 5+, Debian 13 core utilities, WSL Debian for POSIX tests, SHA-256, GnuPG verification of official Node.js release metadata.

## Global Constraints

- Codex must not receive SSH, Proxmox, console, VPN, API, browser-session, or remote-desktop access to Debian or Proxmox.
- The user runs every Debian and Proxmox command locally.
- The dedicated removable FAT32 USB is the only laptop-to-Debian file-transfer path.
- `D:\Project-A-Migration` and its returned report must remain byte-for-byte unchanged.
- The new root name is exactly `Project-A-Migration-Phase-2-Host-Prep`.
- The Phase 2 identifier is exactly `debian-host-prep-v1`.
- The Phase 2 bundle contains no Project-A source, npm package, runtime JSON, environment file, secret, credential, Cloudflare artifact, systemd unit, timer, journald override, or Node archive.
- The Debian apply boundary is limited to the exact seven-package allowlist, pinned Node.js, the `palziv` system account, and six empty directories.
- The package allowlist is exactly `ca-certificates`, `curl`, `git`, `jq`, `rsync`, `tar`, and `xz-utils`.
- Node.js is exactly `v24.18.0`, archive `node-v24.18.0-linux-x64.tar.xz`, URL `https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz`, and SHA-256 `55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742`.
- Node release-key provenance is pinned to `nodejs/release-keys` commit `b28073028e6d6855cfb53bf7fa0137599c01f967`.
- No script may install or configure `cloudflared`, call a mutating `systemctl` action, change a firewall/network setting, probe the public Project-A URL, create `/opt/palziv/current`, write `/etc/palziv/palziv.env`, run npm, deploy code, or read runtime/secret material. Preflight and receipt collection may use only `systemctl is-active` and `systemctl is-enabled`.
- The current Windows production application, automation, runtime data, and Cloudflare connector remain unchanged.
- No new npm dependency is allowed.
- Every new behavior follows red-green-refactor; a failing test must be observed before production code is written.
- Windows and WSL tests use temporary paths only. They must not touch `D:`, the Debian VM, or Proxmox.
- The physical `D:` write occurs only in Task 7 after syntax, focused, WSL, full-suite, patch-hygiene, and review gates pass.
- Existing uncommitted Proxmox/Linux work remains out of scope and must not be staged or committed.

---

## File Structure

- Create `scripts/migration/usb-host-prep-lib.mjs`: Phase 2 constants, strict input schema, Phase 1 tree snapshots, manifest fingerprinting, and snapshot comparison.
- Create `scripts/migration/preflight-host-prep.sh`: reusable read-only state classification plus the operator preflight/token entry point.
- Create `scripts/migration/apply-host-prep.sh`: explicit root-only `--apply` host mutation.
- Create `scripts/migration/collect-host-prep-evidence.sh`: read-only metadata receipt publisher.
- Create `scripts/migration/verify-usb-host-prep.mjs`: exact Phase 2 outbound/returned verifier.
- Create `scripts/migration/build-usb-host-prep.mjs`: guarded sibling-bundle builder.
- Create `scripts/migration/prepare-usb-host-prep.ps1`: removable-FAT32 Windows entry point.
- Create `deploy/usb-host-prep/README-FIRST.txt`: snapshot, mount, out-of-band hash, staging, preflight, apply, collector, cleanup, and return steps.
- Create `deploy/usb-host-prep/ISOLATION-BOUNDARY.txt`: concise approved/forbidden boundary.
- Create `test/usb-host-prep.test.js`: Windows contract, Node behavior, WSL runtime, race, redaction, and regression coverage.
- Do not modify `scripts/migration/verify-usb-handoff.mjs` or any Phase 1 payload file.

### Task 1: Phase 2 integrity profile and authenticated provenance

**Files:**
- Create: `scripts/migration/usb-host-prep-lib.mjs`
- Create: `test/usb-host-prep.test.js`

**Interfaces:**
- Consumes: `sha256File` and path/FAT32 primitives from `scripts/migration/usb-handoff-lib.mjs`
- Produces: `HOST_PREP_ROOT_NAME`
- Produces: `HOST_PREP_PHASE_ID`
- Produces: `HOST_PREP_MANIFEST_PATH`
- Produces: `HOST_PREP_INBOUND_FILES`
- Produces: `NODE_PROVENANCE`
- Produces: `createPhase2Input({ reportFileName, reportSha256, phase1ManifestSha256 })`
- Produces: `validatePhase2Input(value)`
- Produces: `snapshotRegularTree(rootPath)`
- Produces: `assertTreeSnapshotEqual(before, after)`
- Produces: `manifestFingerprint(manifestPath)`

- [ ] **Step 1: Authenticate the upstream Node.js digest before encoding it**

Run from the worktree:

```powershell
wsl.exe --distribution Debian -- bash -lc @'
set -Eeuo pipefail
work="$(mktemp -d)"
cleanup() {
  case "$work" in
    /tmp/*) rm -rf -- "$work" ;;
    *) exit 1 ;;
  esac
}
trap cleanup EXIT
git clone --quiet https://github.com/nodejs/release-keys.git "$work/release-keys"
git -C "$work/release-keys" checkout --quiet --detach b28073028e6d6855cfb53bf7fa0137599c01f967
test "$(git -C "$work/release-keys" rev-parse HEAD)" = "b28073028e6d6855cfb53bf7fa0137599c01f967"
curl --fail --silent --show-error --location \
  https://nodejs.org/dist/v24.18.0/SHASUMS256.txt.asc \
  --output "$work/SHASUMS256.txt.asc"
gpgv \
  --keyring "$work/release-keys/gpg/pubring.kbx" \
  --output "$work/SHASUMS256.txt" \
  "$work/SHASUMS256.txt.asc"
grep -Fx \
  "55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742  node-v24.18.0-linux-x64.tar.xz" \
  "$work/SHASUMS256.txt"
'@
```

Expected: `gpgv` reports a good Node.js release signature and `grep` prints the one exact Linux x64 digest line. Stop the plan if either check fails.

- [ ] **Step 2: Write failing profile, schema, snapshot, and fingerprint tests**

Start `test/usb-host-prep.test.js` with:

```js
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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

test("tree snapshots reject linked content and manifest fingerprints hash raw bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-a-phase1-linked-"));
  try {
    await writeFile(path.join(root, "manifest.sha256"), "safe\n");
    assert.equal((await manifestFingerprint(path.join(root, "manifest.sha256"))).length, 64);
    await symlink(path.join(root, "manifest.sha256"), path.join(root, "linked.txt"));
    await assert.rejects(snapshotRegularTree(root), /link|junction/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run the new test and verify RED**

Run:

```powershell
node --test test/usb-host-prep.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `usb-host-prep-lib.mjs`.

- [ ] **Step 4: Implement the exact constants and Phase 2 input schema**

Create `scripts/migration/usb-host-prep-lib.mjs` with these public constants and schema shape:

```js
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { sha256File } from "./usb-handoff-lib.mjs";

export const HOST_PREP_ROOT_NAME = "Project-A-Migration-Phase-2-Host-Prep";
export const HOST_PREP_PHASE_ID = "debian-host-prep-v1";
export const HOST_PREP_MANIFEST_PATH = "CHECKSUMS/PHASE-2-HOST-PREP.sha256";
export const HOST_PREP_INBOUND_FILES = Object.freeze([
  "ISOLATION-BOUNDARY.txt",
  "PHASE-2-INPUT.json",
  "README-FIRST.txt",
  "TO-DEBIAN/apply-host-prep.sh",
  "TO-DEBIAN/collect-host-prep-evidence.sh",
  "TO-DEBIAN/preflight-host-prep.sh"
]);
export const NODE_PROVENANCE = Object.freeze({
  version: "v24.18.0",
  archiveFileName: "node-v24.18.0-linux-x64.tar.xz",
  archiveUrl: "https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz",
  archiveSha256: "55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742",
  releaseKeysCommit: "b28073028e6d6855cfb53bf7fa0137599c01f967"
});

export function createPhase2Input({
  reportFileName,
  reportSha256,
  phase1ManifestSha256
}) {
  return {
    schemaVersion: 1,
    phaseId: HOST_PREP_PHASE_ID,
    phase1: {
      bundleName: "Project-A-Migration",
      reportFileName,
      reportSha256,
      outboundManifestSha256: phase1ManifestSha256
    },
    node: { ...NODE_PROVENANCE }
  };
}
```

`validatePhase2Input` must reject non-objects, arrays, missing/extra keys at every level, a report name outside `^debian-readiness-\d{8}T\d{6}Z-[A-Za-z0-9._-]+\.txt$`, non-lowercase 64-character hashes, or any Node field differing from `NODE_PROVENANCE`. Return a deep plain-object copy containing only the approved keys.

- [ ] **Step 5: Implement deterministic link-free tree snapshots and fingerprinting**

`snapshotRegularTree(rootPath)` must:

1. Require an absolute root.
2. Walk with `lstat`, never `stat`.
3. Reject symbolic links, Windows junctions/reparse points, sockets, devices, and any type other than regular file or directory.
4. Record directories including empty ones as `{ path, type: "directory", size: 0, sha256: null }`.
5. Record files as `{ path, type: "file", size, sha256 }`.
6. Use forward-slash relative paths and lexical sorting.
7. Recheck every file's identity after hashing and reject an identity change.

`assertTreeSnapshotEqual` must compare canonical JSON encodings and throw `Phase 1 changed while building the host-prep bundle.` on any difference.

`manifestFingerprint` must hash the manifest's raw bytes with `sha256File`.

- [ ] **Step 6: Verify GREEN and Phase 1 regression**

Run:

```powershell
node --test test/usb-host-prep.test.js test/usb-migration-handoff.test.js
git diff --check
```

Expected: all new tests pass; all existing Phase 1 tests retain their prior result.

- [ ] **Step 7: Commit Task 1**

```powershell
git add -- scripts/migration/usb-host-prep-lib.mjs test/usb-host-prep.test.js
git commit -m "feat: add host prep integrity profile"
```

### Task 2: Read-only Debian preflight and reusable state classification

**Files:**
- Create: `scripts/migration/preflight-host-prep.sh`
- Modify: `test/usb-host-prep.test.js`

**Interfaces:**
- Consumes: a locally copied Phase 2 root with a verified manifest
- CLI: `/bin/bash TO-DEBIAN/preflight-host-prep.sh`
- Produces: `<stage-root>/.host-prep-preflight-ok` only on `clean` or `already-prepared`
- Produces shell functions when sourced: `host_prep_stage_root`, `host_prep_manifest_fingerprint`, `host_prep_classify`, `host_prep_verify_safety_state`
- Test-only fixture boundary: `PALZIV_HOST_PREP_TEST_MODE=1`, `PALZIV_HOST_PREP_TEST_ROOT=/tmp/project-a-host-prep-test.*`, and `PALZIV_HOST_PREP_TEST_BIN=/tmp/project-a-host-prep-test.*`

- [ ] **Step 1: Add failing static and POSIX preflight tests**

Append tests that read the script and assert:

```js
test("host prep preflight has an explicit read-only contract", async () => {
  const script = await readFile(
    new URL("../scripts/migration/preflight-host-prep.sh", import.meta.url),
    "utf8"
  );
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
```

Add a POSIX test that creates a fixture root and command stubs beneath `/tmp/project-a-host-prep-test.<random>`, copies a minimal Phase 2 stage, runs preflight with hostile `BASH_ENV`, `ENV`, `CURL_HOME`, proxy variables, `SSLKEYLOGFILE`, and `PATH`, then asserts:

- exit `0`
- stdout classification is `clean`
- exactly one `.host-prep-preflight-ok` exists
- token mode is `0600`
- token contains only the six approved fields
- hostile hooks/configuration were not executed
- no fixture system path changed

Add separate cases for `already-prepared`, partial Node state, unexpected Palziv path, port `3116` listener, active service, stale token removal, and missing HTTPS reachability. Only the first two create a token.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
node --test --test-name-pattern "host prep preflight" test/usb-host-prep.test.js
```

Expected: FAIL because `preflight-host-prep.sh` does not exist.

- [ ] **Step 3: Implement environment isolation and safe fixture routing**

Start the script with:

```bash
#!/usr/bin/env bash
set -Eeuo pipefail

unset BASH_ENV ENV CDPATH GLOBIGNORE
unset CURL_HOME CURL_CA_BUNDLE CURL_CA_PATH CURL_SSL_BACKEND
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY
unset http_proxy https_proxy all_proxy no_proxy
unset SSL_CERT_FILE SSL_CERT_DIR SSLKEYLOGFILE
umask 077

readonly SAFE_PATH="/usr/sbin:/usr/bin:/sbin:/bin"
PATH="$SAFE_PATH"
export PATH
```

Fixture mode is allowed only when all three `PALZIV_HOST_PREP_TEST_*` variables are set, both paths canonicalize beneath `/tmp/project-a-host-prep-test.`, and the root is not `/`. Partial, malformed, linked, or broad fixture paths exit before reading or writing. Production mode unsets all fixture variables and uses `/`.

Derive the stage root as the canonical parent of the script's `TO-DEBIAN` directory. Require the exact manifest location and fixed script location. Reject a linked script, stage, checksum directory, manifest, or token path.

Before inspecting the host, compute the raw manifest fingerprint and run `sha256sum --check CHECKSUMS/PHASE-2-HOST-PREP.sha256` from the canonical stage root. A missing, extra, changed, linked, or mismatched inbound file fails before host inspection or token creation.

- [ ] **Step 4: Implement `clean`, `already-prepared`, and `conflict` classification**

Use fixed commands and exact thresholds:

- `/etc/os-release`: `ID=debian`, `VERSION_ID=13`
- `uname -m`: `x86_64`
- `systemd-detect-virt`: `kvm`
- `nproc`: at least `2`
- `/proc/meminfo` `MemTotal`: at least `3_584_000` KiB
- `df -B1 --output=avail /`: at least `10_737_418_240`
- `timedatectl show --property=NTPSynchronized --value`: `yes`
- `systemctl is-active --quiet qemu-guest-agent.service`
- `systemctl is-active --quiet systemd-timesyncd.service`
- isolated `curl --disable --noproxy '*' --proto '=https' --proto-redir '=https'` probes to `https://deb.debian.org/` and `https://nodejs.org/`
- `systemctl is-active` and `is-enabled` must both reject `palziv.service` and `cloudflared.service`
- `ss -H -ltn 'sport = :3116'` must return no row

For host-owned state, classify:

- `clean`: Node targets, `palziv` user/group, and all six Palziv directories are absent.
- `already-prepared`: Node version/symlink, account/group, directories, owners, groups, and modes exactly match the specification.
- `conflict`: every other mixture or unexpected type/link.

UFW status is printed as `active`, `inactive`, or `unavailable`; it never affects state through mutation.

- [ ] **Step 5: Implement the atomic 15-minute preflight token**

Delete only `<stage-root>/.host-prep-preflight-ok` after confirming it is a regular file owned by the current user or absent. On `clean` or `already-prepared`, atomically publish mode-`0600` JSON:

```json
{
  "schemaVersion": 1,
  "phaseId": "debian-host-prep-v1",
  "manifestFingerprint": "<64 lowercase hex>",
  "stageRoot": "<canonical absolute stage path>",
  "classification": "clean",
  "createdAtEpoch": 1785436800
}
```

Generate JSON with `jq -n`; do not interpolate unescaped filesystem text. Print one JSON summary containing only `ok`, `phaseId`, `classification`, and `tokenCreated`.

Guard the entry point:

```bash
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  host_prep_preflight_main "$@"
fi
```

This lets the apply script source the read-only classification functions without re-running preflight main.

- [ ] **Step 6: Verify GREEN on Windows and WSL**

Run:

```powershell
node --test --test-name-pattern "host prep preflight" test/usb-host-prep.test.js
wsl.exe --distribution Debian -- bash -lc 'cd /mnt/c/Users/admin/Documents/Codex/Project-A/.worktrees/proxmox-migration && node --test --test-name-pattern "host prep preflight" test/usb-host-prep.test.js'
wsl.exe --distribution Debian -- bash -n /mnt/c/Users/admin/Documents/Codex/Project-A/.worktrees/proxmox-migration/scripts/migration/preflight-host-prep.sh
git diff --check
```

Expected: static tests pass on Windows; runtime tests pass without skips in WSL; Bash syntax and patch hygiene pass.

- [ ] **Step 7: Commit Task 2**

```powershell
git add -- scripts/migration/preflight-host-prep.sh test/usb-host-prep.test.js
git commit -m "feat: add Debian host prep preflight"
```

### Task 3: Explicit, constrained Debian apply script

**Files:**
- Create: `scripts/migration/apply-host-prep.sh`
- Modify: `test/usb-host-prep.test.js`

**Interfaces:**
- Consumes: sourced functions and a fresh token from `preflight-host-prep.sh`
- CLI: `sudo /usr/bin/env -i HOME=/root PATH=/usr/sbin:/usr/bin:/sbin:/bin /bin/bash TO-DEBIAN/apply-host-prep.sh --apply`
- Produces: exact Node.js installation, `palziv` account/group, and six directories
- Mutates no USB file and emits no success receipt

- [ ] **Step 1: Add failing apply-contract and WSL fake-root tests**

Add a static contract test:

```js
test("host prep apply is explicit, pinned, and excludes deployment actions", async () => {
  const script = await readFile(
    new URL("../scripts/migration/apply-host-prep.sh", import.meta.url),
    "utf8"
  );
  assert.match(script, /EUID.*0/);
  assert.match(script, /--apply/);
  assert.match(script, /900/);
  assert.match(script, /55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742/);
  assert.match(script, /node-v24\.18\.0-linux-x64\.tar\.xz/);
  for (const packageName of [
    "ca-certificates", "curl", "git", "jq", "rsync", "tar", "xz-utils"
  ]) {
    assert.match(script, new RegExp(packageName.replace("-", "\\-")));
  }
  assert.match(script, /\/usr\/sbin\/nologin/);
  assert.match(script, /\/opt\/palziv\/releases/);
  assert.match(script, /\/var\/lib\/palziv\/data/);
  assert.match(script, /\/var\/backups\/palziv/);
  assert.match(script, /\/etc\/palziv/);
  assert.doesNotMatch(
    script,
    /\b(?:systemctl|ufw|nft|iptables|cloudflared|npm|git\s+clone|rsync\s+--delete)\b/
  );
  assert.doesNotMatch(script, /\/opt\/palziv\/current|palziv\.env|itotexpress\.com/);
});
```

Add root-only WSL fixture tests that run under:

```powershell
wsl.exe --distribution Debian --user root -- bash -lc 'cd /mnt/c/Users/admin/Documents/Codex/Project-A/.worktrees/proxmox-migration && node --test --test-name-pattern "host prep apply" test/usb-host-prep.test.js'
```

Fixture mode redirects every owned absolute path beneath `/tmp/project-a-host-prep-test.<random>/root` and every mutating command to stubs beneath the same bounded fixture. Assert:

- missing root, missing/extra CLI arguments, missing token, token over 900 seconds old, changed manifest, changed stage path, and changed host classification fail before the first mutating stub
- clean apply invokes only `apt-get update`, the exact seven-package install, isolated curl, SHA-256 verification, bounded tar inspection/extraction, `addgroup`, `adduser`, `install -d`, rename, and symlink publication
- the command log contains no service, firewall, Cloudflare, npm, application, public-health, or Proxmox operation
- wrong Node archive hash prevents extraction/publication
- archive parent traversal, absolute entry, unexpected top-level entry, or escaping link fails before extraction
- a successful fixture has the exact Node target/symlink, account metadata, and six paths
- exact `already-prepared` state exits `0` with an empty mutation log
- partial state fails without repair or deletion

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
node --test --test-name-pattern "host prep apply" test/usb-host-prep.test.js
```

Expected: FAIL because `apply-host-prep.sh` does not exist.

- [ ] **Step 3: Implement root, argument, token, and state gates**

Start with isolated environment handling identical to the preflight. Require:

```bash
if [[ "${EUID}" -ne 0 ]]; then
  echo "Host preparation requires root." >&2
  exit 1
fi
if [[ "$#" -ne 1 || "$1" != "--apply" ]]; then
  echo "Usage: apply-host-prep.sh --apply" >&2
  exit 2
fi
```

Source `preflight-host-prep.sh` from the same canonical `TO-DEBIAN` directory. Recompute:

- stage canonical path
- raw manifest SHA-256
- a successful full `sha256sum --check CHECKSUMS/PHASE-2-HOST-PREP.sha256`
- token owner/type/mode
- exact six-field token schema through `jq -e`
- age in inclusive range `0..900`
- `clean` or `already-prepared` classification
- every service/listener/path/account conflict check

If classification is `already-prepared`, print:

```json
{"ok":true,"phaseId":"debian-host-prep-v1","classification":"already-prepared","changed":false}
```

and exit before any mutation.

- [ ] **Step 4: Implement the narrow package and account mutation**

For `clean`, set a step label before each operation and install exactly:

```bash
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  ca-certificates curl git jq rsync tar xz-utils
```

Use an EXIT trap that may remove only a canonical root-owned `mktemp -d /var/tmp/project-a-host-prep.XXXXXX` directory. Never remove a published Node/Palziv path in cleanup.

Create:

```bash
addgroup --system palziv
adduser --system \
  --ingroup palziv \
  --home /var/lib/palziv \
  --no-create-home \
  --shell /usr/sbin/nologin \
  palziv
```

Use `install -d` separately for the exact six paths and modes. Do not use recursive `chown` or `chmod`.

- [ ] **Step 5: Implement pinned Node download and atomic publication**

Download with:

```bash
curl --disable --fail --silent --show-error --location \
  --noproxy '*' \
  --proto '=https' \
  --proto-redir '=https' \
  'https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz' \
  --output "$WORK_ROOT/node-v24.18.0-linux-x64.tar.xz"
```

Verify the exact SHA-256 before listing or extracting. Reject archive entries outside the one `node-v24.18.0-linux-x64/` root, absolute paths, `..` segments, unexpected top-level names, and link targets resolving outside that root.

Extract into a unique `/opt/.node-v24.18.0-linux-x64.partial-*` directory with ownership/permission preservation disabled. Reject links escaping the extracted root. Normalize the final tree to `root:root` without following links, publish `/opt/node-v24.18.0-linux-x64` by no-clobber rename, create a temporary `/opt/.node-link-*` symlink, and publish `/opt/node` without replacing an existing path.

Require:

```bash
/opt/node/bin/node --version
/opt/node/bin/npm --version
```

with Node output exactly `v24.18.0`.

- [ ] **Step 6: Verify the exact final state and bounded error output**

Call the sourced state classifier again. Require `already-prepared`; otherwise exit nonzero. On success print:

```json
{"ok":true,"phaseId":"debian-host-prep-v1","classification":"prepared","changed":true}
```

On failure print only `Host preparation failed at step: <allowlisted-step-name>.` Do not enable shell tracing or print environment/token/archive content.

- [ ] **Step 7: Verify GREEN on Windows and WSL**

Run:

```powershell
node --test --test-name-pattern "host prep apply" test/usb-host-prep.test.js
wsl.exe --distribution Debian --user root -- bash -lc 'cd /mnt/c/Users/admin/Documents/Codex/Project-A/.worktrees/proxmox-migration && node --test --test-name-pattern "host prep apply" test/usb-host-prep.test.js'
wsl.exe --distribution Debian -- bash -n /mnt/c/Users/admin/Documents/Codex/Project-A/.worktrees/proxmox-migration/scripts/migration/apply-host-prep.sh
git diff --check
```

Expected: static tests pass on Windows; every runtime case passes in the bounded WSL fixture; no real WSL system path is changed.

- [ ] **Step 8: Commit Task 3**

```powershell
git add -- scripts/migration/apply-host-prep.sh test/usb-host-prep.test.js
git commit -m "feat: add guarded Debian host preparation"
```

### Task 4: Metadata-only host-preparation receipt

**Files:**
- Create: `scripts/migration/collect-host-prep-evidence.sh`
- Modify: `test/usb-host-prep.test.js`

**Interfaces:**
- CLI: `/bin/bash TO-DEBIAN/collect-host-prep-evidence.sh --usb-root /absolute/path/to/Project-A-Migration-Phase-2-Host-Prep`
- Produces: `FROM-DEBIAN/debian-host-prep-<UTC>-<safe-host>.txt`
- Produces: matching `.txt.sha256`
- Stdout: receipt basename and checksum-sidecar basename only

- [ ] **Step 1: Add failing collector contract and POSIX publication tests**

Add a static test that requires Bash strict mode, fixed environment isolation, the exact receipt grammar, atomic temporary output, `sha256sum`, FAT32 size enforcement, and the approved fields. Reject source text containing:

```text
ip address
ip route
resolv.conf
printenv
journalctl
cmdline
.bash_history
security.json
push.json
board.json
analytics.json
/etc/palziv/palziv.env
/etc/cloudflared
systemctl start
systemctl stop
systemctl enable
ufw enable
apt-get
```

Add POSIX runtime cases proving:

- clean fixture produces classification `not-applied`
- exact fixture produces `prepared`
- partial fixture produces `partial`
- output contains no seeded secret, IP address, route, DNS, process argument, environment value, log text, or forbidden filename
- only one report and one sidecar appear beneath `FROM-DEBIAN`
- report hash matches sidecar
- checksum failure removes the report it owns
- concurrent same-second execution cannot delete another invocation's completed pair
- wrong root, linked root/return directory, pre-existing output name, or oversized output fails closed

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
node --test --test-name-pattern "host prep evidence" test/usb-host-prep.test.js
```

Expected: FAIL because `collect-host-prep-evidence.sh` does not exist.

- [ ] **Step 3: Implement fixed metadata collection**

Use the same environment isolation and bounded fixture rules as preflight. Accept exactly `--usb-root <absolute>`, require the exact Phase 2 basename and exact top-level directory types, and validate `FROM-DEBIAN` without following links.

The report contains only:

```text
Project-A Debian Host Preparation Receipt
Collection UTC: <ISO UTC>
OS: Debian 13
Architecture: x86_64
CPU threshold: pass|fail
Memory threshold: pass|fail
Root free-space threshold: pass|fail
Package ca-certificates: installed <version>|absent
Package curl: installed <version>|absent
Package git: installed <version>|absent
Package jq: installed <version>|absent
Package rsync: installed <version>|absent
Package tar: installed <version>|absent
Package xz-utils: installed <version>|absent
Node: v24.18.0|absent|other
npm: <version>|absent
Palziv user: present|absent
Palziv group: present|absent
Directory <approved path>: type=<value> owner=<value> group=<value> mode=<value>
Service palziv: enabled=<yes|no|not-found> active=<yes|no|not-found>
Service cloudflared: enabled=<yes|no|not-found> active=<yes|no|not-found>
Timer palziv-backup: enabled=<yes|no|not-found> active=<yes|no|not-found>
Timer palziv-health: enabled=<yes|no|not-found> active=<yes|no|not-found>
UFW: active|inactive|unavailable
TCP 3116 listener: present|absent
Classification: prepared|partial|not-applied
```

Do not enumerate `/etc/palziv` or read any content beneath it.

- [ ] **Step 4: Implement atomic paired publication**

Use an exclusive same-second reservation directory beneath `FROM-DEBIAN`. Build the report in an owned temporary file, enforce a 64 MiB maximum, publish the report without replacement, create a single-line basename-only sidecar, and publish the sidecar without replacement. Cleanup may remove only owned temporary/reservation files and its own final report if sidecar publication fails.

Clear reservation ownership only after both final files exist and `sync` succeeds. Print basenames, not paths or content.

- [ ] **Step 5: Verify GREEN on Windows and WSL**

```powershell
node --test --test-name-pattern "host prep evidence" test/usb-host-prep.test.js
wsl.exe --distribution Debian -- bash -lc 'cd /mnt/c/Users/admin/Documents/Codex/Project-A/.worktrees/proxmox-migration && node --test --test-name-pattern "host prep evidence" test/usb-host-prep.test.js'
wsl.exe --distribution Debian -- bash -n /mnt/c/Users/admin/Documents/Codex/Project-A/.worktrees/proxmox-migration/scripts/migration/collect-host-prep-evidence.sh
git diff --check
```

Expected: static tests pass on Windows; all runtime publication/failure cases pass without skips in WSL.

- [ ] **Step 6: Commit Task 4**

```powershell
git add -- scripts/migration/collect-host-prep-evidence.sh test/usb-host-prep.test.js
git commit -m "feat: collect Debian host prep evidence"
```

### Task 5: Dedicated Phase 2 outbound and returned verifier

**Files:**
- Create: `scripts/migration/verify-usb-host-prep.mjs`
- Modify: `test/usb-host-prep.test.js`

**Interfaces:**
- CLI: `node scripts/migration/verify-usb-host-prep.mjs --handoff-root <absolute> --mode outbound|returned`
- Produces: `verifyUsbHostPrep({ handoffRoot, mode })`
- Produces outbound JSON: `{ ok, phaseId, mode, inputReferenceSha256, inboundFiles, receipt: null }`
- Produces returned JSON: `{ ok, phaseId, mode, inputReferenceSha256, inboundFiles, receipt: { fileName, sha256 } }`
- Never prints Phase 2 input JSON, report content, sidecar content, or attacker-controlled media text

- [ ] **Step 1: Add failing exact-layout and returned-verification tests**

Create a test helper that assembles an exact temporary Phase 2 tree and manifest. Add cases proving:

- outbound exact tree passes
- returned exact one-pair tree passes
- report/sidecar checksum mismatch fails
- secret-shaped receipt fails without echoing the seeded value
- extra top-level, checksum, `TO-DEBIAN`, secret, or return entry fails
- wrong entry type, symlink, Windows junction, POSIX link, directory in a file slot, or file in a directory slot fails
- invalid/extra/missing Phase 2 input field fails
- wrong Phase 1 report hash or Node provenance fails
- missing/duplicate report or sidecar fails
- unsafe sidecar path, multiple sidecar lines, wrong filename grammar, temporary file, and oversized checksum/report fail
- file replacement between approval/open/read fails
- relative roots, duplicate CLI options, unknown modes, and extra arguments fail
- the existing Phase 1 verifier still accepts the unchanged returned Phase 1 fixture

Use the receipt grammar:

```js
const RECEIPT_NAME = /^debian-host-prep-\d{8}T\d{6}Z-[A-Za-z0-9._-]+\.txt$/;
```

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
node --test --test-name-pattern "host prep verifier" test/usb-host-prep.test.js
```

Expected: FAIL because `verify-usb-host-prep.mjs` does not exist.

- [ ] **Step 3: Implement exact Phase 2 layout and manifest verification**

Require:

```js
const TOP_LEVEL = Object.freeze([
  "CHECKSUMS",
  "FROM-DEBIAN",
  "ISOLATION-BOUNDARY.txt",
  "PHASE-2-INPUT.json",
  "README-FIRST.txt",
  "SECRETS-ENCRYPTED",
  "TO-DEBIAN"
]);
const FIXED_DIRECTORY_ENTRIES = Object.freeze({
  CHECKSUMS: ["PHASE-2-HOST-PREP.sha256"],
  "SECRETS-ENCRYPTED": [],
  "TO-DEBIAN": [
    "apply-host-prep.sh",
    "collect-host-prep-evidence.sh",
    "preflight-host-prep.sh"
  ]
});
```

Reject linked ancestors/components before inspection. Approve and stably read a bounded manifest, require exactly `HOST_PREP_INBOUND_FILES` in sorted order, then hash each approved regular file from one no-follow handle with identity checks before/after.

Read and validate `PHASE-2-INPUT.json` only after its manifest entry passes. Compute `inputReferenceSha256` from the verified raw input bytes.

- [ ] **Step 4: Implement bounded returned receipt verification**

Outbound mode requires empty `FROM-DEBIAN`.

Returned mode requires exactly one receipt and sidecar. Read the bounded sidecar without following links, require one lowercase SHA-256 plus two spaces plus the receipt basename, then open the receipt without following links. Hash before UTF-8 decoding, require stable identity throughout, and run `scanReturnedReport`.

On screening failure print only:

```text
Potential secret material detected at line <n> (<rule>); do not open or share this receipt.
```

Every other media-derived failure uses fixed text without attacker-controlled names/content.

- [ ] **Step 5: Verify GREEN and unchanged Phase 1 behavior**

```powershell
node --check scripts/migration/verify-usb-host-prep.mjs
node --test test/usb-host-prep.test.js test/usb-migration-handoff.test.js
wsl.exe --distribution Debian -- bash -lc 'cd /mnt/c/Users/admin/Documents/Codex/Project-A/.worktrees/proxmox-migration && node --test test/usb-host-prep.test.js test/usb-migration-handoff.test.js'
git diff --check
```

Expected: Phase 2 tests pass; Phase 1 tests retain the same Windows/WSL pass-skip behavior.

- [ ] **Step 6: Commit Task 5**

```powershell
git add -- scripts/migration/verify-usb-host-prep.mjs test/usb-host-prep.test.js
git commit -m "feat: verify returned host prep evidence"
```

### Task 6: Guarded Windows builder and exact operator handoff

**Files:**
- Create: `scripts/migration/build-usb-host-prep.mjs`
- Create: `scripts/migration/prepare-usb-host-prep.ps1`
- Create: `deploy/usb-host-prep/README-FIRST.txt`
- Create: `deploy/usb-host-prep/ISOLATION-BOUNDARY.txt`
- Modify: `test/usb-host-prep.test.js`

**Interfaces:**
- Node CLI: `node scripts/migration/build-usb-host-prep.mjs --usb-root <absolute drive root>`
- PowerShell CLI: `.\scripts\migration\prepare-usb-host-prep.ps1 -UsbDrive D:`
- Consumes: a valid returned `Project-A-Migration` sibling
- Produces: exact outbound `Project-A-Migration-Phase-2-Host-Prep`
- Prints: one JSON object containing root name, file count, manifest fingerprint, Phase 1 report basename/hash, and `phase1Unchanged: true`

- [ ] **Step 1: Add failing builder, wrapper, race, and instruction tests**

Add Node builder cases proving:

- a valid temporary Phase 1 return produces the exact Phase 2 tree and manifest
- `PHASE-2-INPUT.json` contains only the approved metadata and exact Phase 1/Node values
- the returned Phase 1 tree snapshot is byte-for-byte unchanged after success
- tampered/secret-bearing/invalid Phase 1 blocks all Phase 2 staging
- existing Phase 2 target, publish-time empty target, linked/junction target, linked source, source replacement, insufficient space, oversized source, and manifest tampering fail
- failure cleanup removes only the builder-owned staging root and never a Phase 1 path
- JSON output contains no report body, local username, secret, or unrelated USB entry

Add PowerShell tests proving UNC/network/relative/non-root/non-removable/non-FAT32/substituted/reparse-point/low-space/old-Node destinations fail before invoking Node. The success path invokes the builder exactly once and independently invokes the Phase 2 outbound verifier.

Add README/boundary tests requiring:

- exact sibling names
- Proxmox snapshot name pattern
- removable FAT32 and mount option checks
- full out-of-band manifest fingerprint comparison
- `sha256sum --check CHECKSUMS/PHASE-2-HOST-PREP.sha256`
- verified local staging copy and second checksum pass
- environment-isolated preflight/apply/collector commands
- explicit `--apply`
- source-verified `sync` and bounded unmount
- stop-on-error wording
- no SSH/SCP/Proxmox API/remote-access instruction
- no firewall, Cloudflare, app, npm, data, secret, service, timer, or cutover instruction

Add POSIX mount-block tests for redirected/non-directory/already-mounted/wrong-source/non-vfat/missing-option/failed-mount/failed-copy/failed-checksum/failed-preflight/failed-sync/failed-unmount/signal-window behavior.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
node --test --test-name-pattern "host prep builder|host prep PowerShell|host prep instructions" test/usb-host-prep.test.js
```

Expected: FAIL because the builder, wrapper, and operator files do not exist.

- [ ] **Step 3: Write the concise isolation boundary**

`ISOLATION-BOUNDARY.txt` must state:

```text
PROJECT-A DEBIAN HOST PREPARATION - ISOLATION BOUNDARY

Codex has no remote access to Debian or Proxmox. The operator runs every server command locally.
This bundle may install only the approved Debian packages, Node.js v24.18.0, the palziv system account, and six empty restricted directories.
This bundle must not contain or inspect application data, secrets, credentials, environment files, Cloudflare material, logs, SSH material, or Proxmox authentication material.
This bundle must not deploy or start Project-A, change a firewall or network setting, install Cloudflare, create or enable a service/timer, probe the public application, or alter the Windows production host.
Stop on any checksum, fingerprint, mount, preflight, apply, collector, sync, or unmount error. Do not retry.
```

- [ ] **Step 4: Write the exact fail-closed README flow**

Use the proven literal-device/mountpoint/source verification and one-attempt cleanup structure from `deploy/usb-migration/README-FIRST.txt`, but the new file must stand alone and name only the Phase 2 root.

Its core execution sequence is:

```bash
HANDOFF_ROOT="$MOUNT_POINT/Project-A-Migration-Phase-2-Host-Prep"
cd -- "$HANDOFF_ROOT"
printf '%s\n' 'Compare the next full SHA-256 with the separately retained Codex value:'
sha256sum CHECKSUMS/PHASE-2-HOST-PREP.sha256
sha256sum --check CHECKSUMS/PHASE-2-HOST-PREP.sha256

STAGE_ROOT="$(mktemp -d "$HOME/project-a-host-prep.XXXXXX")"
cp -a -- "$HANDOFF_ROOT/." "$STAGE_ROOT/"
cd -- "$STAGE_ROOT"
sha256sum --check CHECKSUMS/PHASE-2-HOST-PREP.sha256

/usr/bin/env -i \
  HOME="$HOME" \
  PATH="/usr/sbin:/usr/bin:/sbin:/bin" \
  /bin/bash TO-DEBIAN/preflight-host-prep.sh

sudo /usr/bin/env -i \
  HOME=/root \
  PATH="/usr/sbin:/usr/bin:/sbin:/bin" \
  /bin/bash TO-DEBIAN/apply-host-prep.sh --apply

/usr/bin/env -i \
  HOME="$HOME" \
  PATH="/usr/sbin:/usr/bin:/sbin:/bin" \
  /bin/bash TO-DEBIAN/collect-host-prep-evidence.sh \
  --usb-root "$HANDOFF_ROOT"
```

On apply failure, capture its exit code, run the collector once, then stop without retry. Before local-stage deletion require the canonical path to match `$HOME/project-a-host-prep.*`; remove only that validated path. Validate the mounted source again before `sync` and one `sudo umount -- "$MOUNT_POINT"` attempt.

The README requires the operator to create `before-project-a-host-prep-YYYYMMDD-HHMM` in Proxmox immediately before `--apply`. It explicitly states that `noexec` does not block `/bin/bash script.sh`; authenticity comes from the out-of-band fingerprint, manifest verification, and stable local copy.

- [ ] **Step 5: Implement the atomic sibling builder**

Parse exactly `--usb-root <absolute>`. Derive:

```js
const phase1Root = path.join(usbRoot, "Project-A-Migration");
const finalRoot = path.join(usbRoot, HOST_PREP_ROOT_NAME);
```

Builder order:

1. Reject linked USB/Phase 1/target/staging ancestors.
2. Call `verifyUsbHandoff({ handoffRoot: phase1Root, mode: "returned" })`.
3. Require exactly one approved Phase 1 report.
4. Snapshot Phase 1.
5. Hash `Project-A-Migration/CHECKSUMS/TO-DEBIAN.sha256`.
6. Approve each fixed repository source once and copy from one no-follow handle into exclusive staging files, with identity checks before/after.
7. Atomically write `PHASE-2-INPUT.json`.
8. Write the six-entry sorted manifest.
9. Verify the staged bundle with `verifyUsbHostPrep(..., mode: "outbound")`.
10. Publish without replacement on the same volume.
11. Verify the final bundle independently.
12. Snapshot Phase 1 again and require equality.
13. Print metadata-only JSON.

Use the existing FAT32 limit and the no-clobber Windows/GNU publication behavior already proven by the Phase 1 builder. Do not import an operation that deletes an arbitrary caller path.

- [ ] **Step 6: Implement the Windows removable-media wrapper**

Follow this validation order:

1. Parse only `-UsbDrive`.
2. Require `^[A-Za-z]:$`.
3. Reject UNC/network/substituted/reparse roots before disk inspection.
4. Resolve `Win32_LogicalDisk` and require `DriveType=2`, `FileSystem=FAT32`, and at least `104857600` free bytes.
5. Require Node major version at least 22.
6. Require existing Phase 1 and absent Phase 2.
7. Invoke the Node builder exactly once.
8. Parse exactly one JSON object.
9. Invoke the committed Phase 2 verifier in outbound mode.
10. Confirm Phase 1 returned verification still passes.
11. Print the builder JSON and a separate human-readable full manifest fingerprint.

No formatting, deletion, repair, ejection, mount, or network destination is permitted.

- [ ] **Step 7: Verify GREEN on Windows and WSL**

```powershell
node --check scripts/migration/build-usb-host-prep.mjs
node --check scripts/migration/verify-usb-host-prep.mjs
node --test test/usb-host-prep.test.js test/usb-migration-handoff.test.js
wsl.exe --distribution Debian -- bash -lc 'cd /mnt/c/Users/admin/Documents/Codex/Project-A/.worktrees/proxmox-migration && node --test test/usb-host-prep.test.js test/usb-migration-handoff.test.js'
git diff --check
```

Parse the PowerShell wrapper without running it:

```powershell
$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path .\scripts\migration\prepare-usb-host-prep.ps1),
  [ref]$null,
  [ref]$parseErrors
) | Out-Null
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
```

Expected: all focused suites pass; WSL POSIX cases have zero skips; syntax and patch hygiene pass.

- [ ] **Step 8: Commit Task 6**

```powershell
git add -- `
  deploy/usb-host-prep/README-FIRST.txt `
  deploy/usb-host-prep/ISOLATION-BOUNDARY.txt `
  scripts/migration/build-usb-host-prep.mjs `
  scripts/migration/prepare-usb-host-prep.ps1 `
  test/usb-host-prep.test.js
git commit -m "feat: build USB host prep handoff"
```

### Task 7: Full verification, review, and guarded physical publication

**Files:**
- Verify: all Task 1-6 files
- Write only after all gates pass: `D:\Project-A-Migration-Phase-2-Host-Prep`
- Never modify: `D:\Project-A-Migration`

**Interfaces:**
- Consumes: reviewed repository implementation and returned Phase 1 evidence
- Produces: one verified outbound Phase 2 sibling bundle
- Produces: one full out-of-band SHA-256 fingerprint for the user to retain

- [ ] **Step 1: Run all syntax gates**

```powershell
node --check scripts/migration/usb-host-prep-lib.mjs
node --check scripts/migration/build-usb-host-prep.mjs
node --check scripts/migration/verify-usb-host-prep.mjs
node --check scripts/migration/verify-usb-handoff.mjs
node --check server.js
node --check security.js
node --check public/app.js
```

```powershell
$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path .\scripts\migration\prepare-usb-host-prep.ps1),
  [ref]$null,
  [ref]$parseErrors
) | Out-Null
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
```

```powershell
wsl.exe --distribution Debian -- bash -n /mnt/c/Users/admin/Documents/Codex/Project-A/.worktrees/proxmox-migration/scripts/migration/preflight-host-prep.sh
wsl.exe --distribution Debian -- bash -n /mnt/c/Users/admin/Documents/Codex/Project-A/.worktrees/proxmox-migration/scripts/migration/apply-host-prep.sh
wsl.exe --distribution Debian -- bash -n /mnt/c/Users/admin/Documents/Codex/Project-A/.worktrees/proxmox-migration/scripts/migration/collect-host-prep-evidence.sh
```

Expected: every syntax/parser command exits `0`.

- [ ] **Step 2: Run focused Windows and WSL suites**

```powershell
node --test test/usb-host-prep.test.js test/usb-migration-handoff.test.js
wsl.exe --distribution Debian -- bash -lc 'cd /mnt/c/Users/admin/Documents/Codex/Project-A/.worktrees/proxmox-migration && node --test test/usb-host-prep.test.js test/usb-migration-handoff.test.js'
```

Expected: zero failures; all Phase 2 POSIX runtime cases execute without skips in WSL.

- [ ] **Step 3: Re-run signed Node provenance verification**

Repeat Task 1 Step 1 exactly. Expected: good signature plus the exact approved archive digest.

- [ ] **Step 4: Run complete regression and hygiene gates**

```powershell
npm test
git diff --check
git status --short
git diff --stat
```

Expected: complete suite has zero failures; no whitespace errors; only approved Phase 2 files/commits belong to this plan. Do not stage the pre-existing broader migration files.

- [ ] **Step 5: Run per-task and whole-branch reviews**

For every completed task, require:

- spec compliance approved
- code quality approved
- no open Critical or Important finding
- every fix round independently re-reviewed

Then create a whole-branch review package from the branch merge-base through `HEAD`. The reviewer must explicitly inspect:

- Phase 1 immutability
- same-media authenticity mitigation
- link/junction and TOCTOU boundaries
- shell environment isolation
- test-only fixture confinement
- exact apply allowlist
- absence of services/firewall/Cloudflare/app/data/secrets/cutover
- failure cleanup containment
- returned report redaction/non-echo behavior
- physical-drive no-clobber behavior

Stop before physical publication on any unresolved load-bearing finding.

- [ ] **Step 6: Inspect `D:` without changing it**

```powershell
$usb = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='D:'"
$usb | Select-Object DeviceID, VolumeName, FileSystem, DriveType, Size, FreeSpace
Test-Path -LiteralPath 'D:\Project-A-Migration'
Test-Path -LiteralPath 'D:\Project-A-Migration-Phase-2-Host-Prep'
node .\scripts\migration\verify-usb-handoff.mjs `
  --handoff-root D:\Project-A-Migration `
  --mode returned
```

Proceed only when `D:` is removable FAT32 with at least 100 MB free, Phase 1 returned verification passes, and Phase 2 does not exist. If Phase 2 exists, stop without deleting or replacing it.

- [ ] **Step 7: Snapshot Phase 1 and run the physical wrapper exactly once**

Use `snapshotRegularTree` to save the pre-write Phase 1 snapshot in a temporary local path outside the USB. Then run:

```powershell
.\scripts\migration\prepare-usb-host-prep.ps1 -UsbDrive D:
```

Expected: one successful builder JSON object, one successful outbound-verifier JSON object, and one full manifest fingerprint. Do not retry automatically.

- [ ] **Step 8: Independently verify both bundles and unchanged Phase 1**

```powershell
node .\scripts\migration\verify-usb-handoff.mjs `
  --handoff-root D:\Project-A-Migration `
  --mode returned

node .\scripts\migration\verify-usb-host-prep.mjs `
  --handoff-root D:\Project-A-Migration-Phase-2-Host-Prep `
  --mode outbound

Get-ChildItem -LiteralPath 'D:\Project-A-Migration-Phase-2-Host-Prep' -Force -Recurse |
  Select-Object FullName, Mode, Length, LastWriteTime

Get-FileHash -Algorithm SHA256 `
  -LiteralPath 'D:\Project-A-Migration-Phase-2-Host-Prep\CHECKSUMS\PHASE-2-HOST-PREP.sha256'
```

Compare the post-write Phase 1 snapshot with the saved pre-write snapshot. Require exact equality. Confirm:

- exact Phase 2 top-level and nested tree
- empty `FROM-DEBIAN` and `SECRETS-ENCRYPTED`
- no link/junction/reparse point
- no partial staging residue
- every file below the FAT32 limit
- every non-secret input covered by the manifest
- no unrelated USB entry changed

- [ ] **Step 9: Hand off the authenticated operator step**

Tell the user:

1. The exact Phase 2 USB path.
2. The full 64-character out-of-band manifest fingerprint to retain separately.
3. Phase 1 remains verified and unchanged.
4. Codex made no Debian or Proxmox connection.
5. They must create the named Proxmox snapshot, safely eject the USB, attach it to Debian, and follow the new `README-FIRST.txt`.
6. They must stop and return the USB on any fingerprint, checksum, mount, preflight, apply, collector, sync, or unmount error.
7. They must not open or paste the returned receipt; Codex will run the dedicated returned verifier first.
