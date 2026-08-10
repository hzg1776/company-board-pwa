#!/usr/bin/env bash
set -Eeuo pipefail

trap 'rc=$?; printf "ERROR line=%s status=%s command=%q\n" "$LINENO" "$rc" "$BASH_COMMAND" >&2; exit "$rc"' ERR

readonly PHASE_ID='project-a-two-phase-v1'
readonly BUNDLE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly RETURN_ROOT="$BUNDLE_ROOT/FROM-DEBIAN"
readonly FINAL_ROOT="$BUNDLE_ROOT/FINAL-ENCRYPTED"
readonly AGE_IDENTITY='/etc/palziv/migration-age.key'
readonly LOCAL_ORIGIN='http://127.0.0.1:3116'
readonly -a LOCAL_ROUTES=(
  '/api/health'
  '/palzivalerts/'
  '/palzivalerts/employee'
  '/palzivalerts/hr'
  '/palzivalerts/webmaster'
  '/palzivalerts/it'
  '/sw.js'
  '/manifest.webmanifest'
)
CUTOVER_TEMP=''

cleanup() {
  if [[ -n "$CUTOVER_TEMP" ]]; then
    local resolved=''
    resolved="$(realpath -e -- "$CUTOVER_TEMP" 2>/dev/null || true)"
    if [[ "$resolved" == /var/tmp/project-a-cutover.* && -d "$resolved" && ! -L "$resolved" ]]; then
      rm -rf -- "$resolved"
    fi
  fi
}
trap cleanup EXIT

if [[ "$EUID" -ne 0 ]]; then
  printf '%s\n' 'Run this script with sudo.' >&2
  exit 1
fi
if [[ "$(basename -- "$BUNDLE_ROOT")" != 'Project-A-Migration-Two-Phase' || -L "$BUNDLE_ROOT" ]]; then
  printf '%s\n' 'The migration bundle path is invalid.' >&2
  exit 1
fi
if [[ -f "$RETURN_ROOT/CUTOVER-SUCCESS.json" ]]; then
  (cd -- "$RETURN_ROOT" && sha256sum --check --strict --quiet 'CUTOVER-SUCCESS.sha256')
  systemctl is-active --quiet palziv.service
  systemctl is-active --quiet cloudflared.service
  printf '%s\n' 'CUTOVER ALREADY COMPLETE: both Debian services are active.'
  exit 0
fi

(
  cd -- "$BUNDLE_ROOT"
  sha256sum --check --strict --quiet 'CHECKSUMS/TWO-PHASE.sha256'
)
readonly -a FINAL_ENCRYPTED=(
  'cloudflared-config.age'
  'cloudflared-credential.age'
  'production-env.age'
  'runtime.tar.gz.age'
)
readonly -a EXPECTED_FINAL=(
  'CUTOVER-AUTHORIZATION.json'
  'FINAL-ENCRYPTED.sha256'
  "${FINAL_ENCRYPTED[@]}"
)
mapfile -t ACTUAL_FINAL < <(find "$FINAL_ROOT" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)
mapfile -t SORTED_EXPECTED < <(printf '%s\n' "${EXPECTED_FINAL[@]}" | LC_ALL=C sort)
[[ "${ACTUAL_FINAL[*]}" == "${SORTED_EXPECTED[*]}" ]] || {
  printf '%s\n' 'FINAL-ENCRYPTED does not contain the exact authorized payload.' >&2
  exit 1
}
for item in "${EXPECTED_FINAL[@]}"; do
  [[ -f "$FINAL_ROOT/$item" && ! -L "$FINAL_ROOT/$item" ]] || {
    printf 'Unsafe cutover payload entry: %s\n' "$item" >&2
    exit 1
  }
done
(
  cd -- "$FINAL_ROOT"
  sha256sum --check --strict --quiet 'FINAL-ENCRYPTED.sha256'
)
(
  cd -- "$RETURN_ROOT"
  sha256sum --check --strict --quiet 'STAGE-SUCCESS.sha256'
)

