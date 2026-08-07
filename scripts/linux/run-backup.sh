#!/usr/bin/env bash
set -Eeuo pipefail

APP_WAS_ACTIVE=0
if systemctl is-active --quiet palziv.service; then
  APP_WAS_ACTIVE=1
fi

restart_app() {
  if [[ "$APP_WAS_ACTIVE" -eq 1 ]]; then
    systemctl start palziv.service
  fi
}

trap restart_app EXIT

if [[ "$APP_WAS_ACTIVE" -eq 1 ]]; then
  systemctl stop palziv.service
fi

RELEASE_SHA="$(basename "$(readlink -f /opt/palziv/current)")"
/opt/node/bin/node /opt/palziv/current/scripts/linux/backup-runtime.mjs \
  --data-dir /var/lib/palziv/data \
  --output-dir /var/backups/palziv \
  --release-sha "$RELEASE_SHA" \
  --daily-retention 14 \
  --weekly-retention 8

if [[ "$APP_WAS_ACTIVE" -eq 1 ]]; then
  systemctl start palziv.service
  APP_WAS_ACTIVE=0
  LOCAL_HEALTHY=0
  for _attempt in {1..30}; do
    if /opt/node/bin/node /opt/palziv/current/scripts/linux/health-check.mjs \
      --local-url http://127.0.0.1:3116 \
      --public-url http://127.0.0.1:3116 \
      --timeout-ms 1000 >/dev/null; then
      LOCAL_HEALTHY=1
      break
    fi
    sleep 1
  done

  if [[ "$LOCAL_HEALTHY" -ne 1 ]]; then
    echo "Backup completed, but local application health did not recover within 30 seconds." >&2
    exit 1
  fi
fi
