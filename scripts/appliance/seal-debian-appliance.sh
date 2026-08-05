#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

require_real_path() {
  local expected="$1" kind="$2" resolved
  [[ ! -L "$expected" ]] || fail "Refusing linked path: $expected"
  case "$kind" in
    directory) [[ -d "$expected" ]] || fail "Required directory is missing: $expected" ;;
    file) [[ -f "$expected" ]] || fail "Required file is missing: $expected" ;;
    *) fail 'Internal path type error.' ;;
  esac
  resolved="$(realpath -e -- "$expected")"
  [[ "$resolved" == "$expected" ]] || fail "Path does not resolve to its fixed location: $expected"
}

fingerprint_is_absent() {
  local expected_fingerprint="$1" candidate fingerprint
  while IFS= read -r -d '' candidate; do
    fingerprint="$(ssh-keygen -l -E sha256 -f "$candidate" 2>/dev/null | awk 'NR == 1 { print $2 }' || true)"
    [[ "$fingerprint" != "$expected_fingerprint" ]] || return 1
  done < <(find /root /home /etc/ssh /var/lib/cloud -xdev -type f -size -1M -print0 2>/dev/null)
}

[[ "$EUID" -eq 0 ]] || fail 'Run as root.'
[[ "$#" -eq 3 ]] || fail 'Usage: seal-debian-appliance.sh <release-sha> <build-key-fingerprint> <receipt-directory>'

readonly RELEASE_SHA="$1"
readonly BUILD_KEY_FINGERPRINT="$2"
readonly RECEIPT_DIR="$3"
[[ "$RELEASE_SHA" =~ ^[a-f0-9]{40}$ ]] || fail 'Release SHA is invalid.'
[[ "$BUILD_KEY_FINGERPRINT" =~ ^SHA256:[A-Za-z0-9+/]{43}$ ]] || fail 'Build key fingerprint is invalid.'
[[ "$RECEIPT_DIR" =~ ^/var/tmp/palziv-appliance-receipts-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$ ]] || fail 'Receipt directory is invalid.'

require_real_path "/opt/palziv/releases/$RELEASE_SHA" directory
require_real_path /etc/palziv/palziv.env file
require_real_path /etc/palziv/migration-age.key file
require_real_path "$RECEIPT_DIR" directory
for receipt in VERIFY-LOCAL.json STAGE-SUCCESS.json STAGE-SUCCESS.sha256 age-recipient.txt; do
  require_real_path "$RECEIPT_DIR/$receipt" file
done
(cd -- "$RECEIPT_DIR" && sha256sum --check --strict STAGE-SUCCESS.sha256 >/dev/null)
[[ -L /opt/palziv/current && "$(readlink -f -- /opt/palziv/current)" == "/opt/palziv/releases/$RELEASE_SHA" ]] || fail 'Current release link changed before sealing.'

systemctl stop palziv.service
systemctl disable --now cloudflared.service
[[ "$(systemctl is-active cloudflared.service 2>/dev/null || true)" == 'inactive' ]]
[[ "$(systemctl is-enabled cloudflared.service 2>/dev/null || true)" == 'disabled' ]]

data_dir="$(realpath -e -- /var/lib/palziv/data)"
[[ "$data_dir" == '/var/lib/palziv/data' && ! -L "$data_dir" ]] || fail 'Runtime data path is unsafe.'
find "$data_dir" -xdev -mindepth 1 -delete
chown palziv:palziv "$data_dir"
chmod 0700 "$data_dir"

rm -f -- /var/tmp/project-a-release.tar /var/tmp/provision-debian-appliance.sh
rm -f -- /var/tmp/verify-debian-appliance.sh /var/tmp/seal-debian-appliance.sh

if getent passwd palziv-build >/dev/null; then
  loginctl terminate-user palziv-build || true
  pkill -KILL -u palziv-build || true
  userdel --remove palziv-build
fi
getent passwd palziv-build >/dev/null && fail 'Build user still exists after sealing.'

cloud_root="$(realpath -e -- /var/lib/cloud)"
[[ "$cloud_root" == '/var/lib/cloud' && ! -L "$cloud_root" ]] || fail 'Cloud-init state path is unsafe.'
if [[ -e "$cloud_root/instances" || -L "$cloud_root/instances" ]]; then
  instances_root="$(realpath -e -- "$cloud_root/instances")"
  [[ "$instances_root" == '/var/lib/cloud/instances' && ! -L "$instances_root" ]] || fail 'Cloud-init instance path is unsafe.'
  find "$instances_root" -xdev -mindepth 1 -delete
fi
rm -f -- "$cloud_root/instance"
cloud-init clean --logs --machine-id --seed

apt-get clean
apt_lists="$(realpath -e -- /var/lib/apt/lists)"
[[ "$apt_lists" == '/var/lib/apt/lists' && ! -L "$apt_lists" ]] || fail 'APT list path is unsafe.'
find "$apt_lists" -xdev -type f -delete
rm -f -- /etc/ssh/ssh_host_*

require_real_path "/opt/palziv/releases/$RELEASE_SHA" directory
require_real_path /etc/palziv/palziv.env file
require_real_path /etc/palziv/migration-age.key file
fingerprint_is_absent "$BUILD_KEY_FINGERPRINT" || fail 'Ephemeral build key fingerprint remains in the sealed guest.'

sync
systemctl poweroff
