#!/usr/bin/env bash
set -Eeuo pipefail

readonly HOST_PREP_PHASE_ID="debian-host-prep-v1"
readonly HOST_PREP_TOKEN_NAME=".host-prep-preflight-ok"
readonly HOST_PREP_MANIFEST_RELATIVE="CHECKSUMS/PHASE-2-HOST-PREP.sha256"
readonly HOST_PREP_EXPECTED_VERSION_ID="13"
readonly HOST_PREP_EXPECTED_ARCH="x86_64"
readonly HOST_PREP_MIN_MEMORY_KIB="3584000" # 3500 MiB
readonly HOST_PREP_MIN_FREE_BYTES="10737418240" # 10 GiB
readonly HOST_PREP_NODE_VERSION="v24.18.0"
readonly HOST_PREP_NODE_DIRECTORY="/opt/node-v24.18.0-linux-x64"
readonly HOST_PREP_NODE_LINK="/opt/node"
readonly SAFE_PATH="/usr/sbin:/usr/bin:/sbin:/bin"

HOST_PREP_SCRIPT_SOURCE="${BASH_SOURCE[0]}"
if [[ "$HOST_PREP_SCRIPT_SOURCE" != /* ]]; then
  HOST_PREP_SCRIPT_SOURCE="$PWD/$HOST_PREP_SCRIPT_SOURCE"
fi
readonly HOST_PREP_SCRIPT_SOURCE

readonly HOST_PREP_CAPTURED_TEST_MODE="${PALZIV_HOST_PREP_TEST_MODE-}"
readonly HOST_PREP_CAPTURED_TEST_ROOT="${PALZIV_HOST_PREP_TEST_ROOT-}"
readonly HOST_PREP_CAPTURED_TEST_BIN="${PALZIV_HOST_PREP_TEST_BIN-}"

unset BASH_ENV ENV CDPATH GLOBIGNORE
unset CURL_HOME CURL_CA_BUNDLE CURL_CA_PATH CURL_SSL_BACKEND
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY
unset http_proxy https_proxy all_proxy no_proxy
unset SSL_CERT_FILE SSL_CERT_DIR SSLKEYLOGFILE
unset PALZIV_HOST_PREP_TEST_MODE PALZIV_HOST_PREP_TEST_ROOT PALZIV_HOST_PREP_TEST_BIN
umask 077

PATH="$SAFE_PATH"
export PATH

HOST_PREP_INITIALIZED=0
HOST_PREP_TEST_MODE=0
HOST_PREP_SYSTEM_ROOT="/"
HOST_PREP_TEST_COMMAND_BIN=""
HOST_PREP_STAGE=""
HOST_PREP_MANIFEST=""
HOST_PREP_TOKEN=""
HOST_PREP_TEMP_TOKEN=""
HOST_PREP_SAFE_REMOVAL=""

host_prep_emit_summary() {
  local ok="$1"
  local classification="$2"
  local token_created="$3"
  printf '{"ok":%s,"phaseId":"%s","classification":"%s","tokenCreated":%s}\n' \
    "$ok" "$HOST_PREP_PHASE_ID" "$classification" "$token_created"
}

host_prep_fail_main() {
  local step="$1"
  printf 'host-prep: failed step=%s\n' "$step" >&2
  host_prep_emit_summary false conflict false
  return 1
}

host_prep_path_has_no_link_components() {
  local candidate="$1"
  local canonical
  [[ "$candidate" == /* ]] || return 1
  [[ "$candidate" != *$'\n'* && "$candidate" != *$'\r'* ]] || return 1
  canonical=$(/usr/bin/readlink -e -- "$candidate") || return 1
  [[ "$canonical" == "$candidate" ]] || return 1
  [[ -d "$candidate" && ! -L "$candidate" ]] || return 1
}

host_prep_validate_fixture_path() {
  local candidate="$1"
  [[ "$candidate" =~ ^/tmp/project-a-host-prep-test\.[A-Za-z0-9_-]+(/[A-Za-z0-9._-]+)*$ ]] ||
    return 1
  [[ "$candidate" != "/" && "$candidate" != "/tmp" ]] || return 1
  host_prep_path_has_no_link_components "$candidate"
}

host_prep_initialize_environment() {
  local supplied=0
  (( HOST_PREP_INITIALIZED == 0 )) || return 0

  [[ -n "$HOST_PREP_CAPTURED_TEST_MODE" ]] && (( supplied += 1 ))
  [[ -n "$HOST_PREP_CAPTURED_TEST_ROOT" ]] && (( supplied += 1 ))
  [[ -n "$HOST_PREP_CAPTURED_TEST_BIN" ]] && (( supplied += 1 ))

  if (( supplied == 0 )); then
    HOST_PREP_TEST_MODE=0
    HOST_PREP_SYSTEM_ROOT="/"
    HOST_PREP_TEST_COMMAND_BIN=""
  else
    (( supplied == 3 )) || return 1
    [[ "$HOST_PREP_CAPTURED_TEST_MODE" == "1" ]] || return 1
    host_prep_validate_fixture_path "$HOST_PREP_CAPTURED_TEST_ROOT" || return 1
    host_prep_validate_fixture_path "$HOST_PREP_CAPTURED_TEST_BIN" || return 1
    [[ "$HOST_PREP_CAPTURED_TEST_ROOT" != "$HOST_PREP_CAPTURED_TEST_BIN" ]] || return 1
    [[ "$HOST_PREP_CAPTURED_TEST_ROOT/" != "$HOST_PREP_CAPTURED_TEST_BIN/"* ]] || return 1
    [[ "$HOST_PREP_CAPTURED_TEST_BIN/" != "$HOST_PREP_CAPTURED_TEST_ROOT/"* ]] || return 1
    HOST_PREP_TEST_MODE=1
    HOST_PREP_SYSTEM_ROOT="$HOST_PREP_CAPTURED_TEST_ROOT"
    HOST_PREP_TEST_COMMAND_BIN="$HOST_PREP_CAPTURED_TEST_BIN"
  fi

  HOST_PREP_INITIALIZED=1
}

host_prep_system_path() {
  local absolute_path="$1"
  [[ "$absolute_path" == /* ]] || return 1
  if (( HOST_PREP_TEST_MODE == 1 )); then
    printf '%s%s\n' "$HOST_PREP_SYSTEM_ROOT" "$absolute_path"
  else
    printf '%s\n' "$absolute_path"
  fi
}

host_prep_observer_path() {
  local name="$1"
  local resolved
  if (( HOST_PREP_TEST_MODE == 1 )); then
    resolved="$HOST_PREP_TEST_COMMAND_BIN/$name"
  else
    case "$name" in
      uname) resolved="/usr/bin/uname" ;;
      systemd-detect-virt) resolved="/usr/bin/systemd-detect-virt" ;;
      nproc) resolved="/usr/bin/nproc" ;;
      df) resolved="/usr/bin/df" ;;
      timedatectl) resolved="/usr/bin/timedatectl" ;;
      systemctl) resolved="/usr/bin/systemctl" ;;
      curl) resolved="/usr/bin/curl" ;;
      ss) resolved="/usr/bin/ss" ;;
      getent) resolved="/usr/bin/getent" ;;
      stat) resolved="/usr/bin/stat" ;;
      jq) resolved="/usr/bin/jq" ;;
      u""fw) resolved="/usr/sbin/u""fw" ;;
      *) return 1 ;;
    esac
  fi
  [[ -f "$resolved" && ! -L "$resolved" && -x "$resolved" ]] || return 1
  printf '%s\n' "$resolved"
}

host_prep_observe() {
  local name="$1"
  local command_path
  shift
  command_path=$(host_prep_observer_path "$name") || return 127
  "$command_path" "$@"
}

host_prep_stage_root() {
  local lexical_source
  local canonical_source
  local to_debian
  local stage

  host_prep_initialize_environment || return 1
  lexical_source=$(/usr/bin/realpath -s -- "$HOST_PREP_SCRIPT_SOURCE") || return 1
  canonical_source=$(/usr/bin/readlink -e -- "$HOST_PREP_SCRIPT_SOURCE") || return 1
  [[ "$lexical_source" == "$canonical_source" ]] || return 1
  [[ -f "$canonical_source" && ! -L "$HOST_PREP_SCRIPT_SOURCE" ]] || return 1
  [[ "${canonical_source##*/}" == "preflight-host-prep.sh" ]] || return 1

  to_debian=${canonical_source%/*}
  stage=${to_debian%/*}
  [[ "${to_debian##*/}" == "TO-DEBIAN" ]] || return 1
  [[ -d "$to_debian" && ! -L "$to_debian" ]] || return 1
  [[ -d "$stage" && ! -L "$stage" && "$stage" != "/" ]] || return 1
  [[ "$canonical_source" == "$stage/TO-DEBIAN/preflight-host-prep.sh" ]] || return 1
  [[ "$stage" != *$'\n'* && "$stage" != *$'\r'* ]] || return 1
  printf '%s\n' "$stage"
}

