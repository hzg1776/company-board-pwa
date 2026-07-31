#!/usr/bin/env bash
set -Eeuo pipefail

readonly EVIDENCE_PHASE_ID="debian-host-prep-v1"
readonly EVIDENCE_ROOT_NAME="Project-A-Migration-Phase-2-Host-Prep"
readonly EVIDENCE_MAX_REPORT_BYTES="67108864"
readonly EVIDENCE_MAX_PHASE_INPUT_BYTES="65536"
readonly EVIDENCE_MIN_MEMORY_KIB="3584000"
readonly EVIDENCE_MIN_FREE_BYTES="10737418240"
readonly EVIDENCE_SAFE_PATH="/usr/sbin:/usr/bin:/sbin:/bin"

EVIDENCE_CAPTURED_TEST_MODE="${PALZIV_HOST_PREP_EVIDENCE_TEST_MODE-}"
EVIDENCE_CAPTURED_TEST_ROOT="${PALZIV_HOST_PREP_EVIDENCE_TEST_ROOT-}"
EVIDENCE_CAPTURED_TEST_BIN="${PALZIV_HOST_PREP_EVIDENCE_TEST_BIN-}"
EVIDENCE_CAPTURED_SHA256_FAIL="${PALZIV_HOST_PREP_EVIDENCE_TEST_SHA256_FAIL-}"
EVIDENCE_CAPTURED_DELAY="${PALZIV_HOST_PREP_EVIDENCE_TEST_DELAY-}"
EVIDENCE_CAPTURED_FORCE_OVERSIZE="${PALZIV_HOST_PREP_EVIDENCE_TEST_FORCE_OVERSIZE-}"

unset BASH_ENV ENV CDPATH GLOBIGNORE
unset CURL_HOME CURL_CA_BUNDLE CURL_CA_PATH CURL_SSL_BACKEND
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY
unset http_proxy https_proxy all_proxy no_proxy
unset SSL_CERT_FILE SSL_CERT_DIR SSLKEYLOGFILE
unset LD_PRELOAD LD_LIBRARY_PATH NODE_OPTIONS NODE_PATH
unset NPM_CONFIG_USERCONFIG npm_config_userconfig
unset PALZIV_HOST_PREP_EVIDENCE_TEST_MODE PALZIV_HOST_PREP_EVIDENCE_TEST_ROOT
unset PALZIV_HOST_PREP_EVIDENCE_TEST_BIN PALZIV_HOST_PREP_EVIDENCE_TEST_SHA256_FAIL
unset PALZIV_HOST_PREP_EVIDENCE_TEST_DELAY PALZIV_HOST_PREP_EVIDENCE_TEST_FORCE_OVERSIZE
umask 077

PATH="$EVIDENCE_SAFE_PATH"
LC_ALL=C
LANG=C
export PATH LC_ALL LANG
hash -r

EVIDENCE_TEST_MODE=0
EVIDENCE_SYSTEM_ROOT="/"
EVIDENCE_TEST_BIN=""
EVIDENCE_USB_ROOT=""
EVIDENCE_FROM_DIR=""
EVIDENCE_TIMESTAMP=""
EVIDENCE_ISO_UTC=""
EVIDENCE_SAFE_HOST=""
EVIDENCE_REPORT_NAME=""
EVIDENCE_SIDECAR_NAME=""
EVIDENCE_REPORT_FINAL=""
EVIDENCE_SIDECAR_FINAL=""
EVIDENCE_RESERVATION=""
EVIDENCE_RESERVATION_IDENTITY=""
EVIDENCE_RESERVATION_OWNED=0
EVIDENCE_REPORT_TEMP=""
EVIDENCE_REPORT_TEMP_IDENTITY=""
EVIDENCE_SIDECAR_TEMP=""
EVIDENCE_SIDECAR_TEMP_IDENTITY=""
EVIDENCE_REPORT_FINAL_IDENTITY=""
EVIDENCE_REPORT_PUBLISHED=0
EVIDENCE_SIDECAR_PUBLISHED=0
EVIDENCE_OUTPUT_COMPLETE=0
EVIDENCE_OBSERVATION=""
EVIDENCE_OBSERVATION_STATUS=125

evidence_fail() {
  printf 'host-prep-evidence: failed step=%s\n' "$1" >&2
  return 1
}