readonly STAGE_RECEIPT_SHA="$(sha256sum -- "$RETURN_ROOT/STAGE-SUCCESS.json" | awk '{print $1}')"
readonly RECIPIENT_SHA="$(sha256sum -- "$RETURN_ROOT/age-recipient.txt" | awk '{print $1}')"
readonly AUTH_STAGE_SHA="$(jq -er '.stageReceiptSha256 | select(test("^[a-f0-9]{64}$"))' "$FINAL_ROOT/CUTOVER-AUTHORIZATION.json")"
readonly AUTH_RECIPIENT_SHA="$(jq -er '.ageRecipientSha256 | select(test("^[a-f0-9]{64}$"))' "$FINAL_ROOT/CUTOVER-AUTHORIZATION.json")"
readonly AUTH_RUNTIME_SHA="$(jq -er '.runtimeArchivePlaintextSha256 | select(test("^[a-f0-9]{64}$"))' "$FINAL_ROOT/CUTOVER-AUTHORIZATION.json")"
[[ "$STAGE_RECEIPT_SHA" == "$AUTH_STAGE_SHA" && "$RECIPIENT_SHA" == "$AUTH_RECIPIENT_SHA" ]] || {
  printf '%s\n' 'Cutover authorization belongs to a different staged host.' >&2
  exit 1
}
[[ -f "$AGE_IDENTITY" && ! -L "$AGE_IDENTITY" ]] || {
  printf '%s\n' 'The Debian-only age identity is missing or unsafe.' >&2
  exit 1
}
readonly EXPECTED_RECIPIENT="$(cat -- "$RETURN_ROOT/age-recipient.txt")"
[[ "$(age-keygen -y "$AGE_IDENTITY")" == "$EXPECTED_RECIPIENT" ]] || {
  printf '%s\n' 'The encrypted payload recipient does not match this Debian host.' >&2
  exit 1
}
[[ "$(timedatectl show --property=NTPSynchronized --value)" == 'yes' ]] || {
  printf '%s\n' 'System time is not synchronized.' >&2
  exit 1
}
systemctl is-active --quiet palziv.service
systemctl is-active --quiet cloudflared.service && {
  printf '%s\n' 'Cloudflare must be stopped before cutover.' >&2
  exit 1
}

CUTOVER_TEMP="$(mktemp -d /var/tmp/project-a-cutover.XXXXXXXX)"
chmod 0700 "$CUTOVER_TEMP"
age --decrypt -i "$AGE_IDENTITY" -o "$CUTOVER_TEMP/runtime.tar.gz" "$FINAL_ROOT/runtime.tar.gz.age"
age --decrypt -i "$AGE_IDENTITY" -o "$CUTOVER_TEMP/palziv.env" "$FINAL_ROOT/production-env.age"
age --decrypt -i "$AGE_IDENTITY" -o "$CUTOVER_TEMP/credentials.json" "$FINAL_ROOT/cloudflared-credential.age"
age --decrypt -i "$AGE_IDENTITY" -o "$CUTOVER_TEMP/config.yml" "$FINAL_ROOT/cloudflared-config.age"
[[ "$(sha256sum -- "$CUTOVER_TEMP/runtime.tar.gz" | awk '{print $1}')" == "$AUTH_RUNTIME_SHA" ]] || {
  printf '%s\n' 'The decrypted runtime archive does not match its authorization.' >&2
  exit 1
}
mapfile -t ARCHIVE_ENTRIES < <(tar -tzf "$CUTOVER_TEMP/runtime.tar.gz" | LC_ALL=C sort)
readonly -a EXPECTED_ARCHIVE=(
  'data/analytics.json'
  'data/board.json'
  'data/push.json'
  'data/security.json'
  'manifest.json'
)
[[ "${ARCHIVE_ENTRIES[*]}" == "${EXPECTED_ARCHIVE[*]}" ]] || {
  printf '%s\n' 'The runtime archive contains unexpected entries.' >&2
  exit 1
}
jq -e . "$CUTOVER_TEMP/credentials.json" >/dev/null
grep -Eq '^HOST=127\.0\.0\.1$' "$CUTOVER_TEMP/palziv.env"
grep -Eq '^PORT=3116$' "$CUTOVER_TEMP/palziv.env"
grep -Eq '^RUNTIME_DATA_DIR=/var/lib/palziv/data$' "$CUTOVER_TEMP/palziv.env"
grep -Eq '127\.0\.0\.1:3116' "$CUTOVER_TEMP/config.yml"
tar -xOzf "$CUTOVER_TEMP/runtime.tar.gz" 'manifest.json' > "$CUTOVER_TEMP/embedded-manifest.json"
jq --arg archiveFile 'runtime.tar.gz' --arg archiveSha256 "$AUTH_RUNTIME_SHA" \
  '. + {archiveFile:$archiveFile,archiveSha256:$archiveSha256}' \
  "$CUTOVER_TEMP/embedded-manifest.json" > "$CUTOVER_TEMP/runtime.manifest.json"

