# USB-Only Codex-Isolated Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a checksummed USB handoff that lets the user collect migration-readiness evidence from the Debian VM without giving Codex any network or administrative path to Debian or Proxmox.

**Architecture:** A Windows-facing PowerShell entry point validates that the selected drive is a removable FAT32 volume, then invokes a cross-platform Node.js builder that atomically creates `Project-A-Migration`. A Bash collector runs locally on Debian, reads a fixed allowlist of non-secret system facts, and atomically writes a report plus SHA-256 sidecar under `FROM-DEBIAN`; a Node.js verifier checks every inbound and returned hash and rejects likely secret material before any report is reviewed.

**Tech Stack:** Node.js 22+ ES modules, built-in `node:test`, Windows PowerShell 5.1+, Bash 5+, Debian 13 core utilities, SHA-256.

## Global Constraints

- Codex must not receive SSH, Proxmox, console, VPN, browser-session, API, or remote-desktop access to the Debian VM or Proxmox host.
- The user runs every Debian or Proxmox command locally.
- Files move between the Codex laptop and Debian only through the dedicated USB drive currently mounted as `D:` on Windows.
- Codex may read redacted reports only after the user physically returns the USB to the laptop and the return verifier passes.
- Passwords, private SSH keys, recovery codes, environment-secret values, Cloudflare credentials, runtime security data, and push credentials must never be shown to Codex.
- The Debian VM may access the internet directly for approved application and operating-system dependencies, but it must not initiate a callback or management session to Codex.
- Inventory collection must not change a production service, firewall rule, account, package, tunnel, runtime file, or system configuration.
- The USB is FAT32; every individual artifact must be smaller than 4,294,967,295 bytes.
- The builder must never overwrite an existing `Project-A-Migration` directory.
- The collector may write only a final report, its checksum sidecar, and temporary forms of those two files beneath `FROM-DEBIAN`.
- No new npm dependency is allowed.
- The current Windows production host and its runtime data remain intact until the controlled Debian cutover and rollback window are complete.

---

## File Structure

- Create `scripts/migration/usb-handoff-lib.mjs`: shared path-containment, SHA-256 manifest, FAT32-size, atomic-write, and report-screening primitives.
- Create `scripts/migration/build-usb-handoff.mjs`: cross-platform CLI that assembles the handoff beneath a caller-supplied drive root.
- Create `scripts/migration/prepare-usb-handoff.ps1`: operator-facing Windows entry point that accepts only a removable FAT32 drive and invokes the Node.js builder.
- Create `scripts/migration/collect-debian-readiness.sh`: allowlisted, read-only Debian inventory collector.
- Create `scripts/migration/verify-usb-handoff.mjs`: outbound and returned-bundle verifier that never prints report bodies.
- Create `deploy/usb-migration/README-FIRST.txt`: exact Windows, Debian mount, checksum, collector, unmount, and return-verification commands.
- Create `deploy/usb-migration/ISOLATION-BOUNDARY.txt`: concise statement of permitted and forbidden access/data.
- Create `test/usb-migration-handoff.test.js`: integrity-library, builder, collector-contract, runtime-collector, and return-verifier tests.
- Modify `docs/PROXMOX_MIGRATION_RUNBOOK.md:22`: add the USB inventory gate before infrastructure preparation.
- Modify `test/proxmox-runbook-contract.test.js:9`: require the runbook to preserve the Codex-isolation workflow.

### Task 1: Shared USB integrity and redaction primitives

**Files:**
- Create: `scripts/migration/usb-handoff-lib.mjs`
- Create: `test/usb-migration-handoff.test.js`

**Interfaces:**
- Produces: `FAT32_MAX_FILE_BYTES = 4_294_967_294`
- Produces: `assertPathWithin(rootPath, candidatePath) -> absolute candidate path or throws`
- Produces: `assertFat32CompatibleSize(size, label) -> undefined or throws`
- Produces: `sha256File(filePath) -> Promise<string>`
- Produces: `writeSha256Manifest({ rootPath, relativePaths, manifestPath }) -> Promise<Array<{ path, sha256 }>>`
- Produces: `verifySha256Manifest({ rootPath, manifestPath }) -> Promise<Array<{ path, sha256 }>>`
- Produces: `scanReturnedReport(text) -> { ok: boolean, findings: Array<{ line, rule }> }`

- [ ] **Step 1: Write the failing containment, size, and hash tests**

Add imports and focused tests:

```js
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
```

- [ ] **Step 2: Write the failing manifest-path and returned-report screening tests**

Append:

```js
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
```

- [ ] **Step 3: Run the new test and verify RED**

Run:

```powershell
node --test test/usb-migration-handoff.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `usb-handoff-lib.mjs`.

- [ ] **Step 4: Implement strict path, size, and hashing primitives**

Create `usb-handoff-lib.mjs` with these foundations:

```js
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const FAT32_MAX_FILE_BYTES = 4_294_967_294;
const MANIFEST_LINE = /^([a-f0-9]{64}) {2}([^\r\n]+)$/;

