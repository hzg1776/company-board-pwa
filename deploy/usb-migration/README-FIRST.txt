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

Run the collector only through the clean /usr/bin/env and /bin/bash invocation
in the block below. STOP if the collector reports an error. Do not print or add
passwords, keys, tokens, credentials, environment values, runtime JSON, or
backup-encryption keys.

PHASE 9 - FLUSH AND UNMOUNT

Run sync, leave the mount, and run sudo umount /mnt/project-a-usb. STOP if sync
or unmount fails; do not physically remove a mounted or busy device.

Copy-ready Debian command block:

/usr/bin/env -i \
  PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' \
  LC_ALL=C \
  /bin/bash --noprofile --norc <<'PROJECT_A_USB_MOUNT'
set -Eeuo pipefail
readonly SYSTEM_PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export PATH="$SYSTEM_PATH"
export LC_ALL=C
umask 077

readonly MOUNT_POINT='/mnt/project-a-usb'
readonly HANDOFF_DIR="$MOUNT_POINT/Project-A-Migration"
MOUNT_ATTEMPTED=0
MOUNTED=0
USB_DEVICE=''
EFFECTIVE_OPTIONS=''

stop() {
  printf 'STOP: %s\n' "$1" >&2
  exit 1
}

option_present() {
  case ",$EFFECTIVE_OPTIONS," in
    *",$1,"*) return 0 ;;
    *) return 1 ;;
  esac
}

require_literal_mount_directory() {
  local canonical_mount_point=''
  [[ -d "$MOUNT_POINT" && ! -L "$MOUNT_POINT" ]] ||
    stop 'the USB mountpoint must be a real directory, not a symbolic link.'
  canonical_mount_point="$(readlink -e -- "$MOUNT_POINT")" ||
    stop 'the USB mountpoint could not be canonicalized.'
  [[ "$canonical_mount_point" == "$MOUNT_POINT" ]] ||
    stop 'the USB mountpoint canonical path does not match the approved literal path.'
}

