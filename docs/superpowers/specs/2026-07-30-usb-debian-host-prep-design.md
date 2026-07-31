# USB Debian Host Preparation Design

Status: user-approved design boundary

## Goal

Prepare the existing Debian 13 VM for a later Project-A deployment without giving Codex remote access and without installing the application, moving production data, introducing secrets, changing firewall policy, configuring Cloudflare, starting services, or cutting over traffic.

The deliverable is a second, independently verified USB bundle. It is a sibling of the completed readiness-inventory bundle so the original returned evidence remains byte-for-byte unchanged.

## Approved Boundary

Codex remains isolated from Debian and Proxmox:

- Codex receives no SSH, Proxmox, console, VPN, API, browser-session, or remote-desktop access.
- The user runs every Debian and Proxmox command locally.
- The Debian VM may use the internet for approved Debian packages and the pinned Node.js archive.
- The dedicated FAT32 USB remains the only file-transfer path between this workspace and Debian.
- No password, private key, recovery code, environment-secret value, Cloudflare credential, runtime JSON content, or push credential is included in the bundle or returned evidence.
- The existing Windows production application and Cloudflare connector remain unchanged and active.

This host-preparation step may:

- Run a read-only Debian preflight.
- Install a narrow allowlist of operating-system prerequisites.
- Install the exact approved Node.js runtime.
- Create the unprivileged `palziv` system account and empty restricted directories.
- Collect a redacted, metadata-only host-preparation receipt.

This host-preparation step must not:

- Install Project-A source code or npm dependencies.
- Create `/opt/palziv/current` or a release directory.
- Copy, create, inspect, or restore production runtime JSON.
- Create `/etc/palziv/palziv.env`.
- Install or configure `cloudflared`.
- Create Cloudflare accounts, directories, configuration, credentials, or services.
- Install, enable, start, stop, or restart Project-A, Cloudflare, backup, or health services or timers.
- Change journald policy.
- Change UFW, nftables, iptables, Proxmox firewall, DNS, VLAN, bridge, gateway, or IP configuration.
- Probe the public Project-A URL.
- Modify the Proxmox host.
- Disable or alter the current Windows production application, tasks, or tunnel.

## Evidence Baseline

The Phase 1 returned verifier approved:

- Bundle: `D:\Project-A-Migration`
- Report: `debian-readiness-20260730T192552Z-palziv-prod.txt`
- Report SHA-256: `6170af37d51ee151424dc505ae9537c3e78a381bd6867eeb39a40fbd2634a588`

The verified VM is Debian 13 `x86_64` under KVM with 2 vCPU, approximately 4 GB RAM, approximately 39 GB free root storage, synchronized time, active SSH, active QEMU Guest Agent, and working DNS/HTTPS. Git, curl, jq, rsync, Bash, and systemd are present. Node.js, npm, `cloudflared`, Palziv directories, and Palziv services are absent. UFW is inactive.

These facts authorize package design only. The host-preparation preflight must independently recheck the safety-critical subset before mutation because the VM may change between USB trips.

## Bundle Identity and Immutability

The USB root will contain two independent bundles:

```text
D:\
├── Project-A-Migration\
└── Project-A-Migration-Phase-2-Host-Prep\
```

`Project-A-Migration` is immutable evidence. The Phase 2 builder must:

1. Run the existing Phase 1 returned verifier successfully.
2. Record the Phase 1 report basename and SHA-256.
3. Hash the existing Phase 1 outbound manifest.
4. Snapshot every Phase 1 relative path, type, size, and SHA-256 before building.
5. Build only the sibling `Project-A-Migration-Phase-2-Host-Prep`.
6. Re-snapshot Phase 1 after publication and require an exact match.

The builder must fail without cleanup outside its own validated staging directory if the Phase 2 target already exists, appears during publication, is a link or junction, or is not on the same confirmed removable FAT32 volume.

## Phase 2 Layout

```text
Project-A-Migration-Phase-2-Host-Prep\
├── README-FIRST.txt
├── ISOLATION-BOUNDARY.txt
├── PHASE-2-INPUT.json
├── CHECKSUMS\
│   └── PHASE-2-HOST-PREP.sha256
├── TO-DEBIAN\
│   ├── preflight-host-prep.sh
│   ├── apply-host-prep.sh
│   └── collect-host-prep-evidence.sh
├── FROM-DEBIAN\
└── SECRETS-ENCRYPTED\
```

`FROM-DEBIAN` and `SECRETS-ENCRYPTED` are empty at publication. The bundle contains no application source, runtime data, secret template, credential, tunnel configuration, systemd unit, timer, journald override, package-manager cache, or downloaded Node archive.

`PHASE-2-INPUT.json` contains only:

- `schemaVersion`
- `phaseId`
- Phase 1 bundle basename
- Phase 1 report basename and SHA-256
- Phase 1 outbound-manifest SHA-256
- exact Node.js version, archive basename, archive URL, and approved archive SHA-256
- the pinned Node release-key repository commit used to authenticate the official signed checksum material

No host report body or value-bearing production configuration is copied into this file.

## Node.js Provenance

Production will use Node.js `v24.18.0` for Linux x64:

- Archive: `node-v24.18.0-linux-x64.tar.xz`
- URL: `https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz`
- Approved SHA-256: `55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742`
- Release-key repository commit: `b28073028e6d6855cfb53bf7fa0137599c01f967`

Before the approved digest is embedded in the bundle sources, the implementation workflow must verify Node's `SHASUMS256.txt.asc` for `v24.18.0` with the official `nodejs/release-keys` keyring at the pinned commit. The verified signed manifest must contain the exact archive basename and digest above.

The Debian apply script downloads only the exact HTTPS URL, writes to a root-owned temporary directory, verifies the exact embedded SHA-256, and extracts only after the hash passes. Before extraction, it requires every archive entry to remain beneath the single expected `node-v24.18.0-linux-x64/` root and rejects absolute paths, parent traversal, links escaping that root, and unexpected top-level entries. Extraction does not preserve archive ownership or unsafe permission bits. The authenticated Phase 2 manifest protects the apply script and its embedded expected digest; the archive hash protects the downloaded bytes.

Installation uses:

- Version directory: `/opt/node-v24.18.0-linux-x64`
- Stable symlink: `/opt/node`

Extraction is staged under `/opt` and published by rename. A matching existing version and symlink are accepted only after `/opt/node/bin/node --version` reports exactly `v24.18.0`. Any conflicting path, symlink target, version, owner, or directory type stops the script.

## Out-of-Band Authenticity

Same-media SHA-256 files detect accidental corruption but cannot authenticate a USB against an attacker who can replace both content and checksums. Therefore the Windows publication step also computes:

```text
SHA-256(CHECKSUMS/PHASE-2-HOST-PREP.sha256)
```

That 64-character fingerprint is shown to the user in Codex after publication and is not stored as the trust anchor on the USB. Before running any Phase 2 script, the user compares the full fingerprint on Debian with the separately retained value.

The README treats `nodev`, `nosuid`, and `noexec` as defense-in-depth only. It explicitly states that invoking a script with Bash bypasses `noexec`; the authenticated manifest and stable local copy are the execution trust boundary.

## Windows Builder

A dedicated Phase 2 PowerShell wrapper and Node.js builder will:

- Accept only a drive-letter root.
- Require `DriveType=2`, FAT32, at least 100 MB free, and Node.js 22 or newer.
- Reject UNC, network, substituted, reparse-point, relative, and non-root destinations before publication.
- Require a valid returned Phase 1 sibling.
- Reject an existing Phase 2 target without deleting or replacing it.
- Copy only a fixed source allowlist.
- Reject symbolic links, junctions, non-regular source files, source identity changes, and files over the FAT32 single-file limit.
- Generate a sorted SHA-256 manifest for every non-secret Phase 2 file except the manifest itself.
- Stage on the USB volume and publish with a no-clobber rename.
- Independently verify the published bundle.
- Prove the Phase 1 snapshot is unchanged.
- Print one metadata-only JSON summary and the out-of-band manifest fingerprint.

The builder never formats, deletes, repairs, ejects, or writes outside its validated Phase 2 staging and final directories.

## Debian Operator Flow

The README provides one fail-closed flow:

1. Create a new Proxmox snapshot of `palziv-prod` immediately before host preparation, using the name pattern `before-project-a-host-prep-YYYYMMDD-HHMM`. Do not run `--apply` without that rollback point.
2. Identify the USB locally and mount its FAT32 partition with `nodev,nosuid,noexec,umask=077`.
3. Verify the mounted source, filesystem type, and effective mount options.
4. Compute the full Phase 2 manifest fingerprint and compare it with the separately retained value.
5. Run `sha256sum --check CHECKSUMS/PHASE-2-HOST-PREP.sha256`.
6. Copy the complete verified Phase 2 bundle into a newly created, user-owned local staging directory.
7. Re-run the manifest verification against the local copy.
8. Run `preflight-host-prep.sh` from the local copy without elevation.
9. Stop on any preflight failure.
10. Run the visibly mutating command with both elevation and the exact `--apply` argument.
11. Run the evidence collector after success or failure; it is read-only and records the resulting bounded state.
12. Synchronize writes, remove the local staging copy, unmount the USB, and return it to the laptop.

