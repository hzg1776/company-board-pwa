#!/usr/bin/env bash
set -Eeuo pipefail

readonly IMAGE_NAME='debian-13-genericcloud-amd64.qcow2'
readonly IMAGE_URL="https://cloud.debian.org/images/cloud/trixie/latest/${IMAGE_NAME}"
readonly SUMS_URL='https://cloud.debian.org/images/cloud/trixie/latest/SHA512SUMS'
readonly DISK_VIRTUAL_SIZE='40G'
readonly DEFAULT_SSH_TIMEOUT_SECONDS=300
readonly DEFAULT_SHUTDOWN_SSH_TIMEOUT_SECONDS=30
readonly SHUTDOWN_TIMEOUT_SECONDS=180

REPOSITORY=''
BUILD_ROOT=''
RELEASE_TAR=''
RELEASE_SHA=''
BUILD_ID=''
BUILD_PUBLIC_KEY=''
BOOT_ONLY=0
QEMU_PID=''
WORK_DISK=''
QGA_SOCKET=''
QGA_RUNTIME_DIR=''
QGA_RUNTIME_ID=''
QGA_RUNTIME_OWNED=0
EXPECTED_OS_DRIVE_ARGUMENT=''

report_error() {
  local rc=$?
  trap - ERR
  printf 'ERROR line=%s status=%s command=%q\n' "$BASH_LINENO" "$rc" "$BASH_COMMAND" >&2
  exit "$rc"
}
trap report_error ERR

fail() {
  printf '%s\n' "$1" >&2
  return 1
}