host_prep_assert_exact_layout() {
  local stage="$1"
  local relative_path
  local entry_type
  local expected_type
  local token_seen=0
  local -A expected=(
    ["CHECKSUMS"]="d"
    ["CHECKSUMS/PHASE-2-HOST-PREP.sha256"]="f"
    ["FROM-DEBIAN"]="d"
    ["ISOLATION-BOUNDARY.txt"]="f"
    ["PHASE-2-INPUT.json"]="f"
    ["README-FIRST.txt"]="f"
    ["SECRETS-ENCRYPTED"]="d"
    ["TO-DEBIAN"]="d"
    ["TO-DEBIAN/apply-host-prep.sh"]="f"
    ["TO-DEBIAN/collect-host-prep-evidence.sh"]="f"
    ["TO-DEBIAN/preflight-host-prep.sh"]="f"
  )
  local -A seen=()

  while IFS= read -r -d '' relative_path && IFS= read -r -d '' entry_type; do
    if [[ "$relative_path" == "$HOST_PREP_TOKEN_NAME" ]]; then
      [[ "$entry_type" == "f" ]] || return 1
      (( token_seen += 1 ))
      (( token_seen == 1 )) || return 1
      continue
    fi
    expected_type="${expected[$relative_path]-}"
    [[ -n "$expected_type" && "$entry_type" == "$expected_type" ]] || return 1
    [[ -z "${seen[$relative_path]-}" ]] || return 1
    seen["$relative_path"]=1
  done < <(/usr/bin/find "$stage" -mindepth 1 -printf '%P\0%y\0')

  for relative_path in "${!expected[@]}"; do
    [[ -n "${seen[$relative_path]-}" ]] || return 1
  done
}