evidence_identity() {
  local candidate="$1"
  [[ -e "$candidate" && ! -L "$candidate" ]] || return 1
  /usr/bin/stat -c '%d:%i:%u:%f' -- "$candidate" 2>/dev/null
}

evidence_same_identity() {
  local actual
  actual=$(evidence_identity "$1") || return 1
  [[ "$actual" == "$2" ]]
}

evidence_remove_owned_file() {
  local candidate="$1"
  local expected="$2"
  local prefix="$3"
  [[ -n "$candidate" && -n "$expected" ]] || return 0
  [[ "${candidate%/*}" == "$EVIDENCE_FROM_DIR" ]] || return 1
  [[ "${candidate##*/}" == "$prefix"* ]] || return 1
  evidence_same_identity "$candidate" "$expected" || return 1
  /usr/bin/rm -f -- "$candidate"
}

evidence_reservation_is_owned() {
  (( EVIDENCE_RESERVATION_OWNED == 1 )) || return 1
  [[ "${EVIDENCE_RESERVATION%/*}" == "$EVIDENCE_FROM_DIR" ]] || return 1
  [[ "${EVIDENCE_RESERVATION##*/}" == .debian-host-prep-*.lock ]] || return 1
  evidence_same_identity "$EVIDENCE_RESERVATION" "$EVIDENCE_RESERVATION_IDENTITY"
}

evidence_cleanup() {
  if [[ -n "$EVIDENCE_SIDECAR_TEMP" ]]; then
    evidence_remove_owned_file \
      "$EVIDENCE_SIDECAR_TEMP" "$EVIDENCE_SIDECAR_TEMP_IDENTITY" ".debian-host-prep." ||
      true
  fi
  if [[ -n "$EVIDENCE_REPORT_TEMP" ]]; then
    evidence_remove_owned_file \
      "$EVIDENCE_REPORT_TEMP" "$EVIDENCE_REPORT_TEMP_IDENTITY" ".debian-host-prep." ||
      true
  fi
  if (( EVIDENCE_OUTPUT_COMPLETE == 0 &&
    EVIDENCE_REPORT_PUBLISHED == 1 &&
    EVIDENCE_SIDECAR_PUBLISHED == 0 )) &&
    evidence_reservation_is_owned; then
    evidence_remove_owned_file \
      "$EVIDENCE_REPORT_FINAL" "$EVIDENCE_REPORT_FINAL_IDENTITY" "debian-host-prep-" ||
      true
  fi
  if evidence_reservation_is_owned; then
    /usr/bin/rmdir -- "$EVIDENCE_RESERVATION" 2>/dev/null || true
  fi
}
trap evidence_cleanup EXIT
trap 'exit 1' HUP INT TERM

evidence_validate_canonical_directory() {
  local candidate="$1"
  local canonical
  [[ "$candidate" == /* && ! "$candidate" =~ [[:cntrl:]] ]] || return 1
  [[ -d "$candidate" && ! -L "$candidate" && -r "$candidate" && -x "$candidate" ]] ||
    return 1
  canonical=$(/usr/bin/readlink -e -- "$candidate" 2>/dev/null) || return 1
  [[ "$canonical" == "$candidate" ]]
}

evidence_validate_test_fixture() {
  local root_base
  local bin_base
  [[ "$EVIDENCE_CAPTURED_TEST_MODE" == "1" ]] || return 1
  case "$EVIDENCE_CAPTURED_TEST_ROOT" in
    /tmp/project-a-host-prep-evidence-test.*/system-root) ;;
    *) return 1 ;;
  esac
  case "$EVIDENCE_CAPTURED_TEST_BIN" in
    /tmp/project-a-host-prep-evidence-test.*/bin) ;;
    *) return 1 ;;
  esac
  root_base="${EVIDENCE_CAPTURED_TEST_ROOT%/system-root}"
  bin_base="${EVIDENCE_CAPTURED_TEST_BIN%/bin}"
  [[ "$root_base" == "$bin_base" ]] || return 1
  evidence_validate_canonical_directory "$EVIDENCE_CAPTURED_TEST_ROOT" || return 1
  evidence_validate_canonical_directory "$EVIDENCE_CAPTURED_TEST_BIN" || return 1
  EVIDENCE_TEST_MODE=1
  EVIDENCE_SYSTEM_ROOT="$EVIDENCE_CAPTURED_TEST_ROOT"
  EVIDENCE_TEST_BIN="$EVIDENCE_CAPTURED_TEST_BIN"
}