require_absolute_path() {
  local label="$1" value="$2"
  [[ "$value" == /* ]] || fail "$label must be an absolute path."
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* && "$value" != *$'\t'* ]] || fail "$label contains control characters."
}

require_unlinked_existing_path() {
  local label="$1" value="$2" expected_type="$3" resolved
  [[ ! -L "$value" ]] || fail "$label must not be a symbolic link."
  case "$expected_type" in
    directory) [[ -d "$value" ]] || fail "$label must be an existing directory." ;;
    file) [[ -f "$value" ]] || fail "$label must be an existing regular file." ;;
    *) fail "Internal path-type error." ;;
  esac
  resolved="$(realpath -e -- "$value")"
  [[ "$resolved" == "$value" ]] || fail "$label must not traverse a linked path."
}

reserve_empty_file() {
  local destination="$1"
  (set -o noclobber; : > "$destination") 2>/dev/null || fail "Path already exists; refusing to reuse: $destination"
}

publish_noclobber() {
  local source="$1" destination="$2"
  if ! ln -- "$source" "$destination" 2>/dev/null; then
    fail "Destination already exists; refusing to overwrite: $destination"
  fi
  rm -- "$source"
}

download_to_partial() {
  local url="$1" destination="$2" partial="${2}.partial.$$"
  reserve_empty_file "$partial"
  curl --fail --location --silent --show-error \
    --connect-timeout 15 --max-time 900 \
    --retry 3 --retry-all-errors --retry-max-time 120 \
    --proto '=https' --proto-redir '=https' \
    --output "$partial" "$url"
  printf '%s\n' "$partial"
}

json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "$value"
}

process_is_alive() {
  local pid="$1" state
  [[ -r "/proc/${pid}/stat" ]] || return 1
  read -r _ _ state _ 2>/dev/null < "/proc/${pid}/stat" || return 1
  [[ "$state" != 'Z' ]]
}

is_owned_qemu_process() {
  local pid="$1" actual_exe expected_exe argument previous='' found=0
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  process_is_alive "$pid" || return 1
  actual_exe="$(readlink -f -- "/proc/${pid}/exe" 2>/dev/null)" || return 1
  expected_exe="$(readlink -f -- "$(command -v qemu-system-x86_64)")" || return 1
  [[ "$actual_exe" == "$expected_exe" ]] || return 1
  [[ -n "$EXPECTED_OS_DRIVE_ARGUMENT" ]] || return 1
  while IFS= read -r -d '' argument; do
    if [[ "$previous" == '-drive' && "$argument" == "$EXPECTED_OS_DRIVE_ARGUMENT" ]]; then
      found=1
      break
    fi
    previous="$argument"
  done < "/proc/${pid}/cmdline"
  [[ "$found" -eq 1 ]]
}

stop_owned_qemu() {
  local pid="${QEMU_PID:-}" attempt
  [[ -n "$pid" ]] || return 0
  process_is_alive "$pid" || return 0
  is_owned_qemu_process "$pid" || return 0
  kill -TERM "$pid" 2>/dev/null || true
  for ((attempt=0; attempt<10; attempt++)); do
    process_is_alive "$pid" || return 0
    sleep 1
  done
  is_owned_qemu_process "$pid" && kill -KILL "$pid" 2>/dev/null || true
}

cleanup() {
  local rc=$? actual_id actual_mode actual_uid actual_path
  trap - EXIT ERR
  stop_owned_qemu
  if [[ "$QGA_RUNTIME_OWNED" -eq 1 && -n "$QGA_RUNTIME_DIR" && -d "$QGA_RUNTIME_DIR" && ! -L "$QGA_RUNTIME_DIR" ]]; then
    actual_path="$(realpath -e -- "$QGA_RUNTIME_DIR" 2>/dev/null || true)"
    actual_id="$(stat -Lc '%d:%i' -- "$QGA_RUNTIME_DIR" 2>/dev/null || true)"
    actual_uid="$(stat -Lc '%u' -- "$QGA_RUNTIME_DIR" 2>/dev/null || true)"
    actual_mode="$(stat -Lc '%a' -- "$QGA_RUNTIME_DIR" 2>/dev/null || true)"
    if [[ "$actual_path" == "$QGA_RUNTIME_DIR" && "$actual_id" == "$QGA_RUNTIME_ID" && "$actual_uid" == '0' && "$actual_mode" == '700' ]]; then
      if [[ -S "$QGA_SOCKET" && ! -L "$QGA_SOCKET" ]]; then
        rm -- "$QGA_SOCKET"
      fi
      rmdir -- "$QGA_RUNTIME_DIR" 2>/dev/null || true
    fi
  fi
  exit "$rc"
}
trap cleanup EXIT

choose_unused_port() {
  local listeners port
  listeners="$(ss -H -ltn)"
  for ((port=22000; port<=42000; port++)); do
    if ! grep -Eq "(^|[.:[[:space:]])${port}([[:space:]]|$)" <<< "$listeners"; then
      printf '%s\n' "$port"
      return 0
    fi
  done
  fail 'No unused loopback SSH port is available.'
}

listener_is_loopback_only() {
  local output local_address found=0
  output="$(ss -H -ltn "sport = :${SSH_PORT}")"
  while read -r _ _ _ local_address _; do
    [[ -n "$local_address" ]] || continue
    case "$local_address" in
      "127.0.0.1:${SSH_PORT}") found=1 ;;
      *":${SSH_PORT}") return 1 ;;
    esac
  done <<< "$output"
  [[ "$found" -eq 1 ]]
}

monotonic_seconds() {
  local uptime
  read -r uptime _ < /proc/uptime
  printf '%s\n' "${uptime%%.*}"
}

write_build_state() {
  local classification="$1" temporary="${BUILD_STATE}.partial.$$"
  reserve_empty_file "$temporary"
  printf '{"schemaVersion":1,"classification":"%s","buildId":"%s","releaseSha":"%s","sshPort":%s,"qemuPid":%s,"workingDisk":"%s","qgaSocket":"%s"}\n' \
    "$classification" "$BUILD_ID" "$RELEASE_SHA" "$SSH_PORT" "$QEMU_PID" "$(json_escape "$WORK_DISK")" "$(json_escape "$QGA_SOCKET")" > "$temporary"
  mv -f -T -- "$temporary" "$BUILD_STATE"
}

while (($#)); do
  case "$1" in
    --repository) [[ $# -ge 2 ]] || fail '--repository requires a value.'; REPOSITORY="$2"; shift 2 ;;
    --build-root) [[ $# -ge 2 ]] || fail '--build-root requires a value.'; BUILD_ROOT="$2"; shift 2 ;;
    --release-tar) [[ $# -ge 2 ]] || fail '--release-tar requires a value.'; RELEASE_TAR="$2"; shift 2 ;;
    --release-sha) [[ $# -ge 2 ]] || fail '--release-sha requires a value.'; RELEASE_SHA="$2"; shift 2 ;;
    --build-id) [[ $# -ge 2 ]] || fail '--build-id requires a value.'; BUILD_ID="$2"; shift 2 ;;
    --build-public-key) [[ $# -ge 2 ]] || fail '--build-public-key requires a value.'; BUILD_PUBLIC_KEY="$2"; shift 2 ;;
    --boot-only) BOOT_ONLY=1; shift ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

[[ "$EUID" -eq 0 ]] || fail 'Run as root inside WSL.'
for required in REPOSITORY BUILD_ROOT RELEASE_TAR RELEASE_SHA BUILD_ID BUILD_PUBLIC_KEY; do
  [[ -n "${!required}" ]] || fail "Missing required argument: ${required}"
done
[[ "$RELEASE_SHA" =~ ^[a-f0-9]{40}$ ]] || fail 'Release SHA must be exactly 40 lowercase hexadecimal characters.'
[[ "$BUILD_ID" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$ ]] || fail 'Build ID is invalid.'
[[ "$BOOT_ONLY" -eq 1 ]] || fail 'This controller currently requires the explicit --boot-only boundary.'

require_absolute_path 'Repository' "$REPOSITORY"
require_absolute_path 'Build root' "$BUILD_ROOT"
require_absolute_path 'Release tar' "$RELEASE_TAR"
require_absolute_path 'Build public key' "$BUILD_PUBLIC_KEY"
require_unlinked_existing_path 'Repository' "$REPOSITORY" directory
require_unlinked_existing_path 'Build root' "$BUILD_ROOT" directory
require_unlinked_existing_path 'Release tar' "$RELEASE_TAR" file
require_unlinked_existing_path 'Build public key' "$BUILD_PUBLIC_KEY" file

[[ "$(basename -- "$BUILD_ROOT")" == "$BUILD_ID" ]] || fail 'Build root basename must match the build ID.'
[[ "$BUILD_ROOT" == "$REPOSITORY/artifacts/"* ]] || fail 'Build root must remain beneath repository artifacts.'
[[ "$RELEASE_TAR" == "$BUILD_ROOT/project-a-release.tar" ]] || fail 'Release tar must be the named build-local archive.'
[[ "$BUILD_PUBLIC_KEY" == "$BUILD_ROOT/build_ssh_ed25519.pub" ]] || fail 'Build public key must be the named build-local key.'

readonly BUILD_PRIVATE_KEY="${BUILD_PUBLIC_KEY%.pub}"
require_unlinked_existing_path 'Build private key' "$BUILD_PRIVATE_KEY" file

readonly OUTPUT_ROOT="$(dirname -- "$BUILD_ROOT")"
readonly CACHE_ROOT="${OUTPUT_ROOT}/.cache"
readonly WORK_ROOT="${BUILD_ROOT}/work"
readonly SEED_ROOT="${BUILD_ROOT}/seed"
readonly SUMS_FILE="${BUILD_ROOT}/SHA512SUMS"
readonly WORK_DISK="${WORK_ROOT}/work-disk.qcow2"
readonly BUILD_BASE_IMAGE="${WORK_ROOT}/base-image.qcow2"
readonly SEED_IMAGE="${WORK_ROOT}/seed.img"
readonly CONSOLE_LOG="${BUILD_ROOT}/qemu-console.log"
readonly QEMU_PID_FILE="${BUILD_ROOT}/qemu.pid"
readonly BUILD_STATE="${BUILD_ROOT}/BUILD-STATE.json"
readonly KNOWN_HOSTS="${BUILD_ROOT}/known_hosts"

require_unlinked_existing_path 'Output root' "$OUTPUT_ROOT" directory
if [[ -e "$CACHE_ROOT" || -L "$CACHE_ROOT" ]]; then
  require_unlinked_existing_path 'Cache root' "$CACHE_ROOT" directory
else
  mkdir -- "$CACHE_ROOT"
fi

for child in "$WORK_ROOT" "$SEED_ROOT" "$SUMS_FILE" "$CONSOLE_LOG" "$QEMU_PID_FILE" "$BUILD_STATE" "$KNOWN_HOSTS"; do
  [[ ! -e "$child" && ! -L "$child" ]] || fail "Path already exists; refusing to reuse: $child"
done
[[ -c /dev/kvm ]] || fail 'KVM is required at /dev/kvm.'
readonly KVM_DEVICE="${PALZIV_APPLIANCE_KVM_DEVICE:-/dev/kvm}"
[[ -c "$KVM_DEVICE" ]] || fail 'KVM is required at /dev/kvm.'
export DEBIAN_FRONTEND=noninteractive
apt-get update >/dev/null
apt-get install -y ca-certificates cloud-image-utils curl jq openssh-client qemu-system-x86 qemu-utils >/dev/null

umask 077
mkdir -- "$WORK_ROOT" "$SEED_ROOT"
QGA_RUNTIME_DIR="$(mktemp -d /tmp/palziv-qga.XXXXXXXX)"
chmod 0700 -- "$QGA_RUNTIME_DIR"
QGA_RUNTIME_DIR="$(realpath -e -- "$QGA_RUNTIME_DIR")"
[[ ! -L "$QGA_RUNTIME_DIR" ]] || fail 'QEMU guest-agent runtime directory must not be a symbolic link.'
[[ "$(stat -Lc '%u:%a' -- "$QGA_RUNTIME_DIR")" == '0:700' ]] || fail 'QEMU guest-agent runtime directory ownership or mode was unsafe.'
QGA_RUNTIME_ID="$(stat -Lc '%d:%i' -- "$QGA_RUNTIME_DIR")"
QGA_RUNTIME_OWNED=1
QGA_SOCKET="${QGA_RUNTIME_DIR}/qga.sock"
[[ "$(printf '%s' "$QGA_SOCKET" | wc -c)" -lt 108 ]] || fail 'QEMU guest-agent socket path exceeds sockaddr_un.'

sums_partial="$(download_to_partial "$SUMS_URL" "$SUMS_FILE")"
expected_line="$(grep -E "^[a-f0-9]{128}  ${IMAGE_NAME}$" "$sums_partial" || true)"
[[ "$(wc -l <<< "$expected_line")" -eq 1 && -n "$expected_line" ]] || fail 'SHA512SUMS did not contain exactly one trusted image entry.'
readonly IMAGE_SHA512="${expected_line%% *}"
publish_noclobber "$sums_partial" "$SUMS_FILE"

readonly BASE_IMAGE="${CACHE_ROOT}/${IMAGE_NAME}"
if [[ -e "$BASE_IMAGE" || -L "$BASE_IMAGE" ]]; then
  require_unlinked_existing_path 'Cached Debian image' "$BASE_IMAGE" file
  printf '%s  %s\n' "$IMAGE_SHA512" "$IMAGE_NAME" > "$WORK_ROOT/${IMAGE_NAME}.sha512"
  (cd -- "$CACHE_ROOT" && sha512sum --check --strict "$WORK_ROOT/${IMAGE_NAME}.sha512" >/dev/null) || fail 'Cached Debian image SHA-512 checksum failed.'
else
  image_partial="$(download_to_partial "$IMAGE_URL" "$BASE_IMAGE")"
  image_partial_name="$(basename -- "$image_partial")"
  printf '%s  %s\n' "$IMAGE_SHA512" "$image_partial_name" > "$WORK_ROOT/${IMAGE_NAME}.partial.sha512"
  (cd -- "$CACHE_ROOT" && sha512sum --check --strict "$WORK_ROOT/${IMAGE_NAME}.partial.sha512" >/dev/null) || fail 'Downloaded Debian image SHA-512 checksum failed.'
  publish_noclobber "$image_partial" "$BASE_IMAGE"
fi

base_snapshot_partial="${BUILD_BASE_IMAGE}.partial.$$"
reserve_empty_file "$base_snapshot_partial"
cp --reflink=never -- "$BASE_IMAGE" "$base_snapshot_partial"
publish_noclobber "$base_snapshot_partial" "$BUILD_BASE_IMAGE"
chmod 0444 -- "$BUILD_BASE_IMAGE"
snapshot_checksum="${WORK_ROOT}/${IMAGE_NAME}.snapshot.sha512"
snapshot_checksum_partial="${snapshot_checksum}.partial.$$"
reserve_empty_file "$snapshot_checksum_partial"
printf '%s  %s\n' "$IMAGE_SHA512" "$(basename -- "$BUILD_BASE_IMAGE")" > "$snapshot_checksum_partial"
(cd -- "$WORK_ROOT" && sha512sum --check --strict "$(basename -- "$snapshot_checksum_partial")" >/dev/null) || fail 'Build-local Debian image snapshot SHA-512 checksum failed.'
publish_noclobber "$snapshot_checksum_partial" "$snapshot_checksum"

qemu-img create -f qcow2 -F qcow2 -b "$BUILD_BASE_IMAGE" "$WORK_DISK" "$DISK_VIRTUAL_SIZE" >/dev/null

public_key="$(<"$BUILD_PUBLIC_KEY")"
[[ "$(wc -l < "$BUILD_PUBLIC_KEY")" -eq 1 ]] || fail 'Build public key must contain exactly one line.'
[[ "$public_key" =~ ^ssh-ed25519\ [A-Za-z0-9+/]+={0,3}(\ [A-Za-z0-9._@+-]+)?$ ]] || fail 'Build public key is not a bounded Ed25519 public key.'

printf 'instance-id: palziv-build-%s\nlocal-hostname: palziv-build\n' "$BUILD_ID" > "$SEED_ROOT/meta-data"
printf '%s\n' \
  '#cloud-config' \
  'users:' \
  '  - name: palziv-build' \
  '    groups: [sudo]' \
  '    sudo: ALL=(ALL) NOPASSWD:ALL' \
  '    shell: /bin/bash' \
  '    ssh_authorized_keys:' \
  "      - ${public_key}" \
  'ssh_pwauth: false' \
  'disable_root: true' \
  'packages: [openssh-server]' > "$SEED_ROOT/user-data"
cloud-localds "$SEED_IMAGE" "$SEED_ROOT/user-data" "$SEED_ROOT/meta-data" >/dev/null

readonly SSH_PORT="$(choose_unused_port)"
readonly EXPECTED_OS_DRIVE_ARGUMENT="file=${WORK_DISK},if=none,format=qcow2,id=osdisk"
qemu-system-x86_64 \
  -accel kvm \
  -machine q35 \
  -cpu host \
  -smp 2 \
  -m 4096 \
  -device virtio-scsi-pci,id=scsi0 \
  -drive "$EXPECTED_OS_DRIVE_ARGUMENT" \
  -device scsi-hd,drive=osdisk \
  -drive "file=${SEED_IMAGE},if=virtio,format=raw,readonly=on" \
  -device virtio-serial-pci \
  -chardev "socket,path=${QGA_SOCKET},server=on,wait=off,id=qga0" \
  -device virtserialport,chardev=qga0,name=org.qemu.guest_agent.0 \
  -device virtio-net-pci,netdev=net0 \
  -netdev "user,id=net0,hostfwd=tcp:127.0.0.1:${SSH_PORT}-:22" \
  -display none \
  -serial "file:${CONSOLE_LOG}" \
  -monitor none \
  -pidfile "$QEMU_PID_FILE" \
  -daemonize

[[ -f "$QEMU_PID_FILE" && ! -L "$QEMU_PID_FILE" ]] || fail 'QEMU did not create its build-local PID file.'
[[ "$(wc -c < "$QEMU_PID_FILE")" -le 32 ]] || fail 'QEMU PID file was not bounded.'
QEMU_PID="$(<"$QEMU_PID_FILE")"
[[ "$QEMU_PID" =~ ^[1-9][0-9]*$ ]] || fail 'QEMU PID file was invalid.'
is_owned_qemu_process "$QEMU_PID" || fail 'Recorded PID is not the owned QEMU process for this working disk.'
write_build_state 'booting'

ssh_timeout="${PALZIV_APPLIANCE_SSH_TIMEOUT_SECONDS:-$DEFAULT_SSH_TIMEOUT_SECONDS}"
[[ "$ssh_timeout" =~ ^[1-9][0-9]{0,2}$ && "$ssh_timeout" -le "$DEFAULT_SSH_TIMEOUT_SECONDS" ]] || fail 'SSH timeout must be between 1 and 300 seconds.'
host_key=''
ssh_deadline=$(( $(monotonic_seconds) + ssh_timeout ))
while (( $(monotonic_seconds) < ssh_deadline )); do
  is_owned_qemu_process "$QEMU_PID" || fail 'Owned QEMU process exited before SSH became ready.'
  if listener_is_loopback_only; then
    remaining_seconds=$(( ssh_deadline - $(monotonic_seconds) ))
    (( remaining_seconds > 0 )) || break
    scan_timeout="$remaining_seconds"
    (( scan_timeout <= 5 )) || scan_timeout=5
    host_key="$(timeout --signal=TERM --kill-after=1s "${remaining_seconds}s" \
      ssh-keyscan -T "$scan_timeout" -p "$SSH_PORT" 127.0.0.1 2>/dev/null | head -n 1 || true)"
    if [[ "$host_key" =~ ^\[127\.0\.0\.1\]:${SSH_PORT}\ ssh-(ed25519|rsa|ecdsa-)\  ]]; then
      break
    fi
  fi
  (( $(monotonic_seconds) < ssh_deadline )) && sleep 1
done
[[ -n "$host_key" ]] || fail 'SSH readiness timed out after the bounded wait.'

known_hosts_partial="${KNOWN_HOSTS}.partial.$$"
reserve_empty_file "$known_hosts_partial"
printf '%s\n' "$host_key" > "$known_hosts_partial"
publish_noclobber "$known_hosts_partial" "$KNOWN_HOSTS"

shutdown_ssh_timeout="${PALZIV_APPLIANCE_SHUTDOWN_SSH_TIMEOUT_SECONDS:-$DEFAULT_SHUTDOWN_SSH_TIMEOUT_SECONDS}"
[[ "$shutdown_ssh_timeout" =~ ^[1-9][0-9]{0,2}$ && "$shutdown_ssh_timeout" -le "$DEFAULT_SHUTDOWN_SSH_TIMEOUT_SECONDS" ]] || fail 'Shutdown SSH timeout must be between 1 and 30 seconds.'
if timeout --signal=TERM --kill-after=1s "${shutdown_ssh_timeout}s" \
    ssh -p "$SSH_PORT" -i "$BUILD_PRIVATE_KEY" \
    -o "UserKnownHostsFile=${KNOWN_HOSTS}" \
    -o StrictHostKeyChecking=yes \
    -o BatchMode=yes \
    -o ConnectTimeout=10 \
    palziv-build@127.0.0.1 'sudo systemctl poweroff' >/dev/null 2>&1; then
  ssh_status=0
else
  ssh_status=$?
fi
[[ "$ssh_status" -ne 124 && "$ssh_status" -ne 137 ]] || fail 'Boot-only guest shutdown SSH command timed out.'
[[ "$ssh_status" -eq 0 || "$ssh_status" -eq 255 ]] || fail 'Boot-only guest shutdown command failed.'

for ((attempt=0; attempt<SHUTDOWN_TIMEOUT_SECONDS; attempt++)); do
  process_is_alive "$QEMU_PID" || break
  sleep 1
done
process_is_alive "$QEMU_PID" && fail 'QEMU did not exit after the boot-only shutdown request.'

write_build_state 'boot-only'
printf '{"ok":true,"classification":"boot-only","buildId":"%s","releaseSha":"%s","sshPort":%s}\n' \
  "$BUILD_ID" "$RELEASE_SHA" "$SSH_PORT"
