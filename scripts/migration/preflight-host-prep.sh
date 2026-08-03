#!/usr/bin/env bash
set -Eeuo pipefail
shopt -s lastpipe

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
readonly HOST_PREP_PACKAGE_EXECUTABLE_NAME="n""pm"
readonly HOST_PREP_PACKAGE_LINK_TARGET="../lib/node_modules/$HOST_PREP_PACKAGE_EXECUTABLE_NAME/bin/${HOST_PREP_PACKAGE_EXECUTABLE_NAME}-cli.js"
readonly HOST_PREP_PACKAGE_CLI_RELATIVE="lib/node_modules/$HOST_PREP_PACKAGE_EXECUTABLE_NAME/bin/${HOST_PREP_PACKAGE_EXECUTABLE_NAME}-cli.js"
readonly SAFE_PATH="/usr/sbin:/usr/bin:/sbin:/bin"
readonly HOST_PREP_MAX_COMMAND_OUTPUT="512"

HOST_PREP_SCRIPT_SOURCE="${BASH_SOURCE[0]}"
HOST_PREP_ORIGINAL_SOURCE_OVERRIDE="${PALZIV_HOST_PREP_ORIGINAL_SOURCE-}"
if [[ -n "$HOST_PREP_ORIGINAL_SOURCE_OVERRIDE" ]]; then
  HOST_PREP_SNAPSHOT_SOURCE="$HOST_PREP_SCRIPT_SOURCE"
  [[ "$-" == *p* && EUID -eq 0 && "${BASH_SOURCE[0]}" != "$0" ]] || return 1
  [[ "$HOST_PREP_SNAPSHOT_SOURCE" == /* &&
    "$HOST_PREP_ORIGINAL_SOURCE_OVERRIDE" == /* &&
    ! "$HOST_PREP_SNAPSHOT_SOURCE" =~ [[:cntrl:]] &&
    ! "$HOST_PREP_ORIGINAL_SOURCE_OVERRIDE" =~ [[:cntrl:]] ]] || return 1
  HOST_PREP_SNAPSHOT_CANONICAL=$(
    /usr/bin/readlink -e -- "$HOST_PREP_SNAPSHOT_SOURCE" 2>/dev/null
  ) || return 1
  HOST_PREP_ORIGINAL_CANONICAL=$(
    /usr/bin/readlink -e -- "$HOST_PREP_ORIGINAL_SOURCE_OVERRIDE" 2>/dev/null
  ) || return 1
  [[ "$HOST_PREP_SNAPSHOT_CANONICAL" == "$HOST_PREP_SNAPSHOT_SOURCE" &&
    "$HOST_PREP_ORIGINAL_CANONICAL" == "$HOST_PREP_ORIGINAL_SOURCE_OVERRIDE" &&
    -f "$HOST_PREP_SNAPSHOT_SOURCE" &&
    ! -L "$HOST_PREP_SNAPSHOT_SOURCE" &&
    -f "$HOST_PREP_ORIGINAL_SOURCE_OVERRIDE" &&
    ! -L "$HOST_PREP_ORIGINAL_SOURCE_OVERRIDE" ]] || return 1
  HOST_PREP_SNAPSHOT_PARENT="${HOST_PREP_SNAPSHOT_SOURCE%/*}"
  [[ "$(/usr/bin/stat -Lc '%u:%g:%a:%F' -- "$HOST_PREP_SNAPSHOT_SOURCE" 2>/dev/null)" == "0:0:600:regular file" ]] ||
    return 1
  [[ "$(/usr/bin/stat -Lc '%u:%g:%a:%F' -- "$HOST_PREP_SNAPSHOT_PARENT" 2>/dev/null)" == "0:0:700:directory" ]] ||
    return 1
  if [[ "${PALZIV_HOST_PREP_TEST_MODE-}" == "1" ]]; then
    case "$HOST_PREP_ORIGINAL_SOURCE_OVERRIDE" in
      /tmp/project-a-host-prep-test.*/stage/TO-DEBIAN/preflight-host-prep.sh) ;;
      *) return 1 ;;
    esac
    HOST_PREP_OVERRIDE_TEST_BASE="${HOST_PREP_ORIGINAL_SOURCE_OVERRIDE%%/stage/TO-DEBIAN/preflight-host-prep.sh}"
    case "$HOST_PREP_SNAPSHOT_SOURCE" in
      "$HOST_PREP_OVERRIDE_TEST_BASE"/project-a-host-prep-bootstrap.*/preflight-host-prep.sh) ;;
      *) return 1 ;;
    esac
  else
    case "$HOST_PREP_SNAPSHOT_SOURCE" in
      /var/tmp/project-a-host-prep-bootstrap.*/preflight-host-prep.sh) ;;
      *) return 1 ;;
    esac
  fi
  HOST_PREP_SCRIPT_SOURCE="$HOST_PREP_ORIGINAL_SOURCE_OVERRIDE"
fi
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
unset PALZIV_HOST_PREP_ORIGINAL_SOURCE
unset HOST_PREP_ORIGINAL_SOURCE_OVERRIDE HOST_PREP_SNAPSHOT_SOURCE
unset HOST_PREP_SNAPSHOT_CANONICAL HOST_PREP_ORIGINAL_CANONICAL
unset HOST_PREP_SNAPSHOT_PARENT HOST_PREP_OVERRIDE_TEST_BASE
umask 077

PATH="$SAFE_PATH"
LC_ALL=C
LANG=C
export PATH LC_ALL LANG

HOST_PREP_INITIALIZED=0
HOST_PREP_TEST_MODE=0
HOST_PREP_TEST_BASE=""
HOST_PREP_SYSTEM_ROOT="/"
HOST_PREP_TEST_COMMAND_BIN=""
HOST_PREP_TEST_ROOT_IDENTITY=""
HOST_PREP_TEST_BIN_IDENTITY=""
HOST_PREP_MAPPED_PATH=""
HOST_PREP_MAPPED_TEXT=""
HOST_PREP_PATH_STATE=""
HOST_PREP_CLASSIFICATION=""
HOST_PREP_STAGE_ROOT_RESULT=""
HOST_PREP_MANIFEST_FINGERPRINT_RESULT=""
HOST_PREP_CLASSIFICATION_RESULT=""
HOST_PREP_SAFETY_RESULT=""
HOST_PREP_ACCOUNT_STATE=""
HOST_PREP_STAGE=""
HOST_PREP_MANIFEST=""
HOST_PREP_TOKEN=""
HOST_PREP_TEMP_TOKEN=""
HOST_PREP_SAFE_REMOVAL=""
HOST_PREP_BOUNDED_OUTPUT=""
HOST_PREP_BOUNDED_STATUS=125
HOST_PREP_BOUNDED_TRUNCATED=0
HOST_PREP_BOUNDED_MALFORMED=0
HOST_PREP_BOUNDED_READER_STATUS=125
declare -A HOST_PREP_FIXTURE_COMPONENT_STATES=()

host_prep_require_current_shell() {
  if (( BASH_SUBSHELL != 0 )) || [[ "$BASHPID" != "$$" ]]; then
    printf 'host-prep: rejected stateful subshell\n' >&2
    return 1
  fi
}

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
  [[ ! "$candidate" =~ [[:cntrl:]] ]] || return 1
  canonical=$(/usr/bin/readlink -e -- "$candidate" 2>/dev/null) || return 1
  [[ "$canonical" == "$candidate" ]] || return 1
  [[ -d "$candidate" && ! -L "$candidate" && -r "$candidate" && -x "$candidate" ]] || return 1
}

host_prep_fixture_base_for_path() {
  local candidate="$1"
  [[ "$candidate" =~ ^(/tmp/project-a-host-prep-test\.[A-Za-z0-9_-]+)(/[A-Za-z0-9._-]+)+$ ]] ||
    return 1
  printf '%s\n' "${BASH_REMATCH[1]}"
}

