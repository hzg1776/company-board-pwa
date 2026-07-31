#!/usr/bin/env bash
set -Eeuo pipefail
shopt -s lastpipe

readonly APPLY_PHASE_ID="debian-host-prep-v1"
readonly APPLY_TOKEN_MAX_AGE_SECONDS="900"
readonly APPLY_NODE_VERSION="v24.18.0"
readonly APPLY_NODE_ARCHIVE="node-v24.18.0-linux-x64.tar.xz"
readonly APPLY_NODE_ARCHIVE_URL="https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz"
readonly APPLY_NODE_ARCHIVE_SHA256="55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742"
readonly APPLY_NODE_DIRECTORY="/opt/node-v24.18.0-linux-x64"
readonly APPLY_NODE_LINK="/opt/node"
readonly APPLY_PACKAGE_EXECUTABLE_NAME="n""pm"
readonly APPLY_SAFE_PATH="/usr/sbin:/usr/bin:/sbin:/bin"
readonly APPLY_MAX_ARCHIVE_ENTRIES="100000"
readonly APPLY_MAX_ARCHIVE_LINE="4096"

APPLY_STEP="invocation"
APPLY_SUCCEEDED=0
APPLY_SCRIPT_CANONICAL=""
APPLY_PREFLIGHT=""
APPLY_PREFLIGHT_IDENTITY=""
APPLY_BOOTSTRAP_STAGE=""
APPLY_BOOTSTRAP_FINGERPRINT=""
APPLY_STAGE=""
APPLY_FINGERPRINT=""
APPLY_TOKEN_CLASSIFICATION=""
APPLY_INITIAL_CLASSIFICATION=""
APPLY_COMMAND_PATH=""
APPLY_COMMAND_IDENTITY=""
APPLY_CAPTURED_OUTPUT=""
APPLY_CAPTURED_STATUS=125
APPLY_WORK_ROOT=""
APPLY_WORK_ROOT_IDENTITY=""
APPLY_PARTIAL_ROOT=""
APPLY_PARTIAL_ROOT_IDENTITY=""
APPLY_LINK_STAGING=""
APPLY_LINK_STAGING_IDENTITY=""
APPLY_ARCHIVE_FD=""
APPLY_ARCHIVE_IDENTITY=""
APPLY_MAPPED_VAR_TMP=""
APPLY_MAPPED_OPT=""
APPLY_MAPPED_NODE_DIRECTORY=""
APPLY_MAPPED_NODE_LINK=""
APPLY_MAPPED_OPT_PALZIV=""
APPLY_MAPPED_OPT_RELEASES=""
APPLY_MAPPED_VAR_LIB_PALZIV=""
APPLY_MAPPED_VAR_LIB_DATA=""
APPLY_MAPPED_VAR_BACKUPS=""
APPLY_MAPPED_ETC_PALZIV=""
APPLY_ARCHIVE_ENTRY_COUNT=0
APPLY_ARCHIVE_RECORD_INVALID=0
APPLY_ARCHIVE_HAS_ROOT=0
APPLY_ARCHIVE_HAS_BIN=0
APPLY_ARCHIVE_HAS_NODE=0
APPLY_ARCHIVE_HAS_PACKAGE_EXECUTABLE=0
declare -A APPLY_ARCHIVE_SEEN=()

apply_stat_identity() {
  local candidate="$1"
  local follow="${2:-follow}"
  if [[ "$follow" == "no-follow" ]]; then
    /usr/bin/stat -c '%d:%i:%u:%g:%s:%f' -- "$candidate" 2>/dev/null
  else
    /usr/bin/stat -Lc '%d:%i:%u:%g:%s:%f' -- "$candidate" 2>/dev/null
  fi
}

apply_resolve_mutator() {
  local name="$1"
  local candidate=""

  APPLY_COMMAND_PATH=""
  APPLY_COMMAND_IDENTITY=""
  if (( HOST_PREP_TEST_MODE == 1 )); then
    host_prep_revalidate_fixture_boundaries || return 1
    candidate="$HOST_PREP_TEST_COMMAND_BIN/apply-$name"
    [[ "$candidate" == "$HOST_PREP_TEST_BASE/"* ]] || return 1
  else
    case "$name" in
      mktemp) candidate="/usr/bin/mktemp" ;;
      apt-get) candidate="/usr/bin/apt-get" ;;
      curl) candidate="/usr/bin/curl" ;;
      sha256sum) candidate="/usr/bin/sha256sum" ;;
      tar) candidate="/usr/bin/tar" ;;
      addgroup) candidate="/usr/sbin/addgroup" ;;
      adduser) candidate="/usr/sbin/adduser" ;;
      install) candidate="/usr/bin/install" ;;
      mv) candidate="/usr/bin/mv" ;;
      ln) candidate="/usr/bin/ln" ;;
      rm) candidate="/usr/bin/rm" ;;
      *) return 1 ;;
    esac
  fi
  [[ -f "$candidate" && ! -L "$candidate" && -x "$candidate" ]] || return 1
  APPLY_COMMAND_IDENTITY=$(apply_stat_identity "$candidate") || return 1
  APPLY_COMMAND_PATH="$candidate"
}

apply_recheck_mutator() {
  local candidate="$1"
  local identity="$2"
  local after

  if (( HOST_PREP_TEST_MODE == 1 )); then
    host_prep_revalidate_fixture_boundaries || return 1
  fi
  [[ -f "$candidate" && ! -L "$candidate" && -x "$candidate" ]] || return 1
  after=$(apply_stat_identity "$candidate") || return 1
  [[ "$after" == "$identity" ]]
}

apply_run_quiet() {
  local name="$1"
  local command_path
  local command_identity
  local status
  shift

  apply_resolve_mutator "$name" || return 1
  command_path="$APPLY_COMMAND_PATH"
  command_identity="$APPLY_COMMAND_IDENTITY"
  if "$command_path" "$@" >/dev/null 2>&1; then
    status=0
  else
    status=$?
  fi
  apply_recheck_mutator "$command_path" "$command_identity" || return 1
  return "$status"
}

apply_run_quiet_noninteractive() {
  local name="$1"
  local command_path
  local command_identity
  local status
  shift

  apply_resolve_mutator "$name" || return 1
  command_path="$APPLY_COMMAND_PATH"
  command_identity="$APPLY_COMMAND_IDENTITY"
  if DEBIAN_FRONTEND=noninteractive "$command_path" "$@" >/dev/null 2>&1; then
    status=0
  else
    status=$?
  fi
  apply_recheck_mutator "$command_path" "$command_identity" || return 1
  return "$status"
}

