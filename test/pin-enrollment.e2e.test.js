import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSecurityStore } from "../security.js";

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Users\\admin\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"
].filter(Boolean);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileExists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function findChromeExecutable() {
  for (const candidate of CHROME_CANDIDATES) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return null;
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

async function waitForHttpJson(url, predicate = () => true, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);

      if (response.ok) {
        const body = await response.json();

        if (predicate(body)) {
          return body;
        }

        lastError = `Unexpected payload from ${url}`;
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await sleep(100);
  }

  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}

async function waitForHttpOk(url, timeoutMs = 15_000) {
  return waitForHttpJson(url, (body) => Boolean(body && body.ok), timeoutMs);
}

async function startBoardServer({ port, tempDir }) {
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

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  await waitForHttpOk(`http://127.0.0.1:${port}/api/health`);
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr
  };
}

async function startChrome(chromePath) {
  const port = await findFreePort();
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "palziv-chrome-"));
  const child = spawn(chromePath, [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-background-networking",
    `--user-data-dir=${userDataDir}`,
    "about:blank"
  ], {
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

  const version = await waitForHttpJson(
    `http://127.0.0.1:${port}/json/version`,
    (body) => Boolean(body?.webSocketDebuggerUrl),
    20_000
  );

  return {
    child,
    port,
    userDataDir,
    webSocketDebuggerUrl: version.webSocketDebuggerUrl,
    stdout: () => stdout,
    stderr: () => stderr
  };
}

function createCdpConnection(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  const listeners = new Map();
  let nextId = 0;
  let readyResolve;
  let readyReject;

  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  socket.addEventListener("open", () => {
    readyResolve();
  });

  socket.addEventListener("error", (error) => {
    readyReject(error instanceof Error ? error : new Error("Chrome CDP connection failed."));
  });

  socket.addEventListener("close", () => {
    const closeError = new Error("Chrome CDP connection closed.");

    for (const entry of pending.values()) {
      entry.reject(closeError);
    }
    pending.clear();
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);

    if (message.id) {
      const entry = pending.get(message.id);

      if (!entry) {
        return;
      }

      pending.delete(message.id);

      if (message.error) {
        entry.reject(new Error(message.error.message || "Chrome CDP command failed."));
      } else {
        entry.resolve(message.result || {});
      }

      return;
    }

    const handlers = listeners.get(message.method);

    if (!handlers) {
      return;
    }

    for (const handler of [...handlers]) {
      handler(message);
    }
  });

  function send(method, params = {}, sessionId = null) {
    const id = ++nextId;
    const payload = { id, method };

    if (params && Object.keys(params).length > 0) {
      payload.params = params;
    }

    if (sessionId) {
      payload.sessionId = sessionId;
    }

    socket.send(JSON.stringify(payload));

    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  }

  function on(method, handler) {
    const handlers = listeners.get(method) || new Set();
    handlers.add(handler);
    listeners.set(method, handlers);

    return () => {
      handlers.delete(handler);

      if (handlers.size === 0) {
        listeners.delete(method);
      }
    };
  }

  function waitForEvent(method, predicate = () => true, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        off();
        reject(new Error(`Timed out waiting for CDP event: ${method}`));
      }, timeoutMs);

      const off = on(method, (message) => {
        if (!predicate(message)) {
          return;
        }

        clearTimeout(timeout);
        off();
        resolve(message);
      });
    });
  }

  async function close() {
    socket.close();
  }

  return {
    ready,
    send,
    waitForEvent,
    close
  };
}

async function createPageSession(connection) {
  const { targetId } = await connection.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await connection.send("Target.attachToTarget", {
    targetId,
    flatten: true
  });

  const session = {
    sessionId,
    send(method, params = {}) {
      return connection.send(method, params, sessionId);
    },
    waitForEvent(method, predicate = () => true, timeoutMs = 10_000) {
      return connection.waitForEvent(
        method,
        (message) => message.sessionId === sessionId && predicate(message),
        timeoutMs
      );
    }
  };

  await session.send("Page.enable");
  await session.send("Runtime.enable");
  await session.send("Network.enable");

  return session;
}

