import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function startHealthServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/api/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false }));
    });

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        port: typeof address === "object" && address ? address.port : 0,
        baseUrl: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`
      });
    });
  });
}

function runWatchdogScript({ runtimeRoot, baseUrl, localPort }) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(process.cwd(), "scripts", "tunnel-watchdog.ps1"),
      "-ProjectRoot",
      process.cwd(),
      "-RuntimeRoot",
      runtimeRoot,
      "-PublicBaseUrl",
      baseUrl,
      "-LocalPort",
      String(localPort),
      "-PublicTimeoutSec",
      "2",
      "-LocalTimeoutSec",
      "2",
      "-RecoveryWaitSec",
      "1"
    ], {
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

    child.once("error", reject);
    child.once("exit", (code) => {
      resolve({
        code,
        stdout,
        stderr
      });
    });
  });
}

test("watchdog script reads persisted state under Windows PowerShell", {
  skip: process.platform === "win32" ? false : "Windows-only watchdog compatibility check."
}, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-watchdog-script-"));
  const runtimeRoot = path.join(tempDir, "runtime");
  const logDirectory = path.join(runtimeRoot, "logs");
  const stateFile = path.join(logDirectory, "tunnel-watchdog.state.json");
  const { server, baseUrl, port } = await startHealthServer();

  try {
    await mkdir(logDirectory, { recursive: true });
    await writeFile(stateFile, JSON.stringify({
      lastAlertAt: "2026-06-18T15:30:00.000Z",
      lastAlertKey: "origin-down",
      lastRecoveryAt: "2026-06-18T15:20:00.000Z"
    }, null, 2));

    const result = await runWatchdogScript({
      runtimeRoot,
      baseUrl,
      localPort: port
    });

    assert.equal(result.code, 0, result.stderr || result.stdout);

    const logPath = path.join(logDirectory, "tunnel-watchdog.log");
    const logContents = await readFile(logPath, "utf8");

    assert.ok(!logContents.includes("Could not read watchdog state"), logContents);
    assert.ok(logContents.includes("Public health ok."), logContents);
  } finally {
    server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});