export function assertPathWithin(rootPath, candidatePath) {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".") return candidate;
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path is outside the handoff root: ${candidate}`);
  }
  return candidate;
}

export function assertFat32CompatibleSize(size, label) {
  if (!Number.isSafeInteger(size) || size < 0 || size > FAT32_MAX_FILE_BYTES) {
    throw new Error(`${label} is not compatible with the FAT32 single-file limit`);
  }
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}
```

Use `path.posix.normalize` for manifest entries, reject empty, absolute, backslash, drive-letter, and `..` forms, and call `assertPathWithin` after converting `/` to the host separator.

- [ ] **Step 5: Implement atomic manifest writing and verification**

`writeSha256Manifest` must:

1. Normalize and lexically sort unique relative paths.
2. `stat` every source and reject non-files and FAT32-incompatible sizes.
3. Create the checksum directory.
4. Write `<64 lowercase hex><two spaces><forward-slash path>\n` to `${manifestPath}.partial`.
5. Rename the partial file to the final path.
6. Remove the partial file on failure.

`verifySha256Manifest` must parse every non-empty line with `MANIFEST_LINE`, reject duplicate paths, verify containment and file size, hash each file, and throw `Checksum mismatch for <relative path>` without printing file contents.

Use this structure so normalization and containment are shared by both operations:

```js
function normalizeManifestPath(value) {
  const raw = String(value || "");
  if (!raw || raw.includes("\\") || /^[A-Za-z]:/.test(raw) || path.posix.isAbsolute(raw)) {
    throw new Error(`Unsafe manifest path: ${raw}`);
  }
  const normalized = path.posix.normalize(raw);
  if (normalized === ".." || normalized.startsWith("../") || normalized === ".") {
    throw new Error(`Unsafe manifest path: ${raw}`);
  }
  return normalized;
}

function manifestPathToHostPath(rootPath, relativePath) {
  return assertPathWithin(
    rootPath,
    path.join(path.resolve(rootPath), ...normalizeManifestPath(relativePath).split("/"))
  );
}

export async function writeSha256Manifest({ rootPath, relativePaths, manifestPath }) {
  const root = path.resolve(rootPath);
  const finalPath = assertPathWithin(root, manifestPath);
  const partialPath = assertPathWithin(root, `${finalPath}.partial`);
  const paths = [...new Set(relativePaths.map(normalizeManifestPath))].sort();
  const records = [];

  for (const relativePath of paths) {
    const filePath = manifestPathToHostPath(root, relativePath);
    const metadata = await stat(filePath);
    if (!metadata.isFile()) throw new Error(`Manifest source is not a file: ${relativePath}`);
    assertFat32CompatibleSize(metadata.size, relativePath);
    records.push({ path: relativePath, sha256: await sha256File(filePath) });
  }

  await mkdir(path.dirname(finalPath), { recursive: true });
  try {
    await writeFile(
      partialPath,
      `${records.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n")}\n`,
      { flag: "wx" }
    );
    await rename(partialPath, finalPath);
  } catch (error) {
    await rm(partialPath, { force: true });
    throw error;
  }
  return records;
}

