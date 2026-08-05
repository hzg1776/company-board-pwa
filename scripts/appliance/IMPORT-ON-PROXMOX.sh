#!/usr/bin/env bash
set -Eeuo pipefail

trap 'rc=$?; printf "STOP: import failed at line %s (status %s). The VM remains stopped for inspection.\n" "$LINENO" "$rc" >&2; exit "$rc"' ERR

readonly VMID="${VMID:?Set VMID}"
readonly IMAGE_PATH="${IMAGE_PATH:?Set IMAGE_PATH}"
readonly STORAGE="${STORAGE:?Set STORAGE}"
readonly BRIDGE="${BRIDGE:?Set BRIDGE}"
readonly SSH_KEY_FILE="${SSH_KEY_FILE:?Set SSH_KEY_FILE}"
readonly IP_CONFIG="${IP_CONFIG:-ip=dhcp}"
readonly VM_NAME="${VM_NAME:-palziv-prod}"

[[ "$EUID" -eq 0 ]]
[[ "$VMID" =~ ^[1-9][0-9]{2,8}$ ]]
[[ "$STORAGE" =~ ^[A-Za-z0-9._-]{1,64}$ ]]
[[ "$BRIDGE" =~ ^[A-Za-z0-9._-]{1,64}$ ]]
[[ "$VM_NAME" =~ ^[A-Za-z0-9._-]{1,64}$ ]]
[[ "$IMAGE_PATH" == /* && -f "$IMAGE_PATH" && ! -L "$IMAGE_PATH" ]]
[[ "$SSH_KEY_FILE" == /* && -f "$SSH_KEY_FILE" && ! -L "$SSH_KEY_FILE" ]]
command -v qm >/dev/null
command -v qemu-img >/dev/null
command -v sha256sum >/dev/null

image_dir="$(realpath -e -- "$(dirname -- "$IMAGE_PATH")")"
image_name="$(basename -- "$IMAGE_PATH")"
image_real="$(realpath -e -- "$IMAGE_PATH")"
key_real="$(realpath -e -- "$SSH_KEY_FILE")"
[[ "$image_real" == "$image_dir/$image_name" ]]
case "$image_real" in /|/etc|/var|/var/lib|/root) exit 1 ;; esac
case "$key_real" in /|/etc|/var|/var/lib|/root) exit 1 ;; esac
[[ -f "$image_dir/ARTIFACTS.sha256" && ! -L "$image_dir/ARTIFACTS.sha256" ]]

mapfile -t image_checks < <(awk -v name="$image_name" '$2 == name { print }' "$image_dir/ARTIFACTS.sha256")
[[ "${#image_checks[@]}" -eq 1 ]]
[[ "${image_checks[0]}" =~ ^[a-f0-9]{64}\ \ [A-Za-z0-9._-]+$ ]]
(cd -- "$image_dir" && printf '%s\n' "${image_checks[0]}" | sha256sum --check --strict)
qemu-img check -- "$image_real"

if qm status "$VMID" >/dev/null 2>&1; then
  printf 'VMID %s already exists; refusing to modify it.\n' "$VMID" >&2
  exit 1
fi

qm create "$VMID" --name "$VM_NAME" --ostype l26 --machine q35 --cpu host \
  --cores 2 --memory 4096 --scsihw virtio-scsi-single \
  --agent enabled=1,fstrim_cloned_disks=1 \
  --net0 "virtio,bridge=${BRIDGE},firewall=1" --serial0 socket --vga serial0
qm disk import "$VMID" "$image_real" "$STORAGE" --format qcow2
imported="$(qm config "$VMID" | awk -F': ' '/^unused[0-9]+:/ { sub(/,.*/, "", $2); print $2 }' | tail -n1)"
[[ -n "$imported" ]]
qm set "$VMID" --scsi0 "${imported},discard=on,iothread=1,ssd=1"
qm set "$VMID" --ide2 "${STORAGE}:cloudinit" --boot order=scsi0
qm set "$VMID" --ciuser palziv-admin --sshkeys "$key_real" --ipconfig0 "$IP_CONFIG"
qm set "$VMID" --onboot 1 --tags 'production;palziv'
qm config "$VMID"
printf '%s\n' 'IMPORT COMPLETE: VM remains stopped. Review networking and firewall before first boot.'
