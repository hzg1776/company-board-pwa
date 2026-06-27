import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  assert.equal(spoofedSummaryBody.urls.it, `${server.baseUrl}/palzivalerts/it`);

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

test("employees can acknowledge important posts and HR sees acknowledgement totals", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-server-ack-"));
  const securityFile = path.join(tempDir, "security.json");
  const provisionStore = createSecurityStore({ dataFile: securityFile });
  await provisionStore.init();
  await provisionStore.setupAdminAccess({
    username: "hr",
    password: "ManagerSecret1!",
    userAgent: "test"
  });
  await provisionStore.createEmployeeAccount({
    name: "Maria Lopez",
    username: "maria.lopez",
    password: "EmployeePass1!"
  });
  await provisionStore.createEmployeeAccount({
    name: "Alex Smith",
    username: "alex.smith",
    password: "EmployeePass1!"
  });

  const port = await findFreePort();
  const server = await startServer(tempDir, port);

  t.after(async () => {
    await stopServer(server);
    await rm(tempDir, { recursive: true, force: true });
  });

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

  const createdPostResponse = await fetch(`${server.baseUrl}/api/posts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: adminCookie,
      "X-CSRF-Token": adminBody.csrfToken
    },
    body: JSON.stringify({
      type: "Safety",
      priority: "Important",
      title: "PPE reminder",
      body: "Safety glasses are required on the floor.",
      audience: "All employees"
    })
  });
  assert.equal(createdPostResponse.status, 201);
  const createdPostBody = await createdPostResponse.json();

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

  const acknowledgementResponse = await fetch(`${server.baseUrl}/api/posts/${encodeURIComponent(createdPostBody.post.id)}/acknowledgements`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: employeeCookie
    },
    body: JSON.stringify({})
  });
  assert.equal(acknowledgementResponse.status, 201);
  const acknowledgementBody = await acknowledgementResponse.json();
  assert.equal(acknowledgementBody.acknowledgement.employeeName, "Maria Lopez");

  const duplicateResponse = await fetch(`${server.baseUrl}/api/posts/${encodeURIComponent(createdPostBody.post.id)}/acknowledgements`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: employeeCookie
    },
    body: JSON.stringify({})
  });
  assert.equal(duplicateResponse.status, 200);

  const hrPostsResponse = await fetch(`${server.baseUrl}/api/posts`, {
    headers: {
      Cookie: adminCookie
    }
  });
  assert.equal(hrPostsResponse.status, 200);
  const hrPostsBody = await hrPostsResponse.json();
  const post = hrPostsBody.posts.find((entry) => entry.id === createdPostBody.post.id);
  assert.equal(post.acknowledgementSummary.acknowledged, 1);
  assert.equal(post.acknowledgementSummary.totalEmployees, 2);
  assert.equal(post.acknowledgementSummary.pending, 1);
  assert.equal(post.acknowledgements[0].employeeName, "Maria Lopez");
  assert.equal(post.pendingAcknowledgements.length, 1);
  assert.equal(post.pendingAcknowledgements[0].employeeName, "Alex Smith");
  assert.equal(post.pendingAcknowledgements[0].username, "alex.smith");
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

test("server scopes the webmaster admin API to webmaster-role admin accounts", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-server-webmaster-admin-users-"));
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

  const listAdmins = await fetch(`${server.baseUrl}/api/webmaster/admin-users`, {
    headers: {
      Cookie: webmasterCookie
    }
  });
  assert.equal(listAdmins.status, 200);
  const listAdminsBody = await listAdmins.json();
  assert.equal(Array.isArray(listAdminsBody.adminUsers), true);
  assert.equal(listAdminsBody.adminUsers.length, 1);
  assert.equal(listAdminsBody.adminUsers[0].username, "webmaster.owner");
  assert.equal(listAdminsBody.adminUsers[0].currentUser, true);
  assert.equal(listAdminsBody.adminUsers.some((adminUser) => adminUser.username === "hr.owner"), false);

  const deniedCreate = await fetch(`${server.baseUrl}/api/webmaster/admin-users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: webmasterCookie,
      "X-CSRF-Token": webmasterBody.csrfToken
    },
    body: JSON.stringify({
      displayName: "Only HR",
      email: "only.hr@example.com",
      username: "only.hr",
      password: "OnlyHrSecret1!",
      roles: ["hr"]
    })
  });
  assert.equal(deniedCreate.status, 400);
  const deniedCreateBody = await deniedCreate.json();
  assert.match(String(deniedCreateBody.error || ""), /Webmaster admin accounts must include the webmaster role/i);

  const createAdmin = await fetch(`${server.baseUrl}/api/webmaster/admin-users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: webmasterCookie,
      "X-CSRF-Token": webmasterBody.csrfToken
    },
    body: JSON.stringify({
      displayName: "Ops Webmaster",
      email: "ops.webmaster@example.com",
      username: "ops.webmaster",
      password: "OpsWebmaster1!",
      roles: ["webmaster"]
    })
  });
  assert.equal(createAdmin.status, 201);
  const createAdminBody = await createAdmin.json();
  assert.deepEqual(createAdminBody.adminUser.roles, ["webmaster"]);

  const invitedAdmin = await fetch(`${server.baseUrl}/api/webmaster/admin-users/invite`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: webmasterCookie,
      "X-CSRF-Token": webmasterBody.csrfToken
    },
    body: JSON.stringify({
      displayName: "Jamie Webmaster",
      email: "jamie.webmaster@example.com",
      username: "jamie.webmaster",
      roles: ["webmaster"]
    })
  });
  assert.equal(invitedAdmin.status, 201);
  const invitedAdminBody = await invitedAdmin.json();
  assert.equal(Boolean(invitedAdminBody.adminUser.invitePending), true);

  const managedLogin = await fetch(`${server.baseUrl}/api/webmaster/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl
    },
    body: JSON.stringify({
      username: "ops.webmaster",
      password: "OpsWebmaster1!"
    })
  });
  assert.equal(managedLogin.status, 200);
  const managedCookie = readSetCookie(managedLogin);

  const resetPassword = await fetch(`${server.baseUrl}/api/webmaster/admin-users/${encodeURIComponent(createAdminBody.adminUser.id)}/password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: webmasterCookie,
      "X-CSRF-Token": webmasterBody.csrfToken
    },
    body: JSON.stringify({
      password: "OpsWebmaster2!"
    })
  });
  assert.equal(resetPassword.status, 200);

  const revokedCheck = await fetch(`${server.baseUrl}/api/webmaster/check`, {
    headers: {
      Cookie: managedCookie
    }
  });
  assert.equal(revokedCheck.status, 200);
  const revokedCheckBody = await revokedCheck.json();
  assert.equal(Boolean(revokedCheckBody.authorized), false);

  const relogin = await fetch(`${server.baseUrl}/api/webmaster/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl
    },
    body: JSON.stringify({
      username: "ops.webmaster",
      password: "OpsWebmaster2!"
    })
  });
  assert.equal(relogin.status, 200);

  const deniedHrMutation = await fetch(`${server.baseUrl}/api/webmaster/admin-users/${encodeURIComponent(hrSetup.user.id)}/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: webmasterCookie,
      "X-CSRF-Token": webmasterBody.csrfToken
    },
    body: JSON.stringify({
      active: false
    })
  });
  assert.equal(deniedHrMutation.status, 400);
  const deniedHrMutationBody = await deniedHrMutation.json();
  assert.match(String(deniedHrMutationBody.error || ""), /Webmaster can only manage webmaster accounts/i);

  const scopedListAgain = await fetch(`${server.baseUrl}/api/webmaster/admin-users`, {
    headers: {
      Cookie: webmasterCookie
    }
  });
  assert.equal(scopedListAgain.status, 200);
  const scopedListAgainBody = await scopedListAgain.json();
  assert.equal(scopedListAgainBody.adminUsers.some((adminUser) => adminUser.id === hrSetup.user.id), false);
  assert.equal(scopedListAgainBody.adminUsers.some((adminUser) => adminUser.id === webmasterSetup.user.id), true);
  assert.equal(scopedListAgainBody.adminUsers.some((adminUser) => adminUser.id === createAdminBody.adminUser.id), true);
});

test("server supports IT admin governance and protects IT role boundaries", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-server-it-admin-users-"));
  const securityFile = path.join(tempDir, "security.json");
  const provisionStore = createSecurityStore({ dataFile: securityFile });
  await provisionStore.init();
  const itSetup = await provisionStore.setupItAccess({
    username: "it",
    password: "OwnerSecret1!",
    userAgent: "test"
  });
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

  const itLogin = await fetch(`${server.baseUrl}/api/it/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl
    },
    body: JSON.stringify({
      username: "it",
      password: "OwnerSecret1!"
    })
  });
  assert.equal(itLogin.status, 200);
  const itBody = await itLogin.json();
  const itCookie = readSetCookie(itLogin);
  assert.equal(itBody.user.username, "it");
  assert.deepEqual(itBody.user.roles, ["it"]);
  assert.match(itCookie, /palziv_it_auth=/);

  const itCheck = await fetch(`${server.baseUrl}/api/it/check`, {
    headers: {
      Cookie: itCookie
    }
  });
  assert.equal(itCheck.status, 200);
  const itCheckBody = await itCheck.json();
  assert.equal(Boolean(itCheckBody.authorized), true);

  const listAdmins = await fetch(`${server.baseUrl}/api/it/admin-users`, {
    headers: {
      Cookie: itCookie
    }
  });
  assert.equal(listAdmins.status, 200);
  const listAdminsBody = await listAdmins.json();
  assert.equal(Array.isArray(listAdminsBody.adminUsers), true);
  assert.equal(listAdminsBody.adminUsers.length, 3);
  assert.equal(listAdminsBody.adminUsers.some((adminUser) => adminUser.username === "it"), true);
  assert.equal(listAdminsBody.adminUsers.some((adminUser) => adminUser.username === "hr.owner"), true);
  assert.equal(listAdminsBody.adminUsers.some((adminUser) => adminUser.username === "webmaster.owner"), true);

  const createAdmin = await fetch(`${server.baseUrl}/api/it/admin-users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: itCookie,
      "X-CSRF-Token": itBody.csrfToken
    },
    body: JSON.stringify({
      displayName: "Operations Lead",
      email: "ops.lead@example.com",
      username: "ops.lead",
      password: "OpsLeadSecret1!",
      roles: ["webmaster"]
    })
  });
  assert.equal(createAdmin.status, 201);
  const createAdminBody = await createAdmin.json();
  assert.deepEqual(createAdminBody.adminUser.roles, ["webmaster"]);

  const securityEvents = await fetch(`${server.baseUrl}/api/security/events`, {
    headers: {
      Cookie: itCookie
    }
  });
  assert.equal(securityEvents.status, 200);
  const securityEventsBody = await securityEvents.json();
  const createEvent = Array.isArray(securityEventsBody.events)
    ? securityEventsBody.events.find((event) => String(event.accountKey || "") === "ops.lead")
    : null;
  assert.equal(createEvent?.type, "it_admin_created");
  assert.equal(createEvent?.actor, "it");

  const updateProfile = await fetch(`${server.baseUrl}/api/it/admin-users/${encodeURIComponent(createAdminBody.adminUser.id)}/profile`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: itCookie,
      "X-CSRF-Token": itBody.csrfToken
    },
    body: JSON.stringify({
      displayName: "Operations Director",
      email: "ops.director@example.com"
    })
  });
  assert.equal(updateProfile.status, 200);
  const updateProfileBody = await updateProfile.json();
  assert.equal(updateProfileBody.adminUser.displayName, "Operations Director");

  const managedLogin = await fetch(`${server.baseUrl}/api/webmaster/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl
    },
    body: JSON.stringify({
      username: "ops.lead",
      password: "OpsLeadSecret1!"
    })
  });
  assert.equal(managedLogin.status, 200);
  const managedCookie = readSetCookie(managedLogin);

  const resetPassword = await fetch(`${server.baseUrl}/api/it/admin-users/${encodeURIComponent(createAdminBody.adminUser.id)}/password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: itCookie,
      "X-CSRF-Token": itBody.csrfToken
    },
    body: JSON.stringify({
      password: "OpsLeadSecret2!"
    })
  });
  assert.equal(resetPassword.status, 200);

  const revokedCheck = await fetch(`${server.baseUrl}/api/webmaster/check`, {
    headers: {
      Cookie: managedCookie
    }
  });
  assert.equal(revokedCheck.status, 200);
  const revokedCheckBody = await revokedCheck.json();
  assert.equal(Boolean(revokedCheckBody.authorized), false);

  const createInvitedAdmin = await fetch(`${server.baseUrl}/api/it/admin-users/invite`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: itCookie,
      "X-CSRF-Token": itBody.csrfToken
    },
    body: JSON.stringify({
      displayName: "Invited IT",
      email: "invited.owner@example.com",
      username: "invited.owner",
      roles: ["it"]
    })
  });
  assert.equal(createInvitedAdmin.status, 201);
  const createInvitedAdminBody = await createInvitedAdmin.json();
  assert.equal(Boolean(createInvitedAdminBody.adminUser.invitePending), true);

  const resendInvite = await fetch(`${server.baseUrl}/api/it/admin-users/${encodeURIComponent(createInvitedAdminBody.adminUser.id)}/invite`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: itCookie,
      "X-CSRF-Token": itBody.csrfToken
    }
  });
  assert.equal(resendInvite.status, 200);

  const reloginManaged = await fetch(`${server.baseUrl}/api/webmaster/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl
    },
    body: JSON.stringify({
      username: "ops.lead",
      password: "OpsLeadSecret2!"
    })
  });
  assert.equal(reloginManaged.status, 200);
  const reloginManagedCookie = readSetCookie(reloginManaged);

  const revokeSessions = await fetch(`${server.baseUrl}/api/it/admin-users/${encodeURIComponent(createAdminBody.adminUser.id)}/sessions/revoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: itCookie,
      "X-CSRF-Token": itBody.csrfToken
    }
  });
  assert.equal(revokeSessions.status, 200);

  const revokedAgainCheck = await fetch(`${server.baseUrl}/api/webmaster/check`, {
    headers: {
      Cookie: reloginManagedCookie
    }
  });
  assert.equal(revokedAgainCheck.status, 200);
  const revokedAgainCheckBody = await revokedAgainCheck.json();
  assert.equal(Boolean(revokedAgainCheckBody.authorized), false);

  const createItAdmin = await fetch(`${server.baseUrl}/api/it/admin-users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: itCookie,
      "X-CSRF-Token": itBody.csrfToken
    },
    body: JSON.stringify({
      displayName: "Backup IT",
      email: "backup.owner@example.com",
      username: "backup.owner",
      password: "BackupOwner1!",
      roles: ["it"]
    })
  });
  assert.equal(createItAdmin.status, 201);
  const createItAdminBody = await createItAdmin.json();
  assert.deepEqual(createItAdminBody.adminUser.roles, ["it"]);

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

  const deniedHrOwnerCreate = await fetch(`${server.baseUrl}/api/admin-users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: hrCookie,
      "X-CSRF-Token": hrBody.csrfToken
    },
    body: JSON.stringify({
      displayName: "HR IT Attempt",
      email: "hr.owner.attempt@example.com",
      username: "hr.owner.attempt",
      password: "OwnerAttempt1!",
      roles: ["it"]
    })
  });
  assert.equal(deniedHrOwnerCreate.status, 400);
  const deniedHrOwnerCreateBody = await deniedHrOwnerCreate.json();
  assert.match(String(deniedHrOwnerCreateBody.error || ""), /HR cannot assign IT roles/i);

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

  const deniedWebmasterOwnerCreate = await fetch(`${server.baseUrl}/api/webmaster/admin-users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: webmasterCookie,
      "X-CSRF-Token": webmasterBody.csrfToken
    },
    body: JSON.stringify({
      displayName: "Systems IT Attempt",
      email: "it.owner.attempt@example.com",
      username: "it.owner.attempt",
      password: "OwnerAttempt1!",
      roles: ["it"]
    })
  });
  assert.equal(deniedWebmasterOwnerCreate.status, 400);
  const deniedWebmasterOwnerCreateBody = await deniedWebmasterOwnerCreate.json();
  assert.match(String(deniedWebmasterOwnerCreateBody.error || ""), /Webmaster cannot assign IT roles/i);

  const demoteSelf = await fetch(`${server.baseUrl}/api/it/admin-users/${encodeURIComponent(itSetup.user.id)}/roles`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: itCookie,
      "X-CSRF-Token": itBody.csrfToken
    },
    body: JSON.stringify({
      roles: ["hr"]
    })
  });
  assert.equal(demoteSelf.status, 400);
  const demoteSelfBody = await demoteSelf.json();
  assert.match(String(demoteSelfBody.error || ""), /You cannot remove your own IT role while signed in/i);

  const disableBackupIt = await fetch(`${server.baseUrl}/api/it/admin-users/${encodeURIComponent(createItAdminBody.adminUser.id)}/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: itCookie,
      "X-CSRF-Token": itBody.csrfToken
    },
    body: JSON.stringify({
      active: false
    })
  });
  assert.equal(disableBackupIt.status, 200);

  const disableLastIt = await fetch(`${server.baseUrl}/api/it/admin-users/${encodeURIComponent(itSetup.user.id)}/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: itCookie,
      "X-CSRF-Token": itBody.csrfToken
    },
    body: JSON.stringify({
      active: false
    })
  });
  assert.equal(disableLastIt.status, 400);
  const disableLastItBody = await disableLastIt.json();
  assert.match(String(disableLastItBody.error || ""), /You cannot disable your own IT account while signed in/i);
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

