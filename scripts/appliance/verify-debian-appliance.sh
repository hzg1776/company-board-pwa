#!/usr/bin/env bash
set -Eeuo pipefail

readonly MAX_RECEIPT_BYTES=16384
readonly ORIGIN='http://127.0.0.1:3116'
readonly -a ROUTES=(
  '/api/health'
  '/palzivalerts/'
  '/palzivalerts/employee'
  '/palzivalerts/hr'
  '/palzivalerts/webmaster'
  '/palzivalerts/it'
  '/sw.js'
  '/manifest.webmanifest'
)

RECEIPT_ROOT=''
PUBLISHING=0

report_error() {
  local rc=$?
  trap - ERR
  if [[ "$PUBLISHING" -eq 1 && -n "$RECEIPT_ROOT" ]]; then
    rm -f -- \
      "$RECEIPT_ROOT/VERIFY-LOCAL.json.partial" \
      "$RECEIPT_ROOT/STAGE-SUCCESS.json.partial" \
      "$RECEIPT_ROOT/STAGE-SUCCESS.sha256.partial" \
      "$RECEIPT_ROOT/age-recipient.txt.partial" 2>/dev/null || true
  fi
  printf '%s\n' 'Appliance verification failed.' >&2
  exit "$rc"
}
trap report_error ERR

require_real_path() {
  local candidate="$1"
  [[ -e "$candidate" && ! -L "$candidate" ]]
  [[ "$(realpath -e -- "$candidate")" == "$candidate" ]]
}

assert_stat() {
  local candidate="$1" expected="$2"
  require_real_path "$candidate"
  [[ "$(stat -Lc '%U:%G:%a' -- "$candidate")" == "$expected" ]]
}

is_bounded_metadata() {
  local candidate="$1" bytes
  [[ -f "$candidate" && ! -L "$candidate" ]]
  bytes="$(wc -c < "$candidate")"
  [[ "$bytes" -ge 2 && "$bytes" -le "$MAX_RECEIPT_BYTES" ]]
  ! LC_ALL=C grep -q $'[\001-\010\013\014\016-\037\177]' "$candidate"
}

cloudflared_is_disabled() {
  if systemctl is-enabled --quiet cloudflared.service; then
    return 1
  fi
}

cloudflared_is_inactive() {
  if systemctl is-active --quiet cloudflared.service; then
    return 1
  fi
}

[[ "$EUID" -eq 0 ]]
[[ "$#" -eq 3 ]]
readonly RELEASE_SHA="$1"
readonly PHASE="$2"
RECEIPT_ROOT="$3"
readonly RECEIPT_ROOT

