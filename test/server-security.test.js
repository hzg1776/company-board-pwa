import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
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

async function startServer(tempDir, port, extraEnv = {}) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_FILE: path.join(tempDir, "board.json"),
      PUSH_DATA_FILE: path.join(tempDir, "push.json"),
      ANALYTICS_DATA_FILE: path.join(tempDir, "analytics.json"),
      SECURITY_DATA_FILE: path.join(tempDir, "security.json"),
      ...extraEnv
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

async function startServerExpectFailure(tempDir, port, extraEnv = {}) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_FILE: path.join(tempDir, "board.json"),
      PUSH_DATA_FILE: path.join(tempDir, "push.json"),
      ANALYTICS_DATA_FILE: path.join(tempDir, "analytics.json"),
      SECURITY_DATA_FILE: path.join(tempDir, "security.json"),
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const exitCode = await new Promise((resolve) => {
    child.once("exit", resolve);
  });

  return {
    exitCode,
    stderr
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

async function startEmailSink() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let rawBody = "";
    for await (const chunk of req) {
      rawBody += chunk.toString();
    }

    requests.push({
      method: req.method,
      url: req.url,
      body: rawBody ? JSON.parse(rawBody) : {}
    });
    res.writeHead(200, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({ id: "email-1" }));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

test("server protects board reads and revokes disabled employees", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-server-managed-"));
  const securityFile = path.join(tempDir, "security.json");
  const provisionStore = createSecurityStore({ dataFile: securityFile });
  await provisionStore.init();
  await provisionStore.setupAdminAccess({
    username: "hr",
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
        endpoint: "https://fcm.googleapis.com/fcm/send/legacy-anonymous",
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

  const missingUsernameLogin = await fetch(`${server.baseUrl}/api/hr/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl
    },
    body: JSON.stringify({
      password: "ManagerSecret1!"
    })
  });
  assert.equal(missingUsernameLogin.status, 400);
  const missingUsernameBody = await missingUsernameLogin.json();
  assert.equal(missingUsernameBody.error, "HR username is required.");

  const adminLogin = await fetch(`${server.baseUrl}/api/hr/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl
    },
    body: JSON.stringify({
      username: "hr",
      password: "ManagerSecret1!"
    })
  });
  assert.equal(adminLogin.status, 200);
  const adminBody = await adminLogin.json();
  const adminCookie = readSetCookie(adminLogin);
  assert.ok(adminCookie.includes("palziv_hr_auth="));
  assert.ok(adminBody.csrfToken);

  const webmasterSetup = await fetch(`${server.baseUrl}/api/webmaster/setup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: adminCookie,
      "X-CSRF-Token": adminBody.csrfToken
    },
    body: JSON.stringify({
      username: "webmaster",
      password: "WebmasterSecret1!"
    })
  });
  assert.equal(webmasterSetup.status, 201);
  const webmasterCookie = readSetCookie(webmasterSetup);
  assert.ok(webmasterCookie.includes("palziv_webmaster_auth="));

  const missingWebmasterUsernameLogin = await fetch(`${server.baseUrl}/api/webmaster/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl
    },
    body: JSON.stringify({
      password: "WebmasterSecret1!"
    })
  });
  assert.equal(missingWebmasterUsernameLogin.status, 400);
  const missingWebmasterUsernameBody = await missingWebmasterUsernameLogin.json();
  assert.equal(missingWebmasterUsernameBody.error, "Webmaster username is required.");

  const webmasterLogin = await fetch(`${server.baseUrl}/api/webmaster/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl
    },
    body: JSON.stringify({
      username: "webmaster",
      password: "WebmasterSecret1!"
    })
  });
  assert.equal(webmasterLogin.status, 200);

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
        endpoint: "https://fcm.googleapis.com/fcm/send/allowed",
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

  const deniedAnonymousUnsubscribe = await fetch(`${server.baseUrl}/api/push/unsubscribe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl
    },
    body: JSON.stringify({
      endpoint: "https://fcm.googleapis.com/fcm/send/allowed"
    })
  });
  assert.equal(deniedAnonymousUnsubscribe.status, 401);

  const deniedCrossEmployeeUnsubscribe = await fetch(`${server.baseUrl}/api/push/unsubscribe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: employeeCookie
    },
    body: JSON.stringify({
      endpoint: "https://fcm.googleapis.com/fcm/send/legacy-anonymous"
    })
  });
  assert.equal(deniedCrossEmployeeUnsubscribe.status, 200);
  const deniedCrossEmployeeBody = await deniedCrossEmployeeUnsubscribe.json();
  assert.equal(Boolean(deniedCrossEmployeeBody.removed), false);

  const deniedAdminSubscribe = await fetch(`${server.baseUrl}/api/push/subscribe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: adminCookie
    },
    body: JSON.stringify({
      subscription: {
        endpoint: "https://fcm.googleapis.com/fcm/send/admin-denied",
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

  const spoofedSummary = await fetch(`${server.baseUrl}/api/webmaster/summary`, {
    headers: {
      Cookie: webmasterCookie,
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "https"
    }
  });
  assert.equal(spoofedSummary.status, 200);
  const spoofedSummaryBody = await spoofedSummary.json();
  assert.equal(spoofedSummaryBody.urls.origin, server.baseUrl);
  assert.equal(spoofedSummaryBody.urls.employee, `${server.baseUrl}/palzivalerts/employee`);

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

test("trusted proxy loopback honors forwarded client IPs for login throttling", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-server-proxy-"));
  const securityFile = path.join(tempDir, "security.json");
  const provisionStore = createSecurityStore({ dataFile: securityFile });
  await provisionStore.init();
  await provisionStore.createEmployeeAccount({
    name: "Maria Lopez",
    username: "maria.lopez",
    password: "EmployeePass1!"
  });
  await provisionStore.createEmployeeAccount({
    name: "John Smith",
    username: "john.smith",
    password: "EmployeePass2!"
  });

  const port = await findFreePort();
  const server = await startServer(tempDir, port, {
    TRUST_PROXY_ADDRESSES: "loopback"
  });

  t.after(async () => {
    await stopServer(server);
    await rm(tempDir, { recursive: true, force: true });
  });

  const statuses = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(`${server.baseUrl}/api/employee/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: server.baseUrl,
        "CF-Connecting-IP": "198.51.100.10"
      },
      body: JSON.stringify({
        username: "maria.lopez",
        password: "WrongPassword1!"
      })
    });
    statuses.push(response.status);
  }

  assert.ok(statuses.some((status) => status === 400));
  assert.ok(statuses.includes(429));

  const secondEmployeeLogin = await fetch(`${server.baseUrl}/api/employee/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      "CF-Connecting-IP": "198.51.100.11"
    },
    body: JSON.stringify({
      username: "john.smith",
      password: "EmployeePass2!"
    })
  });
  assert.equal(secondEmployeeLogin.status, 200);
});