test("IT invitation emails point invitees to the IT route", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-server-it-invites-"));
  const securityFile = path.join(tempDir, "security.json");
  const provisionStore = createSecurityStore({ dataFile: securityFile });
  await provisionStore.init();
  await provisionStore.setupItAccess({
    username: "it",
    password: "OwnerSecret1!",
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

  const itLogin = await fetch(`${server.baseUrl}/api/it/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl
    },
    body: JSON.stringify({
      username: "it",
      password: "OwnerSecret1!"
    })
  });
  assert.equal(itLogin.status, 200);
  const itBody = await itLogin.json();
  const itCookie = readSetCookie(itLogin);

  const inviteItAdmin = await fetch(`${server.baseUrl}/api/it/admin-users/invite`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: itCookie,
      "X-CSRF-Token": itBody.csrfToken
    },
    body: JSON.stringify({
      displayName: "Backup IT",
      email: "backup.owner@example.com",
      username: "backup.owner",
      roles: ["it"]
    })
  });
  assert.equal(inviteItAdmin.status, 201);
  assert.equal(emailSink.requests.length, 1);

  const emailRequest = emailSink.requests[0];
  const inviteUrlMatch = String(emailRequest.body.text || "").match(/Accept invite: (.+)/);
  assert.ok(inviteUrlMatch);
  const inviteUrl = new URL(inviteUrlMatch[1].trim());
  assert.equal(inviteUrl.pathname, "/palzivalerts/it");
});

test("legacy owner URL aliases are no longer served", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-server-legacy-owner-route-alias-"));
  const port = await findFreePort();
  const server = await startServer(tempDir, port);

  t.after(async () => {
    await stopServer(server);
    await rm(tempDir, { recursive: true, force: true });
  });

  const legacyOwnerRootAlias = await fetch(`${server.baseUrl}/owner`, {
    redirect: "manual"
  });
  assert.equal(legacyOwnerRootAlias.status, 404);

  const legacyOwnerBrandedAlias = await fetch(`${server.baseUrl}/palzivalerts/owner`, {
    redirect: "manual"
  });
  assert.equal(legacyOwnerBrandedAlias.status, 404);
});

test("legacy HR admin check alias is no longer served", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-server-legacy-admin-check-"));
  const port = await findFreePort();
  const server = await startServer(tempDir, port);

  t.after(async () => {
    await stopServer(server);
    await rm(tempDir, { recursive: true, force: true });
  });

  const legacyAdminCheck = await fetch(`${server.baseUrl}/api/admin/check`);
  assert.equal(legacyAdminCheck.status, 404);
  const legacyAdminCheckBody = await legacyAdminCheck.json();
  assert.equal(legacyAdminCheckBody.error, "API route not found.");
});

test("client app exposes direct launcher logins without a dedicated admin gateway", async () => {
  const appSource = await readFile(path.join(process.cwd(), "public", "app.js"), "utf8");
  const launcherStart = appSource.indexOf("function renderLauncher()");
  const renderStart = appSource.indexOf("function render(");
  const launcherSource = launcherStart >= 0 && renderStart > launcherStart
    ? appSource.slice(launcherStart, renderStart)
    : "";

  assert.match(launcherSource, /Employee Login/);
  assert.match(launcherSource, /HR Login/);
  assert.match(launcherSource, /Systems and Analytics Login/);
  assert.match(launcherSource, /IT Login/);
  assert.doesNotMatch(appSource, /function renderAdminGateway\(\)/);
  assert.doesNotMatch(appSource, /if \(route === "admin"\) return appPath\("admin"\);/);
  assert.doesNotMatch(appSource, /route === "admin"/);
  assert.doesNotMatch(appSource, /data-admin-entry-route/);
  assert.match(appSource, /function renderLauncherAdminCard\(route, title\)/);
  assert.match(appSource, /href="\$\{escapeHtml\(routePath\(route\)\)\}" data-route="\$\{escapeHtml\(route\)\}"/);
});

test("client app does not ship placeholder helper text in username or password inputs", async () => {
  const appSource = await readFile(path.join(process.cwd(), "public", "app.js"), "utf8");
  const credentialInputs = Array.from(
    appSource.matchAll(/<input\b[^>]*(?:name="username"|type="password")[^>]*>/g)
  ).map((match) => match[0]);

  assert.ok(credentialInputs.length > 0);

  for (const inputMarkup of credentialInputs) {
    assert.doesNotMatch(inputMarkup, /\splaceholder=/);
  }
});

test("client app does not ship static explanatory copy across the live screens", async () => {
  const appSource = await readFile(path.join(process.cwd(), "public", "app.js"), "utf8");
  const removedCopy = [
    "Create a clear employee update and choose exactly who should receive it.",
    "Important and urgent updates notify employees automatically. Routine updates stay in the feed unless you choose to send an alert.",
    "Narrow the feed with a dropdown before deleting or reviewing older updates.",
    "Review the latest failed logins, throttles, and lockouts across HR, Systems, and employee sign-in.",
    "These counters are drawn from the most recent persisted security events.",
    "Quick status for the site, the host, and the copy-ready brief.",
    "These counts show how the site is being used and where errors are happening.",
    "Use this tab to see the server, browser, and performance environment behind the portal.",
    "See what is live, what is urgent, and what is about to expire.",
    "Use these buttons to move the snapshot into Codex without rebuilding the context by hand.",
    "Use this area for company profile, billing contact, data-retention, and compliance defaults once those services are connected.",
    "Keep at least two active named IT accounts. Do not use shared master credentials for emergency access.",
    "Checking the invitation details.",
    "Google Authenticator is active for this account. Use the current 6-digit code whenever this role requires step-up verification."
  ];
  const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  for (const copy of removedCopy) {
    assert.doesNotMatch(appSource, new RegExp(escapeRegex(copy)));
  }
});

test("manifest shortcuts do not expose privileged routes directly", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-server-manifest-gateway-"));
  const port = await findFreePort();
  const server = await startServer(tempDir, port);

  t.after(async () => {
    await stopServer(server);
    await rm(tempDir, { recursive: true, force: true });
  });

  const response = await fetch(`${server.baseUrl}/manifest.webmanifest`);
  assert.equal(response.status, 200);

  const manifest = await response.json();
  const shortcutUrls = Array.isArray(manifest.shortcuts)
    ? manifest.shortcuts.map((shortcut) => String(shortcut?.url || ""))
    : [];

  assert.equal(manifest.start_url, "/palzivalerts/employee");
  assert.equal(shortcutUrls.includes("/palzivalerts"), false);
  assert.ok(shortcutUrls.includes("/palzivalerts/employee"));
  assert.equal(shortcutUrls.includes("/palzivalerts/hr"), false);
  assert.equal(shortcutUrls.includes("/palzivalerts/webmaster"), false);
  assert.equal(shortcutUrls.includes("/palzivalerts/it"), false);
});

test("legacy owner cookie alias no longer authorizes IT access", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-server-legacy-owner-cookie-alias-"));
  const securityFile = path.join(tempDir, "security.json");
  const provisionStore = createSecurityStore({ dataFile: securityFile });
  await provisionStore.init();
  const itSetup = await provisionStore.setupItAccess({
    username: "it",
    password: "OwnerSecret1!",
    userAgent: "test"
  });

  const port = await findFreePort();
  const server = await startServer(tempDir, port);

  t.after(async () => {
    await stopServer(server);
    await rm(tempDir, { recursive: true, force: true });
  });

  const legacyOwnerCookieCheck = await fetch(`${server.baseUrl}/api/it/check`, {
    headers: {
      Cookie: `palziv_owner_auth=${itSetup.sessionId}`
    }
  });
  assert.equal(legacyOwnerCookieCheck.status, 200);
  const legacyOwnerCookieCheckBody = await legacyOwnerCookieCheck.json();
  assert.equal(Boolean(legacyOwnerCookieCheckBody.authorized), false);
  const legacyOwnerCookieRolloverHeader = legacyOwnerCookieCheck.headers.get("set-cookie") || "";
  assert.equal(legacyOwnerCookieRolloverHeader, "");
});

test("server leaves admin MFA off by default even when accounts have stored MFA secrets", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-server-admin-mfa-disabled-"));
  const securityFile = path.join(tempDir, "security.json");
  const provisionStore = createSecurityStore({ dataFile: securityFile });
  await provisionStore.init();
  await provisionStore.setupAdminAccess({
    username: "hr.owner",
    password: "ManagerSecret1!",
    userAgent: "test"
  });
  const seededState = await provisionStore.readSecurityState();
  const hrUser = seededState.adminUsers.find((adminUser) => adminUser.username === "hr.owner");
  hrUser.mfaSecret = "JBSWY3DPEHPK3PXP";
  hrUser.mfaEnabledAt = "2026-06-22T12:00:00.000Z";
  hrUser.mfaGraceUntil = "";
  await provisionStore.writeData(seededState);

  const port = await findFreePort();
  const server = await startServer(tempDir, port);

  t.after(async () => {
    await stopServer(server);
    await rm(tempDir, { recursive: true, force: true });
  });

  const login = await fetch(`${server.baseUrl}/api/hr/login`, {
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
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  assert.equal(Boolean(loginBody.authorized), true);
  assert.equal(Boolean(loginBody.mfaRequired), false);
  assert.equal(Boolean(loginBody.user?.mfa?.available), false);
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

test("server reloads index and service worker templates without a process restart", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-server-shell-reload-"));
  const publicDir = path.join(tempDir, "public");
  await mkdir(publicDir, { recursive: true });
  await writeFile(path.join(publicDir, "index.html"), "<!doctype html><html><body>alpha-shell __ASSET_VERSION__</body></html>\n", "utf8");
  await writeFile(path.join(publicDir, "sw.js"), "self.__shellVersion = 'alpha-sw-__ASSET_VERSION__';\n", "utf8");
  await writeFile(path.join(publicDir, "app.js"), "console.log('alpha-app');\n", "utf8");
  await writeFile(path.join(publicDir, "styles.css"), "body { color: black; }\n", "utf8");
  await writeFile(path.join(publicDir, "sw-routing.js"), "export {};\n", "utf8");

  const port = await findFreePort();
  const server = await startServer(tempDir, port, {
    PUBLIC_DIR: publicDir
  });

  t.after(async () => {
    await stopServer(server);
    await rm(tempDir, { recursive: true, force: true });
  });

  const firstIndex = await fetch(`${server.baseUrl}/palzivalerts/`);
  assert.equal(firstIndex.status, 200);
  const firstIndexHtml = await firstIndex.text();
  assert.match(firstIndexHtml, /alpha-shell/i);

  const firstSw = await fetch(`${server.baseUrl}/sw.js`);
  assert.equal(firstSw.status, 200);
  const firstSwText = await firstSw.text();
  assert.match(firstSwText, /alpha-sw/i);

  await writeFile(path.join(publicDir, "index.html"), "<!doctype html><html><body>beta-shell __ASSET_VERSION__</body></html>\n", "utf8");
  await writeFile(path.join(publicDir, "sw.js"), "self.__shellVersion = 'beta-sw-__ASSET_VERSION__';\n", "utf8");

  const secondIndex = await fetch(`${server.baseUrl}/palzivalerts/`);
  assert.equal(secondIndex.status, 200);
  const secondIndexHtml = await secondIndex.text();
  assert.match(secondIndexHtml, /beta-shell/i);

  const secondSw = await fetch(`${server.baseUrl}/sw.js`);
  assert.equal(secondSw.status, 200);
  const secondSwText = await secondSw.text();
  assert.match(secondSwText, /beta-sw/i);
});