[[ "$RELEASE_SHA" =~ ^[a-f0-9]{40}$ ]]
[[ "$PHASE" == 'pre-reboot' || "$PHASE" == 'post-reboot' ]]
[[ "$RECEIPT_ROOT" == /* ]]
[[ "$RECEIPT_ROOT" != *$'\n'* && "$RECEIPT_ROOT" != *$'\r'* && "$RECEIPT_ROOT" != *$'\t'* ]]
require_real_path "$RECEIPT_ROOT"
[[ -d "$RECEIPT_ROOT" ]]
[[ "$(stat -Lc '%U:%G:%a' -- "$RECEIPT_ROOT")" == 'root:root:700' ]]

[[ "$(. /etc/os-release; printf '%s:%s' "$ID" "$VERSION_ID")" == 'debian:13' ]]
[[ "$(uname -m)" == 'x86_64' ]]
readonly NODE_VERSION="$(/opt/node/bin/node --version)"
[[ "$NODE_VERSION" == 'v24.18.0' ]]
[[ -L /opt/palziv/current ]]
[[ "$(readlink -f -- /opt/palziv/current)" == "/opt/palziv/releases/$RELEASE_SHA" ]]

assert_stat /opt/node/bin/node 'root:root:755'
assert_stat /opt/palziv/releases 'root:palziv:750'
assert_stat "/opt/palziv/releases/$RELEASE_SHA" 'root:palziv:750'
assert_stat /etc/palziv 'root:palziv:750'
assert_stat /etc/palziv/palziv.env 'root:palziv:640'
assert_stat /etc/palziv/migration-age.key 'root:root:600'
assert_stat /var/lib/palziv/data 'palziv:palziv:700'
assert_stat /var/backups/palziv 'root:palziv:750'
assert_stat /etc/cloudflared 'root:cloudflared:750'
assert_stat /usr/local/sbin/palziv-run-backup 'root:root:750'
for unit in \
  palziv.service \
  palziv-backup.service \
  palziv-backup.timer \
  palziv-health.service \
  palziv-health.timer \
  cloudflared.service; do
  assert_stat "/etc/systemd/system/$unit" 'root:root:644'
done
assert_stat /etc/systemd/journald.conf.d/palziv.conf 'root:root:644'

systemctl is-active --quiet qemu-guest-agent.service
systemctl is-active --quiet systemd-timesyncd.service
systemctl is-active --quiet palziv.service
cloudflared_is_disabled
cloudflared_is_inactive

listener="$(ss -H -ltn 'sport = :3116')"
listener_count=0
while read -r _ _ _ local_address _; do
  [[ -n "$local_address" ]]
  [[ "$local_address" == '127.0.0.1:3116' ]]
  listener_count=$((listener_count + 1))
done <<< "$listener"
[[ "$listener_count" -ge 1 ]]

for route in "${ROUTES[@]}"; do
  curl --fail --silent --show-error --max-time 15 "$ORIGIN$route" >/dev/null
done

shopt -s nullglob
search_roots=("/opt/palziv/releases/$RELEASE_SHA")
for staging_root in \
  /var/tmp/palziv-appliance-upload-* \
  /var/tmp/palziv-appliance-stage-* \
  /var/tmp/palziv-appliance-release.*; do
  require_real_path "$staging_root"
  [[ -d "$staging_root" ]]
  search_roots+=("$staging_root")
done
shopt -u nullglob
for search_root in "${search_roots[@]}"; do
  forbidden_path="$(find "$search_root" -xdev \
    \( -name .git -o -name .worktrees -o -name local-secrets -o -name runtime -o -name backups \
       -o -name board.json -o -name security.json -o -name push.json -o -name analytics.json \) \
    -print -quit)"
  [[ -z "$forbidden_path" ]]
done

readonly COMPLETED_AT="$(date --utc +'%Y-%m-%dT%H:%M:%SZ')"
verification_json="$(jq -c -n \
  --arg phase "$PHASE" \
  --arg releaseSha "$RELEASE_SHA" \
  --arg nodeVersion "$NODE_VERSION" \
  --arg completedAt "$COMPLETED_AT" \
  '{schemaVersion:1,phase:$phase,classification:"pass",releaseSha:$releaseSha,nodeVersion:$nodeVersion,routeCount:8,services:{app:"active",cloudflared:"disabled-inactive",qemuGuestAgent:"active",systemdTimesyncd:"active"},completedAt:$completedAt}')"
[[ -n "$verification_json" && "$(printf '%s\n' "$verification_json" | wc -c)" -le "$MAX_RECEIPT_BYTES" ]]
! printf '%s' "$verification_json" | LC_ALL=C grep -q $'[\001-\010\013\014\016-\037\177]'

if [[ "$PHASE" == 'pre-reboot' ]]; then
  printf '%s\n' "$verification_json"
  exit 0
fi

for output in VERIFY-LOCAL.json STAGE-SUCCESS.json STAGE-SUCCESS.sha256 age-recipient.txt; do
  [[ ! -e "$RECEIPT_ROOT/$output" && ! -L "$RECEIPT_ROOT/$output" ]]
  [[ ! -e "$RECEIPT_ROOT/$output.partial" && ! -L "$RECEIPT_ROOT/$output.partial" ]]
done
PUBLISHING=1
umask 077
printf '%s\n' "$verification_json" > "$RECEIPT_ROOT/VERIFY-LOCAL.json.partial"
recipient="$(age-keygen -y /etc/palziv/migration-age.key)"
[[ "$recipient" =~ ^age1[ac-hj-np-z02-9]{58}$ ]]
printf '%s\n' "$recipient" > "$RECEIPT_ROOT/age-recipient.txt.partial"
jq -c -n \
  --arg phaseId 'project-a-two-phase-v1' \
  --arg releaseSha "$RELEASE_SHA" \
  --arg nodeVersion "$NODE_VERSION" \
  --arg completedAt "$COMPLETED_AT" \
  '{schemaVersion:1,phaseId:$phaseId,classification:"staged",releaseSha:$releaseSha,nodeVersion:$nodeVersion,app:"active",cloudflared:"disabled-inactive",routeCount:8,completedAt:$completedAt}' \
  > "$RECEIPT_ROOT/STAGE-SUCCESS.json.partial"
for partial in VERIFY-LOCAL.json.partial STAGE-SUCCESS.json.partial age-recipient.txt.partial; do
  is_bounded_metadata "$RECEIPT_ROOT/$partial"
done

mv -T -- "$RECEIPT_ROOT/VERIFY-LOCAL.json.partial" "$RECEIPT_ROOT/VERIFY-LOCAL.json"
mv -T -- "$RECEIPT_ROOT/STAGE-SUCCESS.json.partial" "$RECEIPT_ROOT/STAGE-SUCCESS.json"
mv -T -- "$RECEIPT_ROOT/age-recipient.txt.partial" "$RECEIPT_ROOT/age-recipient.txt"
(
  cd -- "$RECEIPT_ROOT"
  sha256sum STAGE-SUCCESS.json age-recipient.txt > STAGE-SUCCESS.sha256.partial
  is_bounded_metadata STAGE-SUCCESS.sha256.partial
  mv -T -- STAGE-SUCCESS.sha256.partial STAGE-SUCCESS.sha256
)
PUBLISHING=0
printf '%s\n' "$verification_json"