host_prep_manifest_state() {
  local stage="$1"
  local relative_path
  local absolute_path
  local state=""
  local -a manifest_files=(
    "CHECKSUMS/PHASE-2-HOST-PREP.sha256"
    "ISOLATION-BOUNDARY.txt"
    "PHASE-2-INPUT.json"
    "README-FIRST.txt"
    "TO-DEBIAN/apply-host-prep.sh"
    "TO-DEBIAN/collect-host-prep-evidence.sh"
    "TO-DEBIAN/preflight-host-prep.sh"
  )
  for relative_path in "${manifest_files[@]}"; do
    absolute_path="$stage/$relative_path"
    [[ -f "$absolute_path" && ! -L "$absolute_path" ]] || return 1
    state+="$relative_path:"
    state+=$(/usr/bin/stat -Lc '%d:%i:%s:%Y:%Z:%f' -- "$absolute_path") || return 1
    state+=$'\n'
  done
  printf '%s' "$state"
}

host_prep_verify_manifest() {
  local stage="$1"
  local manifest="$stage/$HOST_PREP_MANIFEST_RELATIVE"
  local before
  local after
  local fingerprint_before
  local fingerprint_after
  local line
  local line_number=0
  local -a expected_files=(
    "ISOLATION-BOUNDARY.txt"
    "PHASE-2-INPUT.json"
    "README-FIRST.txt"
    "TO-DEBIAN/apply-host-prep.sh"
    "TO-DEBIAN/collect-host-prep-evidence.sh"
    "TO-DEBIAN/preflight-host-prep.sh"
  )

  host_prep_assert_exact_layout "$stage" || return 1
  [[ -d "$stage/CHECKSUMS" && ! -L "$stage/CHECKSUMS" ]] || return 1
  [[ -f "$manifest" && ! -L "$manifest" ]] || return 1
  before=$(host_prep_manifest_state "$stage") || return 1
  fingerprint_before=$(/usr/bin/sha256sum -- "$manifest") || return 1
  fingerprint_before="${fingerprint_before%% *}"
  [[ "$fingerprint_before" =~ ^[0-9a-f]{64}$ ]] || return 1

  while IFS= read -r line || [[ -n "$line" ]]; do
    (( line_number += 1 ))
    (( line_number <= ${#expected_files[@]} )) || return 1
    [[ "$line" =~ ^[0-9a-f]{64}\ \ (.+)$ ]] || return 1
    [[ "${BASH_REMATCH[1]}" == "${expected_files[line_number - 1]}" ]] || return 1
  done < "$manifest"
  (( line_number == ${#expected_files[@]} )) || return 1

  (
    cd -- "$stage"
    /usr/bin/sha256sum --check "$HOST_PREP_MANIFEST_RELATIVE" >/dev/null 2>&1
  ) || return 1

  after=$(host_prep_manifest_state "$stage") || return 1
  [[ "$before" == "$after" ]] || return 1
  fingerprint_after=$(/usr/bin/sha256sum -- "$manifest") || return 1
  fingerprint_after="${fingerprint_after%% *}"
  [[ "$fingerprint_before" == "$fingerprint_after" ]] || return 1
  printf '%s\n' "$fingerprint_before"
}

host_prep_manifest_fingerprint() {
  local stage
  stage=$(host_prep_stage_root) || return 1
  host_prep_verify_manifest "$stage"
}

host_prep_remove_stale_token() {
  local token="$1"
  local stage="$2"
  local before
  local after
  local quarantine="$stage/.host-prep-preflight-ok.remove.$$"

  if [[ ! -e "$token" && ! -L "$token" ]]; then
    return 0
  fi
  [[ -f "$token" && ! -L "$token" ]] || return 1
  before=$(/usr/bin/stat -c '%d:%i:%u' -- "$token") || return 1
  [[ "$before" == *":$EUID" ]] || return 1
  [[ ! -e "$quarantine" && ! -L "$quarantine" ]] || return 1

  /usr/bin/mv -T -- "$token" "$quarantine" || return 1
  [[ -f "$quarantine" && ! -L "$quarantine" ]] || return 1
  after=$(/usr/bin/stat -c '%d:%i:%u' -- "$quarantine") || return 1
  [[ "$before" == "$after" ]] || return 1
  HOST_PREP_SAFE_REMOVAL="$quarantine"
  /usr/bin/rm -f -- "$quarantine" || return 1
  HOST_PREP_SAFE_REMOVAL=""
}

host_prep_read_os_release() {
  local os_release
  local key
  local value
  local id=""
  local version_id=""
  os_release=$(host_prep_system_path "/etc/os-release") || return 1
  [[ -f "$os_release" && ! -L "$os_release" ]] || return 1
  while IFS='=' read -r key value; do
    value="${value%\"}"
    value="${value#\"}"
    case "$key" in
      ID) id="$value" ;;
      VERSION_ID) version_id="$value" ;;
    esac
  done < "$os_release"
  [[ "$id" == "debian" && "$version_id" == "$HOST_PREP_EXPECTED_VERSION_ID" ]]
}

host_prep_verify_https() {
  local url="$1"
  host_prep_observe curl \
    --disable \
    --silent \
    --show-error \
    --fail \
    --max-time 10 \
    --noproxy '*' \
    --proto '=https' \
    --proto-redir '=https' \
    "$url" >/dev/null 2>&1
}

host_prep_verify_safety_state() {
  local architecture
  local virtualization
  local processors
  local meminfo
  local memory_kib=""
  local key
  local value
  local unit
  local free_output
  local free_bytes
  local tunnel_service="cloudflare""d.service"
  local qemu_service="qemu-guest-agent.service"
  local time_service="systemd-timesyncd.service"
  local listener_output

  host_prep_initialize_environment || return 1
  host_prep_read_os_release || return 1
  architecture=$(host_prep_observe uname -m) || return 1
  [[ "$architecture" == "$HOST_PREP_EXPECTED_ARCH" ]] || return 1
  virtualization=$(host_prep_observe systemd-detect-virt) || return 1
  [[ "$virtualization" == "kvm" ]] || return 1
  processors=$(host_prep_observe nproc) || return 1
  [[ "$processors" =~ ^[0-9]+$ && "$processors" -ge 2 ]] || return 1

  meminfo=$(host_prep_system_path "/proc/meminfo") || return 1
  [[ -f "$meminfo" && ! -L "$meminfo" ]] || return 1
  while read -r key value unit; do
    if [[ "$key" == "MemTotal:" ]]; then
      memory_kib="$value"
      break
    fi
  done < "$meminfo"
  [[ "$memory_kib" =~ ^[0-9]+$ && "$memory_kib" -ge "$HOST_PREP_MIN_MEMORY_KIB" ]] ||
    return 1

  free_output=$(host_prep_observe df -B1 --output=avail "$HOST_PREP_SYSTEM_ROOT") || return 1
  free_bytes="${free_output##*$'\n'}"
  free_bytes="${free_bytes//[[:space:]]/}"
  [[ "$free_bytes" =~ ^[0-9]+$ && "$free_bytes" -ge "$HOST_PREP_MIN_FREE_BYTES" ]] ||
    return 1
  [[ "$(host_prep_observe timedatectl show --property=NTPSynchronized --value)" == "yes" ]] ||
    return 1
  host_prep_observe systemctl is-active --quiet "$qemu_service" || return 1
  host_prep_observe systemctl is-active --quiet "$time_service" || return 1

  host_prep_verify_https "https://deb.debian.org/" || return 1
  host_prep_verify_https "https://nodejs.org/" || return 1

  if host_prep_observe systemctl is-active --quiet "palziv.service"; then
    return 1
  fi
  if host_prep_observe systemctl is-enabled --quiet "palziv.service"; then
    return 1
  fi
  if host_prep_observe systemctl is-active --quiet "$tunnel_service"; then
    return 1
  fi
  if host_prep_observe systemctl is-enabled --quiet "$tunnel_service"; then
    return 1
  fi

  listener_output=$(host_prep_observe ss -H -ltn 'sport = :3116') || return 1
  [[ -z "$listener_output" ]]
}

host_prep_path_state() {
  local absolute_path="$1"
  local mapped
  mapped=$(host_prep_system_path "$absolute_path") || return 1
  if [[ -L "$mapped" ]]; then
    printf '%s\n' link
  elif [[ -e "$mapped" ]]; then
    printf '%s\n' present
  else
    printf '%s\n' absent
  fi
}

host_prep_get_account_state() {
  local passwd_entry=""
  local group_entry=""
  local passwd_status=0
  local group_status=0

  passwd_entry=$(host_prep_observe getent passwd palziv) || passwd_status=$?
  group_entry=$(host_prep_observe getent group palziv) || group_status=$?

  if [[ -z "$passwd_entry" &&
    -z "$group_entry" &&
    "$passwd_status" -eq 2 &&
    "$group_status" -eq 2 ]]; then
    printf '%s\n' absent
    return 0
  fi
  [[ "$passwd_status" -eq 0 && "$group_status" -eq 0 ]] || {
    printf '%s\n' conflict
    return 0
  }

  local user_name password user_id user_group_id gecos user_home user_shell extra
  local group_name group_password group_id group_members group_extra
  IFS=':' read -r user_name password user_id user_group_id gecos user_home user_shell extra \
    <<< "$passwd_entry"
  IFS=':' read -r group_name group_password group_id group_members group_extra <<< "$group_entry"
  if [[ "$user_name" == "palziv" &&
    "$user_id" =~ ^[0-9]+$ &&
    "$user_id" -gt 0 &&
    "$user_id" -lt 1000 &&
    "$user_group_id" == "$group_id" &&
    "$user_home" == "/var/lib/palziv" &&
    "$user_shell" == "/usr/sbin/nologin" &&
    -z "${extra-}" &&
    "$group_name" == "palziv" &&
    "$group_id" =~ ^[0-9]+$ &&
    "$group_id" -gt 0 &&
    "$group_id" -lt 1000 &&
    -z "$group_members" &&
    -z "${group_extra-}" ]]; then
    printf '%s\n' exact
  else
    printf '%s\n' conflict
  fi
}

host_prep_node_is_exact() {
  local version_path
  local link_path
  local node_path
  local link_target
  version_path=$(host_prep_system_path "$HOST_PREP_NODE_DIRECTORY") || return 1
  link_path=$(host_prep_system_path "$HOST_PREP_NODE_LINK") || return 1
  node_path="$version_path/bin/node"

  [[ -d "$version_path" && ! -L "$version_path" ]] || return 1
  [[ -L "$link_path" ]] || return 1
  [[ -f "$node_path" && ! -L "$node_path" && -x "$node_path" ]] || return 1
  [[ "$(host_prep_observe stat -Lc '%U:%G:%a' "$version_path")" == "root:root:755" ]] ||
    return 1
  [[ "$(host_prep_observe stat -Lc '%U:%G:%a' "$node_path")" == "root:root:755" ]] ||
    return 1
  [[ "$(host_prep_observe stat -c '%U:%G' "$link_path")" == "root:root" ]] || return 1
  link_target=$(/usr/bin/readlink -- "$link_path") || return 1
  [[ "$link_target" == "$HOST_PREP_NODE_DIRECTORY" ]] || return 1
  [[ "$("$node_path" --version 2>/dev/null)" == "$HOST_PREP_NODE_VERSION" ]]
}

host_prep_directories_are_exact() {
  local specification
  local absolute_path
  local expected
  local mapped
  local actual
  local -a specifications=(
    "/opt/palziv|root:palziv:750|releases"
    "/opt/palziv/releases|root:palziv:750|"
    "/var/lib/palziv|palziv:palziv:700|data"
    "/var/lib/palziv/data|palziv:palziv:700|"
    "/var/backups/palziv|root:palziv:750|"
    "/etc/palziv|root:palziv:750|"
  )

  for specification in "${specifications[@]}"; do
    IFS='|' read -r absolute_path expected _ <<< "$specification"
    mapped=$(host_prep_system_path "$absolute_path") || return 1
    [[ -d "$mapped" && ! -L "$mapped" ]] || return 1
    actual=$(host_prep_observe stat -Lc '%U:%G:%a' "$mapped") || return 1
    [[ "$actual" == "$expected" ]] || return 1
  done
}

host_prep_classify() {
  local node_directory_state
  local node_link_state
  local account_state
  local directory_state
  local absolute_path
  local all_directories_absent=1
  local -a directories=(
    "/opt/palziv"
    "/opt/palziv/releases"
    "/var/lib/palziv"
    "/var/lib/palziv/data"
    "/var/backups/palziv"
    "/etc/palziv"
  )

  host_prep_initialize_environment || {
    printf '%s\n' conflict
    return 0
  }
  node_directory_state=$(host_prep_path_state "$HOST_PREP_NODE_DIRECTORY") || {
    printf '%s\n' conflict
    return 0
  }
  node_link_state=$(host_prep_path_state "$HOST_PREP_NODE_LINK") || {
    printf '%s\n' conflict
    return 0
  }
  account_state=$(host_prep_get_account_state) || {
    printf '%s\n' conflict
    return 0
  }

  for absolute_path in "${directories[@]}"; do
    directory_state=$(host_prep_path_state "$absolute_path") || {
      printf '%s\n' conflict
      return 0
    }
    [[ "$directory_state" == "absent" ]] || all_directories_absent=0
  done

  if [[ "$node_directory_state" == "absent" &&
    "$node_link_state" == "absent" &&
    "$account_state" == "absent" &&
    "$all_directories_absent" -eq 1 ]]; then
    printf '%s\n' clean
    return 0
  fi

  if [[ "$node_directory_state" == "present" &&
    "$node_link_state" == "link" &&
    "$account_state" == "exact" ]] &&
    host_prep_node_is_exact &&
    host_prep_directories_are_exact; then
    printf '%s\n' already-prepared
    return 0
  fi

  printf '%s\n' conflict
}

host_prep_report_ufw_state() {
  local command_name="u""fw"
  local output
  local status="unavailable"
  if output=$(host_prep_observe "$command_name" status 2>/dev/null); then
    case "$output" in
      *"Status: active"*) status="active" ;;
      *"Status: inactive"*) status="inactive" ;;
    esac
  fi
  printf 'host-prep: u%sw=%s\n' f "$status" >&2
}

host_prep_cleanup() {
  local candidate
  local owner_id
  for candidate in "$HOST_PREP_TEMP_TOKEN" "$HOST_PREP_SAFE_REMOVAL"; do
    [[ -n "$candidate" ]] || continue
    case "${candidate##*/}" in
      .host-prep-preflight-ok.tmp.*|.host-prep-preflight-ok.remove.*) ;;
      *) continue ;;
    esac
    if [[ -f "$candidate" && ! -L "$candidate" ]]; then
      owner_id=$(/usr/bin/stat -c '%u' -- "$candidate" 2>/dev/null) || continue
      if [[ "$owner_id" == "$EUID" ]]; then
        /usr/bin/rm -f -- "$candidate" || true
      fi
    fi
  done
}

