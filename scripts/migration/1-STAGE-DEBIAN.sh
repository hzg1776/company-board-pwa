#!/usr/bin/env bash
set -Eeuo pipefail

trap 'rc=$?; printf "ERROR line=%s status=%s command=%q\n" "$LINENO" "$rc" "$BASH_COMMAND" >&2; exit "$rc"' ERR

readonly PHASE_ID='project-a-two-phase-v1'
readonly BUNDLE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly RELEASE_ROOT="$BUNDLE_ROOT/PAYLOAD/release"
readonly RETURN_ROOT="$BUNDLE_ROOT/FROM-DEBIAN"
readonly AGE_IDENTITY='/etc/palziv/migration-age.key'
readonly ENVIRONMENT_FILE='/etc/palziv/palziv.env'
readonly DATA_DIR='/var/lib/palziv/data'
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

if [[ "$EUID" -ne 0 ]]; then
  printf '%s\n' 'Run this script with sudo.' >&2
  exit 1
fi
if [[ "$(basename -- "$BUNDLE_ROOT")" != 'Project-A-Migration-Two-Phase' ]]; then
  printf '%s\n' 'The migration bundle has the wrong folder name.' >&2
  exit 1
fi
if [[ -L "$BUNDLE_ROOT" || -L "$RELEASE_ROOT" ]]; then
  printf '%s\n' 'Linked migration directories are not allowed.' >&2
  exit 1
fi

(
  cd -- "$BUNDLE_ROOT"
  sha256sum --check --strict --quiet 'CHECKSUMS/TWO-PHASE.sha256'
)

# shellcheck source=/dev/null
. /etc/os-release
[[ "${ID:-}" == 'debian' && "${VERSION_ID:-}" == '13' ]] || {
  printf 'Debian 13 is required; detected %s.\n' "${PRETTY_NAME:-unknown}" >&2
  exit 1
}
[[ "$(uname -m)" == 'x86_64' ]] || {
  printf 'x86_64 is required; detected %s.\n' "$(uname -m)" >&2
  exit 1
}
[[ "$(timedatectl show --property=NTPSynchronized --value)" == 'yes' ]] || {
  printf '%s\n' 'System time is not synchronized.' >&2
  exit 1
}
readonly ROOT_FREE_BYTES="$(df -B1 --output=avail / | awk 'NR==2 {gsub(/[[:space:]]/,""); print}')"
(( ROOT_FREE_BYTES >= 5368709120 )) || {
  printf '%s\n' 'At least 5 GiB of free root-disk space is required.' >&2
  exit 1
}

if ss -H -ltn 'sport = :3116' | grep -q .; then
  if ! systemctl is-active --quiet palziv.service; then
    printf '%s\n' 'Port 3116 is already in use by another process.' >&2
    exit 1
  fi
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y age ca-certificates curl jq rsync tar xz-utils
bash "$RELEASE_ROOT/scripts/linux/prepare-host.sh"
bash "$RELEASE_ROOT/scripts/linux/install-node24.sh"
bash "$RELEASE_ROOT/scripts/linux/install-cloudflared.sh"

readonly RELEASE_SHA="$(jq -er '.releaseSha | select(test("^[a-f0-9]{40}$"))' "$BUNDLE_ROOT/BUNDLE.json")"
bash "$RELEASE_ROOT/scripts/linux/deploy-release.sh" "$RELEASE_ROOT" "$RELEASE_SHA"