async function evaluateExpression(session, expression) {
  const result = await session.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });

  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Chrome expression evaluation failed.");
  }

  return result.result?.value;
}

async function waitForCondition(session, expression, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = await evaluateExpression(session, expression);

    if (value) {
      return value;
    }

    await sleep(100);
  }

  throw new Error(`Timed out waiting for condition: ${expression}`);
}

async function navigate(session, url) {
  const loadEvent = session.waitForEvent("Page.loadEventFired");
  await session.send("Page.navigate", { url });
  await loadEvent;
}

async function cleanupProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill();

  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function removeDirectoryWithRetries(targetPath, attempts = 6) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rm(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      const retryable = ["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code);

      if (!retryable || attempt === attempts - 1) {
        if (!retryable) {
          throw error;
        }

        return;
      }

      await sleep(250 * (attempt + 1));
    }
  }
}

async function startChromeSession(chromePath, attempts = 3) {
  let lastError = new Error("Chrome session could not be started.");

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const chrome = await startChrome(chromePath);
    let connection = null;

    try {
      connection = createCdpConnection(chrome.webSocketDebuggerUrl);
      await connection.ready;
      await connection.send("Browser.getVersion");
      return { chrome, connection };
    } catch (error) {
      const detail = [
        error instanceof Error ? error.message : String(error),
        chrome.stderr().trim(),
        chrome.stdout().trim()
      ].filter(Boolean).join("\n");

      lastError = new Error(`Chrome launch attempt ${attempt + 1} failed.\n${detail}`);

      if (connection) {
        await connection.close().catch(() => {});
      }

      await cleanupProcess(chrome.child);
      await removeDirectoryWithRetries(chrome.userDataDir);

      if (attempt < attempts - 1) {
        await sleep(500 * (attempt + 1));
      }
    }
  }

  throw lastError;
}

async function provisionManagedAccess(tempDir, options = {}) {
  const store = createSecurityStore({
    dataFile: path.join(tempDir, "security.json")
  });
  await store.init();

  if (options.itPassword) {
    await store.setupItAccess({
      username: options.itUsername || "it",
      password: options.itPassword,
      userAgent: "e2e"
    });
  }

  if (options.adminPassword) {
    await store.setupAdminAccess({
      username: options.adminUsername || "hr",
      password: options.adminPassword,
      userAgent: "e2e"
    });
  }

  if (options.employeeUsername && options.employeePassword) {
    await store.createEmployeeAccount({
      name: options.employeeName || options.employeeUsername,
      username: options.employeeUsername,
      password: options.employeePassword
    });
  }
}

const chromePath = await findChromeExecutable();

