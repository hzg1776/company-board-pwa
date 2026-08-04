#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

if [[ "$(uname -m)" != "x86_64" ]]; then
  echo "Unsupported architecture: $(uname -m)" >&2
  exit 1
fi

NODE_VERSION="v24.18.0"
ARCHIVE="node-${NODE_VERSION}-linux-x64.tar.xz"
ARCHIVE_SHA256="55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742"
BASE_URL="https://nodejs.org/dist/${NODE_VERSION}"
VERSION_DIR="${ARCHIVE%.tar.xz}"

TMP_ROOT="$(mktemp -d /var/tmp/palziv-node24.XXXXXX)"
cleanup() {
  local resolved
  resolved="$(realpath "$TMP_ROOT")"
  if [[ "$resolved" == /var/tmp/palziv-node24.* ]]; then
    rm -rf -- "$resolved"
  fi
}
trap cleanup EXIT

curl --fail --silent --show-error --location "$BASE_URL/$ARCHIVE" --output "$TMP_ROOT/$ARCHIVE"
(
  cd "$TMP_ROOT"
  printf '%s  %s\n' "$ARCHIVE_SHA256" "$ARCHIVE" | sha256sum --check -
)

if [[ ! -d "/opt/$VERSION_DIR" ]]; then
  tar -xJf "$TMP_ROOT/$ARCHIVE" -C /opt
fi
ln -sfn "/opt/$VERSION_DIR" /opt/node
/opt/node/bin/node --version
/opt/node/bin/npm --version
