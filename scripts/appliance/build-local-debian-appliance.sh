#!/usr/bin/env bash
set -Eeuo pipefail

readonly IMAGE_NAME='debian-13-genericcloud-amd64.qcow2'
readonly IMAGE_URL="https://cloud.debian.org/images/cloud/trixie/latest/${IMAGE_NAME}"
readonly SUMS_URL='https://cloud.debian.org/images/cloud/trixie/latest/SHA512SUMS'
readonly DISK_VIRTUAL_SIZE='40G'
readonly DEFAULT_SSH_TIMEOUT_SECONDS=300
readonly DEFAULT_SHUTDOWN_SSH_TIMEOUT_SECONDS=30
readonly DEFAULT_COPY_TIMEOUT_SECONDS=300
readonly DEFAULT_PROVISION_TIMEOUT_SECONDS=1800
readonly DEFAULT_REBOOT_TIMEOUT_SECONDS=300
readonly SHUTDOWN_TIMEOUT_SECONDS=180
readonly SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly -a RECEIPT_NAMES=(
  'VERIFY-LOCAL.json'
  'STAGE-SUCCESS.json'
  'STAGE-SUCCESS.sha256'
  'age-recipient.txt'
)

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
RECEIPT_COPY_DIR=''
RECEIPT_COPY_ID=''
RECEIPT_COPY_OWNED=0
RECEIPT_PUBLICATION_ACTIVE=0
declare -A RECEIPT_PUBLICATION_IDS=()
declare -A RECEIPT_PUBLICATION_FDS=()
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

receipt_publication_partial_path() {
  local receipt="$1"
  printf '%s/.receipt-publish.%s.%s\n' "$BUILD_ROOT" "$BUILD_ID" "$receipt"
}

remove_owned_publication_path() {
  local candidate="$1" expected_id="$2" actual_id actual_path
  [[ -n "$expected_id" && -f "$candidate" && ! -L "$candidate" ]] || return 0
  actual_path="$(realpath -e -- "$candidate" 2>/dev/null || true)"
  actual_id="$(stat -Lc '%d:%i:%u:%a' -- "$candidate" 2>/dev/null || true)"
  [[ "$actual_path" == "$candidate" && "$actual_id" == "$expected_id" ]] || return 0
  rm -- "$candidate"
}

cleanup_receipt_publication() {
  local receipt expected_id partial final
  [[ "$RECEIPT_PUBLICATION_ACTIVE" -eq 1 ]] || return 0
  for receipt in "${RECEIPT_NAMES[@]}"; do
    expected_id="${RECEIPT_PUBLICATION_IDS[$receipt]:-}"
    partial="$(receipt_publication_partial_path "$receipt")"
    final="$BUILD_ROOT/$receipt"
    remove_owned_publication_path "$final" "$expected_id" || true
    remove_owned_publication_path "$partial" "$expected_id" || true
  done
  close_receipt_publication_fds
}

close_receipt_publication_fds() {
  local receipt receipt_fd
  for receipt in "${RECEIPT_NAMES[@]}"; do
    receipt_fd="${RECEIPT_PUBLICATION_FDS[$receipt]:-}"
    if [[ "$receipt_fd" =~ ^[1-9][0-9]*$ ]]; then
      exec {receipt_fd}>&- 2>/dev/null || true
      unset 'RECEIPT_PUBLICATION_FDS[$receipt]'
    fi
  done
}

publication_fd_identity() {
  local receipt_fd="$1"
  [[ "$receipt_fd" =~ ^[1-9][0-9]*$ ]] || return 1
  stat -Lc '%d:%i:%u:%a' -- "/proc/self/fd/${receipt_fd}" 2>/dev/null
}

open_receipt_publication_fd() {
  local receipt="$1" partial="$2" receipt_fd expected_id actual_id noclobber_was_set=0 open_status
  [[ -o noclobber ]] && noclobber_was_set=1
  set -o noclobber
  if { exec {receipt_fd}> "$partial"; } 2>/dev/null; then
    open_status=0
  else
    open_status=$?
  fi
  [[ "$noclobber_was_set" -eq 1 ]] || set +o noclobber
  [[ "$open_status" -eq 0 ]] || return 1
  RECEIPT_PUBLICATION_FDS["$receipt"]="$receipt_fd"
  expected_id="$(publication_fd_identity "$receipt_fd")" || return 1
  [[ "$expected_id" =~ ^[0-9]+:[0-9]+:[0-9]+:[0-9]{3,4}$ ]] || return 1
  actual_id="$(stat -Lc '%d:%i:%u:%a' -- "$partial" 2>/dev/null)" || return 1
  [[ ! -L "$partial" && "$actual_id" == "$expected_id" ]] || return 1
  RECEIPT_PUBLICATION_IDS["$receipt"]="$expected_id"
}

publication_source_is_owned() {
  local receipt="$1" partial receipt_fd expected_id fd_id partial_id
  partial="$(receipt_publication_partial_path "$receipt")" || return 1
  receipt_fd="${RECEIPT_PUBLICATION_FDS[$receipt]:-}"
  expected_id="${RECEIPT_PUBLICATION_IDS[$receipt]:-}"
  [[ -n "$expected_id" && -f "$partial" && ! -L "$partial" ]] || return 1
  fd_id="$(publication_fd_identity "$receipt_fd")" || return 1
  partial_id="$(stat -Lc '%d:%i:%u:%a' -- "$partial" 2>/dev/null)" || return 1
  [[ "$fd_id" == "$expected_id" && "$partial_id" == "$expected_id" ]]
}