apply_run_bounded() {
  local maximum="$1"
  local name="$2"
  local command_path
  local command_identity
  local -a pipeline_status=()
  shift 2

  APPLY_CAPTURED_OUTPUT=""
  APPLY_CAPTURED_STATUS=125
  apply_resolve_mutator "$name" || return 1
  command_path="$APPLY_COMMAND_PATH"
  command_identity="$APPLY_COMMAND_IDENTITY"
  if "$command_path" "$@" 2>/dev/null |
    host_prep_read_bounded_stream "$maximum"; then
    pipeline_status=("${PIPESTATUS[@]}")
  else
    pipeline_status=("${PIPESTATUS[@]}")
  fi
  APPLY_CAPTURED_STATUS="${pipeline_status[0]}"
  APPLY_CAPTURED_OUTPUT="$HOST_PREP_BOUNDED_OUTPUT"
  (( pipeline_status[1] == 0 &&
    HOST_PREP_BOUNDED_MALFORMED == 0 &&
    HOST_PREP_BOUNDED_TRUNCATED == 0 )) || return 1
  apply_recheck_mutator "$command_path" "$command_identity"
}

apply_close_archive() {
  if [[ -n "$APPLY_ARCHIVE_FD" ]]; then
    eval "exec ${APPLY_ARCHIVE_FD}<&-" 2>/dev/null || true
    APPLY_ARCHIVE_FD=""
  fi
}

apply_remove_owned_link() {
  local candidate="$APPLY_LINK_STAGING"
  local identity="$APPLY_LINK_STAGING_IDENTITY"
  local current

  [[ -n "$candidate" && -n "$identity" ]] || return 0
  [[ "${candidate%/*}" == "$APPLY_MAPPED_OPT" ]] || return 0
  [[ "${candidate##*/}" =~ ^\.node-link-[0-9]+-[0-9]+-[0-9]+$ ]] || return 0
  [[ -L "$candidate" ]] || return 0
  current=$(apply_stat_identity "$candidate" no-follow) || return 0
  [[ "$current" == "$identity" ]] || return 0
  [[ "$(/usr/bin/readlink -- "$candidate" 2>/dev/null)" == "$APPLY_NODE_DIRECTORY" ]] ||
    return 0
  apply_run_quiet rm -f -- "$candidate" || return 1
  APPLY_LINK_STAGING=""
  APPLY_LINK_STAGING_IDENTITY=""
}

apply_remove_owned_directory() {
  local candidate="$1"
  local expected_parent="$2"
  local expected_pattern="$3"
  local identity="$4"
  local canonical
  local current

  [[ -n "$candidate" && -n "$identity" ]] || return 0
  [[ "${candidate%/*}" == "$expected_parent" ]] || return 0
  [[ "${candidate##*/}" =~ $expected_pattern ]] || return 0
  [[ -d "$candidate" && ! -L "$candidate" ]] || return 0
  canonical=$(/usr/bin/readlink -e -- "$candidate" 2>/dev/null) || return 0
  [[ "$canonical" == "$candidate" ]] || return 0
  current=$(apply_stat_identity "$candidate") || return 0
  [[ "$current" == "$identity" ]] || return 0
  [[ "$(/usr/bin/stat -Lc '%u:%a' -- "$candidate" 2>/dev/null)" == "0:700" ]] ||
    return 0
  apply_run_quiet rm -rf -- "$candidate" || return 1
}

apply_cleanup_owned() {
  local status=0

  apply_close_archive
  apply_remove_owned_link || status=1
  if [[ -n "$APPLY_PARTIAL_ROOT" ]]; then
    apply_remove_owned_directory \
      "$APPLY_PARTIAL_ROOT" \
      "$APPLY_MAPPED_OPT" \
      '^\.node-v24\.18\.0-linux-x64\.partial\.[A-Za-z0-9]+$' \
      "$APPLY_PARTIAL_ROOT_IDENTITY" || status=1
    if [[ ! -e "$APPLY_PARTIAL_ROOT" && ! -L "$APPLY_PARTIAL_ROOT" ]]; then
      APPLY_PARTIAL_ROOT=""
      APPLY_PARTIAL_ROOT_IDENTITY=""
    fi
  fi
  if [[ -n "$APPLY_WORK_ROOT" ]]; then
    apply_remove_owned_directory \
      "$APPLY_WORK_ROOT" \
      "$APPLY_MAPPED_VAR_TMP" \
      '^project-a-host-prep\.[A-Za-z0-9]+$' \
      "$APPLY_WORK_ROOT_IDENTITY" || status=1
    if [[ ! -e "$APPLY_WORK_ROOT" && ! -L "$APPLY_WORK_ROOT" ]]; then
      APPLY_WORK_ROOT=""
      APPLY_WORK_ROOT_IDENTITY=""
    fi
  fi
  return "$status"
}

apply_exit() {
  local status=$?
  trap - EXIT
  apply_cleanup_owned >/dev/null 2>&1 || status=1
  if (( APPLY_SUCCEEDED == 0 )); then
    printf 'Host preparation failed at step: %s.\n' "$APPLY_STEP" >&2
    (( status != 0 )) || status=1
  fi
  exit "$status"
}

apply_interrupt() {
  APPLY_STEP="interrupted"
  exit 1
}

trap apply_exit EXIT
trap apply_interrupt HUP INT TERM

apply_bootstrap_manifest_state() {
  local stage="$1"
  local relative_path
  local state=""
  local -a files=(
    "CHECKSUMS/PHASE-2-HOST-PREP.sha256"
    "ISOLATION-BOUNDARY.txt"
    "PHASE-2-INPUT.json"
    "README-FIRST.txt"
    "TO-DEBIAN/apply-host-prep.sh"
    "TO-DEBIAN/collect-host-prep-evidence.sh"
    "TO-DEBIAN/preflight-host-prep.sh"
  )

  for relative_path in "${files[@]}"; do
    [[ -f "$stage/$relative_path" && ! -L "$stage/$relative_path" ]] || return 1
    state+="$relative_path:"
    state+=$(
      /usr/bin/stat -Lc '%d:%i:%u:%g:%s:%Y:%Z:%f' -- "$stage/$relative_path" 2>/dev/null
    ) || return 1
    state+=$'\n'
  done
  printf '%s' "$state"
}