evidence_initialize_environment() {
  if [[ -n "$EVIDENCE_CAPTURED_TEST_MODE" ||
    -n "$EVIDENCE_CAPTURED_TEST_ROOT" ||
    -n "$EVIDENCE_CAPTURED_TEST_BIN" ]]; then
    evidence_validate_test_fixture
    return
  fi
  [[ -z "$EVIDENCE_CAPTURED_SHA256_FAIL" &&
    -z "$EVIDENCE_CAPTURED_DELAY" &&
    -z "$EVIDENCE_CAPTURED_FORCE_OVERSIZE" ]]
}

evidence_command_path() {
  local name="$1"
  if (( EVIDENCE_TEST_MODE == 1 )); then
    printf '%s/%s\n' "$EVIDENCE_TEST_BIN" "$name"
    return 0
  fi
  case "$name" in
    date|df|dpkg-query|getent|hostname|nproc|sha256sum|ss|stat|systemctl|uname)
      printf '/usr/bin/%s\n' "$name"
      ;;
    node) printf '/opt/node/bin/node\n' ;;
    npm) printf '/opt/node/bin/npm\n' ;;
    ufw) printf '/usr/sbin/ufw\n' ;;
    *) return 1 ;;
  esac
}

evidence_observe() {
  local max_bytes="$1"
  local name="$2"
  local executable
  local output
  local status
  shift 2
  EVIDENCE_OBSERVATION=""
  EVIDENCE_OBSERVATION_STATUS=125
  executable=$(evidence_command_path "$name") || return 1
  [[ -x "$executable" ]] || {
    EVIDENCE_OBSERVATION_STATUS=127
    return 0
  }
  set +e
  output=$(
    /usr/bin/env -i PATH="$EVIDENCE_SAFE_PATH" LC_ALL=C LANG=C \
      "$executable" "$@" 2>/dev/null |
      /usr/bin/head -c "$((max_bytes + 1))"
  )
  status=$?
  set -e
  EVIDENCE_OBSERVATION="$output"
  EVIDENCE_OBSERVATION_STATUS="$status"
  (( ${#EVIDENCE_OBSERVATION} <= max_bytes )) || {
    EVIDENCE_OBSERVATION=""
    EVIDENCE_OBSERVATION_STATUS=124
  }
}

evidence_system_path() {
  [[ "$1" == /* && ! "$1" =~ [[:cntrl:]] ]] || return 1
  if [[ "$EVIDENCE_SYSTEM_ROOT" == "/" ]]; then
    printf '%s\n' "$1"
  else
    printf '%s%s\n' "$EVIDENCE_SYSTEM_ROOT" "$1"
  fi
}

evidence_validate_top_level() {
  local candidate
  local name
  local seen=0
  shopt -s nullglob
  for candidate in \
    "$EVIDENCE_USB_ROOT"/* \
    "$EVIDENCE_USB_ROOT"/.[!.]* \
    "$EVIDENCE_USB_ROOT"/..?*; do
    name="${candidate##*/}"
    case "$name" in
      CHECKSUMS|FROM-DEBIAN|SECRETS-ENCRYPTED|TO-DEBIAN)
        [[ -d "$candidate" && ! -L "$candidate" ]] || return 1
        ;;
      ISOLATION-BOUNDARY.txt|PHASE-2-INPUT.json|README-FIRST.txt)
        [[ -f "$candidate" && ! -L "$candidate" ]] || return 1
        ;;
      *) return 1 ;;
    esac
    (( seen += 1 ))
  done
  shopt -u nullglob
  (( seen == 7 ))
}

evidence_validate_phase_input() {
  local input_path="$EVIDENCE_USB_ROOT/PHASE-2-INPUT.json"
  local input_size
  local identity_before
  local identity_after
  local phase_match
  [[ -f "$input_path" && ! -L "$input_path" ]] || return 1
  input_size=$(/usr/bin/stat -c '%s' -- "$input_path" 2>/dev/null) || return 1
  [[ "$input_size" =~ ^[0-9]+$ ]] || return 1
  (( input_size > 0 && input_size <= EVIDENCE_MAX_PHASE_INPUT_BYTES )) || return 1
  identity_before=$(evidence_identity "$input_path") || return 1
  phase_match=$(
    /usr/bin/env -i PATH="$EVIDENCE_SAFE_PATH" LC_ALL=C LANG=C \
      /usr/bin/grep -aoE '"phaseId"[[:space:]]*:[[:space:]]*"[^"]*"' \
      "$input_path" 2>/dev/null |
      /usr/bin/env -i PATH="$EVIDENCE_SAFE_PATH" LC_ALL=C LANG=C \
        /usr/bin/tr -d '[:space:]'
  ) || return 1
  identity_after=$(evidence_identity "$input_path") || return 1
  [[ "$identity_before" == "$identity_after" ]] || return 1
  [[ "$phase_match" == "\"phaseId\":\"$EVIDENCE_PHASE_ID\"" ]]
}

