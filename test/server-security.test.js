import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cookiePair(setCookieHeader) {
  return String(setCookieHeader || "").split(";")[0];
}

function responseSetCookies(response) {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }

  const single = response.headers.get("set-cookie");
  return single ? [single] : [];
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }

        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });
  });
}

async function waitForHealth(baseUrl, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);

      if (response.ok) {
        return;
      }
    } catch {
      // Wait for the next probe.
    }

    await sleep(100);
  }

  throw new Error(`Timed out waiting for ${baseUrl}/api/health`);
}

async function startServer(tempDir, port) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HR_PIN: "1234-5678",
      SESSION_SECRET: "abcdef0123456789abcdef0123456789",
      DATA_FILE: path.join(tempDir, "board.json"),
      PUSH_DATA_FILE: path.join(tempDir, "push.json"),
      ANALYTICS_DATA_FILE: path.join(tempDir, "analytics.json"),
      SECURITY_DATA_FILE: path.join(tempDir, "security.json")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);

  return {
    child,
    baseUrl,
    stderr: () => stderr
  };
}

async function stopServer(server) {
  if (!server?.child || server.child.killed) {
    return;
  }

  server.child.kill();
  await new Promise((resolve) => {
    server.child.once("exit", resolve);
    setTimeout(resolve, 5_000);
  });
}

test("server enforces same-origin and csrf on privileged mutations", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-server-security-"));
  const port = await findFreePort();
  const approvedUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0 Safari/537.36";
  let server = await startServer(tempDir, port);

  t.after(async () => {
    await stopServer(server);
    await rm(tempDir, { recursive: true, force: true });
  });

  const crossSiteUnlock = await fetch(`${server.baseUrl}/api/hr/unlock`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://evil.example"
    },
    body: JSON.stringify({ pin: "1234-5678" })
  });
  assert.equal(crossSiteUnlock.status, 403);

  const unlockResponse = await fetch(`${server.baseUrl}/api/hr/unlock`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl
    },
    body: JSON.stringify({ pin: "1234-5678" })
  });
  assert.equal(unlockResponse.status, 200);

  const unlockBody = await unlockResponse.json();
  const hrCookie = cookiePair(responseSetCookies(unlockResponse)[0]);
  assert.ok(hrCookie.startsWith("palziv_hr_auth="));
  assert.ok(unlockBody.csrfToken);

  const rejectedPost = await fetch(`${server.baseUrl}/api/posts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: hrCookie
    },
    body: JSON.stringify({
      type: "News",
      priority: "Normal",
      title: "CSRF blocked",
      body: "This request should be rejected.",
      audience: "All employees"
    })
  });
  assert.equal(rejectedPost.status, 403);

  const allowedPost = await fetch(`${server.baseUrl}/api/posts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: hrCookie,
      "X-CSRF-Token": unlockBody.csrfToken
    },
    body: JSON.stringify({
      type: "News",
      priority: "Normal",
      title: "CSRF allowed",
      body: "This request should be accepted.",
      audience: "All employees"
    })
  });
  assert.equal(allowedPost.status, 201);

  const rejectedWeather = await fetch(`${server.baseUrl}/api/weather`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Cookie: hrCookie
    },
    body: JSON.stringify({ location: "New York, NY" })
  });
  assert.equal(rejectedWeather.status, 403);

  const approveResponse = await fetch(`${server.baseUrl}/api/webmaster/approve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: hrCookie,
      "X-CSRF-Token": unlockBody.csrfToken,
      "User-Agent": approvedUserAgent
    },
    body: JSON.stringify({
      label: "Office Chrome",
      browser: "Chrome",
      platform: "Windows",
      userAgent: approvedUserAgent
    })
  });
  assert.equal(approveResponse.status, 200);

  const approveBody = await approveResponse.json();
  const webmasterCookie = cookiePair(responseSetCookies(approveResponse)[0]);
  assert.ok(webmasterCookie.startsWith("palziv_webmaster_auth="));
  assert.ok(approveBody.csrfToken);

  const rejectedPin = await fetch(`${server.baseUrl}/api/push/pin`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: webmasterCookie,
      "User-Agent": approvedUserAgent
    },
    body: JSON.stringify({})
  });
  assert.equal(rejectedPin.status, 403);

  const allowedPin = await fetch(`${server.baseUrl}/api/push/pin`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: webmasterCookie,
      "User-Agent": approvedUserAgent,
      "X-CSRF-Token": approveBody.csrfToken
    },
    body: JSON.stringify({})
  });
  assert.equal(allowedPin.status, 201);

  await stopServer(server);
  server = await startServer(tempDir, await findFreePort());

  const persistedApproval = await fetch(`${server.baseUrl}/api/webmaster/check`, {
    headers: {
      Cookie: webmasterCookie,
      "User-Agent": approvedUserAgent
    }
  });
  assert.equal(persistedApproval.status, 200);

  const persistedApprovalBody = await persistedApproval.json();
  assert.equal(Boolean(persistedApprovalBody.authorized), true);
  assert.equal(String(persistedApprovalBody.approvedBrowser?.label || ""), "Office Chrome");
});