host_prep_directory_identity() {
  local candidate="$1"
  [[ -d "$candidate" && ! -L "$candidate" ]] || return 1
  /usr/bin/stat -Lc '%d:%i:%u:%f' -- "$candidate" 2>/dev/null
}

host_prep_validate_fixture_path() {
  local candidate="$1"
  host_prep_fixture_base_for_path "$candidate" >/dev/null || return 1
  host_prep_path_has_no_link_components "$candidate"
}

host_prep_revalidate_fixture_boundaries() {
  local root_identity
  local bin_identity
  (( HOST_PREP_TEST_MODE == 1 )) || return 0
  # Fixture mode repeatedly validates components and inode identities. Without
  # openat2-style handles, a same-UID writer can still race between checks, so
  # this test harness is not a production trust boundary.
  host_prep_validate_fixture_path "$HOST_PREP_SYSTEM_ROOT" || return 1
  host_prep_validate_fixture_path "$HOST_PREP_TEST_COMMAND_BIN" || return 1
  root_identity=$(host_prep_directory_identity "$HOST_PREP_SYSTEM_ROOT") || return 1
  bin_identity=$(host_prep_directory_identity "$HOST_PREP_TEST_COMMAND_BIN") || return 1
  [[ "$root_identity" == "$HOST_PREP_TEST_ROOT_IDENTITY" ]] || return 1
  [[ "$bin_identity" == "$HOST_PREP_TEST_BIN_IDENTITY" ]] || return 1
}

host_prep_fixture_component_state() {
  local candidate="$1"
  local allow_link="$2"
  local canonical
  local identity
  local link_target
  local state

  [[ "$candidate" == "$HOST_PREP_SYSTEM_ROOT/"* ]] || return 1
  [[ ! "$candidate" =~ [[:cntrl:]] ]] || return 1
  if [[ -L "$candidate" ]]; then
    (( allow_link == 1 )) || return 1
    identity=$(/usr/bin/stat -c '%d:%i:%u:%g:%f' -- "$candidate" 2>/dev/null) ||
      return 1
    link_target=$(/usr/bin/readlink -- "$candidate" 2>/dev/null) || return 1
    [[ ! "$link_target" =~ [[:cntrl:]] ]] || return 1
    state="link:$identity:$link_target"
  elif [[ -e "$candidate" ]]; then
    canonical=$(/usr/bin/readlink -e -- "$candidate" 2>/dev/null) || return 1
    [[ "$canonical" == "$candidate" ]] || return 1
    identity=$(/usr/bin/stat -c '%d:%i:%u:%g:%f' -- "$candidate" 2>/dev/null) ||
      return 1
    if [[ -d "$candidate" && -r "$candidate" && -x "$candidate" ]]; then
      state="directory:$identity"
    elif [[ -f "$candidate" && -r "$candidate" ]]; then
      state="file:$identity"
    else
      return 1
    fi
  else
    state="absent"
  fi

  if [[ -n "${HOST_PREP_FIXTURE_COMPONENT_STATES[$candidate]+set}" ]]; then
    [[ "${HOST_PREP_FIXTURE_COMPONENT_STATES[$candidate]}" == "$state" ]]
  else
    HOST_PREP_FIXTURE_COMPONENT_STATES["$candidate"]="$state"
  fi
}

host_prep_initialize_environment() {
  local supplied=0
  local root_base
  local bin_base
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
    root_base=$(host_prep_fixture_base_for_path "$HOST_PREP_CAPTURED_TEST_ROOT") || return 1
    bin_base=$(host_prep_fixture_base_for_path "$HOST_PREP_CAPTURED_TEST_BIN") || return 1
    [[ "$root_base" == "$bin_base" ]] || return 1
    [[ "$HOST_PREP_CAPTURED_TEST_ROOT" != "$HOST_PREP_CAPTURED_TEST_BIN" ]] || return 1
    [[ "$HOST_PREP_CAPTURED_TEST_ROOT/" != "$HOST_PREP_CAPTURED_TEST_BIN/"* ]] || return 1
    [[ "$HOST_PREP_CAPTURED_TEST_BIN/" != "$HOST_PREP_CAPTURED_TEST_ROOT/"* ]] || return 1
    HOST_PREP_TEST_MODE=1
    HOST_PREP_TEST_BASE="$root_base"
    HOST_PREP_SYSTEM_ROOT="$HOST_PREP_CAPTURED_TEST_ROOT"
    HOST_PREP_TEST_COMMAND_BIN="$HOST_PREP_CAPTURED_TEST_BIN"
    HOST_PREP_TEST_ROOT_IDENTITY=$(host_prep_directory_identity "$HOST_PREP_SYSTEM_ROOT") ||
      return 1
    HOST_PREP_TEST_BIN_IDENTITY=$(host_prep_directory_identity "$HOST_PREP_TEST_COMMAND_BIN") ||
      return 1
  fi

  HOST_PREP_INITIALIZED=1
}