evidence_validate_root() {
  [[ "${1##*/}" == "$EVIDENCE_ROOT_NAME" ]] || return 1
  evidence_validate_canonical_directory "$1" || return 1
  EVIDENCE_USB_ROOT="$1"
  evidence_validate_top_level || return 1
  evidence_validate_phase_input || return 1
  EVIDENCE_FROM_DIR="$EVIDENCE_USB_ROOT/FROM-DEBIAN"
  evidence_validate_canonical_directory "$EVIDENCE_FROM_DIR" || return 1
  [[ "${EVIDENCE_FROM_DIR%/*}" == "$EVIDENCE_USB_ROOT" && -w "$EVIDENCE_FROM_DIR" ]]
}

evidence_read_os() {
  local os_file
  local line
  local id=""
  local version=""
  os_file=$(evidence_system_path "/etc/os-release") || return 1
  [[ -f "$os_file" && ! -L "$os_file" ]] || return 1
  (( $(/usr/bin/stat -c '%s' -- "$os_file" 2>/dev/null) <= 4096 )) || return 1
  while IFS= read -r line; do
    case "$line" in
      ID=debian) id="debian" ;;
      VERSION_ID=13|VERSION_ID=\"13\") version="13" ;;
    esac
  done < "$os_file"
  [[ "$id" == "debian" && "$version" == "13" ]]
}

evidence_cpu_threshold() {
  evidence_observe 32 nproc || return 1
  [[ "$EVIDENCE_OBSERVATION_STATUS" -eq 0 &&
    "$EVIDENCE_OBSERVATION" =~ ^[0-9]+$ &&
    "$EVIDENCE_OBSERVATION" -ge 2 ]]
}

evidence_memory_threshold() {
  local memory_file
  local label
  local value
  local unit
  memory_file=$(evidence_system_path "/proc/meminfo") || return 1
  [[ -f "$memory_file" && ! -L "$memory_file" ]] || return 1
  IFS=' ' read -r label value unit < "$memory_file" || return 1
  [[ "$label" == "MemTotal:" &&
    "$value" =~ ^[0-9]+$ &&
    "$unit" == "kB" &&
    "$value" -ge "$EVIDENCE_MIN_MEMORY_KIB" ]]
}

evidence_space_threshold() {
  local available
  evidence_observe 64 df -B1 --output=avail / || return 1
  [[ "$EVIDENCE_OBSERVATION_STATUS" -eq 0 ]] || return 1
  available="${EVIDENCE_OBSERVATION##*$'\n'}"
  [[ "$available" =~ ^[0-9]+$ && "$available" -ge "$EVIDENCE_MIN_FREE_BYTES" ]]
}

evidence_package_state() {
  local installed_prefix=$'install ok installed\t'
  local version
  evidence_observe 192 dpkg-query --show \
    '--showformat=${db:Status}\t${Version}' "$1" || return 1
  version="${EVIDENCE_OBSERVATION#"$installed_prefix"}"
  if [[ "$EVIDENCE_OBSERVATION_STATUS" -eq 0 &&
    "$EVIDENCE_OBSERVATION" == "$installed_prefix"* &&
    "$version" =~ ^[A-Za-z0-9.+:~_-]{1,128}$ ]]; then
    printf 'installed %s\n' "$version"
  else
    printf 'absent\n'
  fi
}

evidence_node_state() {
  evidence_observe 64 node --version || return 1
  if [[ "$EVIDENCE_OBSERVATION_STATUS" -eq 127 ]]; then
    printf 'absent\n'
  elif [[ "$EVIDENCE_OBSERVATION_STATUS" -eq 0 &&
    "$EVIDENCE_OBSERVATION" == "v24.18.0" ]]; then
    printf 'v24.18.0\n'
  else
    printf 'other\n'
  fi
}

