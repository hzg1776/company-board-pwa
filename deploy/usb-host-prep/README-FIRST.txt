PROJECT-A DEBIAN HOST PREPARATION - LOCAL OPERATOR HANDOFF

Codex has no remote access to Debian or Proxmox. Perform every command locally
at the Debian console. Stop on the first error. Do not retry a failed step.

WINDOWS - BUILD THE SIBLING BUNDLE

From the Project-A repository, run only:

.\scripts\migration\prepare-usb-host-prep.ps1 -UsbDrive D:

Replace D: only with the exact drive letter for the returned removable FAT32
media. The existing returned bundle remains unchanged. The wrapper creates only
the exact sibling Project-A-Migration-Phase-2-Host-Prep. Retain the full
manifest fingerprint printed by the wrapper somewhere separate from the media.
Do not continue unless the wrapper reports successful Phase 2 verification and
successful re-verification of the returned evidence.

DEBIAN - SNAPSHOT AND IDENTIFY THE MEDIA

At the local console, create a Proxmox VM snapshot named exactly with this
pattern immediately before the --apply command:

before-project-a-host-prep-YYYYMMDD-HHMM

Run the detailed lsblk view in the block locally. Identify the expected
removable FAT32 partition without guessing. Stop if it could be the system disk,
a data disk, or a backup disk. The block resolves the partition's PKNAME parent
and requires TYPE=disk, RM=1, and TRAN=usb before mounting. If USB passthrough
reports different RM/TRAN semantics, STOP and record the observed device data.
Adapt this exact identity check to the observed passthrough identity; do not
weaken or bypass it.
The command block below prompts for that literal partition and mounts it with
nodev,nosuid,noexec and a restrictive mask. The noexec option does not block /bin/bash script.sh.
Authenticity comes from the out-of-band fingerprint, the
manifest verification, and the stable local copy.

Copy and run this complete block once:

/usr/bin/env -i \
  HOME="$HOME" \
  PATH="/usr/sbin:/usr/bin:/sbin:/bin" \
  /bin/bash --noprofile --norc <<'PROJECT_A_HOST_PREP_LOCAL'
set -Eeuo pipefail
readonly SYSTEM_PATH='/usr/sbin:/usr/bin:/sbin:/bin'
export PATH="$SYSTEM_PATH"
umask 077

readonly MOUNT_POINT='/mnt/project-a-host-prep-usb'
readonly HANDOFF_ROOT="$MOUNT_POINT/Project-A-Migration-Phase-2-Host-Prep"
USB_DEVICE=''
USB_PARENT_NAME=''
USB_PARENT_DEVICE=''
MOUNT_ATTEMPTED=0
UNMOUNT_ATTEMPTED=0
STAGE_ROOT=''
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
  local canonical=''
  [[ -d "$MOUNT_POINT" && ! -L "$MOUNT_POINT" ]] ||
    stop 'the mountpoint must be a real directory.'
  canonical="$(readlink -e -- "$MOUNT_POINT")" ||
    stop 'the mountpoint could not be canonicalized.'
  [[ "$canonical" == "$MOUNT_POINT" ]] ||
    stop 'the mountpoint was redirected.'
}

verify_mount_source() {
  local source=''
  source="$(findmnt -rn --mountpoint "$MOUNT_POINT" -o SOURCE)" ||
    stop 'the mounted source could not be verified.'
  source="$(readlink -e -- "$source")" ||
    stop 'the mounted source could not be canonicalized.'
  [[ "$source" == "$USB_DEVICE" ]] ||
    stop 'the mounted source does not match the selected partition.'
}

verify_removable_parent() {
  local current_parent_name=''
  local current_parent_device=''
  local current_identity=''
  local current_type=''
  local current_rm=''
  local current_tran=''
  current_parent_name="$(lsblk -dn -o PKNAME -- "$USB_DEVICE")" ||
    stop 'the selected partition parent could not be re-read.'
  [[ "$current_parent_name" == "$USB_PARENT_NAME" ]] ||
    stop 'the selected partition parent changed.'
  current_parent_device="$(readlink -e -- "/dev/$current_parent_name")" ||
    stop 'the selected partition parent could not be re-canonicalized.'
  [[ "$current_parent_device" == "$USB_PARENT_DEVICE" ]] ||
    stop 'the selected partition parent identity changed.'
  current_identity="$(lsblk -dn -o TYPE,RM,TRAN -- "$current_parent_device")" ||
    stop 'the selected partition parent identity could not be re-read.'
  [[ "$current_identity" != *$'\n'* ]] ||
    stop 'the selected partition resolved to an ambiguous parent identity.'
  read -r current_type current_rm current_tran <<< "$current_identity"
  [[ "$current_type" == 'disk' && "$current_rm" == '1' && "$current_tran" == 'usb' ]] ||
    stop 'the selected partition parent is not the approved removable USB identity.'
}

