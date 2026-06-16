import fs from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const options = {
    baseUrl: '',
    setupToken: 'bootstrap-secret-2026',
    artifactDir: ''
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base-url' && i + 1 < argv.length) {
      options.baseUrl = argv[++i];
    } else if (arg === '--setup-token' && i + 1 < argv.length) {
      options.setupToken = argv[++i];
    } else if (arg === '--artifact-dir' && i + 1 < argv.length) {
      options.artifactDir = argv[++i];
    }
  }

  return options;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cookieValue(header) {
  return header ? String(header).split(';')[0] : '';
}

function createRequester(baseUrl) {
  const root = baseUrl.replace(/\/+$/, '');
  return async function request(pathname, { method = 'GET', headers = {}, body, cookie } = {}) {
    const finalHeaders = new Headers(headers);
    if (body !== undefined && !finalHeaders.has('content-type')) {
      finalHeaders.set('content-type', 'application/json');
    }
    if (cookie) {
      finalHeaders.set('cookie', cookie);
    }

    const response = await fetch(root + pathname, {
      method,
      headers: finalHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(15000)
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.baseUrl) {
    throw new Error('--base-url is required.');
  }

  const request = createRequester(options.baseUrl);
  const results = {
    baseUrl: options.baseUrl.replace(/\/+$/, '')
  };

  const health = await request('/api/health');
  const launcher = await request('/palzivalerts/');
  const employeePage = await request('/palzivalerts/employee');
  const hrPage = await request('/palzivalerts/hr');
  const webmasterPage = await request('/palzivalerts/webmaster');
  results.pages = {
    health: { status: health.status, ok: health.body?.ok ?? null },
    launcher: { status: launcher.status, html: launcher.contentType.includes('text/html') },
    employee: { status: employeePage.status, html: employeePage.contentType.includes('text/html') },
    hr: { status: hrPage.status, html: hrPage.contentType.includes('text/html') },
    webmaster: { status: webmasterPage.status, html: webmasterPage.contentType.includes('text/html') }
  };

  const hrSetup = await request('/api/hr/setup', {
    method: 'POST',
    body: { password: 'HrPassword!234', setupToken: options.setupToken }
  });
  const hrCookie = cookieValue(hrSetup.setCookie);
  const hrCsrf = hrSetup.body?.csrfToken || '';
  results.hrSetup = { status: hrSetup.status, authorized: hrSetup.body?.authorized ?? null, error: hrSetup.body?.error ?? null };

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
  results.hrWriteFlow = {
    employeeCreate: employeeCreate.status,
    postCreate: postCreate.status,
    weatherUpdate: weatherUpdate.status
  };

  const webmasterBefore = await request('/api/webmaster/check', { cookie: hrCookie });
  const webmasterSetup = await request('/api/webmaster/setup', {
    method: 'POST',
    cookie: hrCookie,
    headers: { 'x-csrf-token': hrCsrf },
    body: { password: 'Webmaster!234' }
  });
  const webmasterCookie = cookieValue(webmasterSetup.setCookie);
  const webmasterCsrf = webmasterSetup.body?.csrfToken || '';
  results.webmaster = {
    before: {
      status: webmasterBefore.status,
      setupRequired: webmasterBefore.body?.setupRequired ?? null,
      hrAuthorized: webmasterBefore.body?.hrAuthorized ?? null
    },
    setup: { status: webmasterSetup.status, authorized: webmasterSetup.body?.authorized ?? null }
  };

  const summarySpoof = await request('/api/webmaster/summary', {
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
  results.proxy = {
    summary: {
      status: summarySpoof.status,
      origin: summarySpoof.body?.urls?.origin ?? null,
      employee: summarySpoof.body?.urls?.employee ?? null
    },
    spoofedLogin: {
      status: spoofedLogin.status,
      error: spoofedLogin.body?.error ?? null
    }
  };

  const hrLogout = await request('/api/hr/logout', {
    method: 'POST',
    cookie: hrCookie,
    headers: { 'x-csrf-token': hrCsrf },
    body: {}
  });
  const webmasterAfterHrLogout = await request('/api/webmaster/check', { cookie: webmasterCookie });
  results.sessionSplit = {
    hrLogout: hrLogout.status,
    webmasterAuthorizedAfterHrLogout: webmasterAfterHrLogout.body?.authorized ?? null
  };

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
  const employeeLogout = await request('/api/employee/logout', {
    method: 'POST',
    cookie: employeeCookie,
    body: {}
  });
  results.employee = {
    login: { status: employeeLogin.status, authorized: employeeLogin.body?.authorized ?? null },
    feed: {
      postsStatus: posts.status,
      postsCount: Array.isArray(posts.body?.posts) ? posts.body.posts.length : null,
      weatherStatus: weather.status
    },
    push: {
      configStatus: pushConfig.status,
      statusBefore: pushStatusBefore.status,
      subscribeStatus: pushSubscribe.status,
      unsubscribeStatus: pushUnsubscribe.status
    },
    logout: employeeLogout.status
  };

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
  results.lockout = {
    statuses: [...lockStatuses, lockout.status],
    finalError: lockout.body?.error ?? null
  };

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
  results.securityEvents = {
    loginAgain: hrLoginAgain.status,
    status: events.status,
    types: Array.isArray(events.body?.events) ? events.body.events.map((event) => event.type) : []
  };
  results.webmasterLogout = webmasterLogout.status;

  if (options.artifactDir) {
    await fs.mkdir(options.artifactDir, { recursive: true });
    const outputPath = path.join(options.artifactDir, 'summary.json');
    await fs.writeFile(outputPath, JSON.stringify(results, null, 2));
  }

  console.log(JSON.stringify(results, null, 2));
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
