PROJECT-A LOCAL DEBIAN APPLIANCE

This directory is a complete, checksum-verified Proxmox handoff. Keep every
file together and transfer the directory over encrypted media or an
authenticated encrypted channel.

Before import:
1. Run: sha256sum --check --strict ARTIFACTS.sha256
2. Review BUILD-MANIFEST.json and VERIFY-LOCAL.json.
3. Keep the VM stopped until its Proxmox network and firewall are reviewed.

Import on a Proxmox node as root by setting VMID, IMAGE_PATH, STORAGE, BRIDGE,
SSH_KEY_FILE, and optionally IP_CONFIG, then run IMPORT-ON-PROXMOX.sh.
The script imports the disk but never starts or destroys a VM.

Cloudflare is disabled inside the appliance. Production data, tunnel
credentials, passwords, and the private build SSH key are not included.
