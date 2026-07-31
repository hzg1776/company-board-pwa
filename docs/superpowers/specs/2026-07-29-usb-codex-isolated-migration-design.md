# USB-Only Codex-Isolated Migration Design

## Goal

Prepare and operate the Project-A migration without giving Codex, this laptop, or any Codex-managed tool a network path into the Debian VM or Proxmox host.

The Debian VM remains internet-connected for the application’s normal outbound dependencies, including Cloudflare Tunnel, package installation, weather, email when configured, and Web Push. The isolation boundary applies specifically to Codex administration and data collection.

## Approved Boundary

- Codex must not receive SSH, Proxmox, console, VPN, browser-session, API, or remote-desktop access to the Debian VM or Proxmox host.
- The user runs every Debian or Proxmox command locally.
- Files move between the Codex laptop and Debian only through the dedicated USB drive currently mounted as `D:` on Windows.
- Codex may read redacted reports after the user physically returns the USB to the laptop.
- Passwords, private SSH keys, recovery codes, environment-secret values, Cloudflare credentials, runtime security data, and push credentials must never be shown to Codex.
- The Debian VM may access the internet directly for approved application and operating-system dependencies. It must not initiate a callback or management session to Codex.

## Selected Approach

Use a scripted USB handoff with checksummed files and a narrowly scoped, read-only Debian inventory collector.

This approach was selected over:

1. **Direct SSH or remote administration:** rejected because it violates the approved Codex-isolation boundary.
2. **Manual screenshots and transcribed command output:** rejected as the primary method because it is error-prone, incomplete, and difficult to verify.
3. **USB handoff with a local collector:** selected because the user remains the only operator on Debian while Codex receives consistent, redacted evidence.

## USB Layout

The Windows USB root will use:

```text
D:\Project-A-Migration\
├── README-FIRST.txt
├── ISOLATION-BOUNDARY.txt
├── TO-DEBIAN\
├── FROM-DEBIAN\
├── CHECKSUMS\
└── SECRETS-ENCRYPTED\
```

- `TO-DEBIAN` contains reviewed scripts and later migration packages intended for local execution or import.
- `FROM-DEBIAN` contains generated, redacted reports returned for review.
- `CHECKSUMS` contains SHA-256 manifests covering every non-secret handoff artifact.
- `SECRETS-ENCRYPTED` is reserved for encrypted production configuration. Decryption material must be carried separately and must never be written into the USB instructions or reports.

The USB is FAT32 with approximately 29 GB available. No individual artifact may exceed FAT32’s 4 GB single-file limit.

## Inventory Data Flow

1. Codex prepares the collector, instructions, and SHA-256 manifest on the USB.
2. The user physically moves the USB to the Proxmox server and attaches it to the Debian VM.
3. The user identifies the USB partition locally and mounts it with `nodev`, `nosuid`, and `noexec` where practical.
4. The user verifies the SHA-256 manifest before running the collector through an explicit `bash` command.
5. The collector performs read-only inspection of Debian, writes one timestamped report under `FROM-DEBIAN`, and creates a SHA-256 sidecar for that report.
6. The user unmounts the USB and physically returns it to the laptop.
7. Codex reads only the returned report and produces a readiness assessment.
8. A deployment bundle is prepared only after the inventory is reviewed and the migration implementation is ready.

No production service, firewall rule, account, package, tunnel, runtime file, or system configuration is changed during inventory collection.

## Permitted Report Content

The collector may record:

- Collection timestamp and collector checksum.
- Debian release, kernel, hostname, and virtualization type.
- Current non-secret user and group names.
- CPU count, memory, disk layout, filesystem types, mount points, and free capacity.
- Interface names, assigned IP addresses, routes, gateway, and DNS resolver addresses.
- Time synchronization status.
- Installed versions or absence of Git, Node.js, npm, `cloudflared`, `rsync`, `jq`, and related prerequisites.
- Enabled/active state for SSH, QEMU Guest Agent, time synchronization, Project-A, and Cloudflare services.
- Firewall status and listening TCP/UDP socket addresses without process command lines.
- Presence, ownership, and permissions of Project-A target directories without reading file contents.
- Basic outbound DNS and HTTPS reachability to approved public dependencies.

## Forbidden Report Content

The collector must not read or record:

- Environment variables or `/etc/palziv/palziv.env` contents.
- Cloudflare configuration or credential-file contents.
- Service unit command lines that may contain tokens.
- Process command lines.
- Private or public SSH key contents.
- `security.json`, `push.json`, `board.json`, or `analytics.json` contents.
- Application logs, shell history, journals, browser data, recovery material, passwords, tokens, API keys, cookies, or session values.
- Proxmox authentication material or backup-encryption keys.

File and directory names may be reported only when they cannot expose credential values. Secret-bearing directories are represented by existence and permission metadata only.

## USB Integrity And Handling

- Use the dedicated USB only for this migration workflow.
- Disable autorun and do not execute files by double-clicking.
- Verify SHA-256 checksums before using inbound artifacts and after producing returned artifacts.
- Keep production secrets encrypted at rest on the USB.
- Do not store the archive password or decryption key on the same USB.
- Copy deployment artifacts to a controlled staging path before installation; do not run Project-A from the USB.
- Keep the current Windows production host and its runtime data intact until the Debian cutover and rollback window are complete.

## Collector Failure Handling

- Missing optional commands are reported as unavailable rather than causing partial silent output.
- Commands that need elevation report that fact; the collector does not request or capture a password.
- The collector fails safely if the USB return directory is not writable.
- The collector writes to a temporary report, atomically renames it only after collection completes, and removes the temporary file on failure.
- The returned-report checksum is created only after the final report exists.
- The collector does not retry by changing permissions, packages, services, firewall rules, or network configuration.

## Verification

Before the USB is handed to the user:

- Validate the collector with shell syntax checking.
- Run a contract test that rejects forbidden commands and secret-bearing paths.
- Confirm the collector writes only beneath `FROM-DEBIAN`.
- Confirm the checksum manifest matches every handoff artifact.
- Confirm the USB contains no plaintext production secrets.

After the USB returns:

- Verify the returned report checksum.
- Review the report for accidental secret content before using it.
- Compare the evidence against the Proxmox migration runbook’s infrastructure and Debian build gates.

## Acceptance Criteria

- The Debian VM retains normal approved internet access.
- Codex has no remote access path to Debian or Proxmox.
- The user remains the sole command operator on the server.
- The USB collector makes no server-side changes.
- Returned evidence contains enough system, network, storage, time, service, and prerequisite information to make a migration readiness decision.
- No secret or runtime-data contents are exposed to Codex.
- Every transferred non-secret artifact is covered by a verified SHA-256 manifest.

## Out Of Scope

- Performing the production cutover.
- Copying live runtime data before a controlled write freeze.
- Starting or moving the Cloudflare Tunnel connector.
- Configuring Proxmox, Debian, firewalls, backups, systemd, or application secrets.
- Giving Codex temporary remote access for troubleshooting.
