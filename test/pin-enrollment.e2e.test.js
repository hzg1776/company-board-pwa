import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, copyFile, mkdtemp, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Users\\admin\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"
].filter(Boolean);

const DESKTOP_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

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
  const repoRoot = process.cwd();
  const dataFile = path.join(tempDir, "board.json");
  const pushDataFile = path.join(tempDir, "push.json");
  const securityDataFile = path.join(tempDir, "security.json");
  const child = spawn(process.execPath, ["server.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HR_PIN: "1234-5678",
      DATA_FILE: dataFile,
      PUSH_DATA_FILE: pushDataFile,
      SECURITY_DATA_FILE: securityDataFile
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

async function setDesktopBrowserIdentity(session) {
  await session.send("Emulation.setUserAgentOverride", {
    userAgent: DESKTOP_USER_AGENT,
    platform: "Win32",
    acceptLanguage: "en-US,en;q=0.9"
  });
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

const chromePath = await findChromeExecutable();

test(
  "employee setup submits the push path when the browser omits submitter metadata",
  {
    skip: chromePath ? false : "Chrome executable not found.",
    timeout: 120_000
  },
  async (t) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-pin-e2e-"));
    const serverPort = await findFreePort();
    const server = await startBoardServer({
      port: serverPort,
      tempDir
    });
    const chrome = await startChrome(chromePath);
    const connection = createCdpConnection(chrome.webSocketDebuggerUrl);

    t.after(async () => {
      await connection.close();
      await cleanupProcess(chrome.child);
      await cleanupProcess(server.child);
      await rm(tempDir, { recursive: true, force: true });
      await rm(chrome.userDataDir, { recursive: true, force: true });
    });

    await connection.ready;
    await connection.send("Browser.grantPermissions", {
      origin: `http://127.0.0.1:${serverPort}`,
      permissions: ["notifications"]
    });

    const session = await createPageSession(connection);
    const appOrigin = `http://127.0.0.1:${serverPort}`;

    await navigate(session, `${appOrigin}/palzivalerts/hr`);
    await waitForCondition(session, "document.readyState === 'complete'");

    const setupState = await evaluateExpression(session, `
      (async () => {
        const unlockResponse = await fetch('/api/hr/unlock', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin: '1234-5678' })
        });

        if (!unlockResponse.ok) {
          throw new Error('Failed to unlock HR.');
        }

        const unlockData = await unlockResponse.json();

        const approveResponse = await fetch('/api/webmaster/approve', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': String(unlockData.csrfToken || '')
          },
          body: JSON.stringify({
            label: 'Desktop Chrome',
            browser: 'Chrome',
            platform: 'Windows',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
          })
        });

        if (!approveResponse.ok) {
          throw new Error('Failed to approve webmaster access.');
        }

        const approveData = await approveResponse.json();

        const issueResponse = await fetch('/api/push/pin', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': String(approveData.csrfToken || '')
          },
          body: JSON.stringify({})
        });

        if (!issueResponse.ok) {
          throw new Error('Failed to issue a push PIN.');
        }

        return await issueResponse.json();
      })()
    `);

    assert.match(String(setupState.pin || ""), /^\d{4}-\d{4}$/);

    await navigate(session, `${appOrigin}/palzivalerts/employee`);
    await waitForCondition(session, "Boolean(document.querySelector('[data-device-setup-form] input[name=\"accessPin\"]'))");

    const permissionState = await evaluateExpression(session, "Notification.permission");
    assert.equal(permissionState, "granted");

    const pinLiteral = JSON.stringify(String(setupState.pin || ""));

    const pushConfigRequestPromise = session.waitForEvent(
      "Network.requestWillBeSent",
      (message) => String(message.params?.request?.url || "").includes("/api/push/config")
    );

    await evaluateExpression(session, `
      (() => {
        const form = document.querySelector('[data-device-setup-form]');
        const employeeField = form?.querySelector('input[name="employeeName"]');
        const pinField = form?.querySelector('input[name="accessPin"]');

        if (!form || !employeeField || !pinField) {
          throw new Error('Employee setup form is missing required fields.');
        }

        employeeField.value = 'Test Employee';
        pinField.value = ${pinLiteral};
        form.requestSubmit();
        return true;
      })()
    `);

    const pushConfigRequest = await pushConfigRequestPromise;

    assert.ok(String(pushConfigRequest.params.request.url).includes("/api/push/config"));

    const pageText = await evaluateExpression(session, "document.body.innerText");
    assert.ok(!String(pageText).includes("Saved the employee name."));
  }
);

test(
  "hr unlock and webmaster approval complete the admin browser flow",
  {
    skip: chromePath ? false : "Chrome executable not found.",
    timeout: 120_000
  },
  async (t) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-admin-e2e-"));
    const serverPort = await findFreePort();
    const server = await startBoardServer({
      port: serverPort,
      tempDir
    });
    const chrome = await startChrome(chromePath);
    const connection = createCdpConnection(chrome.webSocketDebuggerUrl);

    t.after(async () => {
      await connection.close();
      await cleanupProcess(chrome.child);
      await cleanupProcess(server.child);
      await rm(tempDir, { recursive: true, force: true });
      await rm(chrome.userDataDir, { recursive: true, force: true });
    });

    await connection.ready;
    const session = await createPageSession(connection);
    const appOrigin = `http://127.0.0.1:${serverPort}`;

    await setDesktopBrowserIdentity(session);
    await navigate(session, `${appOrigin}/palzivalerts/hr`);
    await waitForCondition(session, "Boolean(document.querySelector('[data-hr-unlock-form]'))");

    const userAgent = await evaluateExpression(session, "navigator.userAgent");
    assert.match(String(userAgent || ""), /Windows NT/);

    const hrUnlockRequestPromise = session.waitForEvent(
      "Network.requestWillBeSent",
      (message) => String(message.params?.request?.url || "").includes("/api/hr/unlock")
    );

    await evaluateExpression(session, `
      (() => {
        const form = document.querySelector('[data-hr-unlock-form]');
        const pinField = form?.querySelector('input[name="pin"]');
        const submitButton = form?.querySelector('button[type="submit"]');

        if (!form || !pinField || !submitButton) {
          throw new Error('HR unlock form is missing required fields.');
        }

        pinField.value = '1234-5678';
        submitButton.click();
        return true;
      })()
    `);

    const hrUnlockRequest = await hrUnlockRequestPromise;
    assert.ok(String(hrUnlockRequest.params.request.url).includes("/api/hr/unlock"));
    await waitForCondition(session, "document.body.innerText.includes('HR control center')");

    const hrText = await evaluateExpression(session, "document.body.innerText");
    assert.ok(String(hrText).includes("HR control center"));

    await navigate(session, `${appOrigin}/palzivalerts/webmaster`);
    await waitForCondition(session, "Boolean(document.querySelector('[data-approve-webmaster-browser]'))");

    const approveRequestPromise = session.waitForEvent(
      "Network.requestWillBeSent",
      (message) => String(message.params?.request?.url || "").includes("/api/webmaster/approve")
    );

    await evaluateExpression(session, `
      (() => {
        const button = document.querySelector('[data-approve-webmaster-browser]');

        if (!button) {
          throw new Error('Webmaster approval button is missing.');
        }

        button.click();
        return true;
      })()
    `);

    const approveRequest = await approveRequestPromise;
    assert.ok(String(approveRequest.params.request.url).includes("/api/webmaster/approve"));
    try {
      await waitForCondition(session, "document.body.innerText.includes('Webmaster overview')");
    } catch (error) {
      const pageText = await evaluateExpression(session, "document.body.innerText");
      throw new Error(`${error.message}\n\nPage text after approve:\n${pageText}`);
    }

    const dashboardText = await evaluateExpression(session, "document.body.innerText");
    assert.ok(String(dashboardText).includes("Webmaster overview"));

    const cookies = await connection.send("Storage.getCookies", {
      browserContextId: undefined
    }).catch(() => null);
    if (cookies?.cookies) {
      const cookieNames = cookies.cookies.map((cookie) => cookie.name);
      assert.ok(cookieNames.includes("palziv_hr_auth"));
      assert.ok(cookieNames.includes("palziv_webmaster_auth"));
    }

    const webmasterStatus = await evaluateExpression(session, `
      (async () => {
        const response = await fetch('/api/webmaster/check');
        return await response.json();
      })()
    `);

    assert.equal(Boolean(webmasterStatus.authorized), true, JSON.stringify(webmasterStatus));
    assert.equal(Boolean(webmasterStatus.hrAuthorized), true);
    assert.equal(String(webmasterStatus.approvedBrowser?.label || ""), "Windows Chrome");
  }
);