systemctl stop palziv.service
/opt/node/bin/node /opt/palziv/current/scripts/linux/restore-runtime.mjs \
  --archive "$CUTOVER_TEMP/runtime.tar.gz" \
  --data-dir '/var/lib/palziv/data' \
  --force true
chown -R palziv:palziv /var/lib/palziv/data
find /var/lib/palziv/data -type d -exec chmod 0700 {} +
find /var/lib/palziv/data -type f -exec chmod 0600 {} +
install -o root -g palziv -m 0640 "$CUTOVER_TEMP/palziv.env" /etc/palziv/palziv.env
install -o root -g cloudflared -m 0640 "$CUTOVER_TEMP/credentials.json" /etc/cloudflared/credentials.json
install -o root -g cloudflared -m 0640 "$CUTOVER_TEMP/config.yml" /etc/cloudflared/config.yml

systemctl start palziv.service
for attempt in {1..15}; do
  if curl --fail --silent --show-error --max-time 3 "$LOCAL_ORIGIN/api/health" >/dev/null; then break; fi
  if (( attempt == 15 )); then
    printf '%s\n' 'Project-A did not become healthy with restored production data.' >&2
    exit 1
  fi
  sleep 1
done
for route in "${LOCAL_ROUTES[@]}"; do
  curl --fail --silent --show-error --max-time 15 "$LOCAL_ORIGIN$route" >/dev/null
done
systemctl restart palziv.service
for attempt in {1..15}; do
  if curl --fail --silent --show-error --max-time 3 "$LOCAL_ORIGIN/api/health" >/dev/null; then break; fi
  if (( attempt == 15 )); then
    printf '%s\n' 'Project-A failed its production restart check.' >&2
    exit 1
  fi
  sleep 1
done
systemctl enable --now palziv-backup.timer palziv-health.timer
systemctl enable --now cloudflared.service
systemctl is-active --quiet palziv.service
systemctl is-active --quiet cloudflared.service

readonly RELEASE_SHA="$(jq -er '.releaseSha | select(test("^[a-f0-9]{40}$"))' "$RETURN_ROOT/STAGE-SUCCESS.json")"
readonly RECEIPT_PARTIAL="$RETURN_ROOT/.CUTOVER-SUCCESS.json.partial.$$"
jq -n \
  --arg phaseId "$PHASE_ID" \
  --arg releaseSha "$RELEASE_SHA" \
  --arg runtimeArchiveSha256 "$AUTH_RUNTIME_SHA" \
  --arg completedAt "$(date --utc +'%Y-%m-%dT%H:%M:%SZ')" \
  --argjson routeCount "${#LOCAL_ROUTES[@]}" \
  '{schemaVersion:1,phaseId:$phaseId,classification:"cutover-complete",releaseSha:$releaseSha,runtimeArchiveSha256:$runtimeArchiveSha256,app:"active",cloudflared:"active",routeCount:$routeCount,completedAt:$completedAt}' \
  > "$RECEIPT_PARTIAL"
mv -f -- "$RECEIPT_PARTIAL" "$RETURN_ROOT/CUTOVER-SUCCESS.json"
(
  cd -- "$RETURN_ROOT"
  sha256sum -- 'CUTOVER-SUCCESS.json' > 'CUTOVER-SUCCESS.sha256.partial'
  mv -f -- 'CUTOVER-SUCCESS.sha256.partial' 'CUTOVER-SUCCESS.sha256'
)
sync
printf '%s\n' 'CUTOVER COMPLETE: Debian app and Cloudflare are active. Return the USB to Windows for verification.'
