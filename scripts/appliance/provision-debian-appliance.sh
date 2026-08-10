#!/usr/bin/env bash
set -Eeuo pipefail

RELEASE_ROOT=''
RELEASE_ROOT_ID=''
RELEASE_ROOT_UID=''
RELEASE_ROOT_MODE=''

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

cleanup() {
  local rc=$? resolved='' actual_id='' actual_uid='' actual_mode=''
  trap - EXIT ERR
  if [[ -n "$RELEASE_ROOT" && -d "$RELEASE_ROOT" && ! -L "$RELEASE_ROOT" ]]; then
    resolved="$(realpath -e -- "$RELEASE_ROOT" 2>/dev/null || true)"
    actual_id="$(stat -Lc '%d:%i' -- "$RELEASE_ROOT" 2>/dev/null || true)"
    actual_uid="$(stat -Lc '%u' -- "$RELEASE_ROOT" 2>/dev/null || true)"
    actual_mode="$(stat -Lc '%a' -- "$RELEASE_ROOT" 2>/dev/null || true)"
    if [[ "$resolved" == "$RELEASE_ROOT" && "$resolved" == /var/tmp/palziv-appliance-release.* && \
          "$actual_id" == "$RELEASE_ROOT_ID" && "$actual_uid" == "$RELEASE_ROOT_UID" && \
          "$actual_mode" == "$RELEASE_ROOT_MODE" ]]; then
      rm -rf -- "$resolved"
    fi
  fi
  exit "$rc"
}
trap cleanup EXIT

