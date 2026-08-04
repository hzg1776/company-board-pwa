#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
. /etc/os-release
if [[ "${ID:-}" != "debian" || "${VERSION_ID:-}" != "13" ]]; then
  echo "Debian 13 is required; detected ${PRETTY_NAME:-unknown}." >&2
  exit 1
fi

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates curl git jq rsync tar ufw unattended-upgrades qemu-guest-agent systemd-timesyncd

if ! getent group palziv >/dev/null; then
  groupadd --system palziv
fi
if ! id palziv >/dev/null 2>&1; then
  useradd --system --gid palziv --home-dir /var/lib/palziv --no-create-home --shell /usr/sbin/nologin palziv
fi
if ! getent group cloudflared >/dev/null; then
  groupadd --system cloudflared
fi
if ! id cloudflared >/dev/null 2>&1; then
  useradd --system --gid cloudflared --home-dir /var/lib/cloudflared --no-create-home --shell /usr/sbin/nologin cloudflared
fi

install -d -o root -g palziv -m 0750 /opt/palziv/releases
install -d -o palziv -g palziv -m 0700 /var/lib/palziv/data
install -d -o root -g palziv -m 0750 /var/backups/palziv
install -d -o root -g palziv -m 0750 /etc/palziv
install -d -o root -g cloudflared -m 0750 /etc/cloudflared
install -d -o root -g root -m 0755 /etc/systemd/journald.conf.d

install -o root -g root -m 0750 "$PROJECT_ROOT/scripts/linux/run-backup.sh" /usr/local/sbin/palziv-run-backup
install -o root -g root -m 0644 "$PROJECT_ROOT/deploy/linux/palziv.service" /etc/systemd/system/palziv.service
install -o root -g root -m 0644 "$PROJECT_ROOT/deploy/linux/palziv-backup.service" /etc/systemd/system/palziv-backup.service
install -o root -g root -m 0644 "$PROJECT_ROOT/deploy/linux/palziv-backup.timer" /etc/systemd/system/palziv-backup.timer
install -o root -g root -m 0644 "$PROJECT_ROOT/deploy/linux/palziv-health.service" /etc/systemd/system/palziv-health.service
install -o root -g root -m 0644 "$PROJECT_ROOT/deploy/linux/palziv-health.timer" /etc/systemd/system/palziv-health.timer
install -o root -g root -m 0644 "$PROJECT_ROOT/deploy/linux/cloudflared.service" /etc/systemd/system/cloudflared.service
install -o root -g root -m 0644 "$PROJECT_ROOT/deploy/linux/journald.conf" /etc/systemd/journald.conf.d/palziv.conf

if [[ ! -e /etc/palziv/palziv.env ]]; then
  install -o root -g palziv -m 0640 "$PROJECT_ROOT/deploy/linux/palziv.env.example" /etc/palziv/palziv.env
fi

systemctl daemon-reload
systemctl enable --now qemu-guest-agent.service
systemctl enable --now systemd-timesyncd.service
systemctl enable palziv-backup.timer palziv-health.timer
systemctl restart systemd-journald.service
echo "Host prepared. Configure secrets, restore data, and install the tunnel credential before starting services."