evidence_npm_state() {
  evidence_observe 64 npm --version || return 1
  if [[ "$EVIDENCE_OBSERVATION_STATUS" -eq 0 &&
    "$EVIDENCE_OBSERVATION" =~ ^[0-9]+([.][0-9]+){1,3}([-+][A-Za-z0-9._-]+)?$ ]]; then
    printf '%s\n' "$EVIDENCE_OBSERVATION"
  else
    printf 'absent\n'
  fi
}

evidence_account_state() {
  evidence_observe 256 getent "$1" palziv || return 1
  if [[ "$EVIDENCE_OBSERVATION_STATUS" -eq 0 &&
    "$EVIDENCE_OBSERVATION" == palziv:* &&
    "$EVIDENCE_OBSERVATION" != *$'\n'* ]]; then
    printf 'present\n'
  else
    printf 'absent\n'
  fi
}

evidence_directory_state() {
  local mapped
  local type
  local owner
  local group
  local mode
  mapped=$(evidence_system_path "$1") || return 1
  if [[ ! -e "$mapped" && ! -L "$mapped" ]]; then
    printf 'absent|-|-|-\n'
    return 0
  fi
  if [[ -L "$mapped" ]]; then
    printf 'link|-|-|-\n'
    return 0
  fi
  evidence_observe 160 stat -c '%F|%U|%G|%a' "$mapped" || return 1
  if [[ "$EVIDENCE_OBSERVATION_STATUS" -ne 0 ]]; then
    printf 'other|-|-|-\n'
    return 0
  fi
  IFS='|' read -r type owner group mode <<< "$EVIDENCE_OBSERVATION"
  case "$type" in
    directory) ;;
    "regular file") type="file" ;;
    *) type="other" ;;
  esac
  [[ "$owner" =~ ^[A-Za-z0-9_.-]+$ ]] || owner="-"
  [[ "$group" =~ ^[A-Za-z0-9_.-]+$ ]] || group="-"
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || mode="-"
  printf '%s|%s|%s|%s\n' "$type" "$owner" "$group" "$mode"
}

evidence_unit_flag() {
  evidence_observe 32 systemctl "$1" --quiet "$2" || return 1
  case "$EVIDENCE_OBSERVATION_STATUS" in
    0) printf 'yes\n' ;;
    1|3) printf 'no\n' ;;
    *) printf 'not-found\n' ;;
  esac
}

evidence_unit_state() {
  local enabled
  local active
  enabled=$(evidence_unit_flag is-enabled "$1") || return 1
  active=$(evidence_unit_flag is-active "$1") || return 1
  printf '%s|%s\n' "$enabled" "$active"
}

evidence_ufw_state() {
  evidence_observe 256 ufw status || return 1
  if [[ "$EVIDENCE_OBSERVATION_STATUS" -ne 0 ]]; then
    printf 'unavailable\n'
    return 0
  fi
  case "$EVIDENCE_OBSERVATION" in
    "Status: active"|$'Status: active\n'*) printf 'active\n' ;;
    "Status: inactive"|$'Status: inactive\n'*) printf 'inactive\n' ;;
    *) printf 'unavailable\n' ;;
  esac
}

evidence_listener_state() {
  evidence_observe 512 ss -H -ltn 'sport = :3116' || return 1
  if [[ "$EVIDENCE_OBSERVATION_STATUS" -eq 0 && -n "$EVIDENCE_OBSERVATION" ]]; then
    printf 'present\n'
  else
    printf 'absent\n'
  fi
}