test(
  "employee setup submits the push path when the browser omits submitter metadata",
  {
    skip: chromePath ? false : "Chrome executable not found.",
    timeout: 120_000
  },
  async (t) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-open-e2e-"));
    await provisionManagedAccess(tempDir, {
      employeeName: "Test Employee",
      employeeUsername: "test.employee",
      employeePassword: "EmployeePass1!"
    });
    const serverPort = await findFreePort();
    const server = await startBoardServer({
      port: serverPort,
      tempDir
    });
    const { chrome, connection } = await startChromeSession(chromePath);

    t.after(async () => {
      await connection.close();
      await cleanupProcess(chrome.child);
      await cleanupProcess(server.child);
      await removeDirectoryWithRetries(tempDir);
      await removeDirectoryWithRetries(chrome.userDataDir);
    });

    await connection.ready;
    await connection.send("Browser.grantPermissions", {
      origin: `http://127.0.0.1:${serverPort}`,
      permissions: ["notifications"]
    });

    const session = await createPageSession(connection);
    const appOrigin = `http://127.0.0.1:${serverPort}`;

    await navigate(session, `${appOrigin}/palzivalerts/employee`);
    await waitForCondition(session, "document.readyState === 'complete'");
    await waitForCondition(session, "Boolean(document.querySelector('[data-employee-login-form]'))");
    await evaluateExpression(session, `
      (() => {
        const form = document.querySelector('[data-employee-login-form]');
        const username = form?.querySelector('input[name="username"]');
        const password = form?.querySelector('input[name="password"]');

        if (!form || !username || !password) {
          throw new Error('Employee login form is missing required fields.');
        }

        username.value = 'test.employee';
        password.value = 'EmployeePass1!';
        form.requestSubmit();
        return true;
      })()
    `);
    await waitForCondition(
      session,
      "Boolean(document.querySelector('[data-device-setup-form]')) && !document.querySelector('[data-device-setup-form] input[name=\"accessPin\"]')"
    );

    const permissionState = await evaluateExpression(session, "Notification.permission");
    assert.equal(permissionState, "granted");

    const pushConfigRequestPromise = session.waitForEvent(
      "Network.requestWillBeSent",
      (message) => String(message.params?.request?.url || "").includes("/api/push/config")
    );

    await evaluateExpression(session, `
      (() => {
        const form = document.querySelector('[data-device-setup-form]');
        const employeeField = form?.querySelector('input[name="employeeName"]');

        if (!form || !employeeField) {
          throw new Error('Employee setup form is missing required fields.');
        }

        if (form.querySelector('input[name="accessPin"]')) {
          throw new Error('Legacy enrollment field should not render.');
        }

        employeeField.value = 'Test Employee';
        form.requestSubmit();
        return true;
      })()
    `);

    const pushConfigRequest = await pushConfigRequestPromise;
    assert.ok(String(pushConfigRequest.params.request.url).includes("/api/push/config"));

    const pageText = await evaluateExpression(session, "document.body.innerText");
    assert.ok(!String(pageText).includes("Access PIN"));
    assert.ok(!String(pageText).includes("Saved the employee name."));
  }
);

test(
  "hr and webmaster routes require management login and then unlock cleanly",
  {
    skip: chromePath ? false : "Chrome executable not found.",
    timeout: 120_000
  },
  async (t) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-admin-open-e2e-"));
    await provisionManagedAccess(tempDir, {
      adminUsername: "hr",
      adminPassword: "ManagerSecret1!"
    });
    const serverPort = await findFreePort();
    const server = await startBoardServer({
      port: serverPort,
      tempDir
    });
    const { chrome, connection } = await startChromeSession(chromePath);

    t.after(async () => {
      await connection.close();
      await cleanupProcess(chrome.child);
      await cleanupProcess(server.child);
      await removeDirectoryWithRetries(tempDir);
      await removeDirectoryWithRetries(chrome.userDataDir);
    });

    await connection.ready;
    const session = await createPageSession(connection);
    const appOrigin = `http://127.0.0.1:${serverPort}`;

    await navigate(session, `${appOrigin}/palzivalerts/hr`);
    await waitForCondition(session, "Boolean(document.querySelector('[data-admin-auth-form]'))");
    await evaluateExpression(session, `
      (() => {
        const form = document.querySelector('[data-admin-auth-form]');
        const username = form?.querySelector('input[name="username"]');
        const password = form?.querySelector('input[name="password"]');

        if (!form || !username || !password) {
          throw new Error('Admin login form is missing required fields.');
        }

        username.value = 'hr';
        password.value = 'ManagerSecret1!';
        form.requestSubmit();
        return true;
      })()
    `);
    await waitForCondition(session, "document.body.innerText.includes('HR Control Center')");

    const hrScreen = await evaluateExpression(session, `
      ({
        hasAuthForm: Boolean(document.querySelector('[data-admin-auth-form]')),
        text: document.body.innerText
      })
    `);

    assert.equal(hrScreen.hasAuthForm, false);
    assert.ok(String(hrScreen.text).includes("HR Control Center"));

    const hrStatus = await evaluateExpression(session, `
      (async () => {
        const response = await fetch('/api/hr/check');
        return await response.json();
      })()
    `);

    assert.equal(Boolean(hrStatus.authorized), true);

    await navigate(session, `${appOrigin}/palzivalerts/webmaster`);
    await waitForCondition(session, "Boolean(document.querySelector('[data-admin-auth-form]'))");
    await evaluateExpression(session, `
      (() => {
        const form = document.querySelector('[data-admin-auth-form]');
        const username = form?.querySelector('input[name="username"]');
        const password = form?.querySelector('input[name="password"]');

        if (!form || !username || !password) {
          throw new Error('Webmaster setup form is missing required fields.');
        }

        username.value = 'webmaster';
        password.value = 'WebmasterSecret1!';
        form.requestSubmit();
        return {
          mode: form.dataset.adminAuthMode,
          route: form.dataset.adminRoute
        };
      })()
    `);
    await waitForCondition(session, "document.body.innerText.includes('Systems Overview')");

    const webmasterScreen = await evaluateExpression(session, `
      ({
        hasAuthForm: Boolean(document.querySelector('[data-admin-auth-form]')),
        text: document.body.innerText
      })
    `);

    assert.equal(webmasterScreen.hasAuthForm, false);
    assert.ok(String(webmasterScreen.text).includes("Systems Overview"));

    const webmasterStatus = await evaluateExpression(session, `
      (async () => {
        const response = await fetch('/api/webmaster/check');
        return await response.json();
      })()
    `);

    assert.equal(Boolean(webmasterStatus.authorized), true);
    assert.equal(Boolean(webmasterStatus.hrAuthorized), true);
  }
);