export async function verifySha256Manifest({ rootPath, manifestPath }) {
  const root = path.resolve(rootPath);
  const raw = await readFile(assertPathWithin(root, manifestPath), "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const seen = new Set();
  const records = [];
  for (const line of lines) {
    const match = MANIFEST_LINE.exec(line);
    if (!match) throw new Error("Invalid SHA-256 manifest line");
    const relativePath = normalizeManifestPath(match[2]);
    if (seen.has(relativePath)) throw new Error(`Duplicate manifest path: ${relativePath}`);
    seen.add(relativePath);
    const filePath = manifestPathToHostPath(root, relativePath);
    const metadata = await stat(filePath);
    if (!metadata.isFile()) throw new Error(`Manifest entry is not a file: ${relativePath}`);
    assertFat32CompatibleSize(metadata.size, relativePath);
    const actual = await sha256File(filePath);
    if (actual !== match[1]) throw new Error(`Checksum mismatch for ${relativePath}`);
    records.push({ path: relativePath, sha256: actual });
  }
  return records;
}
```

- [ ] **Step 6: Implement secret-shaped report screening**

Use line-by-line rules whose returned findings contain only line number and rule name:

```js
const REPORT_RULES = Object.freeze([
  {
    name: "secret-assignment",
    pattern: /(?:^|[\s"'])(?:[A-Z0-9]+_)*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|COOKIE|SESSION)(?:_[A-Z0-9]+)*\s*[:=]\s*\S+/i
  },
  {
    name: "authorization-value",
    pattern: /^\s*(?:authorization|proxy-authorization)\s*:\s*\S+/i
  },
  {
    name: "private-key-material",
    pattern: /-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----/i
  },
  {
    name: "cloudflare-credential-json",
    pattern: /"(?:AccountTag|TunnelSecret|TunnelID)"\s*:\s*"[^"]+"/i
  }
]);

export function scanReturnedReport(text) {
  const findings = [];
  const lines = String(text).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    for (const rule of REPORT_RULES) {
      if (rule.pattern.test(lines[index])) {
        findings.push({ line: index + 1, rule: rule.name });
      }
    }
  }
  return { ok: findings.length === 0, findings };
}
```

Return `{ ok: findings.length === 0, findings }`; never include the matching line or captured value.

- [ ] **Step 7: Verify GREEN and commit**

Run:

```powershell
node --test test/usb-migration-handoff.test.js
git diff --check
git add scripts/migration/usb-handoff-lib.mjs test/usb-migration-handoff.test.js
git commit -m "feat: add USB handoff integrity primitives"
```

Expected: all tests in `usb-migration-handoff.test.js` pass.

### Task 2: Read-only Debian readiness collector

**Files:**
- Create: `scripts/migration/collect-debian-readiness.sh`
- Modify: `test/usb-migration-handoff.test.js`

**Interfaces:**
- Consumes: a USB root containing existing `TO-DEBIAN` and writable `FROM-DEBIAN` directories.
- CLI: `bash TO-DEBIAN/collect-debian-readiness.sh [--usb-root /absolute/path/to/Project-A-Migration]`
- Produces: `FROM-DEBIAN/debian-readiness-<UTC timestamp>-<safe hostname>.txt`
- Produces: `FROM-DEBIAN/debian-readiness-<UTC timestamp>-<safe hostname>.txt.sha256`
- Stdout: one line naming the final report and one line naming the checksum; no report content.

- [ ] **Step 1: Write the failing collector contract test**

Append:

```js
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
```

- [ ] **Step 2: Write the failing Linux runtime and failure-cleanup tests**

Extend the filesystem import with `copyFile` and `readdir`, import `spawn`, and add this process helper:

```js
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";

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
```

Then add:

```js
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
```

- [ ] **Step 3: Run the targeted test and verify RED**

Run:

```powershell
node --test test/usb-migration-handoff.test.js
```

Expected: FAIL because `collect-debian-readiness.sh` does not exist.

- [ ] **Step 4: Implement argument, path, and atomic-output controls**

Start the collector with:

```bash
#!/usr/bin/env bash
set -Eeuo pipefail
export LC_ALL=C
umask 077

SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname -- "$SCRIPT_PATH")"
USB_ROOT="$(readlink -f -- "$SCRIPT_DIR/..")"