evidence_create_report() {
  local cpu="fail"
  local memory="fail"
  local space="fail"
  local architecture
  local node
  local npm
  local user
  local group
  local ufw
  local listener
  local classification="partial"
  local all_absent=1
  local all_exact=1
  local specification
  local absolute_path
  local expected
  local state
  local type
  local owner
  local directory_group
  local mode
  local unit_state
  local -a directory_specs=(
    "/opt/palziv|directory|root|palziv|750"
    "/opt/palziv/releases|directory|root|palziv|750"
    "/var/lib/palziv|directory|palziv|palziv|700"
    "/var/lib/palziv/data|directory|palziv|palziv|700"
    "/var/backups/palziv|directory|root|palziv|750"
    "/etc/palziv|directory|root|palziv|750"
  )
  local -a directory_lines=()

  evidence_read_os || return 1
  evidence_observe 32 uname -m || return 1
  [[ "$EVIDENCE_OBSERVATION_STATUS" -eq 0 &&
    "$EVIDENCE_OBSERVATION" == "x86_64" ]] || return 1
  architecture="$EVIDENCE_OBSERVATION"
  if evidence_cpu_threshold; then cpu="pass"; fi
  if evidence_memory_threshold; then memory="pass"; fi
  if evidence_space_threshold; then space="pass"; fi
  node=$(evidence_node_state) || return 1
  npm=$(evidence_npm_state) || return 1
  user=$(evidence_account_state passwd) || return 1
  group=$(evidence_account_state group) || return 1

  for specification in "${directory_specs[@]}"; do
    absolute_path="${specification%%|*}"
    expected="${specification#*|}"
    state=$(evidence_directory_state "$absolute_path") || return 1
    IFS='|' read -r type owner directory_group mode <<< "$state"
    directory_lines+=(
      "Directory $absolute_path: type=$type owner=$owner group=$directory_group mode=$mode"
    )
    [[ "$state" == "absent|-|-|-" ]] || all_absent=0
    [[ "$state" == "$expected" ]] || all_exact=0
  done

  if [[ "$node" == "absent" && "$npm" == "absent" &&
    "$user" == "absent" && "$group" == "absent" && "$all_absent" -eq 1 ]]; then
    classification="not-applied"
  elif [[ "$node" == "v24.18.0" && "$npm" != "absent" &&
    "$user" == "present" && "$group" == "present" && "$all_exact" -eq 1 ]]; then
    classification="prepared"
  fi
  ufw=$(evidence_ufw_state) || return 1
  listener=$(evidence_listener_state) || return 1

  {
    printf 'Project-A Debian Host Preparation Receipt\n'
    printf 'Collection UTC: %s\n' "$EVIDENCE_ISO_UTC"
    printf 'OS: Debian 13\n'
    printf 'Architecture: %s\n' "$architecture"
    printf 'CPU threshold: %s\n' "$cpu"
    printf 'Memory threshold: %s\n' "$memory"
    printf 'Root free-space threshold: %s\n' "$space"
    printf 'Package ca-certificates: %s\n' "$(evidence_package_state ca-certificates)"
    printf 'Package curl: %s\n' "$(evidence_package_state curl)"
    printf 'Package git: %s\n' "$(evidence_package_state git)"
    printf 'Package jq: %s\n' "$(evidence_package_state jq)"
    printf 'Package rsync: %s\n' "$(evidence_package_state rsync)"
    printf 'Package tar: %s\n' "$(evidence_package_state tar)"
    printf 'Package xz-utils: %s\n' "$(evidence_package_state xz-utils)"
    printf 'Node: %s\n' "$node"
    printf 'npm: %s\n' "$npm"
    printf 'Palziv user: %s\n' "$user"
    printf 'Palziv group: %s\n' "$group"
    printf '%s\n' "${directory_lines[@]}"
    unit_state=$(evidence_unit_state palziv.service) || return 1
    printf 'Service palziv: enabled=%s active=%s\n' \
      "${unit_state%%|*}" "${unit_state#*|}"
    unit_state=$(evidence_unit_state cloudflared.service) || return 1
    printf 'Service cloudflared: enabled=%s active=%s\n' \
      "${unit_state%%|*}" "${unit_state#*|}"
    unit_state=$(evidence_unit_state palziv-backup.timer) || return 1
    printf 'Timer palziv-backup: enabled=%s active=%s\n' \
      "${unit_state%%|*}" "${unit_state#*|}"
    unit_state=$(evidence_unit_state palziv-health.timer) || return 1
    printf 'Timer palziv-health: enabled=%s active=%s\n' \
      "${unit_state%%|*}" "${unit_state#*|}"
    printf 'UFW: %s\n' "$ufw"
    printf 'TCP 3116 listener: %s\n' "$listener"
    printf 'Classification: %s\n' "$classification"
  } > "$EVIDENCE_REPORT_TEMP"
}