link_receipt_fd_noclobber() {
  local receipt_fd="$1" partial="$2" final="$3" expected_id="$4"
  python3 - "$receipt_fd" "$partial" "$final" "$expected_id" <<'PY'
import ctypes
import os
import stat
import sys

AT_FDCWD = -100
AT_SYMLINK_FOLLOW = 0x400

fd_text, partial, final, expected = sys.argv[1:]
if not fd_text.isascii() or not fd_text.isdigit() or int(fd_text) <= 0:
    raise SystemExit(64)
fd = int(fd_text)

def identity(value):
    return f"{value.st_dev}:{value.st_ino}:{value.st_uid}:{stat.S_IMODE(value.st_mode):o}"

before_fd = os.fstat(fd)
before_partial = os.stat(partial, follow_symlinks=False)
if not stat.S_ISREG(before_fd.st_mode) or not stat.S_ISREG(before_partial.st_mode):
    raise SystemExit(65)
if identity(before_fd) != expected or identity(before_partial) != expected:
    raise SystemExit(66)

libc = ctypes.CDLL(None, use_errno=True)
libc.linkat.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
libc.linkat.restype = ctypes.c_int
source = os.fsencode(f"/proc/self/fd/{fd}")
destination = os.fsencode(final)
if libc.linkat(AT_FDCWD, source, AT_FDCWD, destination, AT_SYMLINK_FOLLOW) != 0:
    raise SystemExit(67)

after_fd = os.fstat(fd)
after_partial = os.stat(partial, follow_symlinks=False)
after_final = os.stat(final, follow_symlinks=False)
if not stat.S_ISREG(after_partial.st_mode) or not stat.S_ISREG(after_final.st_mode):
    raise SystemExit(68)
if identity(after_fd) != expected or identity(after_partial) != expected or identity(after_final) != expected:
    raise SystemExit(69)
PY
}

publish_receipts_atomically() {
  local receipt partial final expected_id receipt_fd
  RECEIPT_PUBLICATION_ACTIVE=1
  for receipt in "${RECEIPT_NAMES[@]}"; do
    partial="$(receipt_publication_partial_path "$receipt")" || return 11
    final="$BUILD_ROOT/$receipt"
    [[ ! -e "$partial" && ! -L "$partial" && ! -e "$final" && ! -L "$final" ]] || return 12
    open_receipt_publication_fd "$receipt" "$partial" || return 13
    receipt_fd="${RECEIPT_PUBLICATION_FDS[$receipt]}"
    expected_id="${RECEIPT_PUBLICATION_IDS[$receipt]}"
    publication_source_is_owned "$receipt" || return 14
    cat -- "$RECEIPT_COPY_DIR/$receipt" >&"$receipt_fd" || return 15
    publication_source_is_owned "$receipt" || return 16
    cmp --silent -- "$RECEIPT_COPY_DIR/$receipt" "/proc/self/fd/${receipt_fd}" || return 17
    [[ "$(publication_fd_identity "$receipt_fd")" == "$expected_id" ]] || return 18
  done
  for receipt in "${RECEIPT_NAMES[@]}"; do
    partial="$(receipt_publication_partial_path "$receipt")" || return 21
    final="$BUILD_ROOT/$receipt"
    receipt_fd="${RECEIPT_PUBLICATION_FDS[$receipt]}"
    expected_id="${RECEIPT_PUBLICATION_IDS[$receipt]}"
    publication_source_is_owned "$receipt" || return 22
    link_receipt_fd_noclobber "$receipt_fd" "$partial" "$final" "$expected_id" >/dev/null 2>&1 || return 23
    publication_source_is_owned "$receipt" || return 24
    [[ -f "$final" && ! -L "$final" && "$(stat -Lc '%d:%i:%u:%a' -- "$final")" == "$expected_id" ]] || return 25
  done
  for receipt in "${RECEIPT_NAMES[@]}"; do
    partial="$(receipt_publication_partial_path "$receipt")" || return 31
    expected_id="${RECEIPT_PUBLICATION_IDS[$receipt]}"
    remove_owned_publication_path "$partial" "$expected_id" || return 32
    [[ ! -e "$partial" && ! -L "$partial" ]] || return 33
  done
  close_receipt_publication_fds
  RECEIPT_PUBLICATION_ACTIVE=0
}

receipt_copy_dir_is_owned() {
  local actual_id actual_path actual_uid actual_mode
  [[ "$RECEIPT_COPY_OWNED" -eq 1 && -n "$RECEIPT_COPY_DIR" && -d "$RECEIPT_COPY_DIR" && ! -L "$RECEIPT_COPY_DIR" ]] || return 1
  actual_path="$(realpath -e -- "$RECEIPT_COPY_DIR" 2>/dev/null)" || return 1
  actual_id="$(stat -Lc '%d:%i' -- "$RECEIPT_COPY_DIR" 2>/dev/null)" || return 1
  actual_uid="$(stat -Lc '%u' -- "$RECEIPT_COPY_DIR" 2>/dev/null)" || return 1
  actual_mode="$(stat -Lc '%a' -- "$RECEIPT_COPY_DIR" 2>/dev/null)" || return 1
  [[ "$actual_path" == "$RECEIPT_COPY_DIR" && "$actual_id" == "$RECEIPT_COPY_ID" && \
        "$actual_uid" == '0' && "$actual_mode" == '700' && \
        "$RECEIPT_COPY_DIR" == /tmp/palziv-receipt-copy.* ]]
}

prepare_receipt_copy_dir() {
  local candidate actual_path actual_id actual_uid actual_mode
  candidate="$(mktemp -d /tmp/palziv-receipt-copy.XXXXXXXX)" || return 1
  [[ "$candidate" == /tmp/palziv-receipt-copy.* && -d "$candidate" && ! -L "$candidate" ]] || return 1
  actual_path="$(realpath -e -- "$candidate" 2>/dev/null)" || return 1
  [[ "$actual_path" == "$candidate" && "$actual_path" == /tmp/palziv-receipt-copy.* ]] || return 1
  actual_id="$(stat -Lc '%d:%i' -- "$actual_path" 2>/dev/null)" || return 1
  actual_uid="$(stat -Lc '%u' -- "$actual_path" 2>/dev/null)" || return 1
  actual_mode="$(stat -Lc '%a' -- "$actual_path" 2>/dev/null)" || return 1
  [[ "$actual_uid" == '0' && "$actual_mode" == '700' ]] || return 1
  RECEIPT_COPY_DIR="$actual_path"
  RECEIPT_COPY_ID="$actual_id"
  RECEIPT_COPY_OWNED=1
}