The mount and cleanup block validates its literal mountpoint and mounted source before attempting one bounded unmount. A signal after mount success triggers the same source-verified cleanup. The instructions never auto-discover and execute a USB file.

## Read-Only Preflight

`preflight-host-prep.sh` runs without `sudo` and makes no system changes. It must require:

- Debian `VERSION_ID=13`
- `x86_64`
- KVM virtualization
- at least 2 logical CPUs
- at least 3,500 MiB total memory
- at least 10 GiB free on `/`
- synchronized system time
- active `qemu-guest-agent.service`
- active `systemd-timesyncd.service`
- working HTTPS to `deb.debian.org` and `nodejs.org`
- no active or enabled `palziv.service`
- no active or enabled `cloudflared.service`
- no listener on TCP port `3116`
- either the verified clean baseline, with no existing Node target, `palziv` account, or owned Palziv directory
- or the exact completed state defined by this specification, with every version, account, path, owner, group, mode, and symlink target matching

UFW state is reported but not changed. Preflight classifies the host as `clean`, `already-prepared`, or `conflict`. Only `clean` and `already-prepared` produce a success token. Any partial or conflicting state stops the apply path and requires the USB to be returned for review.

The preflight must replace inherited command resolution with a fixed safe path, clear Bash startup hooks, proxy/curl configuration, `SSLKEYLOGFILE`, and other transport overrides, and use fixed allowlisted commands. It prints only pass/fail metadata and never reads secrets, logs, process command lines, environment values, SSH material, or service definitions.

Before checking, preflight removes only its own prior token from the local staged bundle. On success it atomically writes `.host-prep-preflight-ok` with mode `0600`. The token is JSON containing only `schemaVersion`, `phaseId`, the full Phase 2 manifest fingerprint, the canonical local-stage path, classification, and creation epoch. The apply script recomputes the manifest fingerprint and canonical stage path, enforces the 15-minute age, and independently reruns every safety-critical conflict check. The token records a completed preflight; it cannot override a changed host or bundle.

## Mutating Apply Script

`apply-host-prep.sh` requires:

- Effective UID 0.
- Exactly one argument: `--apply`.
- A successful, current preflight token generated from the same local staged bundle and no older than 15 minutes.
- A root-owned working directory created with `mktemp`.
- No conflicting target account, group, path, service, timer, listener, or Node installation.

It performs only these mutations:

1. `apt-get update`.
2. Install or confirm this package allowlist:
   - `ca-certificates`
   - `curl`
   - `git`
   - `jq`
   - `rsync`
   - `tar`
   - `xz-utils`
3. Download, hash, stage, and publish Node.js `v24.18.0`.
4. Create the system group `palziv`.
5. Create the system user `palziv` with group `palziv`, home `/var/lib/palziv`, no created home directory, and shell `/usr/sbin/nologin`.
6. Create these empty directories with exact ownership and mode:
   - `/opt/palziv` — `root:palziv`, `0750`
   - `/opt/palziv/releases` — `root:palziv`, `0750`
   - `/var/lib/palziv` — `palziv:palziv`, `0700`
   - `/var/lib/palziv/data` — `palziv:palziv`, `0700`
   - `/var/backups/palziv` — `root:palziv`, `0750`
   - `/etc/palziv` — `root:palziv`, `0750`

The script does not write an environment file into `/etc/palziv`. It does not call `systemctl`, `ufw`, `cloudflared`, `npm`, `git clone`, `rsync --delete`, or any Project-A script. It does not access the Proxmox API or host.

The apply script is idempotent only for the exact completed state it owns. It accepts a rerun when every owned path, account, group, mode, owner, Node version, and symlink target matches. It aborts on partial or conflicting state rather than repairing, deleting, recursively changing ownership, or guessing.

An `already-prepared` preflight causes apply to verify the exact state and exit successfully without running `apt-get`, downloading Node.js, or changing the host.

## Failure and Rollback

The Proxmox snapshot is the rollback mechanism for host mutation. The package does not automate snapshot creation, rollback, account deletion, package removal, or directory deletion.

On failure:

- The apply script cleans only its validated temporary download/extraction directory.
- It does not remove installed Debian packages, accounts, or published directories.
- It does not retry with broader permissions.
- It prints a bounded step name and exit status without command traces, environment values, URLs containing credentials, or file contents.
- The user runs the read-only evidence collector once, returns the USB, and does not retry until the receipt is verified and reviewed.

The design intentionally prefers a visible partial state plus snapshot rollback over an untested automated uninstall that could delete unrelated host data.

## Returned Evidence

`collect-host-prep-evidence.sh` writes exactly one report and one SHA-256 sidecar beneath Phase 2 `FROM-DEBIAN`:

