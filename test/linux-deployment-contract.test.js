import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import test from "node:test";

async function readProjectFile(filePath) {
  return readFile(new URL(`../${filePath}`, import.meta.url), "utf8");
}

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function unusedPort() {
  const probe = net.createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test("Linux health check distinguishes a healthy local app from a failed public tunnel", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === "/api/health" ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: req.url === "/api/health" }));
  });
  const localPort = await listen(server);
  const deadPort = await unusedPort();

  try {
    const result = await runNode([
      "scripts/linux/health-check.mjs",
      "--local-url", `http://127.0.0.1:${localPort}`,
      "--public-url", `http://127.0.0.1:${deadPort}`,
      "--timeout-ms", "1000"
    ]);
    assert.equal(result.code, 2, result.stderr);
    const summary = JSON.parse(result.stdout.trim());
    assert.equal(summary.classification, "public-dns-or-tunnel-failure");
    assert.equal(summary.local.ok, true);
    assert.equal(summary.public.ok, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("systemd deployment contract is loopback-only, least-privilege, and restart-safe", async () => {
  const service = await readProjectFile("deploy/linux/palziv.service");
  const environment = await readProjectFile("deploy/linux/palziv.env.example");
  const backupService = await readProjectFile("deploy/linux/palziv-backup.service");
  const backupTimer = await readProjectFile("deploy/linux/palziv-backup.timer");
  const healthService = await readProjectFile("deploy/linux/palziv-health.service");
  const healthTimer = await readProjectFile("deploy/linux/palziv-health.timer");
  const backupWrapper = await readProjectFile("scripts/linux/run-backup.sh");

  assert.match(service, /^User=palziv$/m);
  assert.match(service, /^Group=palziv$/m);
  assert.match(service, /^EnvironmentFile=\/etc\/palziv\/palziv\.env$/m);
  assert.match(service, /^WorkingDirectory=\/opt\/palziv\/current$/m);
  assert.match(service, /^ExecStart=\/opt\/node\/bin\/node \/opt\/palziv\/current\/server\.js$/m);
  assert.match(service, /^Restart=on-failure$/m);
  assert.match(service, /^NoNewPrivileges=true$/m);
  assert.match(service, /^ProtectSystem=strict$/m);
  assert.match(service, /^ProtectHome=true$/m);
  assert.match(service, /^PrivateTmp=true$/m);
  assert.match(service, /^ReadWritePaths=\/var\/lib\/palziv\/data$/m);
  assert.match(environment, /^HOST=127\.0\.0\.1$/m);
  assert.match(environment, /^PORT=3116$/m);
  assert.match(environment, /^RUNTIME_DATA_DIR=\/var\/lib\/palziv\/data$/m);
  assert.match(environment, /^PUBLIC_BASE_URL=https:\/\/itotexpress\.com$/m);
  assert.match(environment, /^TRUST_PROXY_ADDRESSES=loopback$/m);
  assert.doesNotMatch(environment, /(?i:password|private.?key)\s*=\s*\S+/);
  assert.match(backupService, /^ExecStart=\/usr\/local\/sbin\/palziv-run-backup$/m);
  assert.match(backupTimer, /^OnCalendar=\*-\*-\* 02:45:00 America\/New_York$/m);
  assert.match(healthService, /^ExecStart=\/opt\/node\/bin\/node \/opt\/palziv\/current\/scripts\/linux\/health-check\.mjs/m);
  assert.match(healthTimer, /^OnUnitActiveSec=60s$/m);
  assert.match(backupWrapper, /systemctl stop palziv\.service/);
  assert.match(backupWrapper, /trap restart_app EXIT/);
  assert.match(backupWrapper, /systemctl start palziv\.service/);
  assert.match(backupWrapper, /health-check\.mjs/);
  assert.match(backupWrapper, /Backup completed, but local application health did not recover/);
});

test("Cloudflare, host bootstrap, and Proxmox artifacts enforce the approved architecture", async () => {
  const tunnel = await readProjectFile("deploy/linux/cloudflared-config.yml.example");
  const firewall = await readProjectFile("scripts/linux/configure-firewall.sh");
  const nodeInstaller = await readProjectFile("scripts/linux/install-node24.sh");
  const hostPrep = await readProjectFile("scripts/linux/prepare-host.sh");
  const releaseDeploy = await readProjectFile("scripts/linux/deploy-release.sh");
  const proxmox = await readProjectFile("scripts/proxmox/create-debian13-vm.sh");

  assert.match(tunnel, /hostname: itotexpress\.com/);
  assert.match(tunnel, /hostname: www\.itotexpress\.com/);
  assert.match(tunnel, /service: http:\/\/127\.0\.0\.1:3116/);
  assert.match(tunnel, /service: http_status:404/);
  assert.match(firewall, /ufw default deny incoming/);
  assert.match(firewall, /ufw allow from "\$MANAGEMENT_SUBNET" to any port 22 proto tcp/);
  assert.doesNotMatch(firewall, /allow .*3116/);
  assert.match(nodeInstaller, /NODE_VERSION="v24\.18\.0"/);
  assert.match(nodeInstaller, /55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742/);
  assert.doesNotMatch(nodeInstaller, /latest-v24\.x/);
  assert.match(nodeInstaller, /sha256sum --check/);
  assert.match(hostPrep, /qemu-guest-agent/);
  assert.match(hostPrep, /unattended-upgrades/);
  assert.match(hostPrep, /systemd-timesyncd/);
  assert.match(hostPrep, /systemctl enable --now systemd-timesyncd\.service/);
  assert.match(hostPrep, /groupadd --system cloudflared/);
  assert.match(hostPrep, /useradd --system --gid cloudflared/);
  assert.doesNotMatch(hostPrep, /\baddgroup\b/);
  assert.match(hostPrep, /\/etc\/cloudflared/);
  assert.match(releaseDeploy, /npm ci --omit=dev/);
  assert.match(releaseDeploy, /--exclude='local-secrets'/);
  assert.match(releaseDeploy, /--exclude='runtime'/);
  assert.match(releaseDeploy, /if \[\[ -d "\$RELEASE_DIR" \]\]/);
  assert.match(releaseDeploy, /ln -s "\$RELEASE_DIR" "\$NEXT_LINK"/);
  assert.match(proxmox, /--memory 4096/);
  assert.match(proxmox, /--cores 2/);
  assert.match(proxmox, /--machine q35/);
  assert.match(proxmox, /--scsihw virtio-scsi-single/);
  assert.match(proxmox, /discard=on,iothread=1,ssd=1/);
  assert.match(proxmox, /--agent enabled=1,fstrim_cloned_disks=1/);
  assert.match(proxmox, /qm disk resize "\$VMID" scsi0 40G/);
  assert.match(proxmox, /qm set "\$VMID" --onboot 1/);
});