bounded_metadata_file_is_valid() {
  local file="$1" size last_octet
  [[ -f "$file" && ! -L "$file" ]] || return 1
  size="$(stat -Lc '%s' -- "$file" 2>/dev/null)" || return 1
  [[ "$size" =~ ^[0-9]+$ && "$size" -ge 2 && "$size" -le 16384 ]] || return 1
  if LC_ALL=C grep -q $'[\001-\010\013\014\016-\037\177]' "$file" 2>/dev/null; then return 1; fi
  last_octet="$(tail -c 1 -- "$file" | od -An -t x1 | tr -d '[:space:]')" || return 1
  [[ "$last_octet" == '0a' ]]
}

json_receipt_has_one_document() {
  local file="$1" line_count
  bounded_metadata_file_is_valid "$file" || return 1
  line_count="$(wc -l < "$file")" || return 1
  [[ "$line_count" -eq 1 ]]
}

checksum_manifest_is_exact() {
  local manifest="$RECEIPT_COPY_DIR/STAGE-SUCCESS.sha256" line digest name
  local -a lines=()
  local -A seen=()
  bounded_metadata_file_is_valid "$manifest" || return 1
  mapfile -t lines < "$manifest" || return 1
  [[ "${#lines[@]}" -eq 2 ]] || return 1
  for line in "${lines[@]}"; do
    [[ "$line" =~ ^([a-f0-9]{64})"  "(STAGE-SUCCESS\.json|age-recipient\.txt)$ ]] || return 1
    digest="${BASH_REMATCH[1]}"
    name="${BASH_REMATCH[2]}"
    [[ -z "${seen[$name]:-}" ]] || return 1
    seen["$name"]="$digest"
  done
  [[ -n "${seen[STAGE-SUCCESS.json]:-}" && -n "${seen[age-recipient.txt]:-}" ]] || return 1
  (cd -- "$RECEIPT_COPY_DIR" && sha256sum --check --strict STAGE-SUCCESS.sha256 >/dev/null 2>&1)
}

