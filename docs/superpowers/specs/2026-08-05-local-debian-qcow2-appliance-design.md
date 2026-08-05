# Project-A Local Debian QCOW2 Appliance Design

Date: 2026-08-05
Status: approved architecture; written specification awaiting review

## Goal

Build the Project-A Debian 13 production environment on the current Windows workstation, boot and verify it locally, seal it as one Proxmox-importable QCOW2 disk, and then move that tested disk to the Proxmox server. The server must not be used as the place where the environment is assembled for the first time.

The portable disk is the complete operating environment. The four changing production runtime stores and the Cloudflare production material remain a small encrypted cutover payload so the Windows write freeze does not have to last for the transfer of a multi-gigabyte VM disk.

## Decision

Use WSL 2 with QEMU/KVM to build and boot an official Debian 13 `genericcloud` AMD64 QCOW2 image. Produce a sealed QCOW2 disk that Proxmox imports directly with `qm disk import` or its compatible `qm importdisk` alias.

The rejected alternatives are:

1. Hyper-V VHDX followed by QCOW2 conversion. This adds a disk-format conversion and a second virtual-hardware model without improving the final result.
2. An unattended Debian ISO installer. This rebuilds the target on Proxmox instead of moving the environment that was tested locally.
3. A container image. Project-A's established production contract is a dedicated Debian VM with systemd, not Docker or a container runtime.

## Existing contracts retained

The appliance preserves the current migration and runtime contracts:

- Debian 13, AMD64.
- Node.js 24 LTS at the repository-pinned release, currently `v24.18.0`.
- Project-A deployed beneath `/opt/palziv/releases/<release-sha>` with `/opt/palziv/current` pointing to the selected release.
- `HOST=127.0.0.1` and `PORT=3116`.
- `RUNTIME_DATA_DIR=/var/lib/palziv/data`.
- `PUBLIC_BASE_URL=https://itotexpress.com`.
- `TRUST_PROXY_ADDRESSES=loopback`.
- The four canonical runtime stores are `analytics.json`, `board.json`, `push.json`, and `security.json`.
- Project-A is managed by `palziv.service` and its existing timers.
- Cloudflare Tunnel is outbound-only and remains disabled and inactive throughout local build, local validation, disk transfer, and Proxmox import.
- Exactly one production Cloudflare connector may run. The Debian connector starts only in the explicit cutover phase after loopback validation succeeds.
- The Windows installation remains the production writer and rollback source until cutover.

## Scope

### Included

- A repeatable local builder for this Windows 11 Pro workstation.
- WSL 2 QEMU/KVM prerequisite detection and narrowly scoped installation of missing build packages inside the selected WSL distribution.
- Official Debian image acquisition and integrity verification.
- A 40 GiB sparse QCOW2 disk.
- Temporary cloud-init bootstrapping and loopback-only SSH forwarding for the local build.
- Project-A release deployment, staging configuration, service installation, and local validation.
- Generation of the Debian-only `age` identity needed by the existing encrypted cutover flow.
- Appliance sealing, final disk validation, checksums, manifest, and verification receipt.
- A parameterized Proxmox import script and short operator instructions.
- Contract and fixture tests that do not require production credentials.

### Excluded

- Connecting Codex to Proxmox or the destination Debian guest.
- Changing Proxmox storage, bridge, VLAN, firewall, DNS, Cloudflare, or production services during the local build.
- Copying plaintext production runtime JSON, environment secrets, tunnel credentials, passwords, or recovery material into the sealed base appliance.
- Starting the Cloudflare connector locally.
- Replacing the controlled Windows write freeze, encrypted final payload, rollback decision tree, or seven-day stabilization period.
- Modifying the untracked `DEBIAN-HOST-PREP-EASY-INSTRUCTIONS.txt` file.

## Architecture

### 1. Windows entrypoint

`scripts/appliance/build-local-debian-appliance.ps1` is the only normal Windows entrypoint. It:

1. Resolves the repository and output paths without following linked output directories.
2. Confirms at least 20 GiB of free working space, WSL 2 availability, the selected distribution, `/dev/kvm`, and a clean release commit.
3. Creates a unique ignored build directory under `artifacts/local-debian-appliance/<build-id>`.
4. Invokes the WSL builder with explicit Windows-to-WSL paths.
5. Returns the final artifact paths and hashes without printing secrets.

The entrypoint refuses to reuse an existing build directory or overwrite an existing final artifact.

### 2. WSL build controller

`scripts/appliance/build-local-debian-appliance.sh` owns image acquisition, QEMU lifecycle, SSH provisioning, verification, shutdown, and sealing. It uses KVM acceleration through `/dev/kvm`; it does not fall back silently to slow software emulation.

Its build-only dependencies are installed inside WSL from the Ubuntu package repositories and are limited to QEMU, QCOW2 tooling, cloud-image seed tooling, OpenSSH client utilities, `curl`, `jq`, and checksum utilities. Installing those packages changes only the local WSL development distribution, not Windows production or the destination server.

### 3. Trusted base image

The builder downloads:

- `https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2`
- `https://cloud.debian.org/images/cloud/trixie/latest/SHA512SUMS`

The builder selects the exact filename from the checksum manifest, verifies SHA-512 before first boot, records the resolved download URL, image digest, byte size, and retrieval time, and reuses a cached base image only when its recorded digest still verifies. The base image is never modified in place; every build starts from a copy.

### 4. Temporary local boot

The working disk is resized to a 40 GiB virtual size and booted with:

- Q35 machine type.
- Two virtual CPUs.
- 4096 MiB RAM.
- VirtIO SCSI disk.
- VirtIO network adapter.
- QEMU guest agent support.
- QEMU user-mode NAT.
- SSH forwarded only from `127.0.0.1` on an unused high local port.
- A generated NoCloud seed containing a build-only user and a generated build-only SSH public key.

No QEMU listener binds to a LAN address. The private build key remains in the ignored build directory and is destroyed after successful sealing.

### 5. Guest provisioning

`scripts/appliance/provision-debian-appliance.sh` runs as root in the guest. It:

1. Confirms Debian 13, AMD64, synchronized time, expected disk, and cloud-init completion.
2. Applies current Debian security updates.
3. Installs the repository's required Debian packages, `qemu-guest-agent`, `systemd-timesyncd`, `age`, and the existing Project-A operational utilities.
4. Runs the repository-owned Linux preparation, Node 24 installation, Cloudflare installation, release deployment, service, timer, backup, and health-check installers instead of creating a second deployment contract.
5. Creates the `palziv` and `cloudflared` system identities with their established ownership and permissions.
6. Installs a staging-only `/etc/palziv/palziv.env` with a generated setup token and no production secret values.
7. Creates an empty `/var/lib/palziv/data` and permits Project-A to initialize only synthetic staging state.
8. Generates `/etc/palziv/migration-age.key` as root-owned mode `0600`; only its public recipient leaves the disk.
9. Enables Project-A and its expected production timers, while explicitly disabling and stopping `cloudflared.service`.

The release source is a clean Git archive for one explicit 40-character commit. `.git`, `node_modules`, runtime stores, backups, logs, local secrets, temporary files, worktrees, and unrelated workspace content are excluded.

### 6. Local verification

`scripts/appliance/verify-debian-appliance.sh` runs after provisioning and again after a full guest reboot. It verifies:

- Debian release and AMD64 architecture.
- The pinned Node 24 version and release commit.
- `qemu-guest-agent`, time synchronization, Project-A, and expected timer states.
- Cloudflare is installed but disabled and inactive.
- Project-A listens on `127.0.0.1:3116`, not `0.0.0.0`, `::`, or a guest LAN address.
- Successful responses for `/api/health`, `/palzivalerts/`, all four role routes, `/sw.js`, and `/manifest.webmanifest`.
- Project-A restart and full VM reboot recovery.
- Required owner, group, and permission contracts beneath `/opt/palziv`, `/etc/palziv`, `/etc/cloudflared`, and `/var/lib/palziv`.
- Any runtime stores present during boot verification contain only generated staging state; no source production runtime file is copied into the build.
- Production environment values, Cloudflare credentials, known source-secret filenames, and the Windows workspace path are absent.
- The generated `age` public recipient matches the Debian-only private identity.

The verification output is bounded metadata. It includes classifications, versions, hashes, route status, service states, and timestamps, but no environment values, credentials, runtime JSON, IP configuration, or logs.

### 7. Sealing

`scripts/appliance/seal-debian-appliance.sh` runs only after both verification passes. It:

1. Stops Project-A and confirms Cloudflare is stopped.
2. Removes the generated staging runtime stores and recreates an empty root-owned runtime directory with the established `palziv` ownership and mode; the target's first staging boot may generate fresh disposable state before final restore.
3. Removes the build user, temporary SSH authorization, build scripts, cloud-init instance state, package caches, temporary files, and shell history.
4. Removes host SSH keys so the destination can generate new keys on first boot.
5. Cleans `/etc/machine-id` using Debian's supported image-preparation convention.
6. Confirms no build private key entered the guest.
7. Performs a clean shutdown.

The WSL controller waits for QEMU to exit, runs `qemu-img check`, converts the working disk into a compact final QCOW2 without a backing file, checks it again, and makes the result read-only on the Windows side after hashes are written.

### 8. Artifact contract

One successful build produces a new directory containing:

- `palziv-debian13-<release-sha>.qcow2`
- `ARTIFACTS.sha256`
- `BUILD-MANIFEST.json`
- `VERIFY-LOCAL.json`
- `STAGE-SUCCESS.json`
- `STAGE-SUCCESS.sha256`
- `age-recipient.txt`
- `IMPORT-ON-PROXMOX.sh`
- `README-FIRST.txt`

`BUILD-MANIFEST.json` records schema version, build ID, Debian image URL and digest, Project-A release SHA, Node version, disk virtual size, disk actual size, final QCOW2 SHA-256, verification classification, and UTC timestamps. It contains no machine-specific secret or production value.

The stage receipt and `age` recipient bind the future encrypted cutover payload to this exact appliance. A failed or incomplete build never receives the successful classification and is never renamed to the final artifact filename.

### 9. Proxmox import

`IMPORT-ON-PROXMOX.sh` is parameterized by VMID, storage ID, bridge, SSH public-key file, and IP configuration. It refuses root filesystem paths, missing inputs, an existing VMID, or an unverified QCOW2 checksum. It then creates the VM with the established Project-A hardware contract, imports the disk, attaches a Proxmox cloud-init disk, configures the guest agent, serial console, VirtIO networking, boot order, firewall flag, and automatic start.

The script does not start the VM automatically. The operator first reviews `qm config <vmid>`, firewall policy, bridge, storage, cloud-init identity, and IP settings. The first target boot generates new machine and SSH identities, starts Project-A on loopback, and leaves Cloudflare disabled.

### 10. Final data cutover

After the imported target passes the same loopback validation, Windows remains the only production writer until the user explicitly authorizes cutover. The existing controlled cutover then:

1. Records and disables the actual Windows startup, recovery, and tunnel-watchdog automation.
2. Stops the Windows Node listener and confirms the source is frozen.
3. Archives exactly the four canonical runtime stores.
4. Encrypts runtime data, the production environment, and Cloudflare material to this appliance's `age` recipient.
5. Transfers the small encrypted payload to the imported VM.
6. Restores and validates Project-A while Cloudflare remains stopped.
7. Starts the Debian connector only after all loopback checks succeed.

If no user writes reach Debian, Windows can be reactivated using the recorded source state. If Debian accepts any writes, its runtime state must be backed up and transferred back before Windows can restart. The seven-day Windows stabilization source remains intact.

