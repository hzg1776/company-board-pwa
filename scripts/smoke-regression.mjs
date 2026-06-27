import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function formatTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('') + 'T' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('');
}

function parseArgs(argv) {
  const options = {
    basePort: 0,
    keepArtifacts: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base-port' && i + 1 < argv.length) {
      options.basePort = Number(argv[i + 1]) || 0;
      i += 1;
    } else if (arg === '--keep-artifacts') {
      options.keepArtifacts = true;
    }
  }

  return options;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

async function getFreeBasePort(start = 43000, end = 48000) {
  for (let candidate = start; candidate <= end - 4; candidate += 5) {
    let allFree = true;
    for (let offset = 0; offset < 5; offset += 1) {
      if (!(await testPortAvailable(candidate + offset))) {
        allFree = false;
        break;
      }
    }
    if (allFree) {
      return candidate;
    }
  }

  throw new Error(`Unable to find a free 5-port block between ${start} and ${end}.`);
}

async function waitForHealth(port, attempts = 40, delayMs = 250) {
  const url = `http://127.0.0.1:${port}/api/health`;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await delay(delayMs);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (!response.ok) {
        continue;
      }
      const body = await response.json();
      if (body?.ok) {
        return true;
      }
    } catch {
    }
  }
  return false;
}

async function readText(filePath) {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

async function startServer(artifactRoot, name, port, publicBaseUrl, trustedProxyAddresses) {
  const runtimeDir = path.join(artifactRoot, name);
  await fsp.mkdir(runtimeDir, { recursive: true });

  const stdoutPath = path.join(runtimeDir, 'server.stdout.log');
  const stderrPath = path.join(runtimeDir, 'server.stderr.log');
  const stdoutStream = fs.createWriteStream(stdoutPath, { flags: 'a' });
  const stderrStream = fs.createWriteStream(stderrPath, { flags: 'a' });

  const env = {
    ...process.env,
    PORT: String(port),
    ADMIN_SETUP_TOKEN: 'bootstrap-secret-2026',
    DATA_FILE: path.join(runtimeDir, 'board.json'),
    PUSH_DATA_FILE: path.join(runtimeDir, 'push.json'),
    ANALYTICS_DATA_FILE: path.join(runtimeDir, 'analytics.json'),
    SECURITY_DATA_FILE: path.join(runtimeDir, 'security.json')
  };

  if (publicBaseUrl) {
    env.PUBLIC_BASE_URL = publicBaseUrl;
  } else {
    delete env.PUBLIC_BASE_URL;
  }

  if (trustedProxyAddresses) {
    env.TRUST_PROXY_ADDRESSES = trustedProxyAddresses;
  } else {
    delete env.TRUST_PROXY_ADDRESSES;
  }

  const child = spawn(process.execPath, ['server.js'], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.pipe(stdoutStream);
  child.stderr.pipe(stderrStream);

  return {
    name,
    port,
    runtimeDir,
    stdoutPath,
    stderrPath,
    stdoutStream,
    stderrStream,
    child
  };
}

async function stopServer(server) {
  if (!server) {
    return;
  }

  const { child, stdoutStream, stderrStream } = server;
  if (child && child.pid) {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
    }

    await Promise.race([
      once(child, 'exit').catch(() => {}),
      delay(3000)
    ]);
  }

  await Promise.all([
    new Promise((resolve) => stdoutStream.end(resolve)),
    new Promise((resolve) => stderrStream.end(resolve))
  ]);
}

function cookieValue(header) {
  return header ? String(header).split(';')[0] : '';
}

function createRequester(baseUrl) {
  return async function request(pathname, { method = 'GET', headers = {}, body, cookie } = {}) {
    const finalHeaders = new Headers(headers);
    if (body !== undefined && !finalHeaders.has('content-type')) {
      finalHeaders.set('content-type', 'application/json');
    }
    if (cookie) {
      finalHeaders.set('cookie', cookie);
    }

    const response = await fetch(baseUrl + pathname, {
      method,
      headers: finalHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(10000)
    });

    const text = await response.text();
    let parsedBody = null;
    try {
      parsedBody = text ? JSON.parse(text) : null;
    } catch {
      parsedBody = { raw: text };
    }

    return {
      status: response.status,
      body: parsedBody,
      setCookie: response.headers.get('set-cookie'),
      contentType: response.headers.get('content-type') || ''
    };
  };
}

async function writeScenarioResult(artifactRoot, name, result) {
  const filePath = path.join(artifactRoot, name, 'result.json');
  await fsp.writeFile(filePath, JSON.stringify(result, null, 2));
}

async function runStartupFailureScenario(artifactRoot, name, port, publicBaseUrl, trustedProxyAddresses) {
  const server = await startServer(artifactRoot, name, port, publicBaseUrl, trustedProxyAddresses);
  try {
    await delay(1500);
    const result = {
      started: await waitForHealth(port, 3, 250),
      stdout: await readText(server.stdoutPath),
      stderr: await readText(server.stderrPath),
      runtimeDir: server.runtimeDir
    };
    await writeScenarioResult(artifactRoot, name, result);
    return result;
  } finally {
    await stopServer(server);
  }
}

async function runAuthSplitScenario(artifactRoot, basePort) {
  const name = 'auth_split';
  const port = basePort + 2;
  const server = await startServer(artifactRoot, name, port, `http://127.0.0.1:${port}`, '');
  try {
    if (!(await waitForHealth(port))) {
      throw new Error('Auth smoke server failed to start.');
    }

    const request = createRequester(`http://127.0.0.1:${port}`);
    const results = {};

    const hrSetup = await request('/api/hr/setup', {
      method: 'POST',
      body: { password: 'HrPassword!234', setupToken: 'bootstrap-secret-2026' }
    });
    const hrCookie = cookieValue(hrSetup.setCookie);
    const hrCsrf = hrSetup.body?.csrfToken || '';

    const webmasterBefore = await request('/api/webmaster/check', { cookie: hrCookie });
    const webmasterSetup = await request('/api/webmaster/setup', {
      method: 'POST',
      cookie: hrCookie,
      headers: { 'x-csrf-token': hrCsrf },
      body: { password: 'Webmaster!234' }
    });
    const webmasterCookie = cookieValue(webmasterSetup.setCookie);
    const webmasterCsrf = webmasterSetup.body?.csrfToken || '';

    const hrLogout = await request('/api/hr/logout', {
      method: 'POST',
      cookie: hrCookie,
      headers: { 'x-csrf-token': hrCsrf },
      body: {}
    });
    const webmasterAfterHrLogout = await request('/api/webmaster/check', { cookie: webmasterCookie });

    const lockStatuses = [];
    lockStatuses.push((await request('/api/webmaster/login', { method: 'POST', body: { password: 'wrong-pass' } })).status);
    lockStatuses.push((await request('/api/webmaster/login', { method: 'POST', body: { password: 'wrong-pass' } })).status);
    lockStatuses.push((await request('/api/webmaster/login', { method: 'POST', body: { password: 'wrong-pass' } })).status);
    await delay(5500);
    lockStatuses.push((await request('/api/webmaster/login', { method: 'POST', body: { password: 'wrong-pass' } })).status);
    await delay(10500);
    lockStatuses.push((await request('/api/webmaster/login', { method: 'POST', body: { password: 'wrong-pass' } })).status);
    await delay(20500);
    lockStatuses.push((await request('/api/webmaster/login', { method: 'POST', body: { password: 'wrong-pass' } })).status);
    const lockout = await request('/api/webmaster/login', { method: 'POST', body: { password: 'wrong-pass' } });

    const hrLoginAgain = await request('/api/hr/login', {
      method: 'POST',
      body: { password: 'HrPassword!234' }
    });
    const hrCookie2 = cookieValue(hrLoginAgain.setCookie);
    const events = await request('/api/security/events?limit=10', { cookie: hrCookie2 });

    const webmasterLogout = await request('/api/webmaster/logout', {
      method: 'POST',
      cookie: webmasterCookie,
      headers: { 'x-csrf-token': webmasterCsrf },
      body: {}
    });

    results.hrSetup = { status: hrSetup.status, authorized: hrSetup.body?.authorized ?? null };
    results.webmasterBeforeProvision = {
      status: webmasterBefore.status,
      authorized: webmasterBefore.body?.authorized ?? null,
      setupRequired: webmasterBefore.body?.setupRequired ?? null,
      hrAuthorized: webmasterBefore.body?.hrAuthorized ?? null
    };
    results.webmasterSetup = { status: webmasterSetup.status, authorized: webmasterSetup.body?.authorized ?? null };
    results.sessionSplit = {
      hrLogout: hrLogout.status,
      webmasterAuthorizedAfterHrLogout: webmasterAfterHrLogout.body?.authorized ?? null
    };
    results.lockout = {
      statuses: [...lockStatuses, lockout.status],
      finalError: lockout.body?.error ?? null
    };
    results.securityEvents = {
      status: events.status,
      types: Array.isArray(events.body?.events) ? events.body.events.map((event) => event.type) : []
    };
    results.webmasterLogout = { status: webmasterLogout.status };

    const stderr = await readText(server.stderrPath);
    const securityLogLines = stderr.split(/\r?\n/).filter((line) => line.startsWith('[security]'));
    const result = {
      result: results,
      securityLogCount: securityLogLines.length,
      securityLogSample: securityLogLines.slice(0, 5),
      stdout: await readText(server.stdoutPath),
      stderr,
      runtimeDir: server.runtimeDir
    };
    await writeScenarioResult(artifactRoot, name, result);
    return result;
  } finally {
    await stopServer(server);
  }
}

async function runProxyScenario(artifactRoot, basePort) {
  const name = 'proxy_untrusted';
  const port = basePort + 3;
  const server = await startServer(artifactRoot, name, port, `http://127.0.0.1:${port}`, '');
  try {
    if (!(await waitForHealth(port))) {
      throw new Error('Proxy smoke server failed to start.');
    }

    const request = createRequester(`http://127.0.0.1:${port}`);
    const hrSetup = await request('/api/hr/setup', {
      method: 'POST',
      body: { password: 'HrPassword!234', setupToken: 'bootstrap-secret-2026' }
    });
    const hrCookie = cookieValue(hrSetup.setCookie);
    const hrCsrf = hrSetup.body?.csrfToken || '';
    const webmasterSetup = await request('/api/webmaster/setup', {
      method: 'POST',
      cookie: hrCookie,
      headers: { 'x-csrf-token': hrCsrf },
      body: { password: 'Webmaster!234' }
    });
    const webmasterCookie = cookieValue(webmasterSetup.setCookie);

    const summary = await request('/api/webmaster/summary', {
      cookie: webmasterCookie,
      headers: {
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'https'
      }
    });

    const spoofedLogin = await request('/api/webmaster/login', {
      method: 'POST',
      headers: {
        origin: 'https://evil.example',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'https'
      },
      body: { password: 'Webmaster!234' }
    });

    const result = {
      result: {
        summary: {
          status: summary.status,
          origin: summary.body?.urls?.origin ?? null,
          employee: summary.body?.urls?.employee ?? null
        },
        spoofedLogin: {
          status: spoofedLogin.status,
          error: spoofedLogin.body?.error ?? null
        }
      },
      stdout: await readText(server.stdoutPath),
      stderr: await readText(server.stderrPath),
      runtimeDir: server.runtimeDir
    };
    await writeScenarioResult(artifactRoot, name, result);
    return result;
  } finally {
    await stopServer(server);
  }
}

async function runBroadFlowScenario(artifactRoot, basePort) {
  const name = 'broad_app_flow';
  const port = basePort + 4;
  const server = await startServer(artifactRoot, name, port, `http://127.0.0.1:${port}`, '');
  try {
    if (!(await waitForHealth(port))) {
      throw new Error('Broad app smoke server failed to start.');
    }

    const request = createRequester(`http://127.0.0.1:${port}`);
    const results = {};

    const launcher = await request('/palzivalerts/');
    const employeePage = await request('/palzivalerts/employee');
    const hrPage = await request('/palzivalerts/hr');
    const webmasterPage = await request('/palzivalerts/webmaster');
    const itPage = await request('/palzivalerts/it');
    results.pages = {
      launcher: { status: launcher.status, html: launcher.contentType.includes('text/html') },
      employee: { status: employeePage.status, html: employeePage.contentType.includes('text/html') },
      hr: { status: hrPage.status, html: hrPage.contentType.includes('text/html') },
      webmaster: { status: webmasterPage.status, html: webmasterPage.contentType.includes('text/html') },
      it: { status: itPage.status, html: itPage.contentType.includes('text/html') }
    };

    const hrSetup = await request('/api/hr/setup', {
      method: 'POST',
      body: { password: 'HrPassword!234', setupToken: 'bootstrap-secret-2026' }
    });
    const hrCookie = cookieValue(hrSetup.setCookie);
    const hrCsrf = hrSetup.body?.csrfToken || '';

    const employeeCreate = await request('/api/employees', {
      method: 'POST',
      cookie: hrCookie,
      headers: { 'x-csrf-token': hrCsrf },
      body: { name: 'Taylor Employee', username: 'taylor', password: 'Employee!234' }
    });
    const postCreate = await request('/api/posts', {
      method: 'POST',
      cookie: hrCookie,
      headers: { 'x-csrf-token': hrCsrf },
      body: {
        title: 'Smoke Test Notice',
        body: 'Employee feed smoke notice.',
        type: 'News',
        priority: 'Important',
        audience: 'All employees'
      }
    });
    const weatherUpdate = await request('/api/weather', {
      method: 'PUT',
      cookie: hrCookie,
      headers: { 'x-csrf-token': hrCsrf },
      body: { location: 'New York, NY' }
    });
    const employeeLogin = await request('/api/employee/login', {
      method: 'POST',
      body: { username: 'taylor', password: 'Employee!234' }
    });
    const employeeCookie = cookieValue(employeeLogin.setCookie);

    const posts = await request('/api/posts', { cookie: employeeCookie });
    const weather = await request('/api/weather', { cookie: employeeCookie });
    const pushConfig = await request('/api/push/config', { cookie: employeeCookie });
    const pushStatusBefore = await request('/api/push/status', { cookie: employeeCookie });
    const subscriptionBody = {
      endpoint: 'https://push.example.test/device-1',
      expirationTime: null,
      keys: {
        p256dh: 'sample-public-key',
        auth: 'sample-auth-key'
      },
      deviceId: 'device-1',
      label: 'Taylor Browser',
      browser: 'Chrome',
      platform: 'Windows'
    };
    const pushSubscribe = await request('/api/push/subscribe', {
      method: 'POST',
      cookie: employeeCookie,
      body: subscriptionBody
    });
    const pushUnsubscribe = await request('/api/push/unsubscribe', {
      method: 'POST',
      cookie: employeeCookie,
      body: { endpoint: subscriptionBody.endpoint }
    });
    const hrLogout = await request('/api/hr/logout', {
      method: 'POST',
      cookie: hrCookie,
      headers: { 'x-csrf-token': hrCsrf },
      body: {}
    });
    const employeeLogout = await request('/api/employee/logout', {
      method: 'POST',
      cookie: employeeCookie,
      body: {}
    });

    results.hrSetup = { status: hrSetup.status, authorized: hrSetup.body?.authorized ?? null };
    results.employeeCreate = { status: employeeCreate.status, username: employeeCreate.body?.employee?.username ?? null };
    results.postCreate = { status: postCreate.status, title: postCreate.body?.post?.title ?? null };
    results.weatherUpdate = { status: weatherUpdate.status, condition: weatherUpdate.body?.weather?.condition ?? null };
    results.employeeLogin = { status: employeeLogin.status, authorized: employeeLogin.body?.authorized ?? null };
    results.employeeFeed = {
      postsStatus: posts.status,
      postsCount: Array.isArray(posts.body?.posts) ? posts.body.posts.length : null,
      weatherStatus: weather.status
    };
    results.push = {
      configStatus: pushConfig.status,
      statusBefore: pushStatusBefore.status,
      subscribeStatus: pushSubscribe.status,
      unsubscribeStatus: pushUnsubscribe.status
    };
    results.logouts = { hr: hrLogout.status, employee: employeeLogout.status };

    const result = {
      result: results,
      stdout: await readText(server.stdoutPath),
      stderr: await readText(server.stderrPath),
      runtimeDir: server.runtimeDir
    };
    await writeScenarioResult(artifactRoot, name, result);
    return result;
  } finally {
    await stopServer(server);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const basePort = options.basePort > 0 ? options.basePort : await getFreeBasePort();
  const artifactRoot = path.join(repoRoot, 'security-scans', 'Project-A', `smoke-suite-${formatTimestamp()}`);
  await fsp.mkdir(artifactRoot, { recursive: true });

  const summary = {
    artifactRoot,
    basePort
  };

  const runners = [
    ['missing_public_base_url', () => runStartupFailureScenario(artifactRoot, 'missing_public_base_url', basePort, '', '')],
    ['invalid_trust_proxy', () => runStartupFailureScenario(artifactRoot, 'invalid_trust_proxy', basePort + 1, `http://127.0.0.1:${basePort + 1}`, 'loopback')],
    ['auth_split', () => runAuthSplitScenario(artifactRoot, basePort)],
    ['proxy_untrusted', () => runProxyScenario(artifactRoot, basePort)],
    ['broad_app_flow', () => runBroadFlowScenario(artifactRoot, basePort)]
  ];

  for (const [name, run] of runners) {
    try {
      summary[name] = await run();
    } catch (error) {
      summary[name] = {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : null
      };
      await writeScenarioResult(artifactRoot, name, summary[name]);
    }
  }

  const summaryPath = path.join(artifactRoot, 'summary.json');
  await fsp.writeFile(summaryPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().then(() => {
  process.exit(0);
}).catch(async (error) => {
  console.error(error);
  process.exit(1);
});