copied_receipts_are_valid() {
  local actual_receipt_tree expected_receipt_tree receipt recipient recipient_lines
  receipt_copy_dir_is_owned || return 1
  expected_receipt_tree=$'STAGE-SUCCESS.json\nSTAGE-SUCCESS.sha256\nVERIFY-LOCAL.json\nage-recipient.txt'
  actual_receipt_tree="$(find "$RECEIPT_COPY_DIR" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)" || return 1
  [[ "$actual_receipt_tree" == "$expected_receipt_tree" ]] || return 1
  for receipt in "${RECEIPT_NAMES[@]}"; do
    bounded_metadata_file_is_valid "$RECEIPT_COPY_DIR/$receipt" || return 1
  done
  json_receipt_has_one_document "$RECEIPT_COPY_DIR/VERIFY-LOCAL.json" || return 1
  jq -s -e --arg releaseSha "$RELEASE_SHA" '
    length == 1 and (.[0] |
      type == "object" and
      (keys == ["classification","completedAt","nodeVersion","phase","releaseSha","routeCount","schemaVersion","services"]) and
      .schemaVersion == 1 and .phase == "post-reboot" and .classification == "pass" and
      .releaseSha == $releaseSha and .nodeVersion == "v24.18.0" and .routeCount == 8 and
      .services == {app:"active",cloudflared:"disabled-inactive",qemuGuestAgent:"active",systemdTimesyncd:"active"} and
      (.completedAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")))
  ' "$RECEIPT_COPY_DIR/VERIFY-LOCAL.json" >/dev/null || return 1
  json_receipt_has_one_document "$RECEIPT_COPY_DIR/STAGE-SUCCESS.json" || return 1
  jq -s -e --arg releaseSha "$RELEASE_SHA" '
    length == 1 and (.[0] |
      type == "object" and
      (keys == ["app","classification","cloudflared","completedAt","nodeVersion","phaseId","releaseSha","routeCount","schemaVersion"]) and
      .schemaVersion == 1 and .phaseId == "project-a-two-phase-v1" and .classification == "staged" and
      .releaseSha == $releaseSha and .nodeVersion == "v24.18.0" and .app == "active" and
      .cloudflared == "disabled-inactive" and .routeCount == 8 and
      (.completedAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")))
  ' "$RECEIPT_COPY_DIR/STAGE-SUCCESS.json" >/dev/null || return 1
  recipient_lines="$(wc -l < "$RECEIPT_COPY_DIR/age-recipient.txt")" || return 1
  [[ "$recipient_lines" -eq 1 ]] || return 1
  recipient="$(<"$RECEIPT_COPY_DIR/age-recipient.txt")"
  [[ "$recipient" =~ ^age1[ac-hj-np-z02-9]{58}$ ]] || return 1
  checksum_manifest_is_exact || return 1
  receipt_copy_dir_is_owned
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
  cleanup_receipt_publication
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
  if [[ "$RECEIPT_COPY_OWNED" -eq 1 && -n "$RECEIPT_COPY_DIR" && -d "$RECEIPT_COPY_DIR" && ! -L "$RECEIPT_COPY_DIR" ]]; then
    actual_path="$(realpath -e -- "$RECEIPT_COPY_DIR" 2>/dev/null || true)"
    actual_id="$(stat -Lc '%d:%i' -- "$RECEIPT_COPY_DIR" 2>/dev/null || true)"
    actual_uid="$(stat -Lc '%u' -- "$RECEIPT_COPY_DIR" 2>/dev/null || true)"
    actual_mode="$(stat -Lc '%a' -- "$RECEIPT_COPY_DIR" 2>/dev/null || true)"
    if [[ "$actual_path" == "$RECEIPT_COPY_DIR" && "$actual_id" == "$RECEIPT_COPY_ID" && \
          "$actual_uid" == '0' && "$actual_mode" == '700' && \
          "$RECEIPT_COPY_DIR" == /tmp/palziv-receipt-copy.* ]]; then
      rm -rf -- "$RECEIPT_COPY_DIR"
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

write_failed_build_state() {
  local operation="$1" exit_code="$2" failed_at_utc temporary="${BUILD_STATE}.partial.$$"
  failed_at_utc="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  reserve_empty_file "$temporary"
  printf '{"schemaVersion":1,"classification":"failed","operation":"%s","failedAtUtc":"%s","exitCode":%s,"buildId":"%s","releaseSha":"%s","sshPort":%s,"qemuPid":%s,"workingDisk":"%s","qgaSocket":"%s"}\n' \
    "$(json_escape "$operation")" "$failed_at_utc" "$exit_code" "$BUILD_ID" "$RELEASE_SHA" "$SSH_PORT" "$QEMU_PID" "$(json_escape "$WORK_DISK")" "$(json_escape "$QGA_SOCKET")" > "$temporary"
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
readonly PROVISIONING_SCRIPT="$SCRIPT_ROOT/provision-debian-appliance.sh"
readonly VERIFICATION_SCRIPT="$SCRIPT_ROOT/verify-debian-appliance.sh"

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
readonly REMOTE_UPLOAD_DIR="/var/tmp/palziv-appliance-upload-${BUILD_ID}"
readonly REMOTE_STAGE_DIR="/var/tmp/palziv-appliance-stage-${BUILD_ID}"
readonly REMOTE_RECEIPT_DIR="/var/tmp/palziv-appliance-receipts-${BUILD_ID}"

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
apt-get install -y ca-certificates cloud-image-utils curl jq openssh-client python3 qemu-system-x86 qemu-utils >/dev/null
if [[ "$BOOT_ONLY" -eq 0 ]]; then
  if ! command -v python3 >/dev/null 2>&1; then
    publisher_runtime_status=127
  elif python3 -c 'import ctypes, os, stat, sys' >/dev/null 2>&1; then
    publisher_runtime_status=0
  else
    publisher_runtime_status=$?
  fi
  if [[ "$publisher_runtime_status" -ne 0 ]]; then
    write_failed_build_state 'validate-receipt-publisher-runtime' "$publisher_runtime_status"
    fail 'The receipt publisher runtime is unavailable.'
  fi
fi

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

if [[ "$BOOT_ONLY" -eq 0 ]]; then
  require_unlinked_existing_path 'Provisioning script' "$PROVISIONING_SCRIPT" file
  require_unlinked_existing_path 'Verification script' "$VERIFICATION_SCRIPT" file
  release_tar_sha256="$(sha256sum -- "$RELEASE_TAR")"
  release_tar_sha256="${release_tar_sha256%% *}"
  provisioning_script_sha256="$(sha256sum -- "$PROVISIONING_SCRIPT")"
  provisioning_script_sha256="${provisioning_script_sha256%% *}"
  verification_script_sha256="$(sha256sum -- "$VERIFICATION_SCRIPT")"
  verification_script_sha256="${verification_script_sha256%% *}"
  [[ "$release_tar_sha256" =~ ^[a-f0-9]{64}$ && "$provisioning_script_sha256" =~ ^[a-f0-9]{64}$ && \
     "$verification_script_sha256" =~ ^[a-f0-9]{64}$ ]] || fail 'Provisioning input SHA-256 generation failed.'
  readonly RELEASE_TAR_SHA256="$release_tar_sha256"
  readonly PROVISIONING_SCRIPT_SHA256="$provisioning_script_sha256"
  readonly VERIFICATION_SCRIPT_SHA256="$verification_script_sha256"
  copy_timeout="${PALZIV_APPLIANCE_COPY_TIMEOUT_SECONDS:-$DEFAULT_COPY_TIMEOUT_SECONDS}"
  [[ "$copy_timeout" =~ ^[1-9][0-9]{0,2}$ && "$copy_timeout" -le "$DEFAULT_COPY_TIMEOUT_SECONDS" ]] || fail 'Copy timeout must be between 1 and 300 seconds.'
  remote_stage_command="set -Eeuo pipefail; umask 077; mkdir -m 0700 -- ${REMOTE_UPLOAD_DIR}; sudo mkdir -m 0700 -- ${REMOTE_STAGE_DIR}; sudo chown root:root ${REMOTE_STAGE_DIR}; sudo chmod 0700 ${REMOTE_STAGE_DIR}"
  if timeout --signal=TERM --kill-after=5s "${copy_timeout}s" \
      ssh -p "$SSH_PORT" -i "$BUILD_PRIVATE_KEY" \
      -o "UserKnownHostsFile=${KNOWN_HOSTS}" \
      -o StrictHostKeyChecking=yes \
      -o BatchMode=yes \
      -o ConnectTimeout=10 \
      palziv-build@127.0.0.1 "$remote_stage_command" >/dev/null 2>&1; then
    stage_status=0
  else
    stage_status=$?
  fi
  if [[ "$stage_status" -ne 0 ]]; then
    write_failed_build_state 'prepare-provisioning-stage' "$stage_status"
    fail 'Preparing the root-owned guest staging directory failed.'
  fi

  if timeout --signal=TERM --kill-after=5s "${copy_timeout}s" \
      scp -P "$SSH_PORT" -i "$BUILD_PRIVATE_KEY" \
      -o "UserKnownHostsFile=${KNOWN_HOSTS}" \
      -o StrictHostKeyChecking=yes \
      -o BatchMode=yes \
      -o ConnectTimeout=10 \
      "$RELEASE_TAR" "$PROVISIONING_SCRIPT" "$VERIFICATION_SCRIPT" \
      "palziv-build@127.0.0.1:${REMOTE_UPLOAD_DIR}/" >/dev/null 2>&1; then
    copy_status=0
  else
    copy_status=$?
  fi
  if [[ "$copy_status" -ne 0 ]]; then
    write_failed_build_state 'copy-provisioning-inputs' "$copy_status"
    fail 'Copying the provisioning inputs into the guest failed.'
  fi
  provision_timeout="${PALZIV_APPLIANCE_PROVISION_TIMEOUT_SECONDS:-$DEFAULT_PROVISION_TIMEOUT_SECONDS}"
  [[ "$provision_timeout" =~ ^[1-9][0-9]{0,3}$ && "$provision_timeout" -le "$DEFAULT_PROVISION_TIMEOUT_SECONDS" ]] || fail 'Provision timeout must be between 1 and 1800 seconds.'
  root_snapshot_script="$(cat <<'PALZIV_ROOT_SNAPSHOT'
set -Eeuo pipefail
upload_root="$1"
stage_root="$2"
expected_release_sha256="$3"
expected_provisioner_sha256="$4"
expected_verifier_sha256="$5"
release_sha="$6"
stage_id=''
upload_path=''
upload_id=''
upload_uid=''
upload_mode=''
upload_consumed=0

cleanup() {
  local rc=$? actual_path='' actual_id='' actual_uid='' actual_mode=''
  trap - EXIT ERR
  if [[ -n "$stage_id" && -d "$stage_root" && ! -L "$stage_root" ]]; then
    actual_path="$(realpath -e -- "$stage_root" 2>/dev/null || true)"
    actual_id="$(stat -Lc '%d:%i' -- "$stage_root" 2>/dev/null || true)"
    actual_uid="$(stat -Lc '%u' -- "$stage_root" 2>/dev/null || true)"
    actual_mode="$(stat -Lc '%a' -- "$stage_root" 2>/dev/null || true)"
    if [[ "$actual_path" == "$stage_root" && "$actual_id" == "$stage_id" && "$actual_uid:$actual_mode" == '0:700' && "$stage_root" == /var/tmp/palziv-appliance-stage-* ]]; then
      rm -rf -- "$stage_root"
    fi
  fi
  if [[ "$upload_consumed" -eq 0 && -n "$upload_id" && -d "$upload_root" && ! -L "$upload_root" ]]; then
    actual_path="$(realpath -e -- "$upload_root" 2>/dev/null || true)"
    actual_id="$(stat -Lc '%d:%i' -- "$upload_root" 2>/dev/null || true)"
    actual_uid="$(stat -Lc '%u' -- "$upload_root" 2>/dev/null || true)"
    actual_mode="$(stat -Lc '%a' -- "$upload_root" 2>/dev/null || true)"
    if [[ "$actual_path" == "$upload_path" && "$actual_id" == "$upload_id" && \
          "$actual_uid" == "$upload_uid" && "$actual_mode" == "$upload_mode" && \
          "$upload_root" == /var/tmp/palziv-appliance-upload-* && \
          -z "$(find "$upload_root" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
      rmdir -- "$upload_root"
    fi
  fi
  exit "$rc"
}
trap cleanup EXIT

[[ "$EUID" -eq 0 ]] || exit 70
[[ "$stage_root" == /var/tmp/palziv-appliance-stage-* && "$upload_root" == /var/tmp/palziv-appliance-upload-* ]] || exit 71
[[ "$(realpath -e -- "$stage_root")" == "$stage_root" && ! -L "$stage_root" ]] || exit 72
[[ "$(stat -Lc '%u:%a' -- "$stage_root")" == '0:700' ]] || exit 73
stage_id="$(stat -Lc '%d:%i' -- "$stage_root")"
[[ -d "$upload_root" && ! -L "$upload_root" && "$(realpath -e -- "$upload_root")" == "$upload_root" ]] || exit 74
upload_path="$(realpath -e -- "$upload_root")"
upload_id="$(stat -Lc '%d:%i' -- "$upload_root")"
upload_uid="$(stat -Lc '%u' -- "$upload_root")"
upload_mode="$(stat -Lc '%a' -- "$upload_root")"
[[ "$upload_uid" =~ ^[1-9][0-9]*$ && "$upload_mode" == '700' ]] || exit 76
for input in project-a-release.tar provision-debian-appliance.sh verify-debian-appliance.sh; do
  [[ -f "$upload_root/$input" && ! -L "$upload_root/$input" ]] || exit 75
done

mv -- "$upload_root/project-a-release.tar" "$stage_root/release.tar.partial"
mv -- "$upload_root/provision-debian-appliance.sh" "$stage_root/provision-debian-appliance.sh.partial"
mv -- "$upload_root/verify-debian-appliance.sh" "$stage_root/verify-debian-appliance.sh.partial"
[[ -z "$(find "$upload_root" -mindepth 1 -maxdepth 1 -print -quit)" ]] || exit 77
[[ "$(realpath -e -- "$upload_root")" == "$upload_path" && \
   "$(stat -Lc '%d:%i:%u:%a' -- "$upload_root")" == "$upload_id:$upload_uid:$upload_mode" ]] || exit 78
rmdir -- "$upload_root"
upload_consumed=1
chown root:root "$stage_root/release.tar.partial" "$stage_root/provision-debian-appliance.sh.partial" "$stage_root/verify-debian-appliance.sh.partial"
chmod 0600 "$stage_root/release.tar.partial" "$stage_root/provision-debian-appliance.sh.partial" "$stage_root/verify-debian-appliance.sh.partial"
(
  cd -- "$stage_root"
  printf '%s  %s\n' "$expected_release_sha256" 'release.tar.partial' | sha256sum --check --strict - >/dev/null
  printf '%s  %s\n' "$expected_provisioner_sha256" 'provision-debian-appliance.sh.partial' | sha256sum --check --strict - >/dev/null
  printf '%s  %s\n' "$expected_verifier_sha256" 'verify-debian-appliance.sh.partial' | sha256sum --check --strict - >/dev/null
)
mv -- "$stage_root/release.tar.partial" "$stage_root/release.tar"
mv -- "$stage_root/provision-debian-appliance.sh.partial" "$stage_root/provision-debian-appliance.sh"
mv -- "$stage_root/verify-debian-appliance.sh.partial" "$stage_root/verify-debian-appliance.sh"
bash "$stage_root/provision-debian-appliance.sh" "$stage_root/release.tar" "$release_sha"
install -o root -g root -m 0750 -- "$stage_root/verify-debian-appliance.sh" /usr/local/sbin/palziv-verify-appliance
PALZIV_ROOT_SNAPSHOT
)"
  if printf '%s\n' "$root_snapshot_script" | timeout --signal=TERM --kill-after=5s "${provision_timeout}s" \
      ssh -p "$SSH_PORT" -i "$BUILD_PRIVATE_KEY" \
      -o "UserKnownHostsFile=${KNOWN_HOSTS}" \
      -o StrictHostKeyChecking=yes \
      -o BatchMode=yes \
      -o ConnectTimeout=10 \
      palziv-build@127.0.0.1 \
      sudo bash -s -- "$REMOTE_UPLOAD_DIR" "$REMOTE_STAGE_DIR" \
      "$RELEASE_TAR_SHA256" "$PROVISIONING_SCRIPT_SHA256" "$VERIFICATION_SCRIPT_SHA256" "$RELEASE_SHA" >/dev/null 2>&1; then
    provision_status=0
  else
    provision_status=$?
  fi
  if [[ "$provision_status" -ne 0 ]]; then
    write_failed_build_state 'provision-guest' "$provision_status"
    fail 'Guest provisioning failed.'
  fi

  runtime_command="sudo install -d -o root -g root -m 0700 -- ${REMOTE_RECEIPT_DIR} && sudo /usr/local/sbin/palziv-verify-appliance ${RELEASE_SHA} pre-reboot ${REMOTE_RECEIPT_DIR}"
  if timeout --signal=TERM --kill-after=5s "${copy_timeout}s" \
      ssh -p "$SSH_PORT" -i "$BUILD_PRIVATE_KEY" \
      -o "UserKnownHostsFile=${KNOWN_HOSTS}" \
      -o StrictHostKeyChecking=yes \
      -o BatchMode=yes \
      -o ConnectTimeout=10 \
      palziv-build@127.0.0.1 "$runtime_command" >/dev/null 2>&1; then
    verify_status=0
  else
    verify_status=$?
  fi
  if [[ "$verify_status" -ne 0 ]]; then
    write_failed_build_state 'pre-reboot-verification' "$verify_status"
    fail 'Pre-reboot appliance verification failed.'
  fi

  restart_command='sudo systemctl restart palziv.service && curl --fail --silent --show-error --max-time 15 http://127.0.0.1:3116/api/health'
  if timeout --signal=TERM --kill-after=5s "${copy_timeout}s" \
      ssh -p "$SSH_PORT" -i "$BUILD_PRIVATE_KEY" \
      -o "UserKnownHostsFile=${KNOWN_HOSTS}" \
      -o StrictHostKeyChecking=yes \
      -o BatchMode=yes \
      -o ConnectTimeout=10 \
      palziv-build@127.0.0.1 "$restart_command" >/dev/null 2>&1; then
    restart_status=0
  else
    restart_status=$?
  fi
  if [[ "$restart_status" -ne 0 ]]; then
    write_failed_build_state 'restart-and-health-check' "$restart_status"
    fail 'Application restart or health verification failed.'
  fi

  reboot_timeout="${PALZIV_APPLIANCE_REBOOT_TIMEOUT_SECONDS:-$DEFAULT_REBOOT_TIMEOUT_SECONDS}"
  if [[ ! "$reboot_timeout" =~ ^[1-9][0-9]{0,2}$ || "$reboot_timeout" -gt "$DEFAULT_REBOOT_TIMEOUT_SECONDS" ]]; then
    write_failed_build_state 'validate-reboot-timeout' 1
    fail 'Reboot timeout must be between 1 and 300 seconds.'
  fi
  boot_id_command='cat /proc/sys/kernel/random/boot_id'
  if pre_reboot_boot_id="$(timeout --signal=TERM --kill-after=5s "${copy_timeout}s" \
      ssh -p "$SSH_PORT" -i "$BUILD_PRIVATE_KEY" \
      -o "UserKnownHostsFile=${KNOWN_HOSTS}" \
      -o StrictHostKeyChecking=yes \
      -o BatchMode=yes \
      -o ConnectTimeout=10 \
      palziv-build@127.0.0.1 "$boot_id_command" 2>/dev/null)"; then
    boot_id_status=0
  else
    boot_id_status=$?
  fi
  if [[ "$boot_id_status" -ne 0 || ! "$pre_reboot_boot_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
    [[ "$boot_id_status" -ne 0 ]] || boot_id_status=1
    write_failed_build_state 'read-pre-reboot-boot-id' "$boot_id_status"
    fail 'Reading the pre-reboot guest boot ID failed.'
  fi
  if timeout --signal=TERM --kill-after=1s "${copy_timeout}s" \
      ssh -p "$SSH_PORT" -i "$BUILD_PRIVATE_KEY" \
      -o "UserKnownHostsFile=${KNOWN_HOSTS}" \
      -o StrictHostKeyChecking=yes \
      -o BatchMode=yes \
      -o ConnectTimeout=10 \
      palziv-build@127.0.0.1 'sudo systemctl reboot' >/dev/null 2>&1; then
    reboot_status=0
  else
    reboot_status=$?
  fi
  if [[ "$reboot_status" -ne 0 && "$reboot_status" -ne 255 ]]; then
    write_failed_build_state 'reboot-guest' "$reboot_status"
    fail 'Guest reboot command failed.'
  fi

  reboot_deadline=$(( $(monotonic_seconds) + reboot_timeout ))
  reboot_down=0
  while (( $(monotonic_seconds) < reboot_deadline )); do
    if ! is_owned_qemu_process "$QEMU_PID"; then
      write_failed_build_state 'qemu-exited-during-reboot-down' 1
      fail 'Owned QEMU process exited during reboot-down verification.'
    fi
    remaining_seconds=$(( reboot_deadline - $(monotonic_seconds) ))
    (( remaining_seconds > 0 )) || break
    probe_timeout="$remaining_seconds"
    (( probe_timeout <= 5 )) || probe_timeout=5
    if timeout --signal=TERM --kill-after=1s "${probe_timeout}s" \
        ssh -p "$SSH_PORT" -i "$BUILD_PRIVATE_KEY" \
        -o "UserKnownHostsFile=${KNOWN_HOSTS}" \
        -o StrictHostKeyChecking=yes \
        -o BatchMode=yes \
        -o ConnectTimeout="$probe_timeout" \
        palziv-build@127.0.0.1 true >/dev/null 2>&1; then
      sleep 1
    else
      reboot_down=1
      break
    fi
  done
  if [[ "$reboot_down" -ne 1 ]]; then
    write_failed_build_state 'wait-for-reboot-down' 1
    fail 'SSH did not disappear within the bounded reboot wait.'
  fi

  reboot_up=0
  while (( $(monotonic_seconds) < reboot_deadline )); do
    if ! is_owned_qemu_process "$QEMU_PID"; then
      write_failed_build_state 'qemu-exited-during-reboot-up' 1
      fail 'Owned QEMU process exited during reboot-up verification.'
    fi
    remaining_seconds=$(( reboot_deadline - $(monotonic_seconds) ))
    (( remaining_seconds > 0 )) || break
    probe_timeout="$remaining_seconds"
    (( probe_timeout <= 5 )) || probe_timeout=5
    if timeout --signal=TERM --kill-after=1s "${probe_timeout}s" \
        ssh -p "$SSH_PORT" -i "$BUILD_PRIVATE_KEY" \
        -o "UserKnownHostsFile=${KNOWN_HOSTS}" \
        -o StrictHostKeyChecking=yes \
        -o BatchMode=yes \
        -o ConnectTimeout="$probe_timeout" \
        palziv-build@127.0.0.1 true >/dev/null 2>&1; then
      reboot_up=1
      break
    fi
    sleep 1
  done
  if [[ "$reboot_up" -ne 1 ]]; then
    write_failed_build_state 'wait-for-reboot-up' 1
    fail 'SSH did not return within the bounded reboot wait.'
  fi

  if ! is_owned_qemu_process "$QEMU_PID"; then
    write_failed_build_state 'qemu-exited-during-reboot-up' 1
    fail 'Owned QEMU process exited after the reboot-up probe.'
  fi
  remaining_seconds=$(( reboot_deadline - $(monotonic_seconds) ))
  if (( remaining_seconds <= 0 )); then
    write_failed_build_state 'read-post-reboot-boot-id' 1
    fail 'The shared reboot deadline expired before the post-reboot boot ID could be read.'
  fi
  probe_timeout="$remaining_seconds"
  (( probe_timeout <= 10 )) || probe_timeout=10
  if post_reboot_boot_id="$(timeout --signal=TERM --kill-after=1s "${probe_timeout}s" \
      ssh -p "$SSH_PORT" -i "$BUILD_PRIVATE_KEY" \
      -o "UserKnownHostsFile=${KNOWN_HOSTS}" \
      -o StrictHostKeyChecking=yes \
      -o BatchMode=yes \
      -o ConnectTimeout="$probe_timeout" \
      palziv-build@127.0.0.1 "$boot_id_command" 2>/dev/null)"; then
    boot_id_status=0
  else
    boot_id_status=$?
  fi
  if [[ "$boot_id_status" -ne 0 || ! "$post_reboot_boot_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
    [[ "$boot_id_status" -ne 0 ]] || boot_id_status=1
    write_failed_build_state 'read-post-reboot-boot-id' "$boot_id_status"
    fail 'Reading the post-reboot guest boot ID failed.'
  fi
  if [[ "$post_reboot_boot_id" == "$pre_reboot_boot_id" ]]; then
    write_failed_build_state 'verify-reboot-boot-id' 1
    fail 'SSH returned without evidence of a new guest boot.'
  fi

  post_verify_command="sudo /usr/local/sbin/palziv-verify-appliance ${RELEASE_SHA} post-reboot ${REMOTE_RECEIPT_DIR}"
  if timeout --signal=TERM --kill-after=5s "${copy_timeout}s" \
      ssh -p "$SSH_PORT" -i "$BUILD_PRIVATE_KEY" \
      -o "UserKnownHostsFile=${KNOWN_HOSTS}" \
      -o StrictHostKeyChecking=yes \
      -o BatchMode=yes \
      -o ConnectTimeout=10 \
      palziv-build@127.0.0.1 "$post_verify_command" >/dev/null 2>&1; then
    post_verify_status=0
  else
    post_verify_status=$?
  fi
  if [[ "$post_verify_status" -ne 0 ]]; then
    write_failed_build_state 'post-reboot-verification' "$post_verify_status"
    fail 'Post-reboot appliance verification failed.'
  fi

  share_receipts_command="sudo chown root:palziv-build ${REMOTE_RECEIPT_DIR} ${REMOTE_RECEIPT_DIR}/VERIFY-LOCAL.json ${REMOTE_RECEIPT_DIR}/STAGE-SUCCESS.json ${REMOTE_RECEIPT_DIR}/STAGE-SUCCESS.sha256 ${REMOTE_RECEIPT_DIR}/age-recipient.txt && sudo chmod 0750 ${REMOTE_RECEIPT_DIR} && sudo chmod 0640 ${REMOTE_RECEIPT_DIR}/VERIFY-LOCAL.json ${REMOTE_RECEIPT_DIR}/STAGE-SUCCESS.json ${REMOTE_RECEIPT_DIR}/STAGE-SUCCESS.sha256 ${REMOTE_RECEIPT_DIR}/age-recipient.txt"
  if timeout --signal=TERM --kill-after=5s "${copy_timeout}s" \
      ssh -p "$SSH_PORT" -i "$BUILD_PRIVATE_KEY" \
      -o "UserKnownHostsFile=${KNOWN_HOSTS}" \
      -o StrictHostKeyChecking=yes \
      -o BatchMode=yes \
      -o ConnectTimeout=10 \
      palziv-build@127.0.0.1 "$share_receipts_command" >/dev/null 2>&1; then
    share_status=0
  else
    share_status=$?
  fi
  if [[ "$share_status" -ne 0 ]]; then
    write_failed_build_state 'prepare-stage-receipts' "$share_status"
    fail 'Preparing metadata-only stage receipts for copy failed.'
  fi

  if prepare_receipt_copy_dir; then
    receipt_temp_status=0
  else
    receipt_temp_status=$?
  fi
  if [[ "$receipt_temp_status" -ne 0 ]]; then
    write_failed_build_state 'prepare-receipt-copy-staging' "$receipt_temp_status"
    fail 'Preparing the bounded receipt-copy staging directory failed.'
  fi
  if timeout --signal=TERM --kill-after=5s "${copy_timeout}s" \
      scp -P "$SSH_PORT" -i "$BUILD_PRIVATE_KEY" \
      -o "UserKnownHostsFile=${KNOWN_HOSTS}" \
      -o StrictHostKeyChecking=yes \
      -o BatchMode=yes \
      -o ConnectTimeout=10 \
      "palziv-build@127.0.0.1:${REMOTE_RECEIPT_DIR}/VERIFY-LOCAL.json" \
      "palziv-build@127.0.0.1:${REMOTE_RECEIPT_DIR}/STAGE-SUCCESS.json" \
      "palziv-build@127.0.0.1:${REMOTE_RECEIPT_DIR}/STAGE-SUCCESS.sha256" \
      "palziv-build@127.0.0.1:${REMOTE_RECEIPT_DIR}/age-recipient.txt" \
      "$RECEIPT_COPY_DIR/" >/dev/null 2>&1; then
    receipt_copy_status=0
  else
    receipt_copy_status=$?
  fi
  if [[ "$receipt_copy_status" -ne 0 ]]; then
    write_failed_build_state 'copy-stage-receipts' "$receipt_copy_status"
    fail 'Copying metadata-only stage receipts from the guest failed.'
  fi

  if copied_receipts_are_valid; then
    receipts_status=0
  else
    receipts_status=$?
  fi
  if [[ "$receipts_status" -ne 0 ]]; then
    write_failed_build_state 'validate-stage-receipts' "$receipts_status"
    fail 'Copied stage receipts did not satisfy the bounded metadata contract.'
  fi

  if publish_receipts_atomically; then
    receipt_publish_status=0
  else
    receipt_publish_status=$?
  fi
  if [[ "$receipt_publish_status" -ne 0 ]]; then
    write_failed_build_state 'publish-stage-receipts' "$receipt_publish_status"
    fail "Publishing the validated stage receipts without clobbering failed (status ${receipt_publish_status})."
  fi
  if ! receipt_copy_dir_is_owned; then
    write_failed_build_state 'finalize-receipt-copy-staging' 1
    fail 'Receipt-copy staging identity changed before cleanup.'
  fi
  if ! rm -rf -- "$RECEIPT_COPY_DIR"; then
    write_failed_build_state 'finalize-receipt-copy-staging' 1
    fail 'Removing the receipt-copy staging directory failed.'
  fi
  RECEIPT_COPY_OWNED=0
fi

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
if [[ "$ssh_status" -eq 124 || "$ssh_status" -eq 137 ]]; then
  if [[ "$BOOT_ONLY" -eq 0 ]]; then
    write_failed_build_state 'shutdown-provisioned-guest' "$ssh_status"
    fail 'Provisioned guest shutdown SSH command timed out.'
  fi
  fail 'Boot-only guest shutdown SSH command timed out.'
fi
if [[ "$ssh_status" -ne 0 && "$ssh_status" -ne 255 ]]; then
  if [[ "$BOOT_ONLY" -eq 0 ]]; then
    write_failed_build_state 'shutdown-provisioned-guest' "$ssh_status"
    fail 'Provisioned guest shutdown command failed.'
  fi
  fail 'Boot-only guest shutdown command failed.'
fi

for ((attempt=0; attempt<SHUTDOWN_TIMEOUT_SECONDS; attempt++)); do
  process_is_alive "$QEMU_PID" || break
  sleep 1
done
if process_is_alive "$QEMU_PID"; then
  if [[ "$BOOT_ONLY" -eq 0 ]]; then
    write_failed_build_state 'wait-for-provisioned-guest-shutdown' 1
    fail 'QEMU did not exit after the provisioned guest shutdown request.'
  fi
  fail 'QEMU did not exit after the boot-only shutdown request.'
fi

if [[ "$BOOT_ONLY" -eq 1 ]]; then
  final_classification='boot-only'
else
  final_classification='provisioned'
fi
write_build_state "$final_classification"
printf '{"ok":true,"classification":"%s","buildId":"%s","releaseSha":"%s","sshPort":%s}\n' \
  "$final_classification" "$BUILD_ID" "$RELEASE_SHA" "$SSH_PORT"