install -d -o palziv -g palziv -m 0700 "$DATA_DIR"
if [[ ! -s "$ENVIRONMENT_FILE" ]] || grep -q '^ADMIN_SETUP_TOKEN=$' "$ENVIRONMENT_FILE"; then
  readonly SETUP_TOKEN="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  readonly ENVIRONMENT_PARTIAL="${ENVIRONMENT_FILE}.partial.$$"
  umask 077
  {
    printf '%s\n' \
      'HOST=127.0.0.1' \
      'PORT=3116' \
      'RUNTIME_DATA_DIR=/var/lib/palziv/data' \
      'PUBLIC_BASE_URL=https://itotexpress.com' \
      'TRUST_PROXY_ADDRESSES=loopback' \
      'ADMIN_MFA_ENABLED=true'
    printf 'ADMIN_SETUP_TOKEN=%s\n' "$SETUP_TOKEN"
    printf '%s\n' 'PUSH_ALLOWED_HOSTS=itotexpress.com,www.itotexpress.com'
  } > "$ENVIRONMENT_PARTIAL"
  install -o root -g palziv -m 0640 "$ENVIRONMENT_PARTIAL" "$ENVIRONMENT_FILE"
  rm -f -- "$ENVIRONMENT_PARTIAL"
fi

systemctl disable --now cloudflared.service
systemctl enable --now palziv.service
for route in "${LOCAL_ROUTES[@]}"; do
  curl --fail --silent --show-error --max-time 15 "$LOCAL_ORIGIN$route" >/dev/null
done
systemctl restart palziv.service
for attempt in {1..15}; do
  if curl --fail --silent --show-error --max-time 3 "$LOCAL_ORIGIN/api/health" >/dev/null; then
    break
  fi
  if (( attempt == 15 )); then
    printf '%s\n' 'Project-A did not become healthy after restart.' >&2
    exit 1
  fi
  sleep 1
done
systemctl is-enabled --quiet cloudflared.service && {
  printf '%s\n' 'Cloudflare must remain disabled during staging.' >&2
  exit 1
}
systemctl is-active --quiet cloudflared.service && {
  printf '%s\n' 'Cloudflare must remain stopped during staging.' >&2
  exit 1
}

install -d -o root -g palziv -m 0750 /etc/palziv
if [[ ! -s "$AGE_IDENTITY" ]]; then
  umask 077
  age-keygen -o "$AGE_IDENTITY"
fi
chmod 0600 "$AGE_IDENTITY"
chown root:root "$AGE_IDENTITY"
readonly AGE_RECIPIENT="$(age-keygen -y "$AGE_IDENTITY")"
[[ "$AGE_RECIPIENT" =~ ^age1[ac-hj-np-z02-9]{58}$ ]] || {
  printf '%s\n' 'The generated age recipient is invalid.' >&2
  exit 1
}

install -d -m 0755 "$RETURN_ROOT"
readonly RECEIPT_PARTIAL="$RETURN_ROOT/.STAGE-SUCCESS.json.partial.$$"
readonly RECIPIENT_PARTIAL="$RETURN_ROOT/.age-recipient.txt.partial.$$"
printf '%s\n' "$AGE_RECIPIENT" > "$RECIPIENT_PARTIAL"
jq -n \
  --arg phaseId "$PHASE_ID" \
  --arg releaseSha "$RELEASE_SHA" \
  --arg nodeVersion "$(/opt/node/bin/node --version)" \
  --arg completedAt "$(date --utc +'%Y-%m-%dT%H:%M:%SZ')" \
  --argjson routeCount "${#LOCAL_ROUTES[@]}" \
  '{schemaVersion:1,phaseId:$phaseId,classification:"staged",releaseSha:$releaseSha,nodeVersion:$nodeVersion,app:"active",cloudflared:"disabled-inactive",routeCount:$routeCount,completedAt:$completedAt}' \
  > "$RECEIPT_PARTIAL"
mv -f -- "$RECIPIENT_PARTIAL" "$RETURN_ROOT/age-recipient.txt"
mv -f -- "$RECEIPT_PARTIAL" "$RETURN_ROOT/STAGE-SUCCESS.json"
(
  cd -- "$RETURN_ROOT"
  sha256sum -- 'STAGE-SUCCESS.json' 'age-recipient.txt' > 'STAGE-SUCCESS.sha256.partial'
  mv -f -- 'STAGE-SUCCESS.sha256.partial' 'STAGE-SUCCESS.sha256'
)
sync
printf '%s\n' 'STAGE COMPLETE: Debian is ready; Cloudflare is stopped. Return the USB to Windows.'
