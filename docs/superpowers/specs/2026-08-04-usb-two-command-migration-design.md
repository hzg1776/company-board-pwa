# Project-A USB Two-Phase Migration Design

Date: 2026-08-04
Status: approved design; implementation pending

## Goal

Move Project-A from the current Windows production host to the existing Debian 13 VM with two short operator phases instead of the previous guarded host-preparation wrapper. Phase 1 stages and verifies the Debian target while Windows remains the only production writer. Phase 2 performs a controlled write freeze, transfers the final state, validates the target, and moves the existing Cloudflare Tunnel connector.

The workflow remains USB-only. Codex does not connect to Debian or Proxmox. The operator physically moves the USB and runs the provided scripts from the Debian console.

## Why the approach changes

The previous package failed on three normal Debian 13 behaviors that its fixtures did not model: the canonical `os-release` link, jq's default formatting, and the `addgroup` link. Repeating narrow compatibility patches is no longer acceptable. The replacement uses normal Debian package tools, exposes the real failing command and line, and is validated against an actual Debian 13 userland before handoff.

## Operator experience

The USB root contains:

- `README-FIRST.txt`
- `1-STAGE-DEBIAN.sh`
- `2-CUTOVER-DEBIAN.sh`
- `ROLLBACK-WINDOWS.ps1`
- `PAYLOAD/` for the release and verified manifests
- `FROM-DEBIAN/` for bounded status receipts
- `FINAL-ENCRYPTED/` for the cutover payload created after staging

The Debian instructions contain only short mount and script commands. The implementation does not embed another multi-page shell program in the human-readable document.

## Phase 1: stage Debian

`1-STAGE-DEBIAN.sh` is idempotent and performs these operations:

1. Verify the USB manifest and exact release payload.
2. Confirm Debian 13, x86_64, synchronized time, available disk space, and loopback port availability.
3. Install required Debian packages with `apt-get`, including `age`, and install the pinned Node 24 release.
4. Create the `palziv` and `cloudflared` system accounts using regular Debian account-management binaries.
5. Deploy the Project-A release beneath `/opt/palziv/releases/`, using the verified release SHA as the directory name, and point `/opt/palziv/current` at it.
6. Install the existing systemd service and timer definitions without enabling the Cloudflare service.
7. Create a staging-only environment and staging runtime directory. No production runtime JSON, production environment secret, or tunnel credential is present in Phase 1.
8. Start Project-A on `127.0.0.1:3116`, verify health and all required local routes, verify Node and service restart behavior, then leave the Cloudflare connector disabled.
9. Generate an `age` identity on Debian. The private identity remains root-only on Debian; only its public recipient is written to the USB.
10. Write a bounded `STAGE-SUCCESS.json` receipt to `FROM-DEBIAN/`, sync, and unmount the USB.

Windows production, its scheduled recovery automation, its runtime data, and its Cloudflare connector remain unchanged throughout Phase 1.

## Windows intermission

After the USB returns to Windows, Codex performs read-only verification of the stage receipt. No cutover occurs merely because staging succeeded.

Only after the user explicitly says `cut over now`, the Windows preparation performs these actions in order:

1. Record the actual startup, recovery, and tunnel-watchdog task names and their prior states.
2. Disable those tasks and stop the Windows Node listener on port 3116.
3. Confirm no source listener remains and avoid further source health probes because they mutate analytics.
4. Create and verify the final archive containing exactly `analytics.json`, `board.json`, `push.json`, and `security.json`.
5. Capture the required production environment file and the named-tunnel credential without printing their values.
6. Encrypt the final runtime archive, production environment, and tunnel material to the Debian-generated `age` recipient.
7. Write checksums, a cutover authorization record, and the Windows rollback script to the USB.

Plaintext production data, environment secrets, Cloudflare credentials, passwords, and recovery material are never written to the USB.

## Phase 2: cut over Debian

`2-CUTOVER-DEBIAN.sh` refuses to run unless the stage receipt, final encrypted payload, cutover authorization, and every checksum are valid. It then:

1. Confirm the Debian stage service state and require synchronized time.
2. Stop the staging Project-A service.
3. Decrypt into a root-owned temporary directory with the Debian-only `age` identity.
4. Validate the runtime archive and restore the four canonical files with `palziv:palziv` ownership and `0600` modes.
5. Install the production environment and named-tunnel files with restrictive ownership and modes.
6. Start Project-A while Cloudflare remains stopped.
7. Verify loopback health, required application routes, PWA root assets, data-file presence, release identity, and service restart behavior.
8. Start Cloudflare only after every loopback check succeeds.
9. Verify the local Project-A and Cloudflare services are active and write a `CUTOVER-SUCCESS.json` receipt.

The script prints the actual failed command, source line, and exit status. It never converts an actionable error into an opaque label such as `step: group`. It is safe to rerun only when its output explicitly states that no cutover mutation began; otherwise the operator stops and returns the USB.

## Rollback

The Windows rollback script preserves the recorded task states. If no user writes reached Debian, rollback stops the Debian connector and app, restores the prior Windows task states, starts the Windows app and connector, and confirms that Windows is again the sole writer.

If any user writes reached Debian, automatic rollback is forbidden. The target must first be stopped and backed up, and its runtime data must be copied back before Windows can restart. The scripts state this boundary explicitly.

The Windows host, its pre-cutover runtime backup, and its existing installation remain intact for the seven-day stabilization period.

## Security boundaries

- No Codex remote access to Debian or Proxmox.
- No plaintext production secrets or runtime JSON on the USB.
- The Debian `age` private identity never leaves Debian.
- The USB manifest covers every executable and inbound payload.
- Release deployment excludes `.git`, `node_modules`, local backups, temporary files, and unrelated workspace content.
- The target binds only to `127.0.0.1:3116`.
- Exactly one Cloudflare connector may be active during production.
- The existing public origin `https://itotexpress.com` and PWA route structure remain unchanged.

## Error handling

Both Debian scripts use `set -Eeuo pipefail`, an `ERR` trap that reports the real command and line, deterministic cleanup for owned temporary directories, and explicit status receipts. Destructive operations target fixed, canonical paths. Existing production data is preserved before replacement.

Receipts contain status, versions, hashes, timestamps, and service classifications only. They do not contain environment values, tunnel credentials, runtime JSON content, passwords, tokens, IP configuration, logs, or journal contents.

## Validation

Before the USB is handed back to the operator:

1. Run shell syntax and repository contract checks.
2. Run the stage and cutover scripts against an actual Debian 13 package filesystem so canonical links and executable layouts are real.
3. Exercise clean installation, idempotent stage rerun, checksum rejection, decryption rejection, pre-cutover failure, successful restore, service start, and no-target-write rollback behavior.
4. Verify the USB package in outbound mode, compare its manifest fingerprint out of band, and confirm `FROM-DEBIAN/` is empty.

The production cutover itself remains operator-executed and is not claimed complete until the returned cutover receipt, public routes, role authentication, MFA, PWA assets, push identity, and single-connector state are verified.

## Acceptance criteria

- The operator uses two short Debian phase scripts rather than pasted embedded programs.
- Phase 1 cannot stop or alter Windows production or start the Debian tunnel.
- Phase 2 cannot run without a verified final encrypted payload and explicit Windows cutover authorization.
- Normal Debian 13 links and package layouts are exercised before handoff.
- All four runtime stores and the existing VAPID identity are preserved.
- Windows remains a recoverable rollback source for seven days.
- Any failure identifies the real command and leaves a clear, non-guessing next action.