host_prep_publish_token() {
  local classification="$1"
  local fingerprint="$2"
  local created_epoch
  local temp_identity
  local token_identity

  [[ ! -e "$HOST_PREP_TOKEN" && ! -L "$HOST_PREP_TOKEN" ]] || return 1
  created_epoch=$(/usr/bin/date +%s) || return 1
  [[ "$created_epoch" =~ ^[0-9]+$ ]] || return 1
  HOST_PREP_TEMP_TOKEN=$(
    /usr/bin/mktemp --tmpdir="$HOST_PREP_STAGE" ".host-prep-preflight-ok.tmp.XXXXXXXX"
  ) || return 1
  [[ -f "$HOST_PREP_TEMP_TOKEN" && ! -L "$HOST_PREP_TEMP_TOKEN" ]] || return 1
  /usr/bin/chmod 0600 -- "$HOST_PREP_TEMP_TOKEN" || return 1
  host_prep_observe jq -n \
    --arg phase_id "$HOST_PREP_PHASE_ID" \
    --arg manifest_fingerprint "$fingerprint" \
    --arg stage_root "$HOST_PREP_STAGE" \
    --arg classification "$classification" \
    --argjson created_at_epoch "$created_epoch" \
    '{
      schemaVersion: 1,
      phaseId: $phase_id,
      manifestFingerprint: $manifest_fingerprint,
      stageRoot: $stage_root,
      classification: $classification,
      createdAtEpoch: $created_at_epoch
    }' > "$HOST_PREP_TEMP_TOKEN" || return 1
  [[ "$(/usr/bin/stat -c '%a:%u:%F' -- "$HOST_PREP_TEMP_TOKEN")" == "600:$EUID:regular file" ]] ||
    return 1
  temp_identity=$(/usr/bin/stat -c '%d:%i:%u:%F' -- "$HOST_PREP_TEMP_TOKEN") || return 1
  /usr/bin/mv -T -n -- "$HOST_PREP_TEMP_TOKEN" "$HOST_PREP_TOKEN" || return 1
  [[ ! -e "$HOST_PREP_TEMP_TOKEN" && ! -L "$HOST_PREP_TEMP_TOKEN" ]] || return 1
  token_identity=$(/usr/bin/stat -c '%d:%i:%u:%F' -- "$HOST_PREP_TOKEN") || return 1
  [[ "$temp_identity" == "$token_identity" ]] || return 1
  HOST_PREP_TEMP_TOKEN=""
  [[ -f "$HOST_PREP_TOKEN" && ! -L "$HOST_PREP_TOKEN" ]] || return 1
  [[ "$(/usr/bin/stat -c '%a:%u:%F' -- "$HOST_PREP_TOKEN")" == "600:$EUID:regular file" ]]
}