remove_owned_stage_once() {
  local canonical_stage=''
  local canonical_home=''
  [[ -n "$STAGE_ROOT" ]] || return 0
  canonical_home="$(readlink -e -- "$HOME")" ||
    stop 'the home directory could not be canonicalized for cleanup.'
  canonical_stage="$(readlink -e -- "$STAGE_ROOT")" ||
    stop 'the local stage could not be canonicalized for cleanup.'
  case "$canonical_stage" in
    "$canonical_home"/project-a-host-prep.*) ;;
    *) stop 'the local stage is outside the owned cleanup pattern.' ;;
  esac
  [[ "$(dirname -- "$canonical_stage")" == "$canonical_home" ]] ||
    stop 'the local stage parent is not the operator home.'
  rm -rf -- "$canonical_stage" || stop 'the owned local stage could not be removed.'
  STAGE_ROOT=''
}

cleanup() {
  local exit_status=$?
  local cleanup_source=''
  trap - EXIT HUP INT TERM
  set +e
  cd /
  if [[ -n "$STAGE_ROOT" ]]; then
    canonical_home="$(readlink -e -- "$HOME")"
    canonical_stage="$(readlink -e -- "$STAGE_ROOT")"
    case "$canonical_stage" in
      "$canonical_home"/project-a-host-prep.*)
        if [[ "$(dirname -- "$canonical_stage")" == "$canonical_home" ]]; then
          rm -rf -- "$canonical_stage"
        fi
        ;;
    esac
  fi
  if [[ "$MOUNT_ATTEMPTED" -eq 1 && "$UNMOUNT_ATTEMPTED" -eq 0 ]]; then
    UNMOUNT_ATTEMPTED=1
    if [[ -d "$MOUNT_POINT" && ! -L "$MOUNT_POINT" ]]; then
      cleanup_source="$(findmnt -rn --mountpoint "$MOUNT_POINT" -o SOURCE)"
      cleanup_source="$(readlink -e -- "$cleanup_source")"
    fi
    if [[ -n "$USB_DEVICE" && "$cleanup_source" == "$USB_DEVICE" ]]; then
      sudo umount -- "$MOUNT_POINT" ||
        printf 'STOP: cleanup unmount failed; do not remove the media.\n' >&2
    else
      printf 'STOP: cleanup could not verify the mounted source; do not remove the media.\n' >&2
    fi
  fi
  exit "$exit_status"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

lsblk -o NAME,PATH,TYPE,FSTYPE,RM,TRAN,PKNAME,MODEL,SERIAL,SIZE || stop 'lsblk failed.'
IFS= read -r -p 'Enter the exact removable FAT32 partition shown by lsblk: ' USB_DEVICE < /dev/tty ||
  stop 'the partition could not be read.'