test(
  "webmaster settings expose the webmaster admin accounts panel",
  {
    skip: chromePath ? false : "Chrome executable not found.",
    timeout: 120_000
  },
  async (t) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-webmaster-settings-e2e-"));
    await provisionManagedAccess(tempDir, {
      adminUsername: "hr",
      adminPassword: "ManagerSecret1!"
    });
    const serverPort = await findFreePort();
    const server = await startBoardServer({
      port: serverPort,
      tempDir
    });
    const { chrome, connection } = await startChromeSession(chromePath);

    t.after(async () => {
      await connection.close();
      await cleanupProcess(chrome.child);
      await cleanupProcess(server.child);
      await removeDirectoryWithRetries(tempDir);
      await removeDirectoryWithRetries(chrome.userDataDir);
    });

    await connection.ready;
    const session = await createPageSession(connection);
    const appOrigin = `http://127.0.0.1:${serverPort}`;

    await navigate(session, `${appOrigin}/palzivalerts/hr`);
    await waitForCondition(session, "Boolean(document.querySelector('[data-admin-auth-form]'))");
    await evaluateExpression(session, `
      (() => {
        const form = document.querySelector('[data-admin-auth-form]');
        const username = form?.querySelector('input[name="username"]');
        const password = form?.querySelector('input[name="password"]');

        if (!form || !username || !password) {
          throw new Error('HR login form is missing required fields.');
        }

        username.value = 'hr';
        password.value = 'ManagerSecret1!';
        form.requestSubmit();
        return true;
      })()
    `);
    await waitForCondition(session, "document.body.innerText.includes('HR Control Center')");

    await navigate(session, `${appOrigin}/palzivalerts/webmaster`);
    await waitForCondition(session, "Boolean(document.querySelector('[data-admin-auth-form]'))");
    await evaluateExpression(session, `
      (() => {
        const form = document.querySelector('[data-admin-auth-form]');
        const username = form?.querySelector('input[name="username"]');
        const password = form?.querySelector('input[name="password"]');

        if (!form || !username || !password) {
          throw new Error('Webmaster setup form is missing required fields.');
        }

        username.value = 'webmaster';
        password.value = 'WebmasterSecret1!';
        form.requestSubmit();
        return true;
      })()
    `);
    await waitForCondition(session, "document.body.innerText.includes('Systems Overview')");
    await evaluateExpression(session, `
      (() => {
        const settingsButton = Array.from(document.querySelectorAll('[data-tab]'))
          .find((button) => button.textContent.includes('Settings'));

        if (!settingsButton) {
          throw new Error('Settings tab button was not found.');
        }

        settingsButton.click();
        return true;
      })()
    `);
    await waitForCondition(session, "document.body.innerText.includes('System Ops Admin Accounts')");

    const settingsText = await evaluateExpression(session, "document.body.innerText");
    assert.ok(String(settingsText).includes("System Ops Admin Accounts"));
  }
);