host_prep_validate_mapped_path() {
  local absolute_path="$1"
  local allow_final_link="${2:-0}"
  local current="$HOST_PREP_SYSTEM_ROOT"
  local component
  local final_component
  local index
  local -a components=()

  [[ "$absolute_path" == /* && ! "$absolute_path" =~ [[:cntrl:]] ]] || return 1
  [[ "$absolute_path" != *"/../"* && "$absolute_path" != *"/./"* ]] || return 1
  host_prep_revalidate_fixture_boundaries || return 1
  IFS='/' read -r -a components <<< "${absolute_path#/}"
  final_component=$((${#components[@]} - 1))

  for (( index = 0; index < ${#components[@]}; index += 1 )); do
    component="${components[index]}"
    [[ -n "$component" && "$component" != "." && "$component" != ".." ]] || return 1
    current="$current/$component"
    if [[ -L "$current" ]]; then
      (( index == final_component && allow_final_link == 1 )) || return 1
      host_prep_fixture_component_state "$current" 1 || return 1
      break
    fi
    if [[ -e "$current" ]]; then
      host_prep_fixture_component_state "$current" 0 || return 1
      if (( index < final_component )); then
        [[ -d "$current" && -x "$current" ]] || return 1
      fi
    else
      [[ -d "${current%/*}" && -x "${current%/*}" ]] || return 1
      host_prep_fixture_component_state "$current" 0 || return 1
      break
    fi
  done

  [[ "$current" == "$HOST_PREP_SYSTEM_ROOT/"* ]] || return 1
  host_prep_revalidate_fixture_boundaries || return 1
}

host_prep_system_path() {
  local absolute_path="$1"
  local allow_final_link="${2:-0}"
  HOST_PREP_MAPPED_PATH=""
  [[ "$absolute_path" == /* ]] || return 1
  if (( HOST_PREP_TEST_MODE == 1 )); then
    host_prep_validate_mapped_path "$absolute_path" "$allow_final_link" || return 1
    HOST_PREP_MAPPED_PATH="$HOST_PREP_SYSTEM_ROOT$absolute_path"
  else
    HOST_PREP_MAPPED_PATH="$absolute_path"
  fi
  printf '%s\n' "$HOST_PREP_MAPPED_PATH"
}

host_prep_observer_path() {
  local name="$1"
  local resolved
  if (( HOST_PREP_TEST_MODE == 1 )); then
    host_prep_revalidate_fixture_boundaries || return 1
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
  local before_identity
  local after_identity
  local status
  shift
  command_path=$(host_prep_observer_path "$name") || return 127
  before_identity=$(/usr/bin/stat -Lc '%d:%i:%u:%s:%Y:%Z:%f' -- "$command_path" 2>/dev/null) ||
    return 127
  if "$command_path" "$@"; then
    status=0
  else
    status=$?
  fi
  if (( HOST_PREP_TEST_MODE == 1 )); then
    host_prep_revalidate_fixture_boundaries || return 125
  fi
  [[ -f "$command_path" && ! -L "$command_path" ]] || return 125
  after_identity=$(/usr/bin/stat -Lc '%d:%i:%u:%s:%Y:%Z:%f' -- "$command_path" 2>/dev/null) ||
    return 125
  [[ "$before_identity" == "$after_identity" ]] || return 125
  return "$status"
}

host_prep_read_bounded_stream() {
  local maximum="$1"
  local output=""
  local reader_status

  HOST_PREP_BOUNDED_TRUNCATED=0
  HOST_PREP_BOUNDED_MALFORMED=0
  HOST_PREP_BOUNDED_READER_STATUS=125
  if IFS= read -r -d '' -n "$((maximum + 1))" output; then
    reader_status=0
  else
    reader_status=$?
  fi
  HOST_PREP_BOUNDED_OUTPUT="$output"
  HOST_PREP_BOUNDED_READER_STATUS="$reader_status"
  if (( ${#output} == maximum + 1 )); then
    HOST_PREP_BOUNDED_TRUNCATED=1
    return 66
  fi
  if (( reader_status == 0 )); then
    HOST_PREP_BOUNDED_MALFORMED=1
    return 65
  fi
  if (( reader_status != 1 || ${#output} > maximum )); then
    HOST_PREP_BOUNDED_MALFORMED=1
    return 67
  fi
}

host_prep_run_observer_bounded() {
  local maximum="$1"
  local name="$2"
  local -a pipeline_status=()
  shift 2

  HOST_PREP_BOUNDED_OUTPUT=""
  HOST_PREP_BOUNDED_STATUS=125
  HOST_PREP_BOUNDED_TRUNCATED=0
  HOST_PREP_BOUNDED_MALFORMED=0
  HOST_PREP_BOUNDED_READER_STATUS=125
  if host_prep_observe "$name" "$@" 2>/dev/null |
    host_prep_read_bounded_stream "$maximum"; then
    pipeline_status=("${PIPESTATUS[@]}")
  else
    pipeline_status=("${PIPESTATUS[@]}")
  fi
  HOST_PREP_BOUNDED_STATUS="${pipeline_status[0]}"
  (( pipeline_status[1] == 0 &&
    HOST_PREP_BOUNDED_MALFORMED == 0 &&
    HOST_PREP_BOUNDED_TRUNCATED == 0 ))
}

host_prep_run_path_bounded() {
  local maximum="$1"
  local command_path="$2"
  local -a pipeline_status=()
  shift 2

  HOST_PREP_BOUNDED_OUTPUT=""
  HOST_PREP_BOUNDED_STATUS=125
  HOST_PREP_BOUNDED_TRUNCATED=0
  HOST_PREP_BOUNDED_MALFORMED=0
  HOST_PREP_BOUNDED_READER_STATUS=125
  if "$command_path" "$@" 2>/dev/null |
    host_prep_read_bounded_stream "$maximum"; then
    pipeline_status=("${PIPESTATUS[@]}")
  else
    pipeline_status=("${PIPESTATUS[@]}")
  fi
  HOST_PREP_BOUNDED_STATUS="${pipeline_status[0]}"
  (( pipeline_status[1] == 0 &&
    HOST_PREP_BOUNDED_MALFORMED == 0 &&
    HOST_PREP_BOUNDED_TRUNCATED == 0 ))
}

host_prep_stage_root() {
  local lexical_source
  local canonical_source
  local to_debian
  local stage
  local stage_base

  HOST_PREP_STAGE_ROOT_RESULT=""
  host_prep_require_current_shell || return 1
  host_prep_initialize_environment || return 1
  lexical_source=$(/usr/bin/realpath -s -- "$HOST_PREP_SCRIPT_SOURCE" 2>/dev/null) || return 1
  canonical_source=$(/usr/bin/readlink -e -- "$HOST_PREP_SCRIPT_SOURCE" 2>/dev/null) || return 1
  [[ "$lexical_source" == "$canonical_source" ]] || return 1
  [[ -f "$canonical_source" && ! -L "$HOST_PREP_SCRIPT_SOURCE" ]] || return 1
  [[ "${canonical_source##*/}" == "preflight-host-prep.sh" ]] || return 1

  to_debian=${canonical_source%/*}
  stage=${to_debian%/*}
  [[ "${to_debian##*/}" == "TO-DEBIAN" ]] || return 1
  [[ -d "$to_debian" && ! -L "$to_debian" ]] || return 1
  [[ -d "$stage" && ! -L "$stage" && "$stage" != "/" ]] || return 1
  [[ "$canonical_source" == "$stage/TO-DEBIAN/preflight-host-prep.sh" ]] || return 1
  [[ ! "$stage" =~ [[:cntrl:]] ]] || return 1
  if (( HOST_PREP_TEST_MODE == 1 )); then
    stage_base=$(host_prep_fixture_base_for_path "$stage") || return 1
    [[ "$stage_base" == "$HOST_PREP_TEST_BASE" ]] || return 1
    host_prep_path_has_no_link_components "$stage" || return 1
    [[ "$stage" != "$HOST_PREP_SYSTEM_ROOT" && "$stage" != "$HOST_PREP_TEST_COMMAND_BIN" ]] ||
      return 1
    [[ "$stage/" != "$HOST_PREP_SYSTEM_ROOT/"* ]] || return 1
    [[ "$stage/" != "$HOST_PREP_TEST_COMMAND_BIN/"* ]] || return 1
    [[ "$HOST_PREP_SYSTEM_ROOT/" != "$stage/"* ]] || return 1
    [[ "$HOST_PREP_TEST_COMMAND_BIN/" != "$stage/"* ]] || return 1
    host_prep_revalidate_fixture_boundaries || return 1
  fi
  HOST_PREP_STAGE_ROOT_RESULT="$stage"
  printf '%s\n' "$stage"
}

host_prep_collect_find_pairs() {
  local root="$1"
  local scope="$2"
  local paths_name="$3"
  local types_name="$4"
  local path_value
  local type_value
  local malformed=0
  local -a pipeline_status=()
  local -n paths_reference="$paths_name"
  local -n types_reference="$types_name"

  paths_reference=()
  types_reference=()
  if [[ "$scope" == "tree" ]]; then
    if /usr/bin/find "$root" -mindepth 1 -printf '%P\0%y\0' 2>/dev/null |
      while IFS= read -r -d '' path_value; do
        if ! IFS= read -r -d '' type_value; then
          malformed=1
          break
        fi
        paths_reference+=("$path_value")
        types_reference+=("$type_value")
      done; then
      pipeline_status=("${PIPESTATUS[@]}")
    else
      pipeline_status=("${PIPESTATUS[@]}")
    fi
  else
    if /usr/bin/find "$root" -mindepth 1 -maxdepth 1 -printf '%f\0%y\0' 2>/dev/null |
      while IFS= read -r -d '' path_value; do
        if ! IFS= read -r -d '' type_value; then
          malformed=1
          break
        fi
        paths_reference+=("$path_value")
        types_reference+=("$type_value")
      done; then
      pipeline_status=("${PIPESTATUS[@]}")
    else
      pipeline_status=("${PIPESTATUS[@]}")
    fi
  fi
  (( malformed == 0 && pipeline_status[0] == 0 && pipeline_status[1] == 0 ))
}

host_prep_assert_exact_layout() {
  local stage="$1"
  local relative_path
  local entry_type
  local expected_type
  local token_seen=0
  local index
  local -a found_paths=()
  local -a found_types=()
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

  host_prep_collect_find_pairs "$stage" tree found_paths found_types || return 1
  for (( index = 0; index < ${#found_paths[@]}; index += 1 )); do
    relative_path="${found_paths[index]}"
    entry_type="${found_types[index]}"
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
  done

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
    state+=$(/usr/bin/stat -Lc '%d:%i:%s:%Y:%Z:%f' -- "$absolute_path" 2>/dev/null) ||
      return 1
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
  fingerprint_before=$(/usr/bin/sha256sum -- "$manifest" 2>/dev/null) || return 1
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
  fingerprint_after=$(/usr/bin/sha256sum -- "$manifest" 2>/dev/null) || return 1
  fingerprint_after="${fingerprint_after%% *}"
  [[ "$fingerprint_before" == "$fingerprint_after" ]] || return 1
  printf '%s\n' "$fingerprint_before"
}

host_prep_manifest_fingerprint() {
  local stage
  local fingerprint

  HOST_PREP_MANIFEST_FINGERPRINT_RESULT=""
  host_prep_require_current_shell || return 1
  host_prep_stage_root >/dev/null || return 1
  stage="$HOST_PREP_STAGE_ROOT_RESULT"
  fingerprint=$(host_prep_verify_manifest "$stage") || return 1
  HOST_PREP_MANIFEST_FINGERPRINT_RESULT="$fingerprint"
  printf '%s\n' "$fingerprint"
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
  before=$(/usr/bin/stat -c '%d:%i:%u' -- "$token" 2>/dev/null) || return 1
  [[ "$before" == *":$EUID" ]] || return 1
  [[ ! -e "$quarantine" && ! -L "$quarantine" ]] || return 1

  /usr/bin/mv -T -- "$token" "$quarantine" 2>/dev/null || return 1
  [[ -f "$quarantine" && ! -L "$quarantine" ]] || return 1
  after=$(/usr/bin/stat -c '%d:%i:%u' -- "$quarantine" 2>/dev/null) || return 1
  [[ "$before" == "$after" ]] || return 1
  HOST_PREP_SAFE_REMOVAL="$quarantine"
  /usr/bin/rm -f -- "$quarantine" 2>/dev/null || return 1
  HOST_PREP_SAFE_REMOVAL=""
}

host_prep_read_mapped_text() {
  local absolute_path="$1"
  local maximum="$2"
  local mapped
  local before
  local after
  local size
  local contents

  HOST_PREP_MAPPED_TEXT=""
  host_prep_system_path "$absolute_path" >/dev/null || return 1
  mapped="$HOST_PREP_MAPPED_PATH"
  [[ -f "$mapped" && ! -L "$mapped" && -r "$mapped" ]] || return 1
  before=$(/usr/bin/stat -Lc '%d:%i:%u:%s:%Y:%Z:%f' -- "$mapped" 2>/dev/null) ||
    return 1
  size=$(/usr/bin/stat -Lc '%s' -- "$mapped" 2>/dev/null) || return 1
  [[ "$size" =~ ^[0-9]+$ && "$size" -le "$maximum" ]] || return 1
  contents=$(/usr/bin/head -c "$((maximum + 1))" -- "$mapped" 2>/dev/null) || return 1
  (( ${#contents} <= maximum )) || return 1
  after=$(/usr/bin/stat -Lc '%d:%i:%u:%s:%Y:%Z:%f' -- "$mapped" 2>/dev/null) ||
    return 1
  [[ "$before" == "$after" ]] || return 1
  if (( HOST_PREP_TEST_MODE == 1 )); then
    host_prep_revalidate_fixture_boundaries || return 1
    host_prep_validate_mapped_path "$absolute_path" || return 1
  fi
  HOST_PREP_MAPPED_TEXT="$contents"
  printf '%s' "$HOST_PREP_MAPPED_TEXT"
}

host_prep_read_os_release_text() {
  local os_release
  local link_identity_before
  local link_identity_after
  local link_target_before
  local link_target_after
  local contents

  HOST_PREP_MAPPED_TEXT=""
  host_prep_system_path "/etc/os-release" 1 >/dev/null || return 1
  os_release="$HOST_PREP_MAPPED_PATH"
  if [[ ! -L "$os_release" ]]; then
    host_prep_read_mapped_text "/etc/os-release" 65536 >/dev/null
    return
  fi

  link_target_before=$(/usr/bin/readlink -- "$os_release" 2>/dev/null) || return 1
  [[ "$link_target_before" == "../usr/lib/os-release" ]] || return 1
  link_identity_before=$(
    /usr/bin/stat -c '%d:%i:%u:%g:%s:%Y:%Z:%f' -- "$os_release" 2>/dev/null
  ) || return 1
  host_prep_read_mapped_text "/usr/lib/os-release" 65536 >/dev/null || return 1
  contents="$HOST_PREP_MAPPED_TEXT"
  link_target_after=$(/usr/bin/readlink -- "$os_release" 2>/dev/null) || return 1
  link_identity_after=$(
    /usr/bin/stat -c '%d:%i:%u:%g:%s:%Y:%Z:%f' -- "$os_release" 2>/dev/null
  ) || return 1
  [[ "$link_target_before" == "$link_target_after" &&
    "$link_identity_before" == "$link_identity_after" ]] || return 1
  if (( HOST_PREP_TEST_MODE == 1 )); then
    host_prep_validate_mapped_path "/etc/os-release" 1 || return 1
  fi
  HOST_PREP_MAPPED_TEXT="$contents"
}

host_prep_read_os_release() {
  local contents
  local key
  local value
  local id=""
  local version_id=""
  host_prep_read_os_release_text || return 1
  contents="$HOST_PREP_MAPPED_TEXT"
  while IFS='=' read -r key value; do
    value="${value%\"}"
    value="${value#\"}"
    case "$key" in
      ID) id="$value" ;;
      VERSION_ID) version_id="$value" ;;
    esac
  done <<< "$contents"
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

host_prep_service_is_quietly_absent() {
  local service="$1"
  host_prep_run_observer_bounded 128 systemctl is-active --quiet "$service" || return 1
  (( HOST_PREP_BOUNDED_TRUNCATED == 0 )) || return 1
  [[ -z "$HOST_PREP_BOUNDED_OUTPUT" ]] || return 1
  [[ "$HOST_PREP_BOUNDED_STATUS" -eq 3 || "$HOST_PREP_BOUNDED_STATUS" -eq 4 ]] ||
    return 1

  host_prep_run_observer_bounded 128 systemctl is-enabled --quiet "$service" || return 1
  (( HOST_PREP_BOUNDED_TRUNCATED == 0 )) || return 1
  [[ -z "$HOST_PREP_BOUNDED_OUTPUT" ]] || return 1
  [[ "$HOST_PREP_BOUNDED_STATUS" -eq 1 || "$HOST_PREP_BOUNDED_STATUS" -eq 4 ]]
}

host_prep_verify_safety_state() {
  local output
  local memory_kib=""
  local meminfo_contents
  local key
  local value
  local unit
  local free_bytes
  local tunnel_service="cloudflare""d.service"
  local qemu_service="qemu-guest-agent.service"
  local time_service="systemd-timesyncd.service"

  HOST_PREP_SAFETY_RESULT=""
  host_prep_require_current_shell || return 1
  host_prep_initialize_environment || return 1
  host_prep_read_os_release || return 1
  host_prep_run_observer_bounded 64 uname -m || return 1
  [[ "$HOST_PREP_BOUNDED_STATUS" -eq 0 &&
    "$HOST_PREP_BOUNDED_TRUNCATED" -eq 0 &&
    "$HOST_PREP_BOUNDED_OUTPUT" == "$HOST_PREP_EXPECTED_ARCH"$'\n' ]] || return 1
  host_prep_run_observer_bounded 64 systemd-detect-virt || return 1
  [[ "$HOST_PREP_BOUNDED_STATUS" -eq 0 &&
    "$HOST_PREP_BOUNDED_TRUNCATED" -eq 0 &&
    "$HOST_PREP_BOUNDED_OUTPUT" == "kvm"$'\n' ]] || return 1
  host_prep_run_observer_bounded 64 nproc || return 1
  [[ "$HOST_PREP_BOUNDED_STATUS" -eq 0 && "$HOST_PREP_BOUNDED_TRUNCATED" -eq 0 ]] ||
    return 1
  output="${HOST_PREP_BOUNDED_OUTPUT%$'\n'}"
  [[ "$HOST_PREP_BOUNDED_OUTPUT" == "$output"$'\n' ]] || return 1
  [[ "$output" =~ ^[0-9]+$ && "$output" -ge 2 ]] || return 1

  host_prep_read_mapped_text "/proc/meminfo" 1048576 >/dev/null || return 1
  meminfo_contents="$HOST_PREP_MAPPED_TEXT"
  while read -r key value unit; do
    if [[ "$key" == "MemTotal:" ]]; then
      memory_kib="$value"
      break
    fi
  done <<< "$meminfo_contents"
  [[ "$memory_kib" =~ ^[0-9]+$ && "$memory_kib" -ge "$HOST_PREP_MIN_MEMORY_KIB" ]] ||
    return 1

  host_prep_run_observer_bounded 256 df -B1 --output=avail "$HOST_PREP_SYSTEM_ROOT" ||
    return 1
  [[ "$HOST_PREP_BOUNDED_STATUS" -eq 0 && "$HOST_PREP_BOUNDED_TRUNCATED" -eq 0 ]] ||
    return 1
  output="${HOST_PREP_BOUNDED_OUTPUT%$'\n'}"
  [[ "$HOST_PREP_BOUNDED_OUTPUT" == "$output"$'\n' && "$output" == *$'\n'* ]] ||
    return 1
  local header="${output%%$'\n'*}"
  local value_line="${output#*$'\n'}"
  [[ "$value_line" != *$'\n'* ]] || return 1
  [[ "$header" =~ ^[[:blank:]]*Avail[[:blank:]]*$ ]] || return 1
  [[ "$value_line" =~ ^[[:blank:]]*([0-9]+)[[:blank:]]*$ ]] || return 1
  free_bytes="${BASH_REMATCH[1]}"
  [[ "$free_bytes" =~ ^[0-9]+$ && "$free_bytes" -ge "$HOST_PREP_MIN_FREE_BYTES" ]] ||
    return 1
  host_prep_run_observer_bounded 64 timedatectl show --property=NTPSynchronized --value ||
    return 1
  [[ "$HOST_PREP_BOUNDED_STATUS" -eq 0 &&
    "$HOST_PREP_BOUNDED_TRUNCATED" -eq 0 &&
    "$HOST_PREP_BOUNDED_OUTPUT" == "yes"$'\n' ]] || return 1
  host_prep_run_observer_bounded 128 systemctl is-active --quiet "$qemu_service" || return 1
  [[ "$HOST_PREP_BOUNDED_STATUS" -eq 0 &&
    "$HOST_PREP_BOUNDED_TRUNCATED" -eq 0 &&
    -z "$HOST_PREP_BOUNDED_OUTPUT" ]] || return 1
  host_prep_run_observer_bounded 128 systemctl is-active --quiet "$time_service" || return 1
  [[ "$HOST_PREP_BOUNDED_STATUS" -eq 0 &&
    "$HOST_PREP_BOUNDED_TRUNCATED" -eq 0 &&
    -z "$HOST_PREP_BOUNDED_OUTPUT" ]] || return 1

  host_prep_verify_https "https://deb.debian.org/" || return 1
  host_prep_verify_https "https://nodejs.org/" || return 1

  host_prep_service_is_quietly_absent "palziv.service" || return 1
  host_prep_service_is_quietly_absent "$tunnel_service" || return 1

  host_prep_run_observer_bounded 256 ss -H -ltn 'sport = :3116' || return 1
  [[ "$HOST_PREP_BOUNDED_STATUS" -eq 0 &&
    "$HOST_PREP_BOUNDED_TRUNCATED" -eq 0 &&
    -z "$HOST_PREP_BOUNDED_OUTPUT" ]] || return 1
  HOST_PREP_SAFETY_RESULT="safe"
}

host_prep_path_state() {
  local absolute_path="$1"
  local mapped
  local allow_final_link=0
  HOST_PREP_PATH_STATE=""
  [[ "$absolute_path" == "$HOST_PREP_NODE_LINK" ]] && allow_final_link=1
  host_prep_system_path "$absolute_path" "$allow_final_link" >/dev/null || return 1
  mapped="$HOST_PREP_MAPPED_PATH"
  if [[ -L "$mapped" ]]; then
    HOST_PREP_PATH_STATE="link"
  elif [[ -e "$mapped" ]]; then
    HOST_PREP_PATH_STATE="present"
  else
    HOST_PREP_PATH_STATE="absent"
  fi
  if (( HOST_PREP_TEST_MODE == 1 )); then
    host_prep_revalidate_fixture_boundaries || return 1
    host_prep_validate_mapped_path "$absolute_path" "$allow_final_link" || return 1
  fi
  printf '%s\n' "$HOST_PREP_PATH_STATE"
}

host_prep_get_account_state() {
  local passwd_entry=""
  local group_entry=""
  local passwd_output
  local group_output
  local passwd_status
  local group_status

  HOST_PREP_ACCOUNT_STATE="conflict"
  host_prep_run_observer_bounded "$HOST_PREP_MAX_COMMAND_OUTPUT" getent passwd palziv ||
    return 1
  passwd_output="$HOST_PREP_BOUNDED_OUTPUT"
  passwd_status="$HOST_PREP_BOUNDED_STATUS"
  (( HOST_PREP_BOUNDED_TRUNCATED == 0 )) || {
    printf '%s\n' "$HOST_PREP_ACCOUNT_STATE"
    return 0
  }
  host_prep_run_observer_bounded "$HOST_PREP_MAX_COMMAND_OUTPUT" getent group palziv ||
    return 1
  group_output="$HOST_PREP_BOUNDED_OUTPUT"
  group_status="$HOST_PREP_BOUNDED_STATUS"
  (( HOST_PREP_BOUNDED_TRUNCATED == 0 )) || {
    printf '%s\n' "$HOST_PREP_ACCOUNT_STATE"
    return 0
  }

  if [[ -z "$passwd_output" &&
    -z "$group_output" &&
    "$passwd_status" -eq 2 &&
    "$group_status" -eq 2 ]]; then
    HOST_PREP_ACCOUNT_STATE="absent"
    printf '%s\n' "$HOST_PREP_ACCOUNT_STATE"
    return 0
  fi
  [[ "$passwd_status" -eq 0 && "$group_status" -eq 0 ]] || {
    printf '%s\n' "$HOST_PREP_ACCOUNT_STATE"
    return 0
  }
  [[ "$passwd_output" != *$'\r'* &&
    "$group_output" != *$'\r'* &&
    "$passwd_output" == *$'\n' &&
    "$group_output" == *$'\n' ]] || {
    printf '%s\n' "$HOST_PREP_ACCOUNT_STATE"
    return 0
  }
  passwd_entry="${passwd_output%$'\n'}"
  group_entry="${group_output%$'\n'}"
  [[ "$passwd_entry" != *$'\n'* && "$group_entry" != *$'\n'* ]] || {
    printf '%s\n' "$HOST_PREP_ACCOUNT_STATE"
    return 0
  }

  local user_name password user_id user_group_id gecos user_home user_shell extra
  local group_name group_password group_id group_members group_extra
  IFS=':' read -r user_name password user_id user_group_id gecos user_home user_shell extra \
    <<< "$passwd_entry"
  IFS=':' read -r group_name group_password group_id group_members group_extra <<< "$group_entry"
  if [[ "$user_name" == "palziv" &&
    "$password" == "x" &&
    "$user_id" =~ ^[0-9]+$ &&
    "$user_id" -gt 0 &&
    "$user_id" -lt 1000 &&
    "$user_group_id" == "$group_id" &&
    "$user_home" == "/var/lib/palziv" &&
    "$user_shell" == "/usr/sbin/nologin" &&
    -z "$gecos" &&
    -z "${extra-}" &&
    "$group_name" == "palziv" &&
    "$group_password" == "x" &&
    "$group_id" =~ ^[0-9]+$ &&
    "$group_id" -gt 0 &&
    "$group_id" -lt 1000 &&
    -z "$group_members" &&
    -z "${group_extra-}" ]]; then
    HOST_PREP_ACCOUNT_STATE="exact"
  fi
  printf '%s\n' "$HOST_PREP_ACCOUNT_STATE"
}

host_prep_capture_path_identity() {
  local candidate="$1"
  local expected_type="$2"
  local canonical

  HOST_PREP_PATH_IDENTITY=""
  [[ "$candidate" == /* && ! "$candidate" =~ [[:cntrl:]] ]] || return 1
  [[ ! -L "$candidate" ]] || return 1
  canonical=$(/usr/bin/readlink -e -- "$candidate" 2>/dev/null) || return 1
  [[ "$canonical" == "$candidate" ]] || return 1
  if [[ "$expected_type" == "directory" ]]; then
    [[ -d "$candidate" && -r "$candidate" && -x "$candidate" ]] || return 1
  else
    [[ -f "$candidate" && -r "$candidate" && -x "$candidate" ]] || return 1
  fi
  HOST_PREP_PATH_IDENTITY=$(
    /usr/bin/stat -c '%d:%i:%u:%g:%s:%Y:%Z:%f' -- "$candidate" 2>/dev/null
  ) || return 1
}

host_prep_capture_node_chain() {
  local identities_name="$1"
  local specification
  local candidate
  local expected_type
  local version_path
  local bin_path
  local node_path
  local lib_path
  local node_modules_path
  local package_root_path
  local package_bin_path
  local package_cli_path
  local -n identities_reference="$identities_name"

  host_prep_system_path "$HOST_PREP_NODE_DIRECTORY/bin/node" >/dev/null || return 1
  node_path="$HOST_PREP_MAPPED_PATH"
  bin_path="${node_path%/node}"
  version_path="${bin_path%/bin}"
  lib_path="$version_path/lib"
  node_modules_path="$lib_path/node_modules"
  package_root_path="$node_modules_path/$HOST_PREP_PACKAGE_EXECUTABLE_NAME"
  package_bin_path="$package_root_path/bin"
  package_cli_path="$version_path/$HOST_PREP_PACKAGE_CLI_RELATIVE"
  [[ "$version_path" == "${HOST_PREP_SYSTEM_ROOT%/}$HOST_PREP_NODE_DIRECTORY" ]] || return 1
  identities_reference=()
  for specification in \
    "${HOST_PREP_SYSTEM_ROOT%/}/opt|directory" \
    "$version_path|directory" \
    "$bin_path|directory" \
    "$node_path|file" \
    "$lib_path|directory" \
    "$node_modules_path|directory" \
    "$package_root_path|directory" \
    "$package_bin_path|directory" \
    "$package_cli_path|file"; do
    IFS='|' read -r candidate expected_type <<< "$specification"
    [[ -n "$candidate" ]] || candidate="/"
    host_prep_capture_path_identity "$candidate" "$expected_type" || return 1
    identities_reference+=("$candidate:$HOST_PREP_PATH_IDENTITY")
  done
  HOST_PREP_NODE_VERSION_PATH="$version_path"
  HOST_PREP_NODE_BIN_PATH="$bin_path"
  HOST_PREP_NODE_EXECUTABLE_PATH="$node_path"
  HOST_PREP_PACKAGE_LINK_PATH="$bin_path/$HOST_PREP_PACKAGE_EXECUTABLE_NAME"
  HOST_PREP_PACKAGE_ROOT_PATH="$package_root_path"
  HOST_PREP_PACKAGE_BIN_PATH="$package_bin_path"
  HOST_PREP_PACKAGE_CLI_PATH="$package_cli_path"
}

host_prep_node_chain_matches() {
  local expected_name="$1"
  local index
  local -a current=()
  local -n expected_reference="$expected_name"

  host_prep_capture_node_chain current || return 1
  (( ${#expected_reference[@]} == ${#current[@]} )) || return 1
  for (( index = 0; index < ${#expected_reference[@]}; index += 1 )); do
    [[ "${expected_reference[index]}" == "${current[index]}" ]] || return 1
  done
}

host_prep_observer_exact_line() {
  local expected="$1"
  local maximum="$2"
  local name="$3"
  shift 3
  host_prep_run_observer_bounded "$maximum" "$name" "$@" || return 1
  [[ "$HOST_PREP_BOUNDED_STATUS" -eq 0 &&
    "$HOST_PREP_BOUNDED_OUTPUT" == "$expected"$'\n' ]]
}

host_prep_node_is_exact() {
  local version_path
  local bin_path
  local link_path
  local node_path
  local package_link_path
  local package_cli_path
  local link_before
  local link_after
  local link_target
  local package_link_before
  local package_link_after
  local package_link_target
  local package_resolved
  local first_line
  local metadata_path
  local -a chain_before=()

  host_prep_capture_node_chain chain_before || return 1
  version_path="$HOST_PREP_NODE_VERSION_PATH"
  bin_path="$HOST_PREP_NODE_BIN_PATH"
  node_path="$HOST_PREP_NODE_EXECUTABLE_PATH"
  package_link_path="$HOST_PREP_PACKAGE_LINK_PATH"
  package_cli_path="$HOST_PREP_PACKAGE_CLI_PATH"
  host_prep_system_path "$HOST_PREP_NODE_LINK" 1 >/dev/null || return 1
  link_path="$HOST_PREP_MAPPED_PATH"
  [[ -L "$link_path" && -L "$package_link_path" ]] || return 1
  link_before=$(/usr/bin/stat -c '%d:%i:%u:%g:%s:%Y:%Z:%f' -- "$link_path" 2>/dev/null) ||
    return 1
  package_link_before=$(
    /usr/bin/stat -c '%d:%i:%u:%g:%s:%Y:%Z:%f' -- "$package_link_path" 2>/dev/null
  ) || return 1
  for metadata_path in \
    "$version_path" \
    "$bin_path" \
    "$node_path" \
    "$version_path/lib" \
    "$version_path/lib/node_modules" \
    "$HOST_PREP_PACKAGE_ROOT_PATH" \
    "$HOST_PREP_PACKAGE_BIN_PATH" \
    "$package_cli_path"; do
    host_prep_observer_exact_line "root:root:755" 64 stat -Lc '%U:%G:%a' "$metadata_path" ||
      return 1
    host_prep_node_chain_matches chain_before || return 1
  done
  host_prep_observer_exact_line "root:root" 64 stat -c '%U:%G' "$link_path" || return 1
  host_prep_node_chain_matches chain_before || return 1
  host_prep_observer_exact_line "root:root" 64 stat -c '%U:%G' "$package_link_path" ||
    return 1
  host_prep_node_chain_matches chain_before || return 1
  link_after=$(/usr/bin/stat -c '%d:%i:%u:%g:%s:%Y:%Z:%f' -- "$link_path" 2>/dev/null) ||
    return 1
  [[ "$link_before" == "$link_after" ]] || return 1
  link_target=$(/usr/bin/readlink -- "$link_path" 2>/dev/null) || return 1
  [[ "$link_target" == "$HOST_PREP_NODE_DIRECTORY" ]] || return 1
  package_link_after=$(
    /usr/bin/stat -c '%d:%i:%u:%g:%s:%Y:%Z:%f' -- "$package_link_path" 2>/dev/null
  ) || return 1
  [[ "$package_link_after" == "$package_link_before" ]] || return 1
  package_link_target=$(/usr/bin/readlink -- "$package_link_path" 2>/dev/null) ||
    return 1
  [[ "$package_link_target" == "$HOST_PREP_PACKAGE_LINK_TARGET" ]] || return 1
  package_resolved=$(/usr/bin/readlink -e -- "$package_link_path" 2>/dev/null) || return 1
  [[ "$package_resolved" == "$package_cli_path" ]] || return 1
  IFS= read -r first_line < "$package_cli_path" || return 1
  [[ "$first_line" == '#!/usr/bin/env node' ]] || return 1
  host_prep_node_chain_matches chain_before || return 1

  host_prep_run_path_bounded 64 "$node_path" --version || return 1
  [[ "$HOST_PREP_BOUNDED_STATUS" -eq 0 &&
    "$HOST_PREP_BOUNDED_OUTPUT" == "$HOST_PREP_NODE_VERSION"$'\n' ]] || return 1

  host_prep_node_chain_matches chain_before || return 1
  host_prep_run_path_bounded 64 "$node_path" "$package_cli_path" --version || return 1
  [[ "$HOST_PREP_BOUNDED_STATUS" -eq 0 &&
    "$HOST_PREP_BOUNDED_OUTPUT" =~ ^[0-9]+\.[0-9]+\.[0-9]+$'\n'$ ]] || return 1
  host_prep_node_chain_matches chain_before || return 1
  host_prep_system_path "$HOST_PREP_NODE_LINK" 1 >/dev/null || return 1
  [[ "$HOST_PREP_MAPPED_PATH" == "$link_path" &&
    -L "$link_path" &&
    -L "$package_link_path" ]] || return 1
  link_after=$(/usr/bin/stat -c '%d:%i:%u:%g:%s:%Y:%Z:%f' -- "$link_path" 2>/dev/null) ||
    return 1
  [[ "$link_before" == "$link_after" ]] || return 1
  link_target=$(/usr/bin/readlink -- "$link_path" 2>/dev/null) || return 1
  [[ "$link_target" == "$HOST_PREP_NODE_DIRECTORY" ]] || return 1
  package_link_after=$(
    /usr/bin/stat -c '%d:%i:%u:%g:%s:%Y:%Z:%f' -- "$package_link_path" 2>/dev/null
  ) || return 1
  [[ "$package_link_after" == "$package_link_before" ]] || return 1
  package_link_target=$(/usr/bin/readlink -- "$package_link_path" 2>/dev/null) ||
    return 1
  [[ "$package_link_target" == "$HOST_PREP_PACKAGE_LINK_TARGET" ]] || return 1
  for metadata_path in \
    "$version_path" \
    "$bin_path" \
    "$node_path" \
    "$version_path/lib" \
    "$version_path/lib/node_modules" \
    "$HOST_PREP_PACKAGE_ROOT_PATH" \
    "$HOST_PREP_PACKAGE_BIN_PATH" \
    "$package_cli_path"; do
    host_prep_observer_exact_line "root:root:755" 64 stat -Lc '%U:%G:%a' "$metadata_path" ||
      return 1
    host_prep_node_chain_matches chain_before || return 1
  done
  host_prep_observer_exact_line "root:root" 64 stat -c '%U:%G' "$link_path" || return 1
  host_prep_node_chain_matches chain_before || return 1
  host_prep_observer_exact_line "root:root" 64 stat -c '%U:%G' "$package_link_path" ||
    return 1
  host_prep_node_chain_matches chain_before || return 1
  link_after=$(/usr/bin/stat -c '%d:%i:%u:%g:%s:%Y:%Z:%f' -- "$link_path" 2>/dev/null) ||
    return 1
  [[ "$link_before" == "$link_after" ]] || return 1
  link_target=$(/usr/bin/readlink -- "$link_path" 2>/dev/null) || return 1
  [[ "$link_target" == "$HOST_PREP_NODE_DIRECTORY" ]]
}

host_prep_directory_children_are_exact() {
  local absolute_path="$1"
  local allowed_child="$2"
  local mapped
  local before
  local after
  local -a child_names=()
  local -a child_types=()

  host_prep_system_path "$absolute_path" >/dev/null || return 1
  mapped="$HOST_PREP_MAPPED_PATH"
  [[ -d "$mapped" && ! -L "$mapped" && -r "$mapped" && -x "$mapped" ]] || return 1
  before=$(/usr/bin/stat -Lc '%d:%i:%u:%s:%Y:%Z:%f' -- "$mapped" 2>/dev/null) ||
    return 1
  host_prep_collect_find_pairs "$mapped" immediate child_names child_types || return 1
  after=$(/usr/bin/stat -Lc '%d:%i:%u:%s:%Y:%Z:%f' -- "$mapped" 2>/dev/null) ||
    return 1
  [[ "$before" == "$after" ]] || return 1
  if (( HOST_PREP_TEST_MODE == 1 )); then
    host_prep_revalidate_fixture_boundaries || return 1
    host_prep_validate_mapped_path "$absolute_path" || return 1
  fi

  if [[ -z "$allowed_child" ]]; then
    (( ${#child_names[@]} == 0 ))
    return
  fi
  (( ${#child_names[@]} == 1 && ${#child_types[@]} == 1 )) || return 1
  [[ "${child_names[0]}" == "$allowed_child" && "${child_types[0]}" == "d" ]] || return 1
  host_prep_system_path "$absolute_path/$allowed_child" >/dev/null
}

host_prep_directories_are_exact() {
  local specification
  local absolute_path
  local expected
  local allowed_child
  local mapped
  local -a specifications=(
    "/opt/palziv|root:palziv:750|releases"
    "/opt/palziv/releases|root:palziv:750|"
    "/var/lib/palziv|palziv:palziv:700|data"
    "/var/lib/palziv/data|palziv:palziv:700|"
    "/var/backups/palziv|root:palziv:750|"
    "/etc/palziv|root:palziv:750|"
  )

  for specification in "${specifications[@]}"; do
    IFS='|' read -r absolute_path expected allowed_child <<< "$specification"
    host_prep_system_path "$absolute_path" >/dev/null || return 1
    mapped="$HOST_PREP_MAPPED_PATH"
    [[ -d "$mapped" && ! -L "$mapped" ]] || return 1
    host_prep_observer_exact_line "$expected" 64 stat -Lc '%U:%G:%a' "$mapped" ||
      return 1
    host_prep_directory_children_are_exact "$absolute_path" "$allowed_child" || return 1
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
  HOST_PREP_CLASSIFICATION_RESULT=""
  host_prep_require_current_shell || return 1
  HOST_PREP_CLASSIFICATION="conflict"
  HOST_PREP_CLASSIFICATION_RESULT="$HOST_PREP_CLASSIFICATION"

  host_prep_initialize_environment || {
    printf '%s\n' "$HOST_PREP_CLASSIFICATION_RESULT"
    return 0
  }
  host_prep_path_state "$HOST_PREP_NODE_DIRECTORY" >/dev/null || {
    printf '%s\n' "$HOST_PREP_CLASSIFICATION_RESULT"
    return 0
  }
  node_directory_state="$HOST_PREP_PATH_STATE"
  host_prep_path_state "$HOST_PREP_NODE_LINK" >/dev/null || {
    printf '%s\n' "$HOST_PREP_CLASSIFICATION_RESULT"
    return 0
  }
  node_link_state="$HOST_PREP_PATH_STATE"
  host_prep_get_account_state >/dev/null || {
    printf '%s\n' "$HOST_PREP_CLASSIFICATION_RESULT"
    return 0
  }
  account_state="$HOST_PREP_ACCOUNT_STATE"

  for absolute_path in "${directories[@]}"; do
    host_prep_path_state "$absolute_path" >/dev/null || {
      printf '%s\n' "$HOST_PREP_CLASSIFICATION_RESULT"
      return 0
    }
    directory_state="$HOST_PREP_PATH_STATE"
    [[ "$directory_state" == "absent" ]] || all_directories_absent=0
  done

  if [[ "$node_directory_state" == "absent" &&
    "$node_link_state" == "absent" &&
    "$account_state" == "absent" &&
    "$all_directories_absent" -eq 1 ]]; then
    HOST_PREP_CLASSIFICATION="clean"
    HOST_PREP_CLASSIFICATION_RESULT="$HOST_PREP_CLASSIFICATION"
    printf '%s\n' "$HOST_PREP_CLASSIFICATION_RESULT"
    return 0
  fi

  if [[ "$node_directory_state" == "present" &&
    "$node_link_state" == "link" &&
    "$account_state" == "exact" ]] &&
    host_prep_node_is_exact &&
    host_prep_directories_are_exact; then
    HOST_PREP_CLASSIFICATION="already-prepared"
    HOST_PREP_CLASSIFICATION_RESULT="$HOST_PREP_CLASSIFICATION"
    printf '%s\n' "$HOST_PREP_CLASSIFICATION_RESULT"
    return 0
  fi

  printf '%s\n' "$HOST_PREP_CLASSIFICATION_RESULT"
}

host_prep_report_ufw_state() {
  local command_name="u""fw"
  local status="unavailable"
  host_prep_run_observer_bounded 128 "$command_name" status || true
  if [[ "$HOST_PREP_BOUNDED_STATUS" -eq 0 &&
    "$HOST_PREP_BOUNDED_TRUNCATED" -eq 0 &&
    "$HOST_PREP_BOUNDED_MALFORMED" -eq 0 ]]; then
    case "$HOST_PREP_BOUNDED_OUTPUT" in
      "Status: active"$'\n') status="active" ;;
      "Status: inactive"$'\n') status="inactive" ;;
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
        /usr/bin/rm -f -- "$candidate" 2>/dev/null || true
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
  # This receipt is workflow freshness metadata, not an authorization boundary.
  # The mutating phase must independently replay canonical stage, manifest,
  # schema/age, and the complete host safety classification.
  created_epoch=$(/usr/bin/date +%s 2>/dev/null) || return 1
  [[ "$created_epoch" =~ ^[0-9]+$ ]] || return 1
  HOST_PREP_TEMP_TOKEN=$(
    /usr/bin/mktemp --tmpdir="$HOST_PREP_STAGE" ".host-prep-preflight-ok.tmp.XXXXXXXX"
  ) 2>/dev/null || return 1
  [[ -f "$HOST_PREP_TEMP_TOKEN" && ! -L "$HOST_PREP_TEMP_TOKEN" ]] || return 1
  /usr/bin/chmod 0600 -- "$HOST_PREP_TEMP_TOKEN" 2>/dev/null || return 1
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
    }' > "$HOST_PREP_TEMP_TOKEN" 2>/dev/null || return 1
  [[ "$(/usr/bin/stat -c '%a:%u:%F' -- "$HOST_PREP_TEMP_TOKEN" 2>/dev/null)" == "600:$EUID:regular file" ]] ||
    return 1
  temp_identity=$(/usr/bin/stat -c '%d:%i:%u:%F' -- "$HOST_PREP_TEMP_TOKEN" 2>/dev/null) ||
    return 1
  /usr/bin/mv -T -n -- "$HOST_PREP_TEMP_TOKEN" "$HOST_PREP_TOKEN" 2>/dev/null ||
    return 1
  [[ ! -e "$HOST_PREP_TEMP_TOKEN" && ! -L "$HOST_PREP_TEMP_TOKEN" ]] || return 1
  token_identity=$(/usr/bin/stat -c '%d:%i:%u:%F' -- "$HOST_PREP_TOKEN" 2>/dev/null) ||
    return 1
  [[ "$temp_identity" == "$token_identity" ]] || return 1
  HOST_PREP_TEMP_TOKEN=""
  [[ -f "$HOST_PREP_TOKEN" && ! -L "$HOST_PREP_TOKEN" ]] || return 1
  [[ "$(/usr/bin/stat -c '%a:%u:%F' -- "$HOST_PREP_TOKEN" 2>/dev/null)" == "600:$EUID:regular file" ]]
}

host_prep_preflight_main() {
  local fingerprint
  local final_fingerprint
  local classification
  local final_classification
  local replay_classification

  # Supported production launcher:
  # /usr/bin/env -i HOME="$HOME" PATH="/usr/sbin:/usr/bin:/sbin:/bin" /bin/bash -p TO-DEBIAN/preflight-host-prep.sh
  trap 'host_prep_cleanup' EXIT
  trap 'host_prep_cleanup; exit 1' HUP INT TERM

  host_prep_initialize_environment || {
    host_prep_fail_main fixture-routing
    return 1
  }
  host_prep_stage_root >/dev/null || {
    host_prep_fail_main stage-path
    return 1
  }
  HOST_PREP_STAGE="$HOST_PREP_STAGE_ROOT_RESULT"
  HOST_PREP_MANIFEST="$HOST_PREP_STAGE/$HOST_PREP_MANIFEST_RELATIVE"
  HOST_PREP_TOKEN="$HOST_PREP_STAGE/$HOST_PREP_TOKEN_NAME"

  host_prep_remove_stale_token "$HOST_PREP_TOKEN" "$HOST_PREP_STAGE" || {
    host_prep_fail_main stale-token
    return 1
  }
  [[ "$-" == *p* ]] || {
    host_prep_fail_main invocation
    return 1
  }
  (( $# == 0 )) || {
    host_prep_fail_main arguments
    return 1
  }
  host_prep_manifest_fingerprint >/dev/null || {
    host_prep_fail_main manifest
    return 1
  }
  fingerprint="$HOST_PREP_MANIFEST_FINGERPRINT_RESULT"
  host_prep_verify_safety_state || {
    host_prep_fail_main baseline
    return 1
  }
  host_prep_classify >/dev/null || {
    host_prep_fail_main classification
    return 1
  }
  classification="$HOST_PREP_CLASSIFICATION_RESULT"
  host_prep_report_ufw_state
  [[ "$classification" == "clean" || "$classification" == "already-prepared" ]] || {
    host_prep_fail_main classification
    return 1
  }

  host_prep_classify >/dev/null || {
    host_prep_fail_main final-classification
    return 1
  }
  final_classification="$HOST_PREP_CLASSIFICATION_RESULT"
  [[ "$final_classification" == "$classification" &&
    ( "$final_classification" == "clean" || "$final_classification" == "already-prepared" ) ]] ||
    {
      host_prep_fail_main final-classification
      return 1
    }
  host_prep_verify_safety_state || {
    host_prep_fail_main final-baseline
    return 1
  }
  host_prep_classify >/dev/null || {
    host_prep_fail_main final-classification
    return 1
  }
  replay_classification="$HOST_PREP_CLASSIFICATION_RESULT"
  [[ "$replay_classification" == "$classification" &&
    "$replay_classification" == "$final_classification" &&
    ( "$replay_classification" == "clean" || "$replay_classification" == "already-prepared" ) ]] ||
    {
      host_prep_fail_main final-classification
      return 1
    }
  host_prep_verify_safety_state || {
    host_prep_fail_main final-baseline
    return 1
  }
  host_prep_manifest_fingerprint >/dev/null || {
    host_prep_fail_main final-manifest
    return 1
  }
  final_fingerprint="$HOST_PREP_MANIFEST_FINGERPRINT_RESULT"
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