## Error handling and restartability

- Every script uses terminating errors and reports the real failed command or operation.
- Downloads use partial filenames and atomic promotion after checksum verification.
- Each build has a unique directory and explicit state file; reruns create a new build instead of guessing whether an interrupted disk is reusable.
- QEMU process ID, SSH port, and owned temporary paths are recorded so cleanup targets only the current build.
- Cleanup may stop only the QEMU process whose executable and disk path match the build state.
- A timeout produces a failed build receipt and preserves diagnostic metadata, but never promotes the disk.
- Existing output, base images, VMIDs, or destination disks are never overwritten.
- Production data and production services are outside the local builder's authority.

## Security boundaries

- No inbound LAN listener is created during the local build.
- No production runtime data or production secret is placed in the base appliance.
- No build private key is copied into the guest or final artifact set.
- The Debian `age` private identity never leaves the QCOW2 disk.
- Cloudflare remains disabled until explicit cutover.
- The base-image digest, release SHA, and final disk digest are all recorded and verified.
- The final QCOW2 contains sensitive security posture and the future decryption identity even without production data; it must be transported on encrypted media or an encrypted authenticated channel and stored with restricted access.
- Import is an operator action on Proxmox. No script connects to the server from this workstation.

## Test strategy

### Repository contract tests

`test/local-debian-appliance.test.js` validates command construction, safe paths, manifest schema, expected routes, secret exclusions, loopback binding, Cloudflare disabled state, non-overwrite behavior, and Proxmox import parameters without booting a VM.

### Local integration tests

The real build is the integration test. It uses the official Debian 13 filesystem and KVM, executes a clean install, performs service restart, reboots the guest, verifies all routes and permissions, seals the disk, and runs `qemu-img check` on the final image.

### Negative cases

Fixtures cover a bad Debian checksum, missing `/dev/kvm`, insufficient disk space, occupied SSH-forward port, dirty or nonexistent release commit, failed provisioning, route failure, Cloudflare unexpectedly active, production-data leakage, missing `age` identity, QEMU timeout, corrupted final disk, and existing Proxmox VMID.

### Repository verification

Before the artifact is accepted:

- `node --check` runs on new JavaScript test or helper files.
- The targeted appliance contract test passes.
- Existing Linux migration and two-phase migration tests pass.
- `npm test` passes.
- `git diff --check` passes.

## Acceptance criteria

- The target environment is assembled and boot-tested locally before transfer.
- The final disk is a standalone QCOW2 with no backing file and a 40 GiB virtual size.
- It imports into Proxmox without VHDX or filesystem conversion.
- Project-A survives a local service restart and full guest reboot.
- All required routes and PWA assets pass locally.
- Port 3116 is loopback-only and Cloudflare remains disabled.
- No production runtime JSON, production environment, or tunnel credential exists in the sealed appliance.
- The final encrypted cutover payload is bound to the appliance's Debian-only `age` identity.
- Every final artifact is checksummed and the QCOW2 passes `qemu-img check`.
- The Proxmox import script does not start the VM or modify an existing VMID.
- Windows production and rollback state remain untouched by the local builder.

## Source references

- Official Debian 13 cloud images: `https://cloud.debian.org/images/cloud/trixie/latest/`
- Official Debian image used by this design: `https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2`
- Official Debian checksum manifest: `https://cloud.debian.org/images/cloud/trixie/latest/SHA512SUMS`
- Proxmox VE Administration Guide: `https://pve.proxmox.com/pve-docs/pve-admin-guide.pdf`
- Proxmox migration and disk-import guidance: `https://pve.proxmox.com/wiki/Migrate_to_Proxmox_VE`
- Existing Project-A cutover design: `docs/superpowers/specs/2026-08-04-usb-two-command-migration-design.md`
- Existing Project-A migration runbook: `docs/PROXMOX_MIGRATION_RUNBOOK.md`
