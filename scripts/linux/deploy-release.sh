#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

SOURCE_ROOT="${1:-$(pwd)}"
RELEASE_SHA="${2:-$(git -C "$SOURCE_ROOT" rev-parse HEAD)}"
RELEASE_DIR="/opt/palziv/releases/$RELEASE_SHA"
NEXT_LINK="/opt/palziv/current.next"

if [[ -d "$RELEASE_DIR" ]]; then
  if [[ -L "$RELEASE_DIR" ]]; then
    echo "Release directory must not be a symbolic link: $RELEASE_DIR" >&2
    exit 1
  fi
elif [[ -e "$RELEASE_DIR" ]]; then
  echo "Release path is not a directory: $RELEASE_DIR" >&2
  exit 1
else
  install -d -o root -g palziv -m 0750 "$RELEASE_DIR"
fi

rsync -a --delete \
  --exclude='.git' \
  --exclude='.worktrees' \
  --exclude='node_modules' \
  --exclude='local-secrets' \
  --exclude='runtime' \
  --exclude='backups' \
  "$SOURCE_ROOT/" "$RELEASE_DIR/"

(
  cd "$RELEASE_DIR"
  /opt/node/bin/npm ci --omit=dev
)

chown -R root:palziv "$RELEASE_DIR"
chmod -R u=rwX,g=rX,o= "$RELEASE_DIR"
rm -f -- "$NEXT_LINK"
ln -s "$RELEASE_DIR" "$NEXT_LINK"
mv -Tf "$NEXT_LINK" /opt/palziv/current
echo "$RELEASE_SHA"