test("server scopes the HR admin API to HR-only admin accounts", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-server-admin-users-"));
  const securityFile = path.join(tempDir, "security.json");
  const provisionStore = createSecurityStore({ dataFile: securityFile });
  await provisionStore.init();
  const hrSetup = await provisionStore.setupAdminAccess({
    username: "hr.owner",
    password: "ManagerSecret1!",
    userAgent: "test"
  });
  const webmasterSetup = await provisionStore.setupWebmasterAccess({
    username: "webmaster.owner",
    password: "WebmasterSecret1!",
    userAgent: "test"
  });

  const port = await findFreePort();
  const server = await startServer(tempDir, port);

  t.after(async () => {
    await stopServer(server);
    await rm(tempDir, { recursive: true, force: true });
  });

  const hrLogin = await fetch(`${server.baseUrl}/api/hr/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl
    },
    body: JSON.stringify({
      username: "hr.owner",
      password: "ManagerSecret1!"
    })
  });
  assert.equal(hrLogin.status, 200);
  const hrBody = await hrLogin.json();
  const hrCookie = readSetCookie(hrLogin);

  const listAdmins = await fetch(`${server.baseUrl}/api/admin-users`, {
    headers: {
      Cookie: hrCookie
    }
  });
  assert.equal(listAdmins.status, 200);
  const listAdminsBody = await listAdmins.json();
  assert.equal(Array.isArray(listAdminsBody.adminUsers), true);
  assert.equal(listAdminsBody.adminUsers.length, 1);
  assert.equal(listAdminsBody.adminUsers[0].username, "hr.owner");
  assert.equal(listAdminsBody.adminUsers[0].currentUser, true);
  assert.equal(listAdminsBody.adminUsers.some((adminUser) => adminUser.username === "webmaster.owner"), false);

  const deniedCreate = await fetch(`${server.baseUrl}/api/admin-users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: hrCookie,
      "X-CSRF-Token": hrBody.csrfToken
    },
    body: JSON.stringify({
      displayName: "Ops Admin",
      email: "ops.admin@example.com",
      username: "ops.admin",
      password: "OpsSecret1!",
      roles: ["webmaster"]
    })
  });
  assert.equal(deniedCreate.status, 400);
  const deniedCreateBody = await deniedCreate.json();
  assert.match(String(deniedCreateBody.error || ""), /HR cannot assign webmaster roles/i);

  const createAdmin = await fetch(`${server.baseUrl}/api/admin-users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: hrCookie,
      "X-CSRF-Token": hrBody.csrfToken
    },
    body: JSON.stringify({
      displayName: "Ops Admin",
      email: "ops.admin@example.com",
      username: "ops.admin",
      password: "OpsSecret1!",
      roles: ["hr"]
    })
  });
  assert.equal(createAdmin.status, 201);
  const createAdminBody = await createAdmin.json();
  assert.deepEqual(createAdminBody.adminUser.roles, ["hr"]);

  const adminLogin = await fetch(`${server.baseUrl}/api/hr/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl
    },
    body: JSON.stringify({
      username: "ops.admin",
      password: "OpsSecret1!"
    })
  });
  assert.equal(adminLogin.status, 200);
  const adminCookie = readSetCookie(adminLogin);

  const resetPassword = await fetch(`${server.baseUrl}/api/admin-users/${encodeURIComponent(createAdminBody.adminUser.id)}/password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: hrCookie,
      "X-CSRF-Token": hrBody.csrfToken
    },
    body: JSON.stringify({
      password: "OpsSecret2!"
    })
  });
  assert.equal(resetPassword.status, 200);

  const revokedCheck = await fetch(`${server.baseUrl}/api/hr/check`, {
    headers: {
      Cookie: adminCookie
    }
  });
  assert.equal(revokedCheck.status, 200);
  const revokedCheckBody = await revokedCheck.json();
  assert.equal(Boolean(revokedCheckBody.authorized), false);

  const relogin = await fetch(`${server.baseUrl}/api/hr/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl
    },
    body: JSON.stringify({
      username: "ops.admin",
      password: "OpsSecret2!"
    })
  });
  assert.equal(relogin.status, 200);

  const updateRoles = await fetch(`${server.baseUrl}/api/admin-users/${encodeURIComponent(webmasterSetup.user.id)}/roles`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: hrCookie,
      "X-CSRF-Token": hrBody.csrfToken
    },
    body: JSON.stringify({
      roles: ["hr"]
    })
  });
  assert.equal(updateRoles.status, 400);
  const updateRolesBody = await updateRoles.json();
  assert.match(String(updateRolesBody.error || ""), /HR cannot manage webmaster accounts/i);

  const resetWebmasterPassword = await fetch(`${server.baseUrl}/api/admin-users/${encodeURIComponent(webmasterSetup.user.id)}/password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: hrCookie,
      "X-CSRF-Token": hrBody.csrfToken
    },
    body: JSON.stringify({
      password: "WebmasterSecret2!"
    })
  });
  assert.equal(resetWebmasterPassword.status, 400);
  const resetWebmasterPasswordBody = await resetWebmasterPassword.json();
  assert.match(String(resetWebmasterPasswordBody.error || ""), /HR cannot manage webmaster accounts/i);

  const disableWebmaster = await fetch(`${server.baseUrl}/api/admin-users/${encodeURIComponent(webmasterSetup.user.id)}/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: hrCookie,
      "X-CSRF-Token": hrBody.csrfToken
    },
    body: JSON.stringify({
      active: false
    })
  });
  assert.equal(disableWebmaster.status, 400);
  const disableWebmasterBody = await disableWebmaster.json();
  assert.match(String(disableWebmasterBody.error || ""), /HR cannot manage webmaster accounts/i);

  const scopedListAgain = await fetch(`${server.baseUrl}/api/admin-users`, {
    headers: {
      Cookie: hrCookie
    }
  });
  assert.equal(scopedListAgain.status, 200);
  const scopedListAgainBody = await scopedListAgain.json();
  assert.equal(scopedListAgainBody.adminUsers.some((adminUser) => adminUser.id === webmasterSetup.user.id), false);
  assert.equal(scopedListAgainBody.adminUsers.some((adminUser) => adminUser.id === hrSetup.user.id), true);
});

