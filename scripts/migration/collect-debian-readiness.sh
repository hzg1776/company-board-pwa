#!/usr/bin/env bash
set -Eeuo pipefail
export LC_ALL=C
umask 077
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
unset CURL_HOME XDG_CONFIG_HOME CURL_CA_BUNDLE SSL_CERT_FILE SSL_CERT_DIR

SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname -- "$SCRIPT_PATH")"
USB_ROOT="$(readlink -f -- "$SCRIPT_DIR/..")"

if [[ "${1:-}" == "--usb-root" ]]; then
  [[ -n "${2:-}" && "${2:-}" == /* ]] || {
    printf 'ERROR: --usb-root requires an absolute path.\n' >&2
    exit 2
  }
  USB_ROOT="$(readlink -f -- "$2")"
  shift 2
fi
[[ "$#" -eq 0 ]] || {
  printf 'ERROR: unexpected argument.\n' >&2
  exit 2
}

FROM_DIR="$USB_ROOT/FROM-DEBIAN"
[[ -d "$FROM_DIR" && ! -L "$FROM_DIR" && -w "$FROM_DIR" ]] || {
  printf 'ERROR: FROM-DEBIAN must be a writable, non-symlink directory.\n' >&2
  exit 3
}
[[ "$(readlink -f -- "$FROM_DIR")" == "$USB_ROOT/FROM-DEBIAN" ]] || {
  printf 'ERROR: FROM-DEBIAN resolves outside the handoff root.\n' >&2
  exit 3
}

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SAFE_HOSTNAME="$(hostname 2>/dev/null | tr -cd 'A-Za-z0-9._-')"
SAFE_HOSTNAME="${SAFE_HOSTNAME:-unknown}"
REPORT_FINAL="$FROM_DIR/debian-readiness-$TIMESTAMP-$SAFE_HOSTNAME.txt"
CHECKSUM_FINAL="$REPORT_FINAL.sha256"
[[ ! -e "$REPORT_FINAL" && ! -e "$CHECKSUM_FINAL" ]] || {
  printf 'ERROR: readiness output already exists for this timestamp and hostname.\n' >&2
  exit 4
}
command -v -- sha256sum >/dev/null 2>&1 || {
  printf 'ERROR: sha256sum is required to create the readiness checksum.\n' >&2
  exit 5
}

REPORT_TEMP=""
CHECKSUM_TEMP=""
OUTPUT_COMPLETE=0

cleanup() {
  local temporary_path
  for temporary_path in "$REPORT_TEMP" "$CHECKSUM_TEMP"; do
    if [[ -n "$temporary_path" && "$temporary_path" == "$FROM_DIR"/.debian-readiness.*.tmp && "$(dirname -- "$temporary_path")" == "$FROM_DIR" ]]; then
      rm -f -- "$temporary_path" || true
    fi
  done
  if [[ "$OUTPUT_COMPLETE" -ne 1 ]]; then
    for temporary_path in "$REPORT_FINAL" "$CHECKSUM_FINAL"; do
      if [[ "$temporary_path" == "$FROM_DIR"/debian-readiness-*.txt* && "$(dirname -- "$temporary_path")" == "$FROM_DIR" ]]; then
        rm -f -- "$temporary_path" || true
      fi
    done
  fi
}
trap cleanup EXIT

section() {
  printf '\n## %s\n' "$1"
}

run_safe() {
  local label="$1"
  shift
  printf '\n[%s]\n' "$label"
  if ! command -v -- "$1" >/dev/null 2>&1; then
    printf 'unavailable: %s\n' "$1"
    return 0
  fi
  "$@" 2>&1 || printf 'status: unavailable-or-permission-required\n'
}

version_or_unavailable() {
  local label="$1"
  shift
  printf '\n[%s]\n' "$label"
  if ! command -v -- "$1" >/dev/null 2>&1; then
    printf 'unavailable: %s\n' "$1"
    return 0
  fi
  "$@" --version 2>&1 | sed -n '1p' || printf 'status: unavailable-or-permission-required\n'
}

service_state() {
  local unit="$1"
  printf '%s enabled=' "$unit"
  systemctl is-enabled "$unit" 2>/dev/null || printf 'unavailable'
  printf ' active='
  systemctl is-active "$unit" 2>/dev/null || printf 'unavailable'
  printf '\n'
}

account_names() {
  local source="$1"
  printf '\n[%s]\n' "$source"
  if ! command -v -- getent >/dev/null 2>&1; then
    printf 'unavailable: getent\n'
    return 0
  fi
  getent "$source" 2>&1 | awk -F: '{print $1}' || printf 'status: unavailable-or-permission-required\n'
}

REPORT_TEMP="$(mktemp --tmpdir="$FROM_DIR" ".debian-readiness.XXXXXXXX.tmp")"
CHECKSUM_TEMP="$(mktemp --tmpdir="$FROM_DIR" ".debian-readiness.XXXXXXXX.tmp")"

{
  section "Collection"
  printf 'utc=%s\n' "$TIMESTAMP"
  printf 'hostname=%s\n' "$SAFE_HOSTNAME"
  run_safe "collector SHA-256" sha256sum -- "$SCRIPT_PATH"

  section "Operating system"
  run_safe "os release" awk -F= '/^(PRETTY_NAME|ID|VERSION_ID)=/ { print $1 "=" $2 }' /etc/os-release
  run_safe "kernel release" uname -r
  run_safe "machine architecture" uname -m
  run_safe "virtualization" systemd-detect-virt

  section "Accounts"
  account_names passwd
  account_names group

  section "Compute and storage"
  run_safe "online processors" getconf _NPROCESSORS_ONLN
  run_safe "memory total" awk '/^MemTotal:/{print $1, $2, $3}' /proc/meminfo
  run_safe "block devices" lsblk --bytes --output NAME,TYPE,SIZE,FSTYPE,MOUNTPOINTS
  run_safe "mounted filesystems" df --block-size=1 --output=source,fstype,size,used,avail,pcent,target

  section "Network"
  run_safe "addresses" ip -brief address
  run_safe "routes" ip route show
  run_safe "nameservers" awk '/^nameserver[[:space:]]/ {print}' /etc/resolv.conf

  section "Time"
  run_safe "time status" timedatectl show --property=Timezone --property=NTPSynchronized --property=TimeUSec

  section "Prerequisites"
  version_or_unavailable "git" git
  version_or_unavailable "node" node
  version_or_unavailable "npm" npm
  version_or_unavailable "cloudflared" cloudflared
  version_or_unavailable "rsync" rsync
  version_or_unavailable "jq" jq
  version_or_unavailable "curl" curl
  version_or_unavailable "sha256sum" sha256sum
  version_or_unavailable "bash" bash
  version_or_unavailable "systemctl" systemctl

  section "Services"
  service_state ssh.service
  service_state qemu-guest-agent.service
  service_state systemd-timesyncd.service
  service_state palziv.service
  service_state cloudflared.service

  section "Firewall and listeners"
  run_safe "ufw status" ufw status
  run_safe "listening TCP and UDP sockets" ss -H -lntu

  section "Target directory metadata"
  run_safe "/opt/palziv" stat --format='%n|type=%F|owner=%U|group=%G|mode=%a' /opt/palziv
  run_safe "/opt/palziv/current" stat --format='%n|type=%F|owner=%U|group=%G|mode=%a' /opt/palziv/current
  run_safe "/var/lib/palziv" stat --format='%n|type=%F|owner=%U|group=%G|mode=%a' /var/lib/palziv
  run_safe "/var/lib/palziv/data" stat --format='%n|type=%F|owner=%U|group=%G|mode=%a' /var/lib/palziv/data
  run_safe "/etc/palziv" stat --format='%n|type=%F|owner=%U|group=%G|mode=%a' /etc/palziv
  run_safe "/etc/cloudflared" stat --format='%n|type=%F|owner=%U|group=%G|mode=%a' /etc/cloudflared
  run_safe "/var/backups/palziv" stat --format='%n|type=%F|owner=%U|group=%G|mode=%a' /var/backups/palziv

  section "Approved outbound checks"
  run_safe "nodejs.org DNS" getent ahosts nodejs.org
  run_safe "github.com DNS" getent ahosts github.com
  run_safe "api.open-meteo.com DNS" getent ahosts api.open-meteo.com
  run_safe "updates.cloudflare.com DNS" getent ahosts updates.cloudflare.com
  run_safe "nodejs.org HTTPS" curl --disable --noproxy '*' --proto =https --proto-redir =https --silent --show-error --output /dev/null --connect-timeout 5 --max-time 10 --write-out 'http-status=%{http_code}\n' https://nodejs.org
  run_safe "github.com HTTPS" curl --disable --noproxy '*' --proto =https --proto-redir =https --silent --show-error --output /dev/null --connect-timeout 5 --max-time 10 --write-out 'http-status=%{http_code}\n' https://github.com
  run_safe "api.open-meteo.com HTTPS" curl --disable --noproxy '*' --proto =https --proto-redir =https --silent --show-error --output /dev/null --connect-timeout 5 --max-time 10 --write-out 'http-status=%{http_code}\n' https://api.open-meteo.com
  run_safe "updates.cloudflare.com HTTPS" curl --disable --noproxy '*' --proto =https --proto-redir =https --silent --show-error --output /dev/null --connect-timeout 5 --max-time 10 --write-out 'http-status=%{http_code}\n' https://updates.cloudflare.com
} > "$REPORT_TEMP"

mv -- "$REPORT_TEMP" "$REPORT_FINAL"
REPORT_TEMP=""

(
  cd -- "$FROM_DIR"
  sha256sum -- "$(basename -- "$REPORT_FINAL")"
) > "$CHECKSUM_TEMP"
mv -- "$CHECKSUM_TEMP" "$CHECKSUM_FINAL"
CHECKSUM_TEMP=""
OUTPUT_COMPLETE=1

printf 'Report: %s\n' "$REPORT_FINAL"
printf 'Checksum: %s\n' "$CHECKSUM_FINAL"