host_prep_preflight_main() {
  local fingerprint
  local final_fingerprint
  local classification

  trap 'host_prep_cleanup' EXIT
  trap 'host_prep_cleanup; exit 1' HUP INT TERM

  (( $# == 0 )) || {
    host_prep_fail_main arguments
    return 1
  }
  host_prep_initialize_environment || {
    host_prep_fail_main fixture-routing
    return 1
  }
  HOST_PREP_STAGE=$(host_prep_stage_root) || {
    host_prep_fail_main stage-path
    return 1
  }
  HOST_PREP_MANIFEST="$HOST_PREP_STAGE/$HOST_PREP_MANIFEST_RELATIVE"
  HOST_PREP_TOKEN="$HOST_PREP_STAGE/$HOST_PREP_TOKEN_NAME"

  fingerprint=$(host_prep_verify_manifest "$HOST_PREP_STAGE") || {
    host_prep_fail_main manifest
    return 1
  }
  host_prep_remove_stale_token "$HOST_PREP_TOKEN" "$HOST_PREP_STAGE" || {
    host_prep_fail_main stale-token
    return 1
  }
  host_prep_verify_safety_state || {
    host_prep_fail_main baseline
    return 1
  }
  classification=$(host_prep_classify) || {
    host_prep_fail_main classification
    return 1
  }
  host_prep_report_ufw_state
  [[ "$classification" == "clean" || "$classification" == "already-prepared" ]] || {
    host_prep_fail_main classification
    return 1
  }

  final_fingerprint=$(host_prep_verify_manifest "$HOST_PREP_STAGE") || {
    host_prep_fail_main final-manifest
    return 1
  }
  [[ "$fingerprint" == "$final_fingerprint" ]] || {
    host_prep_fail_main manifest-race
    return 1
  }
  host_prep_publish_token "$classification" "$fingerprint" || {
    host_prep_fail_main token-publication
    return 1
  }
  host_prep_emit_summary true "$classification" true
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  host_prep_preflight_main "$@"
fi