test(
  "IT route exposes governance dashboard sections with consistent IT wording after login",
  {
    skip: chromePath ? false : "Chrome executable not found.",
    timeout: 120_000
  },
  async (t) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-it-e2e-"));
    await provisionManagedAccess(tempDir, {
      itUsername: "it",
      itPassword: "OwnerSecret1!",
      adminUsername: "hr",
      adminPassword: "ManagerSecret1!"
    });
    const serverPort = await findFreePort();
    const server = await startBoardServer({
      port: serverPort,
      tempDir
    });
    const { chrome, connection } = await startChromeSession(chromePath);

    t.after(async () => {
      await connection.close();
      await cleanupProcess(chrome.child);
      await cleanupProcess(server.child);
      await removeDirectoryWithRetries(tempDir);
      await removeDirectoryWithRetries(chrome.userDataDir);
    });

    await connection.ready;
    const session = await createPageSession(connection);
    const appOrigin = `http://127.0.0.1:${serverPort}`;

    await navigate(session, `${appOrigin}/palzivalerts/it`);
    await waitForCondition(session, "Boolean(document.querySelector('[data-admin-auth-form]'))");
    await evaluateExpression(session, `
      (() => {
        const form = document.querySelector('[data-admin-auth-form]');
        const username = form?.querySelector('input[name="username"]');
        const password = form?.querySelector('input[name="password"]');

        if (!form || !username || !password) {
          throw new Error('IT login form is missing required fields.');
        }

        username.value = 'it';
        password.value = 'OwnerSecret1!';
        form.requestSubmit();
        return true;
      })()
    `);
    await waitForCondition(session, "document.body.innerText.includes('IT Control Center')");

    const itScreen = await evaluateExpression(session, `
      (async () => {
        const response = await fetch('/api/it/check');
        const status = await response.json();
        return {
          authorized: Boolean(status.authorized),
          hasAuthForm: Boolean(document.querySelector('[data-admin-auth-form]')),
          text: document.body.innerText,
          path: window.location.pathname,
          hasLegacyOwnerScope: Boolean(document.querySelector('[data-admin-scope="owner"]')),
          hasLegacyOwnerTabGroup: Boolean(document.querySelector('[data-tab-group="owner"]')),
          hasLegacyOwnerShell: Boolean(document.querySelector('.owner-shell')),
          hasItScope: Boolean(document.querySelector('[data-admin-scope="it"]')),
          hasItTabGroup: Boolean(document.querySelector('[data-tab-group="it"]')),
          hasItShell: Boolean(document.querySelector('.it-shell'))
        };
      })()
    `);

    assert.equal(itScreen.authorized, true);
    assert.equal(itScreen.hasAuthForm, false);
    assert.equal(itScreen.path, "/palzivalerts/it");
    assert.ok(String(itScreen.text).includes("IT Control Center"));
    assert.ok(String(itScreen.text).includes("Admin Accounts"));
    assert.ok(String(itScreen.text).includes("Company Settings"));
    assert.ok(String(itScreen.text).includes("Audit Log"));
    assert.ok(String(itScreen.text).includes("Emergency Access"));
    assert.ok(!String(itScreen.text).includes("Owner Control Center"));
    assert.ok(!String(itScreen.text).includes("Active Owners"));
    assert.ok(!String(itScreen.text).includes("Backup Owner"));
    assert.ok(!String(itScreen.text).includes("Owner authenticator"));
    assert.equal(itScreen.hasLegacyOwnerScope, false);
    assert.equal(itScreen.hasLegacyOwnerTabGroup, false);
    assert.equal(itScreen.hasLegacyOwnerShell, false);
    assert.equal(itScreen.hasItScope, true);
    assert.equal(itScreen.hasItTabGroup, true);
    assert.equal(itScreen.hasItShell, true);
  }
);