evidence_publish() {
  local report_size
  local checksum_line
  local report_identity
  local sidecar_identity

  /usr/bin/mkdir -- "$EVIDENCE_RESERVATION" 2>/dev/null || return 1
  EVIDENCE_RESERVATION_OWNED=1
  EVIDENCE_RESERVATION_IDENTITY=$(evidence_identity "$EVIDENCE_RESERVATION") || return 1
  EVIDENCE_REPORT_TEMP=$(
    /usr/bin/mktemp --tmpdir="$EVIDENCE_FROM_DIR" ".debian-host-prep.XXXXXXXX.tmp"
  ) || return 1
  EVIDENCE_REPORT_TEMP_IDENTITY=$(evidence_identity "$EVIDENCE_REPORT_TEMP") || return 1
  EVIDENCE_SIDECAR_TEMP=$(
    /usr/bin/mktemp --tmpdir="$EVIDENCE_FROM_DIR" ".debian-host-prep.XXXXXXXX.tmp"
  ) || return 1
  EVIDENCE_SIDECAR_TEMP_IDENTITY=$(evidence_identity "$EVIDENCE_SIDECAR_TEMP") || return 1

  evidence_create_report || return 1
  evidence_same_identity "$EVIDENCE_REPORT_TEMP" "$EVIDENCE_REPORT_TEMP_IDENTITY" || return 1
  if (( EVIDENCE_TEST_MODE == 1 )) &&
    [[ "$EVIDENCE_CAPTURED_FORCE_OVERSIZE" == "1" ]]; then
    /usr/bin/truncate -s "$((EVIDENCE_MAX_REPORT_BYTES + 1))" -- "$EVIDENCE_REPORT_TEMP" ||
      return 1
  fi
  report_size=$(/usr/bin/stat -c '%s' -- "$EVIDENCE_REPORT_TEMP" 2>/dev/null) || return 1
  (( report_size <= EVIDENCE_MAX_REPORT_BYTES )) || return 1
  [[ ! -e "$EVIDENCE_REPORT_FINAL" && ! -L "$EVIDENCE_REPORT_FINAL" &&
    ! -e "$EVIDENCE_SIDECAR_FINAL" && ! -L "$EVIDENCE_SIDECAR_FINAL" ]] || return 1
  if (( EVIDENCE_TEST_MODE == 1 )) && [[ "$EVIDENCE_CAPTURED_DELAY" == "1" ]]; then
    /bin/sleep 1
  fi
  /usr/bin/mv -T -n -- "$EVIDENCE_REPORT_TEMP" "$EVIDENCE_REPORT_FINAL" || return 1
  [[ ! -e "$EVIDENCE_REPORT_TEMP" && ! -L "$EVIDENCE_REPORT_TEMP" ]] || return 1
  report_identity=$(evidence_identity "$EVIDENCE_REPORT_FINAL") || return 1
  [[ "$report_identity" == "$EVIDENCE_REPORT_TEMP_IDENTITY" ]] || return 1
  EVIDENCE_REPORT_FINAL_IDENTITY="$report_identity"
  EVIDENCE_REPORT_TEMP=""
  EVIDENCE_REPORT_TEMP_IDENTITY=""
  EVIDENCE_REPORT_PUBLISHED=1

  if (( EVIDENCE_TEST_MODE == 1 )) &&
    [[ "$EVIDENCE_CAPTURED_SHA256_FAIL" == "1" ]]; then
    return 1
  fi
  (
    cd -- "$EVIDENCE_FROM_DIR"
    if (( EVIDENCE_TEST_MODE == 1 )); then
      /usr/bin/env -i PATH="$EVIDENCE_SAFE_PATH" LC_ALL=C LANG=C \
        "$EVIDENCE_TEST_BIN/sha256sum" -- "$EVIDENCE_REPORT_NAME"
    else
      /usr/bin/env -i PATH="$EVIDENCE_SAFE_PATH" LC_ALL=C LANG=C \
        /usr/bin/sha256sum -- "$EVIDENCE_REPORT_NAME"
    fi
  ) > "$EVIDENCE_SIDECAR_TEMP" 2>/dev/null || {
    evidence_fail checksum-command
    return 1
  }
  evidence_same_identity "$EVIDENCE_SIDECAR_TEMP" "$EVIDENCE_SIDECAR_TEMP_IDENTITY" ||
    {
      evidence_fail checksum-identity
      return 1
    }
  checksum_line=$(<"$EVIDENCE_SIDECAR_TEMP")
  [[ "$checksum_line" =~ ^[a-f0-9]{64}[[:space:]][[:space:]]$EVIDENCE_REPORT_NAME$ ]] ||
    {
      evidence_fail checksum-grammar
      return 1
    }
  [[ $(/usr/bin/wc -l < "$EVIDENCE_SIDECAR_TEMP") -eq 1 ]] || {
    evidence_fail checksum-lines
    return 1
  }
  /usr/bin/mv -T -n -- "$EVIDENCE_SIDECAR_TEMP" "$EVIDENCE_SIDECAR_FINAL" || return 1
  [[ ! -e "$EVIDENCE_SIDECAR_TEMP" && ! -L "$EVIDENCE_SIDECAR_TEMP" ]] || return 1
  sidecar_identity=$(evidence_identity "$EVIDENCE_SIDECAR_FINAL") || return 1
  [[ "$sidecar_identity" == "$EVIDENCE_SIDECAR_TEMP_IDENTITY" ]] || return 1
  EVIDENCE_SIDECAR_TEMP=""
  EVIDENCE_SIDECAR_TEMP_IDENTITY=""
  EVIDENCE_SIDECAR_PUBLISHED=1
  evidence_same_identity "$EVIDENCE_REPORT_FINAL" "$EVIDENCE_REPORT_FINAL_IDENTITY" ||
    return 1
  evidence_reservation_is_owned || return 1
  /usr/bin/sync -- "$EVIDENCE_REPORT_FINAL" "$EVIDENCE_SIDECAR_FINAL" || return 1
  [[ -f "$EVIDENCE_REPORT_FINAL" && ! -L "$EVIDENCE_REPORT_FINAL" &&
    -f "$EVIDENCE_SIDECAR_FINAL" && ! -L "$EVIDENCE_SIDECAR_FINAL" ]] || return 1
  EVIDENCE_OUTPUT_COMPLETE=1
  /usr/bin/rmdir -- "$EVIDENCE_RESERVATION" || return 1
  EVIDENCE_RESERVATION_OWNED=0
}