cleanup() {
  local exit_status=$?
  local cleanup_mount_point=''
  local cleanup_source=''
  trap - EXIT HUP INT TERM
  set +e
  cd /
  if [[ "$MOUNT_ATTEMPTED" -eq 1 ]]; then
    if [[ -d "$MOUNT_POINT" && ! -L "$MOUNT_POINT" ]]; then
      cleanup_mount_point="$(readlink -e -- "$MOUNT_POINT")"
    fi
    if [[ "$cleanup_mount_point" == "$MOUNT_POINT" ]]; then
      cleanup_source="$(findmnt -rn --mountpoint "$MOUNT_POINT" -o SOURCE)"
      if [[ -n "$cleanup_source" ]]; then
        cleanup_source="$(readlink -e -- "$cleanup_source")"
      fi
    fi
    if [[ -n "$USB_DEVICE" && "$cleanup_source" == "$USB_DEVICE" ]]; then
      if sudo umount -- "$MOUNT_POINT"; then
        MOUNT_ATTEMPTED=0
        MOUNTED=0
      else
        printf 'STOP: automatic USB unmount failed; do not remove the device.\n' >&2
      fi
    else
      printf 'STOP: cleanup could not verify the mounted USB source; do not remove the device.\n' >&2
    fi
  fi
  exit "$exit_status"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

lsblk -f || stop 'lsblk failed.'
IFS= read -r -p "Enter the USB partition path shown by lsblk (example: /dev/sdb1): " USB_DEVICE < /dev/tty ||
  stop 'could not read the USB partition from the terminal.'
USB_DEVICE="$(readlink -e -- "$USB_DEVICE")" ||
  stop 'the selected device could not be canonicalized.'
[[ "$USB_DEVICE" == /dev/* ]] ||
  stop 'the selected device is not beneath /dev.'
[[ -b "$USB_DEVICE" ]] ||
  stop 'the selected device is not an existing block device.'

DEVICE_TYPE="$(lsblk -dn -o TYPE -- "$USB_DEVICE")" ||
  stop 'the selected device type could not be read.'
[[ "$DEVICE_TYPE" == 'part' ]] ||
  stop 'the selected device is not a partition.'
DEVICE_FSTYPE="$(lsblk -dn -o FSTYPE -- "$USB_DEVICE")" ||
  stop 'the selected filesystem could not be read.'
[[ "$DEVICE_FSTYPE" == 'vfat' ]] ||
  stop 'the selected partition filesystem is not vfat.'

FINDMNT_STATUS=0
findmnt -rn --mountpoint "$MOUNT_POINT" >/dev/null 2>&1 ||
  FINDMNT_STATUS=$?
case "$FINDMNT_STATUS" in
  0) stop 'the USB mount target is already mounted.' ;;
  1) ;;
  *) stop 'the USB mount target state could not be verified.' ;;
esac

[[ ! -L "$MOUNT_POINT" ]] ||
  stop 'the USB mountpoint is a symbolic link.'
[[ ! -e "$MOUNT_POINT" || -d "$MOUNT_POINT" ]] ||
  stop 'the USB mountpoint exists but is not a directory.'
sudo mkdir -p -- "$MOUNT_POINT" ||
  stop 'the USB mount directory could not be created.'
require_literal_mount_directory
FINDMNT_STATUS=0
findmnt -rn --mountpoint "$MOUNT_POINT" >/dev/null 2>&1 ||
  FINDMNT_STATUS=$?
case "$FINDMNT_STATUS" in
  0) stop 'the USB mount target became mounted before setup completed.' ;;
  1) ;;
  *) stop 'the USB mount target state could not be rechecked.' ;;
esac

OPERATOR_UID="$(id -u)" || stop 'the operator UID could not be read.'
OPERATOR_GID="$(id -g)" || stop 'the operator GID could not be read.'
readonly OPERATOR_UID OPERATOR_GID
REQUESTED_OPTIONS="nodev,nosuid,noexec,uid=$OPERATOR_UID,gid=$OPERATOR_GID,umask=077"
readonly REQUESTED_OPTIONS

require_literal_mount_directory
MOUNT_ATTEMPTED=1
sudo mount -t vfat -o "$REQUESTED_OPTIONS" -- "$USB_DEVICE" "$MOUNT_POINT" ||
  stop 'the vfat USB mount failed.'
MOUNTED=1

MOUNT_SOURCE="$(findmnt -rn --mountpoint "$MOUNT_POINT" -o SOURCE)" ||
  stop 'the mounted source could not be verified.'
MOUNT_SOURCE="$(readlink -e -- "$MOUNT_SOURCE")" ||
  stop 'the mounted source could not be canonicalized.'
[[ "$MOUNT_SOURCE" == "$USB_DEVICE" ]] ||
  stop 'the mounted source does not match the selected USB partition.'
MOUNT_FSTYPE="$(findmnt -rn --mountpoint "$MOUNT_POINT" -o FSTYPE)" ||
  stop 'the mounted filesystem type could not be verified.'
[[ "$MOUNT_FSTYPE" == 'vfat' ]] ||
  stop 'the effective mounted filesystem is not vfat.'
EFFECTIVE_OPTIONS="$(findmnt -rn --mountpoint "$MOUNT_POINT" -o OPTIONS)" ||
  stop 'the effective mount options could not be verified.'

option_present nodev &&
  option_present nosuid &&
  option_present noexec &&
  option_present "uid=$OPERATOR_UID" &&
  option_present "gid=$OPERATOR_GID" ||
  stop 'the effective mount options are missing a required restriction or identity.'
if option_present umask=077 || option_present umask=0077; then
  :
elif { option_present fmask=077 || option_present fmask=0077; } &&
  { option_present dmask=077 || option_present dmask=0077; }; then
  :
else
  stop 'the effective mount options do not have a restrictive mask.'
fi

cd "$HANDOFF_DIR" || stop 'the Project-A handoff directory could not be entered.'
sha256sum --check CHECKSUMS/TO-DEBIAN.sha256 ||
  stop 'outbound checksum verification failed.'
/usr/bin/env -i PATH="$SYSTEM_PATH" LC_ALL=C /bin/bash --noprofile --norc \
  TO-DEBIAN/collect-debian-readiness.sh ||
  stop 'readiness collection failed.'
sync || stop 'sync failed.'
cd / || stop 'could not leave the USB handoff directory.'
if sudo umount -- "$MOUNT_POINT"; then
  MOUNT_ATTEMPTED=0
  MOUNTED=0
else
  stop 'USB unmount failed; do not remove the device.'
fi

trap - EXIT HUP INT TERM
printf 'USB readiness collection completed and the USB was unmounted.\n'
PROJECT_A_USB_MOUNT

PHASE 10 - RETURN THE USB UNOPENED

Physically return the safely unmounted USB to the laptop. Do not open the
readiness report. STOP if the USB was not unmounted cleanly, is missing, or
appears damaged.

If a power loss or SIGKILL leaves .debian-readiness-*.lock or
.debian-readiness.*.tmp files in FROM-DEBIAN, stop and return the USB for
inspection. Do not delete the residue or retry the collector.

PHASE 11 - VERIFY THE RETURNED HANDOFF ON WINDOWS

From the Project-A repository, run:

node scripts/migration/verify-usb-handoff.mjs --handoff-root D:\Project-A-Migration --mode returned

Replace D: only with the exact removable USB drive. STOP if the return verifier
reports an error. Do not open, print, paste, or transmit the report before a
successful returned-mode verification.
