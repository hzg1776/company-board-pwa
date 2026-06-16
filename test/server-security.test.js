import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSecurityStore } from "../security.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function readSetCookie(response) {
  const value = response.headers.get("set-cookie") || "";
  return value.split(";")[0];
}

test("server protects board reads and revokes disabled employees", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-server-managed-"));
  const securityFile = path.join(tempDir, "security.json");
  const provisionStore = createSecurityStore({ dataFile: securityFile });
  await provisionStore.init();
  await provisionStore.setupAdminAccess({
    password: "ManagerSecret1!",
    userAgent: "test"
  });
  const employeeResult = await provisionStore.createEmployeeAccount({
    name: "Maria Lopez",
    username: "maria.lopez",
    password: "EmployeePass1!"
  });
  await writeFile(path.join(tempDir, "push.json"), `${JSON.stringify({
    subscriptions: [
      {
        endpoint: "https://push.example.com/endpoint/legacy-anonymous",
        expirationTime: null,
        keys: {
          p256dh: "legacy-public-key",
          auth: "legacy-auth-key"
        },
        deviceId: "legacy-anonymous-device",
        label: "Legacy anonymous device",
        browser: "Chrome",
        platform: "Windows",
        authorized: true
      }
    ]
  }, null, 2)}\n`, "utf8");

  const port = await findFreePort();
  const server = await startServer(tempDir, port);

  t.after(async () => {
    await stopServer(server);
    await rm(tempDir, { recursive: true, force: true });
  });

  const hrCheck = await fetch(`${server.baseUrl}/api/hr/check`);
  assert.equal(hrCheck.status, 200);
  const hrCheckBody = await hrCheck.json();
  assert.equal(Boolean(hrCheckBody.authorized), false);
  assert.equal(Boolean(hrCheckBody.setupRequired), false);

  const adminLogin = await fetch(`${server.baseUrl}/api/hr/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl
    },
    body: JSON.stringify({
      password: "ManagerSecret1!"
    })
  });
  assert.equal(adminLogin.status, 200);
  const adminBody = await adminLogin.json();
  const adminCookie = readSetCookie(adminLogin);
  assert.ok(adminCookie.includes("palziv_hr_auth="));
  assert.ok(adminBody.csrfToken);

  const crossSitePost = await fetch(`${server.baseUrl}/api/posts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://evil.example",
      Cookie: adminCookie,
      "X-CSRF-Token": adminBody.csrfToken
    },
    body: JSON.stringify({
      type: "News",
      priority: "Normal",
      title: "Blocked cross-site post",
      body: "This should be rejected.",
      audience: "All employees"
    })
  });
  assert.equal(crossSitePost.status, 403);

  const allowedPost = await fetch(`${server.baseUrl}/api/posts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: adminCookie,
      "X-CSRF-Token": adminBody.csrfToken
    },
    body: JSON.stringify({
      type: "News",
      priority: "Normal",
      title: "Allowed same-origin post",
      body: "This should be accepted.",
      audience: "All employees"
    })
  });
  assert.equal(allowedPost.status, 201);

  const employeeLogin = await fetch(`${server.baseUrl}/api/employee/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl
    },
    body: JSON.stringify({
      username: "maria.lopez",
      password: "EmployeePass1!"
    })
  });
  assert.equal(employeeLogin.status, 200);
  const employeeCookie = readSetCookie(employeeLogin);
  assert.ok(employeeCookie.includes("palziv_employee_auth="));

  const employeePosts = await fetch(`${server.baseUrl}/api/posts`, {
    headers: {
      Cookie: employeeCookie
    }
  });
  assert.equal(employeePosts.status, 200);

  const allowedSubscribe = await fetch(`${server.baseUrl}/api/push/subscribe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: employeeCookie
    },
    body: JSON.stringify({
      subscription: {
        endpoint: "https://push.example.com/endpoint/allowed",
        expirationTime: null,
        keys: {
          p256dh: "sample-public-key",
          auth: "sample-auth-key"
        }
      },
      deviceId: "allowed-device",
      label: "Maria phone",
      browser: "Chrome",
      platform: "Windows"
    })
  });
  assert.equal(allowedSubscribe.status, 201);

  const deniedAdminSubscribe = await fetch(`${server.baseUrl}/api/push/subscribe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: adminCookie
    },
    body: JSON.stringify({
      subscription: {
        endpoint: "https://push.example.com/endpoint/admin-denied",
        expirationTime: null,
        keys: {
          p256dh: "sample-public-key",
          auth: "sample-auth-key"
        }
      },
      deviceId: "admin-denied-device",
      label: "Admin device",
      browser: "Chrome",
      platform: "Windows"
    })
  });
  assert.equal(deniedAdminSubscribe.status, 403);

  const disableEmployee = await fetch(`${server.baseUrl}/api/employees/${employeeResult.employee.id}/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: adminCookie,
      "X-CSRF-Token": adminBody.csrfToken
    },
    body: JSON.stringify({
      active: false
    })
  });
  assert.equal(disableEmployee.status, 200);

  const revokedEmployeePosts = await fetch(`${server.baseUrl}/api/posts`, {
    headers: {
      Cookie: employeeCookie
    }
  });
  assert.equal(revokedEmployeePosts.status, 401);

  const pushStatus = await fetch(`${server.baseUrl}/api/push/status`, {
    headers: {
      Cookie: adminCookie
    }
  });
  assert.equal(pushStatus.status, 200);
  const pushBody = await pushStatus.json();
  assert.equal(Number(pushBody.subscriptions), 2);
  assert.equal(Number(pushBody.authorizedSubscriptions), 0);
  assert.ok(pushBody.devices.some((device) => device.accessState === "Unbound"));

  const removedHrRoute = await fetch(`${server.baseUrl}/api/hr/unlock`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: adminCookie,
      "X-CSRF-Token": adminBody.csrfToken
    },
    body: JSON.stringify({})
  });
  assert.equal(removedHrRoute.status, 404);

  const removedPushRoute = await fetch(`${server.baseUrl}/api/push/pin`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: adminCookie,
      "X-CSRF-Token": adminBody.csrfToken
    },
    body: JSON.stringify({})
  });
  assert.equal(removedPushRoute.status, 404);
});