evidence_main() {
  local raw_host
  evidence_initialize_environment || {
    evidence_fail environment
    return 1
  }
  [[ "$#" -eq 2 && "$1" == "--usb-root" && "$2" == /* ]] || {
    evidence_fail arguments
    return 1
  }
  evidence_validate_root "$2" || {
    evidence_fail usb-root
    return 1
  }
  evidence_observe 32 date -u +%Y%m%dT%H%M%SZ || return 1
  [[ "$EVIDENCE_OBSERVATION_STATUS" -eq 0 &&
    "$EVIDENCE_OBSERVATION" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || {
    evidence_fail timestamp
    return 1
  }
  EVIDENCE_TIMESTAMP="$EVIDENCE_OBSERVATION"
  evidence_observe 32 date -u +%Y-%m-%dT%H:%M:%SZ || return 1
  [[ "$EVIDENCE_OBSERVATION_STATUS" -eq 0 &&
    "$EVIDENCE_OBSERVATION" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
    {
      evidence_fail timestamp
      return 1
    }
  EVIDENCE_ISO_UTC="$EVIDENCE_OBSERVATION"
  evidence_observe 256 hostname || return 1
  raw_host="$EVIDENCE_OBSERVATION"
  EVIDENCE_SAFE_HOST="${raw_host//[^A-Za-z0-9._-]/}"
  [[ -n "$EVIDENCE_SAFE_HOST" ]] || EVIDENCE_SAFE_HOST="unknown"
  EVIDENCE_REPORT_NAME="debian-host-prep-$EVIDENCE_TIMESTAMP-$EVIDENCE_SAFE_HOST.txt"
  EVIDENCE_SIDECAR_NAME="$EVIDENCE_REPORT_NAME.sha256"
  EVIDENCE_REPORT_FINAL="$EVIDENCE_FROM_DIR/$EVIDENCE_REPORT_NAME"
  EVIDENCE_SIDECAR_FINAL="$EVIDENCE_FROM_DIR/$EVIDENCE_SIDECAR_NAME"
  EVIDENCE_RESERVATION="$EVIDENCE_FROM_DIR/.debian-host-prep-$EVIDENCE_TIMESTAMP-$EVIDENCE_SAFE_HOST.lock"
  [[ ! -e "$EVIDENCE_REPORT_FINAL" && ! -L "$EVIDENCE_REPORT_FINAL" &&
    ! -e "$EVIDENCE_SIDECAR_FINAL" && ! -L "$EVIDENCE_SIDECAR_FINAL" ]] || {
    evidence_fail output-exists
    return 1
  }
  evidence_publish || {
    evidence_fail publication
    return 1
  }
  printf '%s\n%s\n' "$EVIDENCE_REPORT_NAME" "$EVIDENCE_SIDECAR_NAME"
}

evidence_main "$@"