USB_DEVICE="$(readlink -e -- "$USB_DEVICE")" || stop 'the partition could not be canonicalized.'
[[ "$USB_DEVICE" == /dev/* && -b "$USB_DEVICE" ]] || stop 'the selection is not a block device beneath /dev.'
[[ "$(lsblk -dn -o TYPE -- "$USB_DEVICE")" == 'part' ]] || stop 'the selection is not a partition.'
[[ "$(lsblk -dn -o FSTYPE -- "$USB_DEVICE")" == 'vfat' ]] || stop 'the selected partition is not FAT32/vfat.'
USB_PARENT_NAME="$(lsblk -dn -o PKNAME -- "$USB_DEVICE")" ||
  stop 'the selected partition parent could not be read.'
[[ "$USB_PARENT_NAME" =~ ^[A-Za-z0-9._-]+$ ]] ||
  stop 'the selected partition parent name is empty or ambiguous.'
USB_PARENT_DEVICE="$(readlink -e -- "/dev/$USB_PARENT_NAME")" ||
  stop 'the selected partition parent could not be canonicalized.'
[[ "$USB_PARENT_DEVICE" == /dev/* && -b "$USB_PARENT_DEVICE" ]] ||
  stop 'the selected partition parent is not a block device beneath /dev.'
USB_PARENT_IDENTITY="$(lsblk -dn -o TYPE,RM,TRAN -- "$USB_PARENT_DEVICE")" ||
  stop 'the selected partition parent identity could not be read.'
[[ "$USB_PARENT_IDENTITY" != *$'\n'* ]] ||
  stop 'the selected partition resolved to an ambiguous parent identity.'
read -r USB_PARENT_TYPE USB_PARENT_RM USB_PARENT_TRAN <<< "$USB_PARENT_IDENTITY"
[[ "$USB_PARENT_TYPE" == 'disk' && "$USB_PARENT_RM" == '1' && "$USB_PARENT_TRAN" == 'usb' ]] ||
  stop 'the selected partition parent is not the approved removable USB identity; STOP and adapt from observed device data, do not weaken the check.'
printf 'Approved USB partition %s has parent %s (TYPE=%s RM=%s TRAN=%s).\n' \
  "$USB_DEVICE" "$USB_PARENT_DEVICE" "$USB_PARENT_TYPE" "$USB_PARENT_RM" "$USB_PARENT_TRAN"

FINDMNT_STATUS=0
findmnt -rn --mountpoint "$MOUNT_POINT" >/dev/null 2>&1 || FINDMNT_STATUS=$?
case "$FINDMNT_STATUS" in
  0) stop 'the target is already mounted.' ;;
  1) ;;
  *) stop 'the target mount state could not be inspected.' ;;
esac
[[ ! -L "$MOUNT_POINT" ]] || stop 'the mountpoint is a symbolic link.'
[[ ! -e "$MOUNT_POINT" || -d "$MOUNT_POINT" ]] || stop 'the mountpoint is not a directory.'
sudo mkdir -p -- "$MOUNT_POINT" || stop 'the mountpoint could not be created.'
require_literal_mount_directory
FINDMNT_STATUS=0
findmnt -rn --mountpoint "$MOUNT_POINT" >/dev/null 2>&1 || FINDMNT_STATUS=$?
[[ "$FINDMNT_STATUS" -eq 1 ]] || stop 'the target became mounted before the approved mount.'

OPERATOR_UID="$(id -u)" || stop 'the operator UID could not be read.'
OPERATOR_GID="$(id -g)" || stop 'the operator GID could not be read.'
readonly OPERATOR_UID OPERATOR_GID
REQUESTED_OPTIONS="nodev,nosuid,noexec,uid=$OPERATOR_UID,gid=$OPERATOR_GID,umask=077"
readonly REQUESTED_OPTIONS
require_literal_mount_directory
verify_removable_parent
MOUNT_ATTEMPTED=1
sudo mount -t vfat -o "$REQUESTED_OPTIONS" -- "$USB_DEVICE" "$MOUNT_POINT" ||
  stop 'the restrictive vfat mount failed.'
verify_mount_source
[[ "$(findmnt -rn --mountpoint "$MOUNT_POINT" -o FSTYPE)" == 'vfat' ]] ||
  stop 'the effective mounted filesystem is not vfat.'
EFFECTIVE_OPTIONS="$(findmnt -rn --mountpoint "$MOUNT_POINT" -o OPTIONS)" ||
  stop 'the effective mount options could not be inspected.'
option_present nodev && option_present nosuid && option_present noexec &&
  option_present "uid=$OPERATOR_UID" && option_present "gid=$OPERATOR_GID" ||
  stop 'the effective mount options are missing a required restriction.'
if option_present umask=077 || option_present umask=0077; then
  :
elif { option_present fmask=077 || option_present fmask=0077; } &&
  { option_present dmask=077 || option_present dmask=0077; }; then
  :
else
  stop 'the effective mount mask is not restrictive.'
fi

cd -- "$HANDOFF_ROOT" || stop 'the exact Phase 2 handoff root is missing.'
printf '%s\n' 'Compare the next full SHA-256 with the separately retained Codex value:'
sha256sum CHECKSUMS/PHASE-2-HOST-PREP.sha256 || stop 'manifest fingerprinting failed.'
IFS= read -r -p 'Enter the separately retained 64-character SHA-256: ' EXPECTED_FINGERPRINT < /dev/tty ||
  stop 'the out-of-band fingerprint could not be read.'
[[ "$EXPECTED_FINGERPRINT" =~ ^[a-f0-9]{64}$ ]] || stop 'the out-of-band fingerprint is invalid.'
ACTUAL_FINGERPRINT="$(sha256sum CHECKSUMS/PHASE-2-HOST-PREP.sha256 | awk '{print $1}')" ||
  stop 'manifest fingerprinting failed.'
[[ "$ACTUAL_FINGERPRINT" == "$EXPECTED_FINGERPRINT" ]] || stop 'the full manifest fingerprint does not match.'
sha256sum --check CHECKSUMS/PHASE-2-HOST-PREP.sha256 || stop 'media checksum verification failed.'

STAGE_ROOT="$(mktemp -d "$HOME/project-a-host-prep.XXXXXX")" || stop 'the local stage could not be created.'
cp -a -- "$HANDOFF_ROOT/." "$STAGE_ROOT/" || stop 'the verified local staging copy failed.'
cd -- "$STAGE_ROOT" || stop 'the local stage could not be entered.'
COPIED_MANIFEST_FINGERPRINT="$(sha256sum CHECKSUMS/PHASE-2-HOST-PREP.sha256 | awk '{print $1}')" ||
  stop 'copied manifest fingerprinting failed.'
[[ "$COPIED_MANIFEST_FINGERPRINT" == "$EXPECTED_FINGERPRINT" ]] ||
  stop 'the copied manifest fingerprint does not match the approved out-of-band value.'
sha256sum --check CHECKSUMS/PHASE-2-HOST-PREP.sha256 || stop 'local checksum verification failed.'

/usr/bin/env -i \
  HOME="$HOME" \
  PATH="/usr/sbin:/usr/bin:/sbin:/bin" \
  /bin/bash -p TO-DEBIAN/preflight-host-prep.sh || stop 'host preparation preflight failed.'

printf '%s\n' 'STOP unless the Proxmox snapshot before-project-a-host-prep-YYYYMMDD-HHMM now exists.'
IFS= read -r -p 'Type APPLY after confirming the snapshot exists: ' APPLY_CONFIRMATION < /dev/tty ||
  stop 'snapshot confirmation could not be read.'
[[ "$APPLY_CONFIRMATION" == 'APPLY' ]] || stop 'snapshot confirmation was not provided.'

set +e
sudo /usr/bin/env -i \
  HOME=/root \
  PATH="/usr/sbin:/usr/bin:/sbin:/bin" \
  /bin/bash -p TO-DEBIAN/apply-host-prep.sh --apply
APPLY_STATUS=$?
set -e

set +e
/usr/bin/env -i \
  HOME="$HOME" \
  PATH="/usr/sbin:/usr/bin:/sbin:/bin" \
  /bin/bash TO-DEBIAN/collect-host-prep-evidence.sh \
  --usb-root "$HANDOFF_ROOT"
COLLECTOR_STATUS=$?
set -e
[[ "$APPLY_STATUS" -eq 0 ]] || stop 'host preparation apply failed; evidence was collected once and no retry is allowed.'
[[ "$COLLECTOR_STATUS" -eq 0 ]] || stop 'host preparation evidence collection failed; do not retry.'

remove_owned_stage_once
verify_mount_source
sync || stop 'sync failed.'
cd / || stop 'the mount directory could not be left.'
UNMOUNT_ATTEMPTED=1
sudo umount -- "$MOUNT_POINT" || stop 'unmount failed; do not remove the media.'
MOUNT_ATTEMPTED=0
trap - EXIT HUP INT TERM
printf '%s\n' 'Host preparation completed; the media is unmounted.'
PROJECT_A_HOST_PREP_LOCAL

If any command stops, preserve the media and the Proxmox snapshot. Do not run
the block again. A failed apply causes exactly one evidence collection attempt
and then stops. A failed unmount must not be retried in this flow.