if [[ "${1:-}" == "--usb-root" ]]; then
  [[ -n "${2:-}" && "${2:-}" == /* ]] || {
    printf 'ERROR: --usb-root requires an absolute path.\n' >&2
    exit 2
  }
  USB_ROOT="$(readlink -f -- "$2")"
  shift 2
fi
[[ "$#" -eq 0 ]] || {
  printf 'ERROR: unexpected argument.\n' >&2
  exit 2
}

FROM_DIR="$USB_ROOT/FROM-DEBIAN"
[[ -d "$FROM_DIR" && ! -L "$FROM_DIR" && -w "$FROM_DIR" ]] || {
  printf 'ERROR: FROM-DEBIAN must be a writable, non-symlink directory.\n' >&2
  exit 3
}
[[ "$(readlink -f -- "$FROM_DIR")" == "$USB_ROOT/FROM-DEBIAN" ]] || {
  printf 'ERROR: FROM-DEBIAN resolves outside the handoff root.\n' >&2
  exit 3
}
```

Create both output names from `date -u +%Y%m%dT%H%M%SZ` and a hostname reduced to `[A-Za-z0-9._-]`. Use `mktemp --tmpdir="$FROM_DIR" ".debian-readiness.XXXXXXXX.tmp"` for the report and checksum temporary paths. Install an `EXIT` trap that removes only those two validated temporary paths. Rename the report first, create its sidecar from the final report, then rename the sidecar.

- [ ] **Step 5: Implement tolerant, allowlisted inspection helpers**

Use helpers that report absence or command failure without stopping the remaining collection:

```bash
section() {
  printf '\n## %s\n' "$1"
}

run_safe() {
  local label="$1"
  shift
  printf '\n[%s]\n' "$label"
  if ! command -v -- "$1" >/dev/null 2>&1; then
    printf 'unavailable: %s\n' "$1"
    return 0
  fi
  "$@" 2>&1 || printf 'status: unavailable-or-permission-required\n'
}

service_state() {
  local unit="$1"
  printf '%s enabled=' "$unit"
  systemctl is-enabled "$unit" 2>/dev/null || printf 'unavailable'
  printf ' active='
  systemctl is-active "$unit" 2>/dev/null || printf 'unavailable'
  printf '\n'
}
```

Never pass a variable-derived command name or service name. The fixed service allowlist is:

```text
ssh.service
qemu-guest-agent.service
systemd-timesyncd.service
palziv.service
cloudflared.service
```

- [ ] **Step 6: Emit the permitted inventory sections**

Write these fixed sections into the temporary report:

1. `Collection`: UTC time, `sha256sum "$SCRIPT_PATH"`, safe hostname.
2. `Operating system`: only `PRETTY_NAME`, `ID`, and `VERSION_ID` parsed from `/etc/os-release`; `uname -r`; `uname -m`; `systemd-detect-virt`.
3. `Accounts`: only the first colon-delimited field from `getent passwd` and `getent group`.
4. `Compute and storage`: `getconf _NPROCESSORS_ONLN`, `awk '/^MemTotal:/{print $1, $2, $3}' /proc/meminfo`, `lsblk --bytes --output NAME,TYPE,SIZE,FSTYPE,MOUNTPOINTS`, and `df --block-size=1 --output=source,fstype,size,used,avail,pcent,target`.
5. `Network`: `ip -brief address`, `ip route show`, and only `nameserver` rows from `/etc/resolv.conf`.
6. `Time`: `timedatectl show --property=Timezone --property=NTPSynchronized --property=TimeUSec`.
7. `Prerequisites`: first-line version or `unavailable` for `git`, `node`, `npm`, `cloudflared`, `rsync`, `jq`, `curl`, `sha256sum`, `bash`, and `systemctl`.
8. `Services`: `is-enabled` and `is-active` for the fixed five-unit allowlist.
9. `Firewall and listeners`: `ufw status` and `ss -H -lntu`; never use process-display flags.
10. `Target directory metadata`: `stat --format='%n|type=%F|owner=%U|group=%G|mode=%a'` for `/opt/palziv`, `/opt/palziv/current`, `/var/lib/palziv`, `/var/lib/palziv/data`, `/etc/palziv`, `/etc/cloudflared`, and `/var/backups/palziv`; do not enumerate their contents.
11. `Approved outbound checks`: DNS resolution and a `curl --silent --show-error --output /dev/null --connect-timeout 5 --max-time 10 --write-out` status for fixed HTTPS endpoints at `nodejs.org`, `github.com`, `api.open-meteo.com`, and `updates.cloudflare.com`.

Do not read environment variables, process arguments, service command lines, logs, journals, shell history, SSH material, application JSON, or files beneath the target directories.

- [ ] **Step 7: Complete the atomic report and checksum**

After collection:

```bash
mv -- "$REPORT_TEMP" "$REPORT_FINAL"
REPORT_TEMP=""

(
  cd -- "$FROM_DIR"
  sha256sum -- "$(basename -- "$REPORT_FINAL")"
) > "$CHECKSUM_TEMP"
mv -- "$CHECKSUM_TEMP" "$CHECKSUM_FINAL"
CHECKSUM_TEMP=""

printf 'Report: %s\n' "$REPORT_FINAL"
printf 'Checksum: %s\n' "$CHECKSUM_FINAL"
```

- [ ] **Step 8: Verify syntax, GREEN, and commit**

Run:

```powershell
node --test test/usb-migration-handoff.test.js
bash -n scripts/migration/collect-debian-readiness.sh
git diff --check
git add scripts/migration/collect-debian-readiness.sh test/usb-migration-handoff.test.js
git commit -m "feat: add redacted Debian readiness collector"
```

Expected: the Node test passes; on Windows the two POSIX runtime cases report as skipped, while the static contract still passes. The available Bash 5.2 runtime exits `0` for the syntax check.

### Task 3: Atomic Windows USB builder and operator instructions

**Files:**
- Create: `scripts/migration/build-usb-handoff.mjs`
- Create: `scripts/migration/prepare-usb-handoff.ps1`
- Create: `deploy/usb-migration/README-FIRST.txt`
- Create: `deploy/usb-migration/ISOLATION-BOUNDARY.txt`
- Modify: `test/usb-migration-handoff.test.js`

**Interfaces:**
- Consumes: `writeSha256Manifest` and `verifySha256Manifest` from Task 1.
- Produces: `buildUsbHandoff({ usbRoot, sourceRoot }) -> { handoffRoot, manifestPath, files }`
- Node CLI: `node scripts/migration/build-usb-handoff.mjs --usb-root <absolute drive root>`
- PowerShell CLI: `.\scripts\migration\prepare-usb-handoff.ps1 -UsbDrive D:`
- Produces this exact tree:

```text
Project-A-Migration/
├── README-FIRST.txt
├── ISOLATION-BOUNDARY.txt
├── TO-DEBIAN/
│   └── collect-debian-readiness.sh
├── FROM-DEBIAN/
├── CHECKSUMS/
│   └── TO-DEBIAN.sha256
└── SECRETS-ENCRYPTED/
```

- [ ] **Step 1: Write the failing builder test**

Append:

```js
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
```

- [ ] **Step 2: Write the failing no-overwrite and instruction-contract tests**

Append:

```js
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

test("USB instructions preserve the approved operator and isolation boundary", async () => {
  const readme = await readFile(new URL("../deploy/usb-migration/README-FIRST.txt", import.meta.url), "utf8");
  const boundary = await readFile(new URL("../deploy/usb-migration/ISOLATION-BOUNDARY.txt", import.meta.url), "utf8");
  const wrapper = await readFile(new URL("../scripts/migration/prepare-usb-handoff.ps1", import.meta.url), "utf8");

  assert.match(readme, /mount -o nodev,nosuid,noexec/);
  assert.match(readme, /sha256sum --check CHECKSUMS\/TO-DEBIAN\.sha256/);
  assert.match(readme, /bash TO-DEBIAN\/collect-debian-readiness\.sh/);
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
```

- [ ] **Step 3: Run the targeted test and verify RED**

Run:

```powershell
node --test test/usb-migration-handoff.test.js
```

Expected: FAIL because the builder, wrapper, and instruction files do not exist.

- [ ] **Step 4: Write the two operator text files**

`ISOLATION-BOUNDARY.txt` must state:

```text
PROJECT-A CODEX-ISOLATION BOUNDARY

Codex has no remote access to this Debian VM or the Proxmox host.
The user is the only person who runs commands on Debian or Proxmox.
Debian remains internet-connected for approved operating-system and application dependencies.
Only this USB transfers Codex-prepared files and redacted readiness reports.
Never place passwords, private SSH keys, recovery codes, tokens, API keys, Cloudflare credentials,
environment values, application runtime JSON, or backup-encryption keys in a returned report.
Stop immediately if an instruction requests remote access for Codex or asks you to print a secret.
```

`README-FIRST.txt` must provide these phases:

1. Windows preparation command: `.\scripts\migration\prepare-usb-handoff.ps1 -UsbDrive D:`.
2. Safe removal and physical USB attachment to the Debian VM.
3. Local device identification with `lsblk -f`.
4. An interactive `read -r -p` command for the user to supply the exact `/dev/...` partition returned by `lsblk`.
5. Mount at `/mnt/project-a-usb` with `nodev,nosuid,noexec,uid="$(id -u)",gid="$(id -g)",umask=077` so the non-root operator can write the report while FAT32 receives restrictive effective permissions.
6. `cd /mnt/project-a-usb/Project-A-Migration`.
7. `sha256sum --check CHECKSUMS/TO-DEBIAN.sha256`.
8. `bash TO-DEBIAN/collect-debian-readiness.sh`.
9. `sync`, leave the mount, and `sudo umount /mnt/project-a-usb`.
10. Return the USB to the laptop without opening the report.
11. Run `node scripts/migration/verify-usb-handoff.mjs --handoff-root D:\Project-A-Migration --mode returned`.

Use this copy-ready Debian command block:

```bash
lsblk -f
read -r -p "Enter the USB partition path shown by lsblk (example: /dev/sdb1): " USB_DEVICE
case "$USB_DEVICE" in
  /dev/*) ;;
  *) printf 'STOP: invalid device path.\n' >&2; exit 1 ;;
esac
sudo mkdir -p /mnt/project-a-usb
MOUNT_OPTIONS="nodev,nosuid,noexec,uid=$(id -u),gid=$(id -g),umask=077"
sudo mount -o "$MOUNT_OPTIONS" -- "$USB_DEVICE" /mnt/project-a-usb
cd /mnt/project-a-usb/Project-A-Migration
sha256sum --check CHECKSUMS/TO-DEBIAN.sha256 || {
  printf 'STOP: outbound checksum verification failed.\n' >&2
  exit 1
}
bash TO-DEBIAN/collect-debian-readiness.sh || {
  printf 'STOP: readiness collection failed.\n' >&2
  exit 1
}
sync
cd /
sudo umount /mnt/project-a-usb
```

Each phase must include an explicit stop condition for a failed checksum, wrong drive, unexpected existing bundle, failed mount, collector error, or return-verifier error.

- [ ] **Step 5: Implement the cross-platform atomic builder**

`build-usb-handoff.mjs` must export `buildUsbHandoff` and run its CLI only when invoked directly. Parse only `--usb-root`; use the repository root derived from `import.meta.url`.

The implementation must:

1. Require an existing absolute USB root directory.
2. Refuse if `Project-A-Migration` already exists.
3. Create a uniquely named staging directory directly beneath the supplied USB root.
4. Create the four child directories in staging.
5. Copy the two text files and collector from the fixed repository paths.
6. Check every copied file against the FAT32 limit.
7. Write and immediately verify `CHECKSUMS/TO-DEBIAN.sha256`.
8. Rename staging to `Project-A-Migration` on the same volume.
9. On failure, resolve and verify that the staging path remains within the supplied USB root before removing that staging directory.
10. Print one JSON summary without file contents.

Use:

```js
const HANDOFF_NAME = "Project-A-Migration";
const TRANSFER_FILES = Object.freeze([
  ["deploy/usb-migration/README-FIRST.txt", "README-FIRST.txt"],
  ["deploy/usb-migration/ISOLATION-BOUNDARY.txt", "ISOLATION-BOUNDARY.txt"],
  ["scripts/migration/collect-debian-readiness.sh", "TO-DEBIAN/collect-debian-readiness.sh"]
]);
```

- [ ] **Step 6: Implement the Windows removable-drive guard**

`prepare-usb-handoff.ps1` must use:

```powershell
[CmdletBinding()]
param(
    [Parameter()]
    [ValidatePattern('^[A-Za-z]:$')]
    [string]$UsbDrive = 'D:'
)

$ErrorActionPreference = 'Stop'
$logicalDisk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$UsbDrive'"
if (-not $logicalDisk) {
    throw "Drive $UsbDrive was not found."
}
if ([int]$logicalDisk.DriveType -ne 2) {
    throw "Drive $UsbDrive is not reported by Windows as removable media."
}
if ([string]$logicalDisk.FileSystem -ne 'FAT32') {
    throw "Drive $UsbDrive must be FAT32 for this approved handoff."
}
if ([uint64]$logicalDisk.FreeSpace -lt 100MB) {
    throw "Drive $UsbDrive has less than 100 MB free."
}
```

Resolve `node.exe`, require major version 22 or newer, resolve the builder relative to `$PSScriptRoot`, invoke it with `--usb-root "$UsbDrive\"`, and fail on a nonzero `$LASTEXITCODE`. Do not format the drive, delete an old bundle, copy secrets, or accept a network destination.

Use:

```powershell
$node = Get-Command node.exe -ErrorAction Stop
$nodeVersion = (& $node.Source --version).Trim()
if ($nodeVersion -notmatch '^v(?<major>\d+)\.') {
    throw "Could not determine the Node.js version."
}
if ([int]$Matches.major -lt 22) {
    throw "Node.js 22 or newer is required."
}
$builder = Join-Path $PSScriptRoot 'build-usb-handoff.mjs'
& $node.Source $builder --usb-root "$UsbDrive\"
if ($LASTEXITCODE -ne 0) {
    throw "USB handoff creation failed."
}
```

- [ ] **Step 7: Verify GREEN and commit**

Run:

```powershell
node --test test/usb-migration-handoff.test.js
$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path .\scripts\migration\prepare-usb-handoff.ps1),
  [ref]$null,
  [ref]$parseErrors
) | Out-Null
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
git diff --check
git add deploy/usb-migration scripts/migration/build-usb-handoff.mjs scripts/migration/prepare-usb-handoff.ps1 test/usb-migration-handoff.test.js
git commit -m "feat: build guarded USB migration handoff"
```

Expected: targeted tests and PowerShell parsing pass.

### Task 4: Returned-bundle verification and migration-runbook bridge

**Files:**
- Create: `scripts/migration/verify-usb-handoff.mjs`
- Modify: `test/usb-migration-handoff.test.js`
- Modify: `docs/PROXMOX_MIGRATION_RUNBOOK.md:22`
- Modify: `test/proxmox-runbook-contract.test.js:9`

**Interfaces:**
- Consumes: `verifySha256Manifest` and `scanReturnedReport` from Task 1.
- Produces: `verifyUsbHandoff({ handoffRoot, mode }) -> { ok, mode, inboundFiles, reports }`
- CLI: `node scripts/migration/verify-usb-handoff.mjs --handoff-root <absolute path> --mode outbound|returned`
- `outbound` mode requires a valid inbound tree and allows an empty `FROM-DEBIAN`.
- `returned` mode additionally requires one or more report/sidecar pairs, rejects temporary or unexpected return files, verifies each sidecar, and screens each report before returning success.

- [ ] **Step 1: Write the failing outbound and returned verification tests**

Append:

```js
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

    const reportName = "debian-readiness-20260729T160000Z-palziv-prod.txt";
    const reportPath = path.join(handoff, "FROM-DEBIAN", reportName);
    await writeFile(reportPath, "## Collection\nHostname: palziv-prod\nNode: v24.8.0\n");
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
    assert.equal(summary.ok, true);
    assert.equal(summary.reports.length, 1);
    assert.equal(summary.reports[0].fileName, reportName);
  } finally {
    await rm(usbRoot, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Write the failing tamper and secret-screening tests**

Append:

```js
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
    assert.match(secretResult.stderr, /potential secret material.*line 1/i);
    assert.doesNotMatch(`${secretResult.stdout}${secretResult.stderr}`, /must-never-be-echoed/);

    await writeFile(reportPath, "safe report changed after hashing\n");
    const tamperResult = await run(process.execPath, [
      "scripts/migration/verify-usb-handoff.mjs",
      "--handoff-root", handoff,
      "--mode", "returned"
    ]);
    assert.notEqual(tamperResult.code, 0);
    assert.match(tamperResult.stderr, /checksum mismatch/i);
  } finally {
    await rm(usbRoot, { recursive: true, force: true });
  }
});
```

Add these table-driven failure cases:

```js
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
      await writeFile(path.join(returnDir, `${reportName}.sha256`), `${"0".repeat(64)}  ${reportName}\n`);
    }
  },
  {
    name: "unsafe filename inside sidecar",
    expected: /unsafe manifest path/i,
    arrange: async (returnDir, reportName) => {
      const reportPath = path.join(returnDir, reportName);
      await writeFile(reportPath, "safe\n");
      await writeFile(
        `${reportPath}.sha256`,
        `${await sha256File(reportPath)}  ../${reportName}\n`
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
```

- [ ] **Step 3: Add the failing runbook contract**

In `test/proxmox-runbook-contract.test.js`, require:

```js
assert.match(runbook, /Codex-isolated USB inventory/i);
assert.match(runbook, /prepare-usb-handoff\.ps1 -UsbDrive D:/);
assert.match(runbook, /sha256sum --check CHECKSUMS\/TO-DEBIAN\.sha256/);
assert.match(runbook, /bash TO-DEBIAN\/collect-debian-readiness\.sh/);
assert.match(runbook, /verify-usb-handoff\.mjs.*--mode returned/);
assert.match(runbook, /Codex.*no remote access.*Debian.*Proxmox/is);
```

- [ ] **Step 4: Run targeted tests and verify RED**

Run:

```powershell
node --test test/usb-migration-handoff.test.js test/proxmox-runbook-contract.test.js
```

Expected: FAIL because the verifier and runbook bridge do not exist.

- [ ] **Step 5: Implement outbound and returned verification**

`verify-usb-handoff.mjs` must:

1. Parse only `--handoff-root` and `--mode`.
2. Require the exact six top-level entries and fixed inbound files.
3. Verify `CHECKSUMS/TO-DEBIAN.sha256`.
4. In outbound mode, reject any file already present in `FROM-DEBIAN`.
5. In returned mode, allow only names matching `^debian-readiness-\d{8}T\d{6}Z-[A-Za-z0-9._-]+\.txt(?:\.sha256)?$`.
6. Require every report to have exactly one sidecar and every sidecar to have exactly one report.
7. Parse each sidecar as one SHA-256 line whose path is the report basename only.
8. Hash the report before reading it.
9. Screen the report with `scanReturnedReport`.
10. On a screening failure, print only `Potential secret material detected at line <n> (<rule>); do not open or share this report.` and exit nonzero.
11. On success, print JSON containing only mode, counts, report basenames, and report SHA-256 values.

Use this core implementation:

```js
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  scanReturnedReport,
  verifySha256Manifest
} from "./usb-handoff-lib.mjs";

const TOP_LEVEL = Object.freeze([
  "CHECKSUMS",
  "FROM-DEBIAN",
  "ISOLATION-BOUNDARY.txt",
  "README-FIRST.txt",
  "SECRETS-ENCRYPTED",
  "TO-DEBIAN"
]);
const INBOUND_FILES = Object.freeze([
  "ISOLATION-BOUNDARY.txt",
  "README-FIRST.txt",
  "TO-DEBIAN/collect-debian-readiness.sh"
]);
const RETURN_NAME = /^debian-readiness-\d{8}T\d{6}Z-[A-Za-z0-9._-]+\.txt(?:\.sha256)?$/;

export async function verifyUsbHandoff({ handoffRoot, mode }) {
  if (!["outbound", "returned"].includes(mode)) {
    throw new Error("--mode must be outbound or returned");
  }
  const root = path.resolve(handoffRoot);
  const topLevel = (await readdir(root, { withFileTypes: true }))
    .map((entry) => entry.name)
    .sort();
  if (JSON.stringify(topLevel) !== JSON.stringify(TOP_LEVEL)) {
    throw new Error("Handoff top-level layout does not match the approved structure");
  }

  const inbound = await verifySha256Manifest({
    rootPath: root,
    manifestPath: path.join(root, "CHECKSUMS", "TO-DEBIAN.sha256")
  });
  if (JSON.stringify(inbound.map((entry) => entry.path)) !== JSON.stringify(INBOUND_FILES)) {
    throw new Error("Inbound checksum manifest does not contain the approved files");
  }

  const returnDir = path.join(root, "FROM-DEBIAN");
  const returnedNames = (await readdir(returnDir)).sort();
  if (mode === "outbound") {
    if (returnedNames.length) throw new Error("Outbound handoff already contains returned files");
    return { ok: true, mode, inboundFiles: inbound.length, reports: [] };
  }
  if (!returnedNames.length) throw new Error("At least one returned report is required");
  const unexpected = returnedNames.find((name) => !RETURN_NAME.test(name));
  if (unexpected) throw new Error(`Unexpected return file: ${unexpected}`);

  const reportNames = returnedNames.filter((name) => name.endsWith(".txt"));
  const sidecarNames = new Set(returnedNames.filter((name) => name.endsWith(".txt.sha256")));
  for (const sidecarName of sidecarNames) {
    const reportName = sidecarName.slice(0, -".sha256".length);
    if (!reportNames.includes(reportName)) throw new Error(`Missing returned report for ${sidecarName}`);
  }

  const reports = [];
  for (const reportName of reportNames) {
    const sidecarName = `${reportName}.sha256`;
    if (!sidecarNames.has(sidecarName)) throw new Error(`Missing checksum sidecar for ${reportName}`);
    const verified = await verifySha256Manifest({
      rootPath: returnDir,
      manifestPath: path.join(returnDir, sidecarName)
    });
    if (verified.length !== 1 || verified[0].path !== reportName) {
      throw new Error(`Checksum sidecar does not name only ${reportName}`);
    }
    const report = await readFile(path.join(returnDir, reportName), "utf8");
    const screening = scanReturnedReport(report);
    if (!screening.ok) {
      const finding = screening.findings[0];
      throw new Error(
        `Potential secret material detected at line ${finding.line} (${finding.rule}); do not open or share this report.`
      );
    }
    reports.push({ fileName: reportName, sha256: verified[0].sha256 });
  }
  return { ok: true, mode, inboundFiles: inbound.length, reports };
}
```

The CLI wrapper must parse the two named arguments, call `verifyUsbHandoff`, serialize only the returned summary on success, and print only `error.message` on failure.

- [ ] **Step 6: Add the runbook bridge**

Insert `## Gate 0 - Codex-isolated USB inventory` before Gate 1. State that:

- Codex has no remote access to Debian or Proxmox.
- The user runs the server commands.
- The Debian VM remains internet-connected.
- Codex-prepared inventory files and returned evidence use the dedicated USB.
- The outbound package is created with `.\scripts\migration\prepare-usb-handoff.ps1 -UsbDrive D:`.
- The user follows `README-FIRST.txt`, verifies `CHECKSUMS/TO-DEBIAN.sha256`, and explicitly invokes the collector with Bash.
- After physical return, `node .\scripts\migration\verify-usb-handoff.mjs --handoff-root D:\Project-A-Migration --mode returned` must pass before the report is reviewed.
- A failed hash or screening result blocks the inventory review.
- This gate gathers evidence only; it does not authorize VM configuration or production cutover.

- [ ] **Step 7: Verify GREEN and commit**

Run:

```powershell
node --check scripts/migration/verify-usb-handoff.mjs
node --test test/usb-migration-handoff.test.js test/proxmox-runbook-contract.test.js
git diff --check
git add scripts/migration/verify-usb-handoff.mjs test/usb-migration-handoff.test.js docs/PROXMOX_MIGRATION_RUNBOOK.md test/proxmox-runbook-contract.test.js
git commit -m "feat: verify returned USB migration evidence"
```

Expected: both targeted test files pass.

### Task 5: Full verification and guarded creation on `D:`

**Files:**
- Verify all files from Tasks 1-4.
- Write only beneath `D:\Project-A-Migration` after all repository checks pass.

**Interfaces:**
- Consumes: the complete tested USB workflow.
- Produces: a verified outbound handoff at `D:\Project-A-Migration`.
- Does not execute any Debian or Proxmox command.

- [ ] **Step 1: Run syntax checks**

Run:

```powershell
node --check scripts/migration/usb-handoff-lib.mjs
node --check scripts/migration/build-usb-handoff.mjs
node --check scripts/migration/verify-usb-handoff.mjs

$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path .\scripts\migration\prepare-usb-handoff.ps1),
  [ref]$null,
  [ref]$parseErrors
) | Out-Null
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }

bash -n scripts/migration/collect-debian-readiness.sh
```

Expected: every syntax check exits `0`, including the available Bash 5.2 runtime.

- [ ] **Step 2: Run targeted tests**

Run:

```powershell
node --test test/usb-migration-handoff.test.js
node --test test/proxmox-runbook-contract.test.js
```

Expected: zero failures; POSIX-only runtime cases may be skipped on Windows.

- [ ] **Step 3: Run repository regression and patch-hygiene checks**

Run:

```powershell
node --check server.js
node --check security.js
node --check public/app.js
npm test
git diff --check
```

Expected: all syntax checks and the complete test suite pass with no whitespace errors.

- [ ] **Step 4: Inspect the selected USB without changing it**

Run:

```powershell
$usb = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='D:'"
$usb | Select-Object DeviceID, VolumeName, FileSystem, DriveType, Size, FreeSpace
Test-Path -LiteralPath 'D:\Project-A-Migration'
```

Proceed only when `D:` exists, `DriveType` is `2`, `FileSystem` is `FAT32`, free space exceeds 100 MB, and `D:\Project-A-Migration` does not exist. If the directory exists, stop without deleting or replacing it and request a separate decision.

- [ ] **Step 5: Build the actual outbound USB handoff**

Run:

```powershell
.\scripts\migration\prepare-usb-handoff.ps1 -UsbDrive D:
```

Expected: one JSON success summary and a new `D:\Project-A-Migration` directory. No other USB path is modified.

- [ ] **Step 6: Verify the USB package independently**

Run:

```powershell
node .\scripts\migration\verify-usb-handoff.mjs `
  --handoff-root D:\Project-A-Migration `
  --mode outbound

Get-ChildItem -LiteralPath 'D:\Project-A-Migration' -Recurse -Force |
  Select-Object FullName, Length
```

Expected: verifier returns `ok: true`; the tree matches the approved layout; `FROM-DEBIAN` and `SECRETS-ENCRYPTED` are empty; every non-secret outbound file is listed in `CHECKSUMS\TO-DEBIAN.sha256`; no file exceeds the FAT32 limit.

- [ ] **Step 7: Review scope and commit any verification-only correction**

Run:

```powershell
git status --short
git diff --stat
git diff --check
```

Confirm the implementation changed only the approved USB workflow, its tests, and the migration-runbook bridge. Do not stage unrelated migration-worktree changes. If verification required no correction, create no extra commit.

- [ ] **Step 8: Hand off the physical server step**

Tell the user:

1. The USB is ready and its exact path.
2. Nothing has connected to Debian or Proxmox.
3. They should safely eject the USB, attach it to the Debian VM, and follow `README-FIRST.txt`.
4. They must stop on any checksum, mount, or collector error.
5. They should return the USB without opening or pasting the report; Codex will run returned-mode verification first.