target_path() {
  local absolute_path="$1"
  [[ "$absolute_path" == /* ]] || fail 'Internal target path must be absolute.'
  if [[ "$TARGET_ROOT" == '/' ]]; then
    printf '%s\n' "$absolute_path"
  else
    printf '%s%s\n' "$TARGET_ROOT" "$absolute_path"
  fi
}

[[ "$EUID" -eq 0 ]] || fail 'Run as root.'
[[ "$#" -eq 2 ]] || fail 'Provisioning requires exactly two arguments.'
readonly RELEASE_TAR="$1"
readonly RELEASE_SHA="$2"
readonly TARGET_ROOT="${PALZIV_APPLIANCE_ROOT:-/}"

[[ "$RELEASE_SHA" =~ ^[a-f0-9]{40}$ ]] || fail 'Invalid release SHA.'
[[ "$RELEASE_TAR" == /* && -f "$RELEASE_TAR" && ! -L "$RELEASE_TAR" ]] || fail 'Release tar must be an absolute regular file.'
[[ "$TARGET_ROOT" == /* && -d "$TARGET_ROOT" && ! -L "$TARGET_ROOT" ]] || fail 'Appliance root must be an absolute directory.'
readonly RESOLVED_TARGET_ROOT="$(realpath -e -- "$TARGET_ROOT")"
[[ "$RESOLVED_TARGET_ROOT" == "$TARGET_ROOT" ]] || fail 'Appliance root must not traverse a linked path.'

archive_entries="$(LC_ALL=C tar --quoting-style=escape -tf "$RELEASE_TAR")"
[[ -n "$archive_entries" ]] || fail 'Release archive is empty.'
while IFS= read -r entry; do
  normalized="$entry"
  while [[ "$normalized" == ./* ]]; do normalized="${normalized#./}"; done
  [[ "$entry" != /* && "$entry" != *'\'* ]] || fail 'Unsafe release archive path.'
  [[ "$normalized" != '..' && "$normalized" != ../* && "$normalized" != */../* && "$normalized" != */.. ]] || fail 'Unsafe release archive path.'
done <<< "$archive_entries"

RELEASE_ROOT="$(mktemp -d /var/tmp/palziv-appliance-release.XXXXXX)"
RELEASE_ROOT="$(realpath -e -- "$RELEASE_ROOT")"
[[ "$RELEASE_ROOT" == /var/tmp/palziv-appliance-release.* && ! -L "$RELEASE_ROOT" ]] || fail 'Release staging directory was unsafe.'
chmod 0700 -- "$RELEASE_ROOT"
RELEASE_ROOT_ID="$(stat -Lc '%d:%i' -- "$RELEASE_ROOT")"
RELEASE_ROOT_UID="$(stat -Lc '%u' -- "$RELEASE_ROOT")"
RELEASE_ROOT_MODE="$(stat -Lc '%a' -- "$RELEASE_ROOT")"
[[ "$RELEASE_ROOT_UID:$RELEASE_ROOT_MODE" == '0:700' ]] || fail 'Release staging directory ownership or mode was unsafe.'
tar --no-overwrite-dir -xf "$RELEASE_TAR" -C "$RELEASE_ROOT"
[[ "$(stat -Lc '%d:%i:%u:%a' -- "$RELEASE_ROOT")" == "$RELEASE_ROOT_ID:$RELEASE_ROOT_UID:$RELEASE_ROOT_MODE" ]] || fail 'Release staging directory identity changed during extraction.'

if [[ -n "$(find "$RELEASE_ROOT" -xdev \( -type l -o \( -type f -links +1 \) \) -print -quit)" ]]; then
  fail 'Release archive links are not allowed.'
fi
if [[ -n "$(find "$RELEASE_ROOT" -xdev ! -type f ! -type d -print -quit)" ]]; then
  fail 'Release archive members must be regular files or directories.'
fi
for helper in prepare-host.sh install-node24.sh install-cloudflared.sh deploy-release.sh; do
  [[ -f "$RELEASE_ROOT/scripts/linux/$helper" && ! -L "$RELEASE_ROOT/scripts/linux/$helper" ]] || fail "Release helper is missing: $helper"
done

bash "$RELEASE_ROOT/scripts/linux/prepare-host.sh"
DEBIAN_FRONTEND=noninteractive apt-get install -y age
bash "$RELEASE_ROOT/scripts/linux/install-node24.sh"
readonly NODE_BINARY="$(target_path /opt/node/bin/node)"
[[ "$("$NODE_BINARY" --version)" == 'v24.18.0' ]] || fail 'Installed Node version did not match v24.18.0.'
bash "$RELEASE_ROOT/scripts/linux/install-cloudflared.sh"
bash "$RELEASE_ROOT/scripts/linux/deploy-release.sh" "$RELEASE_ROOT" "$RELEASE_SHA"

readonly CURRENT_RELEASE="$(target_path /opt/palziv/current)"
readonly EXPECTED_RELEASE="$(target_path "/opt/palziv/releases/$RELEASE_SHA")"
[[ -L "$CURRENT_RELEASE" ]] || fail 'Current release link was not created.'
[[ "$(realpath -e -- "$CURRENT_RELEASE")" == "$EXPECTED_RELEASE" ]] || fail 'Current release identity did not match the requested SHA.'

readonly CONFIG_ROOT="$(target_path /etc/palziv)"
install -d -m 0750 -- "$CONFIG_ROOT"
setup_token="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
[[ "$setup_token" =~ ^[a-f0-9]{64}$ ]] || fail 'Setup token generation failed.'
umask 077
cat > "$CONFIG_ROOT/palziv.env" <<EOF
HOST=127.0.0.1
PORT=3116
RUNTIME_DATA_DIR=/var/lib/palziv/data
PUBLIC_BASE_URL=https://itotexpress.com
TRUST_PROXY_ADDRESSES=loopback
ADMIN_MFA_ENABLED=true
ADMIN_SETUP_TOKEN=${setup_token}
PUSH_ALLOWED_HOSTS=itotexpress.com,www.itotexpress.com
EOF
chown root:palziv "$CONFIG_ROOT/palziv.env"
chmod 0640 "$CONFIG_ROOT/palziv.env"
unset setup_token

readonly AGE_IDENTITY="$CONFIG_ROOT/migration-age.key"
if [[ ! -s "$AGE_IDENTITY" ]]; then
  age-keygen -o "$AGE_IDENTITY" >/dev/null 2>&1
fi
chown root:root "$AGE_IDENTITY"
chmod 0600 "$AGE_IDENTITY"

systemctl disable --now cloudflared.service
systemctl enable --now palziv.service palziv-backup.timer palziv-health.timer
