PROJECT-A USB-ONLY MIGRATION HANDOFF

Codex does not connect to Debian or Proxmox. You are the sole server operator.
Complete these phases in order. Stop at the first failed safety check.

PHASE 1 - PREPARE THE USB ON WINDOWS

From the Project-A repository, run:

.\scripts\migration\prepare-usb-handoff.ps1 -UsbDrive D:

Replace D: only with the exact removable USB drive reported by Windows. STOP if
the wrapper reports the wrong drive, non-removable media, a non-FAT32 filesystem,
less than 100 MB free, Node.js older than 22, or an existing
Project-A-Migration bundle. Do not format the drive or delete an old bundle.

PHASE 2 - SAFELY MOVE THE USB

Use Windows "Eject" and wait for safe-removal confirmation. Physically attach
the USB to the Debian VM. STOP if Windows still reports writes in progress, the
device cannot be ejected safely, or you are not certain which USB was moved.

PHASE 3 - IDENTIFY THE DEVICE LOCALLY ON DEBIAN

Run lsblk -f at the Debian console. STOP if you cannot identify the expected
FAT32 USB partition without guessing. Never use a disk or partition that may
contain Debian, Proxmox, application data, or backups.

PHASE 4 - ENTER THE EXACT PARTITION

Use the interactive read -r -p command in the block below. STOP if the value is
not the exact /dev/... partition shown by lsblk.

PHASE 5 - MOUNT WITH RESTRICTIVE OPTIONS

Mount at /mnt/project-a-usb using nodev,nosuid,noexec, the current operator UID
and GID, and umask 077. The effective mount must be equivalent to
mount -o nodev,nosuid,noexec,uid="$(id -u)",gid="$(id -g)",umask=077.
STOP if the mount fails, mounts a different device, or is not FAT32.

PHASE 6 - ENTER THE HANDOFF

Change to /mnt/project-a-usb/Project-A-Migration. STOP if the directory is
missing, contains an unexpected bundle, or cannot be entered.

PHASE 7 - VERIFY THE OUTBOUND CHECKSUMS

Run sha256sum --check CHECKSUMS/TO-DEBIAN.sha256. STOP immediately if any file
is missing or any checksum fails.

PHASE 8 - COLLECT THE REDACTED READINESS REPORT

Run bash TO-DEBIAN/collect-debian-readiness.sh. STOP if the collector reports an
error. Do not print or add passwords, keys, tokens, credentials, environment
values, runtime JSON, or backup-encryption keys.

PHASE 9 - FLUSH AND UNMOUNT

Run sync, leave the mount, and run sudo umount /mnt/project-a-usb. STOP if sync
or unmount fails; do not physically remove a mounted or busy device.

Copy-ready Debian command block:

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

PHASE 10 - RETURN THE USB UNOPENED

Physically return the safely unmounted USB to the laptop. Do not open the
readiness report. STOP if the USB was not unmounted cleanly, is missing, or
appears damaged.

PHASE 11 - VERIFY THE RETURNED HANDOFF ON WINDOWS

From the Project-A repository, run:

node scripts/migration/verify-usb-handoff.mjs --handoff-root D:\Project-A-Migration --mode returned

Replace D: only with the exact removable USB drive. STOP if the return verifier
reports an error. Do not open, print, paste, or transmit the report before a
successful returned-mode verification.
