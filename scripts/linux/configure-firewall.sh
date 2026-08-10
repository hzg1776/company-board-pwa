#!/usr/bin/env bash
set -Eeuo pipefail

MANAGEMENT_SUBNET="${1:-}"
if [[ -z "$MANAGEMENT_SUBNET" ]]; then
  echo "Usage: $0 <management-subnet-cidr>" >&2
  exit 2
fi

ufw default deny incoming
ufw default allow outgoing
ufw allow from "$MANAGEMENT_SUBNET" to any port 22 proto tcp
ufw --force enable
ufw status verbose
