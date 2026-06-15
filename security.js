import crypto from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const ACCESS_PIN_LENGTH = 8;
const HR_SESSION_COOKIE = "palziv_hr_auth";
const LEGACY_ADMIN_SESSION_COOKIE = "palziv_admin_auth";
const WEBMASTER_SESSION_COOKIE = "palziv_webmaster_auth";
const ADMIN_SESSION_TTL_SECONDS = 8 * 60 * 60;
const WEBMASTER_SESSION_TTL_SECONDS = 180 * 24 * 60 * 60;
const LOGIN_LIMIT = Object.freeze({
  maxAttempts: 5,
  windowMs: 10 * 60 * 1000,
  lockMs: 10 * 60 * 1000
});

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value, maxLength) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeCredentialText(value) {
  return String(value ?? "").trim().slice(0, 256);
}

function normalizeAccessPinText(value) {
  return String(value ?? "")
    .replace(/\D+/g, "")
    .slice(0, ACCESS_PIN_LENGTH);
}

function formatAccessPin(value) {
  const digits = normalizeAccessPinText(value);
  return digits.replace(/(\d{4})(?=\d)/g, "$1-");
}

function generateAccessPin() {
  let pin = "";

  for (let index = 0; index < ACCESS_PIN_LENGTH; index += 1) {
    pin += String(crypto.randomInt(0, 10));
  }

  return pin;
}

function timingSafeStringEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue ?? ""), "utf8");
  const right = Buffer.from(String(rightValue ?? ""), "utf8");

  if (!left.length || left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

function credentialMatches(candidateValue, configuredValue) {
  const candidate = normalizeCredentialText(candidateValue);
  const configured = normalizeCredentialText(configuredValue);
  const candidatePin = normalizeAccessPinText(candidateValue);
  const configuredPin = normalizeAccessPinText(configuredValue);

  return (
    timingSafeStringEqual(candidate, configured) ||
    (candidatePin.length === ACCESS_PIN_LENGTH &&
      configuredPin.length === ACCESS_PIN_LENGTH &&
      timingSafeStringEqual(candidatePin, configuredPin))
  );
}

function credentialVersionFor(value) {
  return crypto
    .createHash("sha256")
    .update(normalizeCredentialText(value))
    .digest("hex")
    .slice(0, 16);
}

function resolveConfiguredCredential() {
  const adminPassword = normalizeCredentialText(process.env.ADMIN_PASSWORD);
  const legacyHrPin = normalizeCredentialText(process.env.HR_PIN);

  if (adminPassword) {
    return {
      value: adminPassword,
      source: "ADMIN_PASSWORD"
    };
  }

  if (legacyHrPin) {
    return {
      value: legacyHrPin,
      source: "HR_PIN"
    };
  }

  const bootstrapPin = generateAccessPin();
  return {
    value: bootstrapPin,
    source: "bootstrap",
    bootstrapPin: formatAccessPin(bootstrapPin)
  };
}

function resolveSessionSecret() {
  const configured = normalizeCredentialText(process.env.SESSION_SECRET || process.env.SECURITY_SESSION_SECRET);

  if (configured.length >= 32) {
    return {
      value: configured,
      source: "environment"
    };
  }

  return {
    value: crypto.randomBytes(32).toString("hex"),
    source: "ephemeral"
  };
}

function signSessionToken(secret, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `v1.${body}.${signature}`;
}

function verifySessionToken(secret, token) {
  const value = cleanText(token, 4096);
  const parts = value.split(".");

  if (parts.length !== 3 || parts[0] !== "v1") {
    return null;
  }

  const [, body, signature] = parts;
  const expectedSignature = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const actual = Buffer.from(signature, "utf8");
  const expected = Buffer.from(expectedSignature, "utf8");

  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));

    if (!payload || typeof payload !== "object") {
      return null;
    }

    const expiresAt = cleanText(payload.expiresAt, 40);

    if (!expiresAt || Number.isNaN(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function parseCookies(cookieHeader = "") {
  return String(cookieHeader || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const equalsIndex = part.indexOf("=");

      if (equalsIndex < 0) {
        return cookies;
      }

      const name = part.slice(0, equalsIndex).trim();
      const value = part.slice(equalsIndex + 1).trim();

      if (name) {
        cookies[name] = value;
      }

      return cookies;
    }, {});
}

function readCookieValue(req, name) {
  const cookies = parseCookies(req?.headers?.cookie || "");
  return cookies[name] || "";
}

function isSecureRequest(req) {
  const forwardedProto = String(req?.headers?.["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();

  return Boolean(req?.socket?.encrypted || forwardedProto === "https");
}

function createCookieHeader(name, value, { maxAgeSeconds = 0, secure = false } = {}) {
  const attributes = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict"
  ];

  if (maxAgeSeconds > 0) {
    attributes.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  }

  if (secure) {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}

function clearCookieHeader(name, { secure = false } = {}) {
  const attributes = [
    `${name}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "Max-Age=0"
  ];

  if (secure) {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}

function clientAddress(req) {
  return String(req?.headers?.["x-forwarded-for"] || req?.socket?.remoteAddress || "unknown")
    .split(",")[0]
    .trim() || "unknown";
}

function createRateLimiter() {
  const attempts = new Map();

  function keyFor(req, bucket) {
    return `${bucket}:${clientAddress(req)}`;
  }

  function entryFor(key) {
    const current = attempts.get(key);
    const now = Date.now();

    if (!current || now - current.windowStartedAt > LOGIN_LIMIT.windowMs) {
      const fresh = {
        count: 0,
        windowStartedAt: now,
        lockedUntil: 0
      };
      attempts.set(key, fresh);
      return fresh;
    }

    return current;
  }

  function assertAllowed(req, bucket) {
    const key = keyFor(req, bucket);
    const entry = entryFor(key);

    if (entry.lockedUntil > Date.now()) {
      const error = new Error("Too many failed attempts. Try again later.");
      error.statusCode = 429;
      throw error;
    }
  }

  function recordFailure(req, bucket) {
    const key = keyFor(req, bucket);
    const entry = entryFor(key);
    entry.count += 1;

    if (entry.count >= LOGIN_LIMIT.maxAttempts) {
      entry.lockedUntil = Date.now() + LOGIN_LIMIT.lockMs;
    }
  }

  function recordSuccess(req, bucket) {
    attempts.delete(keyFor(req, bucket));
  }

  return {
    assertAllowed,
    recordFailure,
    recordSuccess
  };
}

function createSessionCookie(req, name, secret, payload, maxAgeSeconds) {
  const session = signSessionToken(secret, payload);
  return createCookieHeader(name, session, {
    maxAgeSeconds,
    secure: isSecureRequest(req)
  });
}

function isValidIsoTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function cleanUserAgent(value) {
  return cleanText(value, 320);
}

function userAgentHashFor(value) {
  return crypto
    .createHash("sha256")
    .update(cleanUserAgent(value))
    .digest("hex")
    .slice(0, 32);
}

function requestUserAgent(req) {
  return cleanUserAgent(req?.headers?.["user-agent"]);
}

function normalizeWebmasterApproval(value = {}) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const userAgent = cleanUserAgent(value.userAgent);
  const providedUserAgentHash = cleanText(value.userAgentHash, 128);

  if (!providedUserAgentHash && !userAgent) {
    return null;
  }

  const userAgentHash = providedUserAgentHash || userAgentHashFor(userAgent);

  if (!userAgentHash) {
    return null;
  }

  return {
    id: cleanText(value.id, 128) || crypto.randomUUID(),
    label: cleanText(value.label, 80) || "Approved browser",
    browser: cleanText(value.browser, 80),
    platform: cleanText(value.platform, 80),
    userAgent,
    userAgentHash,
    updatedAt: isValidIsoTimestamp(value.updatedAt) ? value.updatedAt : nowIso()
  };
}

function publicWebmasterApproval(approval) {
  if (!approval) {
    return null;
  }

  return {
    label: approval.label || "Approved browser",
    browser: approval.browser || "",
    platform: approval.platform || "",
    userAgent: approval.userAgent || "",
    updatedAt: approval.updatedAt || ""
  };
}

export function normalizeSecurityState(input = {}) {
  return {
    admin: input.admin && typeof input.admin === "object" ? input.admin : null,
    hrPin: input.hrPin && typeof input.hrPin === "object" ? input.hrPin : null,
    webmaster: normalizeWebmasterApproval(input.webmaster)
  };
}

async function ensureDirectory(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
}

async function writeFileAtomic(filePath, data) {
  await ensureDirectory(filePath);
  const tempFile = `${filePath}.${crypto.randomUUID()}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tempFile, filePath);
}

export function createSecurityStore({ dataFile } = {}) {
  const backend = dataFile ? "file" : "memory";
  const rateLimiter = createRateLimiter();
  let initPromise = null;
  let writeQueue = Promise.resolve();
  let adminCredential = null;
  let sessionSecret = null;
  let credentialVersion = "";
  let bootstrapHrPin = "";
  let initializedAt = "";
  let memoryState = normalizeSecurityState();

  async function readStoredState() {
    if (!dataFile) {
      memoryState = normalizeSecurityState(memoryState);
      return memoryState;
    }

    await ensureDirectory(dataFile);

    try {
      const raw = await readFile(dataFile, "utf8");
      const normalized = normalizeSecurityState(JSON.parse(raw));
      const normalizedRaw = `${JSON.stringify(normalized, null, 2)}\n`;

      if (normalizedRaw !== raw) {
        await writeFileAtomic(dataFile, normalized);
      }

      return normalized;
    } catch {
      const seed = normalizeSecurityState();
      await writeFileAtomic(dataFile, seed);
      return seed;
    }
  }

  async function writeStoredState(data) {
    const normalized = normalizeSecurityState(data);

    if (!dataFile) {
      memoryState = normalized;
      return normalized;
    }

    await writeFileAtomic(dataFile, normalized);
    return normalized;
  }

  async function init() {
    if (!initPromise) {
      initPromise = Promise.resolve().then(async () => {
        const credential = resolveConfiguredCredential();
        const secret = resolveSessionSecret();

        adminCredential = credential;
        sessionSecret = secret;
        credentialVersion = credentialVersionFor(credential.value);
        bootstrapHrPin = credential.bootstrapPin || "";
        initializedAt = nowIso();

        return readStoredState();
      });
    }

    return initPromise;
  }

  function ensureInitialized() {
    if (!adminCredential || !sessionSecret) {
      throw new Error("Security store has not been initialized.");
    }
  }

  function getBootstrapHrPin() {
    return bootstrapHrPin;
  }

  function getSecret() {
    ensureInitialized();
    return sessionSecret.value;
  }

  async function flushQueue() {
    await writeQueue.catch(() => {});
  }

  function runtimeSnapshot(storedState = normalizeSecurityState()) {
    return {
      admin: {
        enabled: true,
        credentialSource: adminCredential.source,
        sessionSecretSource: sessionSecret.source,
        sessionTtlSeconds: ADMIN_SESSION_TTL_SECONDS,
        updatedAt: initializedAt || nowIso()
      },
      hrPin: {
        enabled: true,
        version: 1,
        updatedAt: initializedAt || nowIso()
      },
      webmaster: storedState.webmaster
    };
  }

  async function readData() {
    await init();
    await flushQueue();
    return runtimeSnapshot(await readStoredState());
  }

  async function writeData(data) {
    await init();

    const next = writeQueue.then(async () => {
      const storedState = await writeStoredState(data);
      return runtimeSnapshot(storedState);
    });

    writeQueue = next.catch(() => {});
    return next;
  }

  async function updateData(mutator) {
    await init();

    const next = writeQueue.then(async () => {
      const data = await readStoredState();
      const result = await mutator(data);
      await writeStoredState(data);
      return result;
    });

    writeQueue = next.catch(() => {});
    return next;
  }

  function readSessionPayload(req, cookieNames) {
    ensureInitialized();

    for (const cookieName of cookieNames) {
      const cookie = readCookieValue(req, cookieName);

      if (!cookie) {
        continue;
      }

      const payload = verifySessionToken(sessionSecret.value, cookie);

      if (payload) {
        return payload;
      }
    }

    return null;
  }

  function hrSessionPayloadFromRequest(req) {
    return readSessionPayload(req, [HR_SESSION_COOKIE, LEGACY_ADMIN_SESSION_COOKIE]);
  }

  function webmasterSessionPayloadFromRequest(req) {
    return readSessionPayload(req, [WEBMASTER_SESSION_COOKIE]);
  }

  async function checkHrAccess(req) {
    await init();

    const payload = hrSessionPayloadFromRequest(req);
    const sessionExpiresAt = cleanText(payload?.expiresAt, 40);
    const csrfToken = cleanText(payload?.csrfToken, 128);
    const authorized = Boolean(
      payload &&
      payload.scope === "admin" &&
      payload.version === credentialVersion &&
      csrfToken
    );

    return {
      authorized,
      pinRequired: true,
      pinVersion: 1,
      pinUpdatedAt: initializedAt,
      sessionExpiresAt: authorized ? sessionExpiresAt : "",
      csrfToken: authorized ? csrfToken : "",
      credentialManaged: true
    };
  }

  async function unlockHrAccess(req, credentialInput) {
    await init();
    rateLimiter.assertAllowed(req, "admin-login");

    if (!credentialMatches(credentialInput, adminCredential.value)) {
      rateLimiter.recordFailure(req, "admin-login");
      const error = new Error("A valid admin access code is required.");
      error.statusCode = 403;
      throw error;
    }

    rateLimiter.recordSuccess(req, "admin-login");

    const expiresAt = new Date(Date.now() + ADMIN_SESSION_TTL_SECONDS * 1000).toISOString();
    const csrfToken = crypto.randomBytes(24).toString("base64url");
    const setCookie = createSessionCookie(req, HR_SESSION_COOKIE, sessionSecret.value, {
      scope: "admin",
      version: credentialVersion,
      csrfToken,
      expiresAt
    }, ADMIN_SESSION_TTL_SECONDS);

    return {
      authorized: true,
      pinRequired: true,
      pinVersion: 1,
      pinUpdatedAt: initializedAt,
      sessionExpiresAt: expiresAt,
      csrfToken,
      credentialManaged: true,
      setCookie
    };
  }

  async function lockHrAccess(req) {
    await init();
    const secure = isSecureRequest(req);

    return {
      authorized: false,
      setCookie: [
        clearCookieHeader(HR_SESSION_COOKIE, { secure }),
        clearCookieHeader(LEGACY_ADMIN_SESSION_COOKIE, { secure })
      ]
    };
  }

  async function issueHrPin() {
    const error = new Error("Admin credentials are managed by environment variables and cannot be rotated from the browser.");
    error.statusCode = 410;
    throw error;
  }

  async function clearHrPin() {
    const error = new Error("Admin credentials are managed by environment variables and cannot be disabled from the browser.");
    error.statusCode = 410;
    throw error;
  }

  async function checkWebmasterAccess(req) {
    await init();

    const [hrAccess, storedState] = await Promise.all([
      checkHrAccess(req),
      readStoredState()
    ]);
    const approval = normalizeWebmasterApproval(storedState.webmaster);
    const payload = webmasterSessionPayloadFromRequest(req);
    const sessionExpiresAt = cleanText(payload?.expiresAt, 40);
    const csrfToken = cleanText(payload?.csrfToken, 128);
    const authorized = Boolean(
      approval &&
      payload &&
      payload.scope === "webmaster" &&
      cleanText(payload.approvalId, 128) === approval.id &&
      csrfToken
    );

    return {
      authorized,
      hrAuthorized: hrAccess.authorized,
      browserBound: Boolean(approval),
      approvedBrowser: publicWebmasterApproval(approval),
      sessionExpiresAt: authorized ? sessionExpiresAt : "",
      csrfToken: authorized ? csrfToken : ""
    };
  }

  async function approveWebmasterAccess(req, browserInput = {}) {
    await init();

    const hrAccess = await checkHrAccess(req);

    if (!hrAccess.authorized) {
      const error = new Error("Admin access is required.");
      error.statusCode = 401;
      throw error;
    }

    const approval = normalizeWebmasterApproval({
      id: crypto.randomUUID(),
      label: cleanText(browserInput.label, 80),
      browser: cleanText(browserInput.browser, 80),
      platform: cleanText(browserInput.platform, 80),
      userAgent: cleanUserAgent(browserInput.userAgent || requestUserAgent(req)),
      userAgentHash: userAgentHashFor(requestUserAgent(req) || browserInput.userAgent),
      updatedAt: nowIso()
    });

    await updateData((data) => {
      data.webmaster = approval;
      return approval;
    });

    const expiresAt = new Date(Date.now() + WEBMASTER_SESSION_TTL_SECONDS * 1000).toISOString();
    const csrfToken = crypto.randomBytes(24).toString("base64url");
    const setCookie = createSessionCookie(req, WEBMASTER_SESSION_COOKIE, sessionSecret.value, {
      scope: "webmaster",
      approvalId: approval.id,
      userAgentHash: approval.userAgentHash,
      csrfToken,
      expiresAt
    }, WEBMASTER_SESSION_TTL_SECONDS);

    return {
      authorized: true,
      hrAuthorized: true,
      browserBound: true,
      approvedBrowser: publicWebmasterApproval(approval),
      sessionExpiresAt: expiresAt,
      csrfToken,
      setCookie
    };
  }

  async function lockWebmasterAccess(req) {
    await init();

    await updateData((data) => {
      data.webmaster = null;
      return null;
    });

    return {
      authorized: false,
      hrAuthorized: false,
      browserBound: false,
      approvedBrowser: null,
      sessionExpiresAt: "",
      csrfToken: "",
      setCookie: clearCookieHeader(WEBMASTER_SESSION_COOKIE, {
        secure: isSecureRequest(req)
      })
    };
  }

  function assertRateLimit(req, bucket) {
    rateLimiter.assertAllowed(req, bucket);
  }

  function recordRateLimitFailure(req, bucket) {
    rateLimiter.recordFailure(req, bucket);
  }

  function recordRateLimitSuccess(req, bucket) {
    rateLimiter.recordSuccess(req, bucket);
  }

  function verifyCsrf(req, auth) {
    const expected = cleanText(auth?.csrfToken, 128);
    const provided = cleanText(req?.headers?.["x-csrf-token"], 128);
    return Boolean(expected && provided && timingSafeStringEqual(expected, provided));
  }

  function getAccessCookieNames() {
    return {
      admin: HR_SESSION_COOKIE,
      hr: HR_SESSION_COOKIE,
      legacyHr: LEGACY_ADMIN_SESSION_COOKIE,
      webmaster: WEBMASTER_SESSION_COOKIE
    };
  }

  async function close() {
    return undefined;
  }

  return {
    backend,
    init,
    readData,
    writeData,
    updateData,
    close,
    getBootstrapHrPin,
    getSecret,
    getAccessCookieNames,
    checkHrAccess,
    unlockHrAccess,
    lockHrAccess,
    issueHrPin,
    clearHrPin,
    checkWebmasterAccess,
    approveWebmasterAccess,
    lockWebmasterAccess,
    assertRateLimit,
    recordRateLimitFailure,
    recordRateLimitSuccess,
    verifyCsrf
  };
}

export {
  cleanText,
  createCookieHeader,
  formatAccessPin,
  generateAccessPin,
  normalizeAccessPinText,
  parseCookies,
  readCookieValue,
  signSessionToken,
  verifySessionToken
};