```text
debian-host-prep-YYYYMMDDTHHMMSSZ-safe-host.txt
debian-host-prep-YYYYMMDDTHHMMSSZ-safe-host.txt.sha256
```

It is read-only except for those two USB outputs and their owned temporary forms. It records only:

- collection timestamp
- Debian release and architecture
- CPU, memory, and free-root threshold results
- installed versions or absence of the package allowlist
- Node and npm versions or absence
- existence of the `palziv` user and group
- existence, type, owner, group, and mode of the six owned directories
- enabled/active state for `palziv.service`, `cloudflared.service`, `palziv-backup.timer`, and `palziv-health.timer`
- UFW active/inactive state
- presence or absence of a TCP `3116` listener
- overall classification: `prepared`, `partial`, or `not-applied`

It must not read or record IP addresses, routes, DNS servers, environment values, `/etc/palziv` file names or contents, runtime files, logs, journals, process arguments, SSH material, Cloudflare material, package source contents, browser data, passwords, tokens, cookies, recovery material, or Proxmox data.

The report is sensitive infrastructure inventory even after screening. It is not pasted into chat or opened before verification.

## Returned Verification

A dedicated `verify-usb-host-prep.mjs` keeps the proven Phase 1 verifier contract unchanged. It:

- Requires the exact Phase 2 tree and file types.
- Rejects links, junctions, unexpected files, temporary files, directories in file-only locations, and files above bounded limits.
- Verifies the complete Phase 2 manifest before reading `PHASE-2-INPUT.json`.
- Requires the expected Phase 1 linkage and exact Node provenance fields.
- In outbound mode, requires an empty `FROM-DEBIAN`.
- In returned mode, accepts exactly one report/sidecar pair with the approved naming grammar.
- Opens files without following links where supported.
- Verifies stable file identity before, during, and after reads.
- Hashes the receipt before decoding or screening it.
- Applies secret-shaped content screening without echoing matched content.
- Prints only phase ID, input-reference hash, receipt basename, receipt SHA-256, and verification result.

The report body may be read for readiness assessment only after the returned verifier passes.

## Testing Strategy

Implementation follows test-driven development.

Windows tests must prove:

- Valid returned Phase 1 evidence can authorize a Phase 2 build.
- Invalid, missing, tampered, or secret-bearing Phase 1 evidence blocks it.
- Phase 1 remains byte-for-byte unchanged after success and every injected failure.
- The builder rejects non-removable, non-FAT32, network, relative, linked, insufficient-space, pre-existing-target, destination-race, source-race, and oversized-file cases.
- Publication produces the exact tree, sorted manifest, correct metadata-only linkage, and out-of-band fingerprint.
- The dedicated verifier accepts only exact outbound and returned states and never weakens Phase 1 verification.

Linux/WSL tests must prove:

- Preflight is read-only and fails on every required-baseline mismatch.
- Preflight ignores inherited hostile Bash, path, proxy, curl, and TLS state.
- Apply refuses missing elevation, missing `--apply`, stale/missing preflight token, conflicts, and unsafe paths.
- A fake-command harness sees only the approved package/account/directory/Node operations.
- Apply never invokes service, timer, firewall, Cloudflare, npm, app, public-health, or Proxmox operations.
- Node download hash mismatch prevents extraction and publication.
- Exact successful state is idempotent; partial or conflicting state fails closed.
- Failure never emits a success receipt.
- The collector writes only its report pair and contains no forbidden content.
- Signal, checksum, mount, sync, and unmount failures remain bounded.

Final verification requires syntax checks, focused Windows tests, focused WSL tests with no POSIX skips, the complete `npm test` suite, `git diff --check`, an independent whole-branch review, and a physical removable-FAT32 publication check. The physical write occurs only after the repository implementation and review gates pass.

## Acceptance Criteria

- The original Phase 1 bundle and returned report remain unchanged.
- The Phase 2 bundle is independently checksummed and authenticated with a separately retained manifest fingerprint.
- Debian preflight reports either the verified clean baseline or the exact already-prepared state before mutation.
- The apply script requires explicit root authorization and performs only the exact approved host-preparation mutations.
- Node.js is exactly `v24.18.0` and its archive matches the authenticated official digest.
- The `palziv` account and six empty directories have the exact approved ownership and modes.
- No Project-A code, data, secret, service, timer, firewall rule, Cloudflare component, public probe, or cutover action is introduced.
- A returned receipt is checksum-verified and secret-screened before review.
- Codex never connects to Debian or Proxmox.
- The current Windows production system remains unchanged.

## External References

- Node.js v24 archive: `https://nodejs.org/en/download/archive/v24`
- Node.js v24.18.0 release: `https://nodejs.org/en/blog/release/v24.18.0`
- Node.js release-key repository: `https://github.com/nodejs/release-keys`