apply_bootstrap_verify_stage() {
  local stage="$1"
  local manifest="$stage/CHECKSUMS/PHASE-2-HOST-PREP.sha256"
  local relative_path
  local entry_type
  local expected_type
  local token_seen=0
  local malformed=0
  local line
  local line_count=0
  local before
  local after
  local fingerprint_before
  local fingerprint_after
  local -a pipeline_status=()
  local -a expected_manifest_files=(
    "ISOLATION-BOUNDARY.txt"
    "PHASE-2-INPUT.json"
    "README-FIRST.txt"
    "TO-DEBIAN/apply-host-prep.sh"
    "TO-DEBIAN/collect-host-prep-evidence.sh"
    "TO-DEBIAN/preflight-host-prep.sh"
  )
  local -A expected_layout=(
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

  [[ "$stage" == /* && "$stage" != "/" && ! "$stage" =~ [[:cntrl:]] ]] || return 1
  [[ -d "$stage" && ! -L "$stage" ]] || return 1
  if /usr/bin/find "$stage" -mindepth 1 -printf '%P\0%y\0' 2>/dev/null |
    while IFS= read -r -d '' relative_path; do
      if ! IFS= read -r -d '' entry_type; then
        malformed=1
        break
      fi
      if [[ "$relative_path" == ".host-prep-preflight-ok" ]]; then
        [[ "$entry_type" == "f" ]] || { malformed=1; break; }
        (( token_seen += 1 ))
        (( token_seen == 1 )) || { malformed=1; break; }
        continue
      fi
      expected_type="${expected_layout[$relative_path]-}"
      [[ -n "$expected_type" && "$entry_type" == "$expected_type" ]] || {
        malformed=1
        break
      }
      [[ -z "${seen[$relative_path]-}" ]] || { malformed=1; break; }
      seen["$relative_path"]=1
    done; then
    pipeline_status=("${PIPESTATUS[@]}")
  else
    pipeline_status=("${PIPESTATUS[@]}")
  fi
  (( pipeline_status[0] == 0 && pipeline_status[1] == 0 && malformed == 0 )) ||
    return 1
  for relative_path in "${!expected_layout[@]}"; do
    [[ -n "${seen[$relative_path]-}" ]] || return 1
  done

  before=$(apply_bootstrap_manifest_state "$stage") || return 1
  fingerprint_before=$(/usr/bin/sha256sum -- "$manifest" 2>/dev/null) || return 1
  fingerprint_before="${fingerprint_before%% *}"
  [[ "$fingerprint_before" =~ ^[0-9a-f]{64}$ ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    (( line_count += 1 ))
    (( line_count <= ${#expected_manifest_files[@]} )) || return 1
    [[ "$line" =~ ^[0-9a-f]{64}\ \ (.+)$ ]] || return 1
    [[ "${BASH_REMATCH[1]}" == "${expected_manifest_files[line_count - 1]}" ]] ||
      return 1
  done < "$manifest"
  (( line_count == ${#expected_manifest_files[@]} )) || return 1
  (
    cd -- "$stage"
    /usr/bin/sha256sum --check "CHECKSUMS/PHASE-2-HOST-PREP.sha256" >/dev/null 2>&1
  ) || return 1
  after=$(apply_bootstrap_manifest_state "$stage") || return 1
  [[ "$after" == "$before" ]] || return 1
  fingerprint_after=$(/usr/bin/sha256sum -- "$manifest" 2>/dev/null) || return 1
  fingerprint_after="${fingerprint_after%% *}"
  [[ "$fingerprint_after" == "$fingerprint_before" ]] || return 1
  APPLY_BOOTSTRAP_STAGE="$stage"
  APPLY_BOOTSTRAP_FINGERPRINT="$fingerprint_before"
}

apply_locate_preflight() {
  local script_source="${BASH_SOURCE[0]}"
  local lexical
  local canonical
  local to_debian
  local preflight
  local before

  [[ "$script_source" == /* ]] || script_source="$PWD/$script_source"
  lexical=$(/usr/bin/realpath -s -- "$script_source" 2>/dev/null) || return 1
  canonical=$(/usr/bin/readlink -e -- "$script_source" 2>/dev/null) || return 1
  [[ "$lexical" == "$canonical" ]] || return 1
  [[ -f "$canonical" && ! -L "$script_source" ]] || return 1
  [[ "${canonical##*/}" == "apply-host-prep.sh" ]] || return 1
  to_debian="${canonical%/*}"
  [[ "${to_debian##*/}" == "TO-DEBIAN" && -d "$to_debian" && ! -L "$to_debian" ]] ||
    return 1
  apply_bootstrap_verify_stage "${to_debian%/*}" || return 1
  preflight="$to_debian/preflight-host-prep.sh"
  [[ -f "$preflight" && ! -L "$preflight" ]] || return 1
  before=$(apply_stat_identity "$preflight") || return 1

  APPLY_SCRIPT_CANONICAL="$canonical"
  APPLY_PREFLIGHT="$preflight"
  APPLY_PREFLIGHT_IDENTITY="$before"
}

apply_recheck_trusted_sources() {
  local preflight_after
  local apply_after

  [[ -f "$APPLY_SCRIPT_CANONICAL" && ! -L "$APPLY_SCRIPT_CANONICAL" ]] || return 1
  [[ -f "$APPLY_PREFLIGHT" && ! -L "$APPLY_PREFLIGHT" ]] || return 1
  preflight_after=$(apply_stat_identity "$APPLY_PREFLIGHT") || return 1
  [[ "$preflight_after" == "$APPLY_PREFLIGHT_IDENTITY" ]] || return 1
  apply_after=$(/usr/bin/readlink -e -- "$APPLY_SCRIPT_CANONICAL" 2>/dev/null) || return 1
  [[ "$apply_after" == "$APPLY_SCRIPT_CANONICAL" ]]
}

apply_manifest_replay() {
  host_prep_manifest_fingerprint >/dev/null || return 1
  [[ "$HOST_PREP_STAGE_ROOT_RESULT" == "$APPLY_STAGE" ]] || return 1
  [[ "$HOST_PREP_MANIFEST_FINGERPRINT_RESULT" == "$APPLY_FINGERPRINT" ]] || return 1
  apply_recheck_trusted_sources
}

apply_classification_replay() {
  host_prep_classify >/dev/null || return 1
  [[ "$HOST_PREP_CLASSIFICATION_RESULT" == "$APPLY_INITIAL_CLASSIFICATION" ]]
}

apply_safety_replay() {
  host_prep_verify_safety_state || return 1
  [[ "$HOST_PREP_SAFETY_RESULT" == "safe" ]]
}

apply_validate_token() {
  local token="$APPLY_STAGE/$HOST_PREP_TOKEN_NAME"
  local stage_owner
  local before
  local after
  local now
  local classification
  local created
  local age
  local query

  [[ -f "$token" && ! -L "$token" ]] || return 1
  stage_owner=$(/usr/bin/stat -Lc '%u' -- "$APPLY_STAGE" 2>/dev/null) || return 1
  before=$(/usr/bin/stat -Lc '%d:%i:%u:%g:%a:%s:%f' -- "$token" 2>/dev/null) ||
    return 1
  [[ "$before" =~ ^[0-9]+:[0-9]+:([0-9]+):[0-9]+:600:[0-9]+:[0-9a-f]+$ ]] ||
    return 1
  [[ "${BASH_REMATCH[1]}" == "$stage_owner" ]] || return 1

  query='
    if (
      type == "object" and
      keys == [
        "classification",
        "createdAtEpoch",
        "manifestFingerprint",
        "phaseId",
        "schemaVersion",
        "stageRoot"
      ] and
      .schemaVersion == 1 and
      .phaseId == $phase_id and
      .manifestFingerprint == $fingerprint and
      .stageRoot == $stage and
      (.classification == "clean" or .classification == "already-prepared") and
      (.createdAtEpoch | type) == "number" and
      (.createdAtEpoch | floor) == .createdAtEpoch
    ) then
      [.classification, (.createdAtEpoch | tostring)] | @tsv
    else
      error("invalid")
    end
  '
  host_prep_run_observer_bounded 256 jq \
    -e -r \
    --arg phase_id "$APPLY_PHASE_ID" \
    --arg fingerprint "$APPLY_FINGERPRINT" \
    --arg stage "$APPLY_STAGE" \
    "$query" \
    "$token" || return 1
  [[ "$HOST_PREP_BOUNDED_STATUS" -eq 0 &&
    "$HOST_PREP_BOUNDED_OUTPUT" == *$'\n' ]] || return 1
  after=$(/usr/bin/stat -Lc '%d:%i:%u:%g:%a:%s:%f' -- "$token" 2>/dev/null) ||
    return 1
  [[ "$after" == "$before" ]] || return 1

  IFS=$'\t' read -r classification created <<< "${HOST_PREP_BOUNDED_OUTPUT%$'\n'}"
  [[ "$classification" == "clean" || "$classification" == "already-prepared" ]] ||
    return 1
  [[ "$created" =~ ^[0-9]+$ && ${#created} -le 10 ]] || return 1
  now=$(/usr/bin/date +%s 2>/dev/null) || return 1
  [[ "$now" =~ ^[0-9]+$ ]] || return 1
  (( created <= now )) || return 1
  age=$((now - created))
  (( age >= 0 && age <= APPLY_TOKEN_MAX_AGE_SECONDS )) || return 1
  APPLY_TOKEN_CLASSIFICATION="$classification"
}

apply_map_owned_paths() {
  local candidate
  local canonical
  local metadata

  host_prep_system_path "/var/tmp" >/dev/null || return 1
  APPLY_MAPPED_VAR_TMP="$HOST_PREP_MAPPED_PATH"
  host_prep_system_path "/opt" >/dev/null || return 1
  APPLY_MAPPED_OPT="$HOST_PREP_MAPPED_PATH"
  host_prep_system_path "$APPLY_NODE_DIRECTORY" >/dev/null || return 1
  APPLY_MAPPED_NODE_DIRECTORY="$HOST_PREP_MAPPED_PATH"
  host_prep_system_path "$APPLY_NODE_LINK" 1 >/dev/null || return 1
  APPLY_MAPPED_NODE_LINK="$HOST_PREP_MAPPED_PATH"
  host_prep_system_path "/opt/palziv" >/dev/null || return 1
  APPLY_MAPPED_OPT_PALZIV="$HOST_PREP_MAPPED_PATH"
  host_prep_system_path "/opt/palziv/releases" >/dev/null || return 1
  APPLY_MAPPED_OPT_RELEASES="$HOST_PREP_MAPPED_PATH"
  host_prep_system_path "/var/lib/palziv" >/dev/null || return 1
  APPLY_MAPPED_VAR_LIB_PALZIV="$HOST_PREP_MAPPED_PATH"
  host_prep_system_path "/var/lib/palziv/data" >/dev/null || return 1
  APPLY_MAPPED_VAR_LIB_DATA="$HOST_PREP_MAPPED_PATH"
  host_prep_system_path "/var/backups/palziv" >/dev/null || return 1
  APPLY_MAPPED_VAR_BACKUPS="$HOST_PREP_MAPPED_PATH"
  host_prep_system_path "/etc/palziv" >/dev/null || return 1
  APPLY_MAPPED_ETC_PALZIV="$HOST_PREP_MAPPED_PATH"

  for candidate in \
    "$APPLY_MAPPED_OPT" \
    "${APPLY_MAPPED_VAR_TMP%/tmp}" \
    "${APPLY_MAPPED_VAR_LIB_PALZIV%/palziv}" \
    "${APPLY_MAPPED_VAR_BACKUPS%/palziv}" \
    "${APPLY_MAPPED_ETC_PALZIV%/palziv}" \
    "$APPLY_MAPPED_VAR_TMP"; do
    [[ -d "$candidate" && ! -L "$candidate" ]] || return 1
    canonical=$(/usr/bin/readlink -e -- "$candidate" 2>/dev/null) || return 1
    [[ "$canonical" == "$candidate" ]] || return 1
    metadata=$(/usr/bin/stat -Lc '%u:%g:%a' -- "$candidate" 2>/dev/null) || return 1
    if [[ "$candidate" == "$APPLY_MAPPED_VAR_TMP" ]]; then
      if (( HOST_PREP_TEST_MODE == 1 )); then
        [[ "$metadata" == "0:0:755" ]] || return 1
      else
        [[ "$metadata" == "0:0:1777" ]] || return 1
      fi
    else
      [[ "$metadata" == "0:0:755" ]] || return 1
    fi
  done
  [[ ! -e "$APPLY_MAPPED_NODE_DIRECTORY" && ! -L "$APPLY_MAPPED_NODE_DIRECTORY" ]] ||
    return 1
  [[ ! -e "$APPLY_MAPPED_NODE_LINK" && ! -L "$APPLY_MAPPED_NODE_LINK" ]] || return 1
}

apply_capture_owned_directory() {
  local candidate="$1"
  local expected_parent="$2"
  local expected_pattern="$3"
  local canonical
  local identity

  [[ "${candidate%/*}" == "$expected_parent" ]] || return 1
  [[ "${candidate##*/}" =~ $expected_pattern ]] || return 1
  [[ -d "$candidate" && ! -L "$candidate" ]] || return 1
  canonical=$(/usr/bin/readlink -e -- "$candidate" 2>/dev/null) || return 1
  [[ "$canonical" == "$candidate" ]] || return 1
  [[ "$(/usr/bin/stat -Lc '%u:%g:%a' -- "$candidate" 2>/dev/null)" == "0:0:700" ]] ||
    return 1
  identity=$(apply_stat_identity "$candidate") || return 1
  APPLY_CAPTURED_OUTPUT="$identity"
}

apply_create_work_root() {
  apply_run_bounded 4096 mktemp \
    -d "$APPLY_MAPPED_VAR_TMP/project-a-host-prep.XXXXXXXX" || return 1
  [[ "$APPLY_CAPTURED_STATUS" -eq 0 &&
    "$APPLY_CAPTURED_OUTPUT" == *$'\n' ]] || return 1
  APPLY_WORK_ROOT="${APPLY_CAPTURED_OUTPUT%$'\n'}"
  [[ "$APPLY_WORK_ROOT" != *$'\n'* ]] || return 1
  apply_capture_owned_directory \
    "$APPLY_WORK_ROOT" \
    "$APPLY_MAPPED_VAR_TMP" \
    '^project-a-host-prep\.[A-Za-z0-9]+$' || return 1
  APPLY_WORK_ROOT_IDENTITY="$APPLY_CAPTURED_OUTPUT"
}

apply_archive_path_matches_fd() {
  local archive_path="$APPLY_WORK_ROOT/$APPLY_NODE_ARCHIVE"
  local path_identity
  local fd_identity

  [[ -n "$APPLY_ARCHIVE_FD" ]] || return 1
  path_identity=$(apply_stat_identity "$archive_path") || return 1
  fd_identity=$(apply_stat_identity "/proc/$$/fd/$APPLY_ARCHIVE_FD") || return 1
  [[ "$path_identity" == "$APPLY_ARCHIVE_IDENTITY" &&
    "$fd_identity" == "$APPLY_ARCHIVE_IDENTITY" ]]
}

apply_archive_name_is_safe() {
  local name="$1"
  local component
  local -a components=()

  [[ -n "$name" && "$name" != /* ]] || return 1
  [[ ! "$name" =~ [[:cntrl:]] && "$name" != *\\* && "$name" != *[[:space:]]* ]] ||
    return 1
  IFS='/' read -r -a components <<< "$name"
  (( ${#components[@]} >= 1 )) || return 1
  [[ "${components[0]}" == "${APPLY_NODE_ARCHIVE%.tar.xz}" ]] || return 1
  for component in "${components[@]}"; do
    [[ -n "$component" && "$component" != "." && "$component" != ".." ]] || return 1
    [[ "$component" =~ ^[A-Za-z0-9._+@%=-]+$ ]] || return 1
  done
}

apply_symlink_target_is_safe() {
  local name="$1"
  local target="$2"
  local base
  local component
  local -a components=()
  local -a stack=()

  [[ -n "$target" && "$target" != /* ]] || return 1
  [[ ! "$target" =~ [[:cntrl:]] && "$target" != *\\* && "$target" != *[[:space:]]* ]] ||
    return 1
  base="${name%/*}"
  IFS='/' read -r -a components <<< "$base/$target"
  for component in "${components[@]}"; do
    case "$component" in
      ""|.) ;;
      ..)
        (( ${#stack[@]} > 1 )) || return 1
        unset 'stack[${#stack[@]}-1]'
        ;;
      *)
        [[ "$component" =~ ^[A-Za-z0-9._+@%=-]+$ ]] || return 1
        stack+=("$component")
        ;;
    esac
  done
  (( ${#stack[@]} >= 1 )) || return 1
  [[ "${stack[0]}" == "${APPLY_NODE_ARCHIVE%.tar.xz}" ]]
}

apply_validate_archive_record() {
  local line="$1"
  local mode
  local type
  local remainder
  local name
  local target=""
  local normalized

  (( ${#line} > 0 && ${#line} <= APPLY_MAX_ARCHIVE_LINE )) || return 1
  [[ "$line" =~ ^([bcdhlps-][rwxStTs-]{9})[[:space:]]+([0-9]+)/([0-9]+)[[:space:]]+([0-9]+)[[:space:]]+[0-9]{4}-[0-9]{2}-[0-9]{2}[[:space:]]+[0-9]{2}:[0-9]{2}:[0-9]{2}[[:space:]]+(.+)$ ]] ||
    return 1
  mode="${BASH_REMATCH[1]}"
  type="${mode:0:1}"
  remainder="${BASH_REMATCH[5]}"
  case "$type" in
    d|-)
      name="$remainder"
      ;;
    l)
      [[ "$remainder" == *" -> "* ]] || return 1
      name="${remainder%% -> *}"
      target="${remainder#* -> }"
      ;;
    h)
      return 1
      ;;
    *)
      return 1
      ;;
  esac

  if [[ "$type" == "d" ]]; then
    [[ "$name" == */ ]] || return 1
    normalized="${name%/}"
  else
    [[ "$name" != */ ]] || return 1
    normalized="$name"
  fi
  apply_archive_name_is_safe "$normalized" || return 1
  [[ -z "${APPLY_ARCHIVE_SEEN[$normalized]+set}" ]] || return 1
  APPLY_ARCHIVE_SEEN["$normalized"]="$type"
  if [[ "$type" == "l" ]]; then
    apply_symlink_target_is_safe "$normalized" "$target" || return 1
  fi

  (( APPLY_ARCHIVE_ENTRY_COUNT += 1 ))
  (( APPLY_ARCHIVE_ENTRY_COUNT <= APPLY_MAX_ARCHIVE_ENTRIES )) || return 1
  case "$normalized:$type" in
    "node-v24.18.0-linux-x64:d") APPLY_ARCHIVE_HAS_ROOT=1 ;;
    "node-v24.18.0-linux-x64/bin:d") APPLY_ARCHIVE_HAS_BIN=1 ;;
    "node-v24.18.0-linux-x64/bin/node:-") APPLY_ARCHIVE_HAS_NODE=1 ;;
    "node-v24.18.0-linux-x64/bin/$APPLY_PACKAGE_EXECUTABLE_NAME:l"|"node-v24.18.0-linux-x64/bin/$APPLY_PACKAGE_EXECUTABLE_NAME:-")
      APPLY_ARCHIVE_HAS_PACKAGE_EXECUTABLE=1
      ;;
  esac
}

apply_inspect_archive() {
  local command_path
  local command_identity
  local line
  local -a pipeline_status=()

  APPLY_ARCHIVE_ENTRY_COUNT=0
  APPLY_ARCHIVE_RECORD_INVALID=0
  APPLY_ARCHIVE_HAS_ROOT=0
  APPLY_ARCHIVE_HAS_BIN=0
  APPLY_ARCHIVE_HAS_NODE=0
  APPLY_ARCHIVE_HAS_PACKAGE_EXECUTABLE=0
  APPLY_ARCHIVE_SEEN=()
  apply_resolve_mutator tar || return 1
  command_path="$APPLY_COMMAND_PATH"
  command_identity="$APPLY_COMMAND_IDENTITY"
  if "$command_path" \
    --list \
    --verbose \
    --numeric-owner \
    --full-time \
    --quoting-style=escape \
    --file="/proc/$$/fd/$APPLY_ARCHIVE_FD" 2>/dev/null |
    while IFS= read -r line; do
      if ! apply_validate_archive_record "$line"; then
        APPLY_ARCHIVE_RECORD_INVALID=1
        break
      fi
    done; then
    pipeline_status=("${PIPESTATUS[@]}")
  else
    pipeline_status=("${PIPESTATUS[@]}")
  fi
  apply_recheck_mutator "$command_path" "$command_identity" || return 1
  (( pipeline_status[0] == 0 &&
    pipeline_status[1] == 0 &&
    APPLY_ARCHIVE_RECORD_INVALID == 0 &&
    APPLY_ARCHIVE_ENTRY_COUNT > 0 &&
    APPLY_ARCHIVE_HAS_ROOT == 1 &&
    APPLY_ARCHIVE_HAS_BIN == 1 &&
    APPLY_ARCHIVE_HAS_NODE == 1 &&
    APPLY_ARCHIVE_HAS_PACKAGE_EXECUTABLE == 1 ))
}

apply_validate_extracted_tree() {
  local tree="$1"
  local expected
  local node_path="$tree/bin/node"
  local package_path="$tree/bin/$APPLY_PACKAGE_EXECUTABLE_NAME"
  local resolved
  local entry
  local entry_type
  local owner
  local group
  local mode
  local invalid=0
  local count=0
  local -a pipeline_status=()

  expected="$APPLY_PARTIAL_ROOT/${APPLY_NODE_ARCHIVE%.tar.xz}"
  [[ "$tree" == "$expected" && -d "$tree" && ! -L "$tree" ]] || return 1
  resolved=$(/usr/bin/readlink -e -- "$tree" 2>/dev/null) || return 1
  [[ "$resolved" == "$tree" ]] || return 1
  [[ "$(apply_stat_identity "$tree")" == "$APPLY_CAPTURED_OUTPUT" ]] || return 1

  if /usr/bin/find "$tree" -xdev -printf '%p\0%y\0%U\0%G\0%m\0' 2>/dev/null |
    while IFS= read -r -d '' entry; do
      IFS= read -r -d '' entry_type || { invalid=1; break; }
      IFS= read -r -d '' owner || { invalid=1; break; }
      IFS= read -r -d '' group || { invalid=1; break; }
      IFS= read -r -d '' mode || { invalid=1; break; }
      (( count += 1 ))
      (( count <= APPLY_MAX_ARCHIVE_ENTRIES )) || { invalid=1; break; }
      [[ "$entry" == "$tree" || "$entry" == "$tree/"* ]] || { invalid=1; break; }
      [[ "$owner" == "0" && "$group" == "0" ]] || { invalid=1; break; }
      case "$entry_type" in
        d|f)
          [[ "$mode" =~ ^[0-7]{3,4}$ ]] || { invalid=1; break; }
          if (( (8#$mode & 07022) != 0 )); then
            invalid=1
            break
          fi
          ;;
        l)
          resolved=$(/usr/bin/readlink -e -- "$entry" 2>/dev/null) || {
            invalid=1
            break
          }
          [[ "$resolved" == "$tree" || "$resolved" == "$tree/"* ]] || {
            invalid=1
            break
          }
          ;;
        *)
          invalid=1
          break
          ;;
      esac
    done; then
    pipeline_status=("${PIPESTATUS[@]}")
  else
    pipeline_status=("${PIPESTATUS[@]}")
  fi
  (( pipeline_status[0] == 0 && pipeline_status[1] == 0 && invalid == 0 )) ||
    return 1

  [[ "$(/usr/bin/stat -Lc '%u:%g:%a:%F' -- "$tree" 2>/dev/null)" == "0:0:755:directory" ]] ||
    return 1
  [[ "$(/usr/bin/stat -Lc '%u:%g:%a:%F' -- "$tree/bin" 2>/dev/null)" == "0:0:755:directory" ]] ||
    return 1
  [[ "$(/usr/bin/stat -Lc '%u:%g:%a:%F' -- "$node_path" 2>/dev/null)" == "0:0:755:regular file" ]] ||
    return 1
  resolved=$(/usr/bin/readlink -e -- "$package_path" 2>/dev/null) || return 1
  [[ "$resolved" == "$tree/"* && -f "$resolved" && -x "$resolved" && ! -L "$resolved" ]] ||
    return 1
}

apply_observe_runtime() {
  local executable="$1"
  local expected="$2"
  local kind="$3"
  local resolved
  local before
  local after
  local value

  resolved=$(/usr/bin/readlink -e -- "$executable" 2>/dev/null) || return 1
  [[ -f "$resolved" && ! -L "$resolved" && -x "$resolved" ]] || return 1
  before=$(apply_stat_identity "$resolved") || return 1
  host_prep_run_path_bounded 64 "$resolved" --version || return 1
  [[ "$HOST_PREP_BOUNDED_STATUS" -eq 0 &&
    "$HOST_PREP_BOUNDED_OUTPUT" == *$'\n' ]] || return 1
  after=$(apply_stat_identity "$resolved") || return 1
  [[ "$before" == "$after" ]] || return 1
  value="${HOST_PREP_BOUNDED_OUTPUT%$'\n'}"
  [[ "$value" != *$'\n'* ]] || return 1
  if [[ "$kind" == "node" ]]; then
    [[ "$value" == "$expected" ]]
  else
    [[ "$value" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
  fi
}

apply_publish_node() {
  local source="$APPLY_PARTIAL_ROOT/${APPLY_NODE_ARCHIVE%.tar.xz}"
  local source_identity
  local target_identity
  local link_identity
  local link_target

  [[ ! -e "$APPLY_MAPPED_NODE_DIRECTORY" && ! -L "$APPLY_MAPPED_NODE_DIRECTORY" ]] ||
    return 1
  source_identity=$(apply_stat_identity "$source") || return 1
  apply_run_quiet mv -T -n -- "$source" "$APPLY_MAPPED_NODE_DIRECTORY" || return 1
  [[ ! -e "$source" && ! -L "$source" ]] || return 1
  [[ -d "$APPLY_MAPPED_NODE_DIRECTORY" && ! -L "$APPLY_MAPPED_NODE_DIRECTORY" ]] ||
    return 1
  target_identity=$(apply_stat_identity "$APPLY_MAPPED_NODE_DIRECTORY") || return 1
  [[ "$target_identity" == "$source_identity" ]] || return 1

  APPLY_LINK_STAGING="$APPLY_MAPPED_OPT/.node-link-$$-$RANDOM-$RANDOM"
  [[ "${APPLY_LINK_STAGING##*/}" =~ ^\.node-link-[0-9]+-[0-9]+-[0-9]+$ ]] ||
    return 1
  [[ ! -e "$APPLY_LINK_STAGING" && ! -L "$APPLY_LINK_STAGING" ]] || return 1
  apply_run_quiet ln -s -- "$APPLY_NODE_DIRECTORY" "$APPLY_LINK_STAGING" || return 1
  [[ -L "$APPLY_LINK_STAGING" ]] || return 1
  link_target=$(/usr/bin/readlink -- "$APPLY_LINK_STAGING" 2>/dev/null) || return 1
  [[ "$link_target" == "$APPLY_NODE_DIRECTORY" ]] || return 1
  APPLY_LINK_STAGING_IDENTITY=$(apply_stat_identity "$APPLY_LINK_STAGING" no-follow) ||
    return 1
  [[ "$APPLY_LINK_STAGING_IDENTITY" == *":0:0:"* ]] || return 1

  [[ ! -e "$APPLY_MAPPED_NODE_LINK" && ! -L "$APPLY_MAPPED_NODE_LINK" ]] || return 1
  apply_run_quiet mv -T -n -- "$APPLY_LINK_STAGING" "$APPLY_MAPPED_NODE_LINK" || return 1
  [[ ! -e "$APPLY_LINK_STAGING" && ! -L "$APPLY_LINK_STAGING" ]] || return 1
  [[ -L "$APPLY_MAPPED_NODE_LINK" ]] || return 1
  link_identity=$(apply_stat_identity "$APPLY_MAPPED_NODE_LINK" no-follow) || return 1
  [[ "$link_identity" == "$APPLY_LINK_STAGING_IDENTITY" ]] || return 1
  link_target=$(/usr/bin/readlink -- "$APPLY_MAPPED_NODE_LINK" 2>/dev/null) || return 1
  [[ "$link_target" == "$APPLY_NODE_DIRECTORY" ]] || return 1
  APPLY_LINK_STAGING=""
  APPLY_LINK_STAGING_IDENTITY=""
}

apply_final_trust_epoch() {
  local bash_identity_before
  local bash_identity_after
  local env_identity_before
  local env_identity_after
  local preflight_before
  local preflight_after
  local -a child_environment=(
    -i
    "HOME=/root"
    "PATH=$APPLY_SAFE_PATH"
  )
  local final_code

  final_code='
    set -Eeuo pipefail
    shopt -s lastpipe
    preflight_path="$1"
    expected_stage="$2"
    expected_fingerprint="$3"
    . "$preflight_path"
    host_prep_stage_root >/dev/null
    [[ "$HOST_PREP_STAGE_ROOT_RESULT" == "$expected_stage" ]]
    host_prep_manifest_fingerprint >/dev/null
    [[ "$HOST_PREP_STAGE_ROOT_RESULT" == "$expected_stage" ]]
    [[ "$HOST_PREP_MANIFEST_FINGERPRINT_RESULT" == "$expected_fingerprint" ]]
    host_prep_classify >/dev/null
    [[ "$HOST_PREP_CLASSIFICATION_RESULT" == "already-prepared" ]]
    host_prep_verify_safety_state
    [[ "$HOST_PREP_SAFETY_RESULT" == "safe" ]]
    host_prep_classify >/dev/null
    [[ "$HOST_PREP_CLASSIFICATION_RESULT" == "already-prepared" ]]
    host_prep_verify_safety_state
    [[ "$HOST_PREP_SAFETY_RESULT" == "safe" ]]
    host_prep_manifest_fingerprint >/dev/null
    [[ "$HOST_PREP_STAGE_ROOT_RESULT" == "$expected_stage" ]]
    [[ "$HOST_PREP_MANIFEST_FINGERPRINT_RESULT" == "$expected_fingerprint" ]]
  '

  if (( HOST_PREP_TEST_MODE == 1 )); then
    host_prep_revalidate_fixture_boundaries || return 1
    child_environment+=(
      "PALZIV_HOST_PREP_TEST_MODE=1"
      "PALZIV_HOST_PREP_TEST_ROOT=$HOST_PREP_SYSTEM_ROOT"
      "PALZIV_HOST_PREP_TEST_BIN=$HOST_PREP_TEST_COMMAND_BIN"
    )
  fi
  [[ -f "/bin/bash" && ! -L "/bin/bash" && -x "/bin/bash" ]] || return 1
  [[ -f "/usr/bin/env" && ! -L "/usr/bin/env" && -x "/usr/bin/env" ]] || return 1
  bash_identity_before=$(apply_stat_identity "/bin/bash") || return 1
  env_identity_before=$(apply_stat_identity "/usr/bin/env") || return 1
  preflight_before=$(apply_stat_identity "$APPLY_PREFLIGHT") || return 1
  [[ "$preflight_before" == "$APPLY_PREFLIGHT_IDENTITY" ]] || return 1

  /usr/bin/env "${child_environment[@]}" \
    /bin/bash -p -c "$final_code" \
    bash \
    "$APPLY_PREFLIGHT" \
    "$APPLY_STAGE" \
    "$APPLY_FINGERPRINT" >/dev/null 2>&1 || return 1

  bash_identity_after=$(apply_stat_identity "/bin/bash") || return 1
  env_identity_after=$(apply_stat_identity "/usr/bin/env") || return 1
  preflight_after=$(apply_stat_identity "$APPLY_PREFLIGHT") || return 1
  [[ "$bash_identity_after" == "$bash_identity_before" &&
    "$env_identity_after" == "$env_identity_before" &&
    "$preflight_after" == "$preflight_before" ]]
}

apply_main() {
  local first_classification
  local second_classification
  local archive_path
  local archive_output
  local expected_archive_output
  local extracted_tree
  local production_node
  local production_package_executable

  host_prep_initialize_environment || return 1
  host_prep_stage_root >/dev/null || return 1
  APPLY_STAGE="$HOST_PREP_STAGE_ROOT_RESULT"
  [[ "$APPLY_STAGE" == "$APPLY_BOOTSTRAP_STAGE" ]] || return 1
  [[ "$APPLY_SCRIPT_CANONICAL" == "$APPLY_STAGE/TO-DEBIAN/apply-host-prep.sh" ]] ||
    return 1
  [[ "$APPLY_PREFLIGHT" == "$APPLY_STAGE/TO-DEBIAN/preflight-host-prep.sh" ]] ||
    return 1

  APPLY_STEP="manifest"
  host_prep_manifest_fingerprint >/dev/null || return 1
  [[ "$HOST_PREP_STAGE_ROOT_RESULT" == "$APPLY_STAGE" ]] || return 1
  APPLY_FINGERPRINT="$HOST_PREP_MANIFEST_FINGERPRINT_RESULT"
  [[ "$APPLY_FINGERPRINT" == "$APPLY_BOOTSTRAP_FINGERPRINT" ]] || return 1

  APPLY_STEP="token"
  apply_validate_token || return 1

  APPLY_STEP="stable-classification"
  host_prep_classify >/dev/null || return 1
  first_classification="$HOST_PREP_CLASSIFICATION_RESULT"
  [[ "$first_classification" == "clean" || "$first_classification" == "already-prepared" ]] ||
    return 1
  APPLY_INITIAL_CLASSIFICATION="$first_classification"
  [[ "$APPLY_TOKEN_CLASSIFICATION" == "$APPLY_INITIAL_CLASSIFICATION" ]] || return 1

  APPLY_STEP="stable-safety"
  apply_safety_replay || return 1
  APPLY_STEP="stable-classification"
  apply_classification_replay || return 1
  second_classification="$HOST_PREP_CLASSIFICATION_RESULT"
  [[ "$second_classification" == "$first_classification" ]] || return 1
  APPLY_STEP="stable-safety"
  apply_safety_replay || return 1
  APPLY_STEP="stable-manifest"
  apply_manifest_replay || return 1

  if [[ "$APPLY_INITIAL_CLASSIFICATION" == "already-prepared" ]]; then
    APPLY_SUCCEEDED=1
    printf '{"ok":true,"phaseId":"%s","classification":"already-prepared","changed":false}\n' \
      "$APPLY_PHASE_ID"
    return 0
  fi

  APPLY_STEP="owned-paths"
  apply_map_owned_paths || return 1
  APPLY_STEP="immediate-classification"
  apply_classification_replay || return 1
  APPLY_STEP="immediate-safety"
  apply_safety_replay || return 1
  APPLY_STEP="immediate-manifest"
  apply_manifest_replay || return 1
  apply_recheck_trusted_sources || return 1

  APPLY_STEP="work-root"
  apply_create_work_root || return 1

  APPLY_STEP="package-index"
  apply_run_quiet apt-get update || return 1
  APPLY_STEP="packages"
  apply_run_quiet_noninteractive apt-get \
    install -y --no-install-recommends \
    ca-certificates curl git jq rsync tar xz-utils || return 1

  archive_path="$APPLY_WORK_ROOT/$APPLY_NODE_ARCHIVE"
  [[ ! -e "$archive_path" && ! -L "$archive_path" ]] || return 1
  APPLY_STEP="download"
  apply_run_quiet curl \
    --disable \
    --fail \
    --silent \
    --show-error \
    --location \
    --noproxy '*' \
    --proto '=https' \
    --proto-redir '=https' \
    "$APPLY_NODE_ARCHIVE_URL" \
    --output "$archive_path" || return 1
  [[ -f "$archive_path" && ! -L "$archive_path" ]] || return 1
  [[ "$(/usr/bin/stat -Lc '%u:%g:%a' -- "$archive_path" 2>/dev/null)" == "0:0:600" ]] ||
    return 1
  APPLY_ARCHIVE_IDENTITY=$(apply_stat_identity "$archive_path") || return 1
  exec {APPLY_ARCHIVE_FD}< "$archive_path" || return 1
  apply_archive_path_matches_fd || return 1

  APPLY_STEP="archive-hash"
  apply_run_bounded 4096 sha256sum "/proc/$$/fd/$APPLY_ARCHIVE_FD" || return 1
  [[ "$APPLY_CAPTURED_STATUS" -eq 0 ]] || return 1
  archive_output="$APPLY_CAPTURED_OUTPUT"
  expected_archive_output="$APPLY_NODE_ARCHIVE_SHA256  /proc/$$/fd/$APPLY_ARCHIVE_FD"$'\n'
  [[ "$archive_output" == "$expected_archive_output" ]] || return 1
  apply_archive_path_matches_fd || return 1

  APPLY_STEP="archive-inspection"
  apply_inspect_archive || return 1
  APPLY_STEP="archive-race"
  apply_archive_path_matches_fd || return 1

  APPLY_STEP="extraction-root"
  apply_run_bounded 4096 mktemp \
    -d "$APPLY_MAPPED_OPT/.node-v24.18.0-linux-x64.partial.XXXXXXXX" || return 1
  [[ "$APPLY_CAPTURED_STATUS" -eq 0 &&
    "$APPLY_CAPTURED_OUTPUT" == *$'\n' ]] || return 1
  APPLY_PARTIAL_ROOT="${APPLY_CAPTURED_OUTPUT%$'\n'}"
  [[ "$APPLY_PARTIAL_ROOT" != *$'\n'* ]] || return 1
  apply_capture_owned_directory \
    "$APPLY_PARTIAL_ROOT" \
    "$APPLY_MAPPED_OPT" \
    '^\.node-v24\.18\.0-linux-x64\.partial\.[A-Za-z0-9]+$' || return 1
  APPLY_PARTIAL_ROOT_IDENTITY="$APPLY_CAPTURED_OUTPUT"

  APPLY_STEP="archive-extraction"
  apply_archive_path_matches_fd || return 1
  umask 022
  if ! apply_run_quiet tar \
    --extract \
    --file="/proc/$$/fd/$APPLY_ARCHIVE_FD" \
    --directory="$APPLY_PARTIAL_ROOT" \
    --no-same-owner \
    --no-same-permissions \
    --delay-directory-restore; then
    umask 077
    return 1
  fi
  umask 077
  apply_archive_path_matches_fd || return 1
  apply_close_archive

  extracted_tree="$APPLY_PARTIAL_ROOT/${APPLY_NODE_ARCHIVE%.tar.xz}"
  APPLY_CAPTURED_OUTPUT=$(apply_stat_identity "$extracted_tree") || return 1
  APPLY_STEP="extracted-tree"
  apply_validate_extracted_tree "$extracted_tree" || return 1
  APPLY_STEP="runtime-validation"
  apply_observe_runtime "$extracted_tree/bin/node" "$APPLY_NODE_VERSION" node || return 1
  apply_observe_runtime \
    "$extracted_tree/bin/$APPLY_PACKAGE_EXECUTABLE_NAME" "" package || return 1

  APPLY_STEP="group"
  apply_run_quiet addgroup --system palziv || return 1
  APPLY_STEP="account"
  apply_run_quiet adduser \
    --system \
    --ingroup palziv \
    --home /var/lib/palziv \
    --no-create-home \
    --shell /usr/sbin/nologin \
    palziv || return 1

  APPLY_STEP="directory-opt"
  apply_run_quiet install -d -o root -g palziv -m 0750 -- "$APPLY_MAPPED_OPT_PALZIV" ||
    return 1
  APPLY_STEP="directory-releases"
  apply_run_quiet install -d -o root -g palziv -m 0750 -- "$APPLY_MAPPED_OPT_RELEASES" ||
    return 1
  APPLY_STEP="directory-state"
  apply_run_quiet install -d -o palziv -g palziv -m 0700 -- "$APPLY_MAPPED_VAR_LIB_PALZIV" ||
    return 1
  APPLY_STEP="directory-data"
  apply_run_quiet install -d -o palziv -g palziv -m 0700 -- "$APPLY_MAPPED_VAR_LIB_DATA" ||
    return 1
  APPLY_STEP="directory-backups"
  apply_run_quiet install -d -o root -g palziv -m 0750 -- "$APPLY_MAPPED_VAR_BACKUPS" ||
    return 1
  APPLY_STEP="directory-config"
  apply_run_quiet install -d -o root -g palziv -m 0750 -- "$APPLY_MAPPED_ETC_PALZIV" ||
    return 1

  APPLY_STEP="node-publication"
  apply_publish_node || return 1

  if (( HOST_PREP_TEST_MODE == 1 )); then
    production_node="$APPLY_MAPPED_NODE_DIRECTORY/bin/node"
    production_package_executable="$APPLY_MAPPED_NODE_DIRECTORY/bin/$APPLY_PACKAGE_EXECUTABLE_NAME"
  else
    production_node="/opt/node/bin/node"
    production_package_executable="/opt/node/bin/$APPLY_PACKAGE_EXECUTABLE_NAME"
  fi
  APPLY_STEP="runtime-observation"
  apply_observe_runtime "$production_node" "$APPLY_NODE_VERSION" node || return 1
  apply_observe_runtime "$production_package_executable" "" package || return 1

  APPLY_STEP="temporary-cleanup"
  apply_cleanup_owned || return 1
  APPLY_STEP="final-manifest"
  apply_manifest_replay || return 1
  APPLY_STEP="final-state"
  apply_final_trust_epoch || return 1

  APPLY_SUCCEEDED=1
  printf '{"ok":true,"phaseId":"%s","classification":"prepared","changed":true}\n' \
    "$APPLY_PHASE_ID"
}

APPLY_STEP="privileged-mode"
[[ "$-" == *p* ]] || exit 1
APPLY_STEP="root"
(( EUID == 0 )) || exit 1
APPLY_STEP="arguments"
(( $# == 1 )) && [[ "$1" == "--apply" ]] || exit 1
APPLY_STEP="stage-path"
apply_locate_preflight || exit 1
. "$APPLY_PREFLIGHT" >/dev/null 2>&1 || exit 1
[[ "$(apply_stat_identity "$APPLY_PREFLIGHT")" == "$APPLY_PREFLIGHT_IDENTITY" ]] || exit 1

apply_main "$@"