test("server lets Webmaster reset the HR password and removes the old HR-to-Webmaster reset path", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-server-hr-password-reset-"));
  const securityFile = path.join(tempDir, "security.json");
  const provisionStore = createSecurityStore({ dataFile: securityFile });
  await provisionStore.init();
  await provisionStore.setupAdminAccess({
    username: "hr.owner",
    password: "ManagerSecret1!",
    userAgent: "test"
  });
  await provisionStore.setupWebmasterAccess({
    username: "webmaster.owner",
    password: "WebmasterSecret1!",
    userAgent: "test"
  });

  const port = await findFreePort();
  const server = await startServer(tempDir, port);

  t.after(async () => {
    await stopServer(server);
    await rm(tempDir, { recursive: true, force: true });
  });

  const hrLogin = await fetch(`${server.baseUrl}/api/hr/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl
    },
    body: JSON.stringify({
      username: "hr.owner",
      password: "ManagerSecret1!"
    })
  });
  assert.equal(hrLogin.status, 200);
  const hrBody = await hrLogin.json();
  const hrCookie = readSetCookie(hrLogin);

  const webmasterLogin = await fetch(`${server.baseUrl}/api/webmaster/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl
    },
    body: JSON.stringify({
      username: "webmaster.owner",
      password: "WebmasterSecret1!"
    })
  });
  assert.equal(webmasterLogin.status, 200);
  const webmasterBody = await webmasterLogin.json();
  const webmasterCookie = readSetCookie(webmasterLogin);

  const resetHrPassword = await fetch(`${server.baseUrl}/api/hr/password/reset`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: webmasterCookie,
      "X-CSRF-Token": webmasterBody.csrfToken
    },
    body: JSON.stringify({
      password: "ManagerSecret2!"
    })
  });
  assert.equal(resetHrPassword.status, 200);

  const revokedHrCheck = await fetch(`${server.baseUrl}/api/hr/check`, {
    headers: {
      Cookie: hrCookie
    }
  });
  assert.equal(revokedHrCheck.status, 200);
  const revokedHrBody = await revokedHrCheck.json();
  assert.equal(Boolean(revokedHrBody.authorized), false);

  const hrRelogin = await fetch(`${server.baseUrl}/api/hr/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl
    },
    body: JSON.stringify({
      username: "hr.owner",
      password: "ManagerSecret2!"
    })
  });
  assert.equal(hrRelogin.status, 200);

  const oldResetPath = await fetch(`${server.baseUrl}/api/webmaster/password/reset`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: hrCookie,
      "X-CSRF-Token": hrBody.csrfToken
    },
    body: JSON.stringify({
      password: "WebmasterSecret2!"
    })
  });
  assert.equal(oldResetPath.status, 404);
});

test("server supports invite-by-email admin onboarding", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-server-admin-invites-"));
  const securityFile = path.join(tempDir, "security.json");
  const provisionStore = createSecurityStore({ dataFile: securityFile });
  await provisionStore.init();
  await provisionStore.setupAdminAccess({
    username: "hr.owner",
    password: "ManagerSecret1!",
    userAgent: "test"
  });
  const emailSink = await startEmailSink();
  const port = await findFreePort();
  const server = await startServer(tempDir, port, {
    RESEND_API_KEY: "test-key",
    ADMIN_INVITE_EMAIL_FROM: "invites@example.com",
    RESEND_API_BASE_URL: emailSink.baseUrl
  });

  t.after(async () => {
    await stopServer(server);
    await emailSink.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const hrLogin = await fetch(`${server.baseUrl}/api/hr/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl
    },
    body: JSON.stringify({
      username: "hr.owner",
      password: "ManagerSecret1!"
    })
  });
  assert.equal(hrLogin.status, 200);
  const hrBody = await hrLogin.json();
  const hrCookie = readSetCookie(hrLogin);

  const inviteAdmin = await fetch(`${server.baseUrl}/api/admin-users/invite`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: hrCookie,
      "X-CSRF-Token": hrBody.csrfToken
    },
    body: JSON.stringify({
      displayName: "Avery Ops",
      email: "avery.ops@example.com",
      username: "avery.ops",
      roles: ["hr"]
    })
  });
  assert.equal(inviteAdmin.status, 201);
  const inviteAdminBody = await inviteAdmin.json();
  assert.equal(inviteAdminBody.emailDelivered, true);

  assert.equal(emailSink.requests.length, 1);
  const emailRequest = emailSink.requests[0];
  assert.equal(emailRequest.url, "/emails");
  assert.match(emailRequest.body.subject, /admin invitation/i);
  const inviteUrlMatch = String(emailRequest.body.text || "").match(/Accept invite: (.+)/);
  assert.ok(inviteUrlMatch);
  const inviteUrl = new URL(inviteUrlMatch[1].trim());
  const inviteToken = inviteUrl.searchParams.get("invite");
  assert.ok(inviteToken);

  const preview = await fetch(`${server.baseUrl}/api/admin-invites/preview?token=${encodeURIComponent(inviteToken)}`);
  assert.equal(preview.status, 200);
  const previewBody = await preview.json();
  assert.equal(previewBody.adminUser.displayName, "Avery Ops");
  assert.equal(previewBody.adminUser.email, "avery.ops@example.com");
  assert.equal(previewBody.adminUser.credentialsConfigured, false);

  const accept = await fetch(`${server.baseUrl}/api/admin-invites/accept`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl
    },
    body: JSON.stringify({
      token: inviteToken,
      password: "OpsSecret1!"
    })
  });
  assert.equal(accept.status, 200);
  const acceptBody = await accept.json();
  assert.deepEqual(acceptBody.roles, ["hr"]);
  const invitedHrCookie = readSetCookie(accept);
  assert.ok(invitedHrCookie.includes("palziv_hr_auth="));

  const hrCheck = await fetch(`${server.baseUrl}/api/hr/check`, {
    headers: {
      Cookie: invitedHrCookie
    }
  });
  assert.equal(hrCheck.status, 200);
  const hrCheckBody = await hrCheck.json();
  assert.equal(Boolean(hrCheckBody.authorized), true);

  const listAdmins = await fetch(`${server.baseUrl}/api/admin-users`, {
    headers: {
      Cookie: hrCookie
    }
  });
  assert.equal(listAdmins.status, 200);
  const listAdminsBody = await listAdmins.json();
  const invitedAdmin = listAdminsBody.adminUsers.find((adminUser) => adminUser.username === "avery.ops");
  assert.equal(invitedAdmin?.displayName, "Avery Ops");
  assert.equal(invitedAdmin?.email, "avery.ops@example.com");
  assert.equal(Boolean(invitedAdmin?.credentialsConfigured), true);
  assert.equal(invitedAdmin?.inviteState, "accepted");
});

test("server rejects runtime data files outside the managed runtime directory", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-server-runtime-paths-"));
  const runtimeDataDir = path.join(tempDir, "runtime-data");
  const publicDir = path.join(tempDir, "public-leak");
  await writeFile(path.join(tempDir, "board.json"), "{}\n", "utf8");

  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const port = await findFreePort();
  const failed = await startServerExpectFailure(tempDir, port, {
    RUNTIME_DATA_DIR: runtimeDataDir,
    DATA_FILE: path.join(runtimeDataDir, "board.json"),
    PUSH_DATA_FILE: path.join(runtimeDataDir, "push.json"),
    ANALYTICS_DATA_FILE: path.join(runtimeDataDir, "analytics.json"),
    SECURITY_DATA_FILE: path.join(publicDir, "security.json")
  });

  assert.notEqual(failed.exitCode, 0);
  assert.match(failed.stderr, /SECURITY_DATA_FILE must stay within RUNTIME_DATA_DIR/);
});
