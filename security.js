import crypto from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const EMPLOYEE_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const ADMIN_SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const MIN_PASSWORD_LENGTH = 10;
const LOGIN_FAILURE_WINDOW_MS = 1000 * 60 * 15;
const LOGIN_BACKOFF_START_FAILURE = 3;
const LOGIN_BACKOFF_BASE_MS = 1000 * 5;
const LOGIN_BACKOFF_MAX_MS = 1000 * 60 * 15;
const LOGIN_LOCKOUT_START_FAILURE = 6;
const LOGIN_LOCKOUT_STEP_MS = 1000 * 60 * 5;
const LOGIN_LOCKOUT_MAX_MS = 1000 * 60 * 60;
const LOGIN_GUARD_RETENTION_MS = 1000 * 60 * 60 * 24;
const SECURITY_EVENT_LIMIT = 250;

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value, maxLength) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeUsername(value) {
  return cleanText(value, 80).toLowerCase();
}

function passwordDigest(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 64).toString("hex");
}

function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return {
    salt,
    hash: passwordDigest(password, salt)
  };
}

function verifyPassword(password, salt, hash) {
  const expected = Buffer.from(String(hash || ""), "hex");
  const actual = Buffer.from(passwordDigest(password, salt), "hex");

  if (!expected.length || expected.length !== actual.length) {
    return false;
  }

  return crypto.timingSafeEqual(actual, expected);
}

function normalizeEmployee(input = {}) {
  const createdAt = cleanText(input.createdAt, 40) || nowIso();
  const updatedAt = cleanText(input.updatedAt, 40) || createdAt;
  const id = cleanText(input.id, 80) || crypto.randomUUID();
  const name = cleanText(input.name, 120);
  const username = normalizeUsername(input.username);
  const passwordSalt = cleanText(input.passwordSalt, 128);
  const passwordHash = cleanText(input.passwordHash, 256);
  const sessionVersion = Number.isInteger(input.sessionVersion) && input.sessionVersion >= 0
    ? input.sessionVersion
    : 0;

  return {
    id,
    name,
    username,
    passwordSalt,
    passwordHash,
    active: input.active !== false,
    sessionVersion,
    lastLoginAt: cleanText(input.lastLoginAt, 40),
    createdAt,
    updatedAt,
    disabledAt: cleanText(input.disabledAt, 40)
  };
}

function normalizeAdmin(input = {}) {
  const updatedAt = cleanText(input.updatedAt, 40);

  return {
    passwordSalt: cleanText(input.passwordSalt, 128),
    passwordHash: cleanText(input.passwordHash, 256),
    updatedAt
  };
}

function hasConfiguredAdminRecord(input = {}) {
  return Boolean(
    cleanText(input.passwordSalt, 128) &&
    cleanText(input.passwordHash, 256)
  );
}

function selectCanonicalAdminRecord(primary, fallback) {
  return hasConfiguredAdminRecord(primary) ? primary : fallback;
}

function selectCanonicalAdminSessions(primary, fallback) {
  if (Array.isArray(primary) && primary.length) {
    return primary;
  }

  return Array.isArray(fallback) ? fallback : [];
}

function normalizeAdminSession(input = {}) {
  const createdAt = cleanText(input.createdAt, 40) || nowIso();
  const updatedAt = cleanText(input.updatedAt, 40) || createdAt;
  const expiresAt = cleanText(input.expiresAt, 40);

  return {
    id: cleanText(input.id, 120),
    createdAt,
    updatedAt,
    expiresAt,
    revokedAt: cleanText(input.revokedAt, 40),
    csrfToken: cleanText(input.csrfToken, 120),
    userAgent: cleanText(input.userAgent, 240)
  };
}

function normalizeEmployeeSession(input = {}) {
  const createdAt = cleanText(input.createdAt, 40) || nowIso();
  const updatedAt = cleanText(input.updatedAt, 40) || createdAt;
  const expiresAt = cleanText(input.expiresAt, 40);

  return {
    id: cleanText(input.id, 120),
    employeeId: cleanText(input.employeeId, 80),
    sessionVersion: Number.isInteger(input.sessionVersion) && input.sessionVersion >= 0
      ? input.sessionVersion
      : 0,
    createdAt,
    updatedAt,
    expiresAt,
    revokedAt: cleanText(input.revokedAt, 40),
    userAgent: cleanText(input.userAgent, 240)
  };
}

function normalizeSecurityKey(value) {
  return cleanText(value, 160).toLowerCase() || "unknown";
}

function normalizeLoginGuardEntry(input = {}) {
  return {
    key: normalizeSecurityKey(input.key),
    failureCount: Number.isFinite(Number(input.failureCount)) && Number(input.failureCount) > 0
      ? Math.floor(Number(input.failureCount))
      : 0,
    firstFailureAt: cleanText(input.firstFailureAt, 40),
    lastFailureAt: cleanText(input.lastFailureAt, 40),
    backoffUntil: cleanText(input.backoffUntil, 40),
    lockUntil: cleanText(input.lockUntil, 40)
  };
}

function normalizeLoginGuardBucket(input = {}) {
  return {
    byIp: Array.isArray(input.byIp)
      ? input.byIp.map((entry) => normalizeLoginGuardEntry(entry)).filter((entry) => entry.key)
      : [],
    byAccount: Array.isArray(input.byAccount)
      ? input.byAccount.map((entry) => normalizeLoginGuardEntry(entry)).filter((entry) => entry.key)
      : []
  };
}

function normalizeLoginGuards(input = {}) {
  return {
    hr: normalizeLoginGuardBucket(input.hr || input.admin),
    webmaster: normalizeLoginGuardBucket(input.webmaster),
    employee: normalizeLoginGuardBucket(input.employee)
  };
}

function normalizeSecurityEvent(input = {}) {
  const createdAt = cleanText(input.createdAt, 40) || nowIso();

  return {
    id: cleanText(input.id, 120) || crypto.randomUUID(),
    createdAt,
    type: cleanText(input.type, 80),
    actor: cleanText(input.actor, 40),
    accountKey: cleanText(input.accountKey, 80),
    sourceIp: normalizeSecurityKey(input.sourceIp),
    outcome: cleanText(input.outcome, 40),
    detail: cleanText(input.detail, 200),
    userAgent: cleanText(input.userAgent, 240)
  };
}

function normalizeRecoveryChallenge(input = {}) {
  return {
    codeSalt: cleanText(input.codeSalt, 128),
    codeHash: cleanText(input.codeHash, 256),
    email: cleanText(input.email, 200),
    requestedAt: cleanText(input.requestedAt, 40),
    expiresAt: cleanText(input.expiresAt, 40),
    consumedAt: cleanText(input.consumedAt, 40)
  };
}

function normalizeRecoveryState(input = {}) {
  return {
    hr: normalizeRecoveryChallenge(input.hr)
  };
}

function normalizeSecurityState(input = {}) {
  const admin = normalizeAdmin(selectCanonicalAdminRecord(input.hr, input.admin));
  const webmaster = normalizeAdmin(input.webmaster);

  const employees = Array.isArray(input.employees)
    ? input.employees
      .map((employee) => normalizeEmployee(employee))
      .filter((employee) => employee.username && employee.passwordSalt && employee.passwordHash)
    : [];
  const adminSessions = selectCanonicalAdminSessions(input.hrSessions, input.adminSessions)
    .map((session) => normalizeAdminSession(session))
    .filter((session) => session.id && session.csrfToken);
  const webmasterSessions = Array.isArray(input.webmasterSessions)
    ? input.webmasterSessions
      .map((session) => normalizeAdminSession(session))
      .filter((session) => session.id && session.csrfToken)
    : [];
  const employeeSessions = Array.isArray(input.employeeSessions)
    ? input.employeeSessions
      .map((session) => normalizeEmployeeSession(session))
      .filter((session) => session.id && session.employeeId)
    : [];
  const loginGuards = normalizeLoginGuards(input.loginGuards);
  const recovery = normalizeRecoveryState(input.recovery);
  const securityEvents = Array.isArray(input.securityEvents)
    ? input.securityEvents
      .map((event) => normalizeSecurityEvent(event))
      .filter((event) => event.type && event.outcome)
      .slice(0, SECURITY_EVENT_LIMIT)
    : [];

  return {
    admin,
    hr: admin,
    adminSessions,
    hrSessions: adminSessions,
    webmaster,
    webmasterSessions,
    employees,
    employeeSessions,
    loginGuards,
    recovery,
    securityEvents
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

function parseCookies(value) {
  const cookies = {};

  for (const entry of String(value || "").split(";")) {
    const [rawName, ...rawValueParts] = entry.split("=");
    const name = String(rawName || "").trim();

    if (!name) {
      continue;
    }

    cookies[name] = decodeURIComponent(rawValueParts.join("=").trim());
  }

  return cookies;
}

function publicEmployeeRecord(employee, sessions = []) {
  const activeSessions = sessions.filter((session) => !session.revokedAt && new Date(session.expiresAt).getTime() > Date.now()).length;

  return {
    id: employee.id,
    name: employee.name,
    username: employee.username,
    active: employee.active !== false,
    sessionVersion: employee.sessionVersion || 0,
    activeSessions,
    lastLoginAt: employee.lastLoginAt || "",
    createdAt: employee.createdAt || "",
    updatedAt: employee.updatedAt || "",
    disabledAt: employee.disabledAt || ""
  };
}

function runtimeSnapshot(state, initializedAt) {
  const admin = state?.hr || state?.admin || {};
  const webmaster = state?.webmaster || {};
  const adminConfigured = Boolean(admin.passwordSalt && admin.passwordHash);
  const webmasterConfigured = Boolean(webmaster.passwordSalt && webmaster.passwordHash);
  const employees = Array.isArray(state?.employees) ? state.employees : [];
  const adminSessions = Array.isArray(state?.hrSessions) ? state.hrSessions : Array.isArray(state?.adminSessions) ? state.adminSessions : [];
  const webmasterSessions = Array.isArray(state?.webmasterSessions) ? state.webmasterSessions : [];
  const employeeSessions = Array.isArray(state?.employeeSessions) ? state.employeeSessions : [];
  const activeEmployees = employees.filter((employee) => employee.active !== false).length;
  const adminSummary = {
    enabled: adminConfigured,
    access: adminConfigured ? 'password' : 'setup-required',
    updatedAt: admin.updatedAt || initializedAt || nowIso(),
    activeSessions: adminSessions.filter((session) => !session.revokedAt && new Date(session.expiresAt).getTime() > Date.now()).length
  };

  return {
    admin: adminSummary,
    hr: adminSummary,
    webmaster: {
      enabled: webmasterConfigured,
      access: webmasterConfigured ? 'password' : 'hr-provisioned',
      updatedAt: webmaster.updatedAt || initializedAt || nowIso(),
      activeSessions: webmasterSessions.filter((session) => !session.revokedAt && new Date(session.expiresAt).getTime() > Date.now()).length
    },
    accessModel: adminConfigured || webmasterConfigured || employees.length ? 'managed-accounts' : 'open',
    employees: {
      total: employees.length,
      active: activeEmployees,
      inactive: Math.max(0, employees.length - activeEmployees),
      sessions: employeeSessions.filter((session) => !session.revokedAt && new Date(session.expiresAt).getTime() > Date.now()).length
    }
  };
}

function isSessionExpired(session) {
  const expiresAt = new Date(session?.expiresAt || 0).getTime();
  return !expiresAt || expiresAt <= Date.now();
}

function createEmployeeSession(employee, userAgent = "") {
  const createdAt = nowIso();

  return {
    id: crypto.randomBytes(32).toString("hex"),
    employeeId: employee.id,
    sessionVersion: Number(employee.sessionVersion || 0),
    createdAt,
    updatedAt: createdAt,
    expiresAt: new Date(Date.now() + EMPLOYEE_SESSION_TTL_MS).toISOString(),
    revokedAt: "",
    userAgent: cleanText(userAgent, 240)
  };
}

function createAdminSession(userAgent = "") {
  const createdAt = nowIso();

  return {
    id: crypto.randomBytes(32).toString("hex"),
    createdAt,
    updatedAt: createdAt,
    expiresAt: new Date(Date.now() + ADMIN_SESSION_TTL_MS).toISOString(),
    revokedAt: "",
    csrfToken: crypto.randomBytes(24).toString("hex"),
    userAgent: cleanText(userAgent, 240)
  };
}

function toTimestamp(value) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function formatDurationMs(durationMs) {
  const totalSeconds = Math.max(1, Math.ceil(Number(durationMs || 0) / 1000));

  if (totalSeconds < 60) {
    return `${totalSeconds} second${totalSeconds === 1 ? "" : "s"}`;
  }

  const totalMinutes = Math.ceil(totalSeconds / 60);
  return `${totalMinutes} minute${totalMinutes === 1 ? "" : "s"}`;
}

function activeGuardUntil(entry) {
  return Math.max(toTimestamp(entry?.backoffUntil), toTimestamp(entry?.lockUntil));
}

function resetLoginGuardEntry(entry) {
  entry.failureCount = 0;
  entry.firstFailureAt = "";
  entry.lastFailureAt = "";
  entry.backoffUntil = "";
  entry.lockUntil = "";
  return entry;
}

function refreshLoginGuardEntry(entry, nowMs = Date.now()) {
  if (!entry) {
    return entry;
  }

  if (activeGuardUntil(entry) > nowMs) {
    return entry;
  }

  const lastFailureAt = toTimestamp(entry.lastFailureAt);

  if (lastFailureAt && nowMs - lastFailureAt <= LOGIN_FAILURE_WINDOW_MS) {
    return entry;
  }

  return resetLoginGuardEntry(entry);
}

function pruneLoginGuardEntries(entries, nowMs = Date.now()) {
  return entries
    .map((entry) => refreshLoginGuardEntry(entry, nowMs))
    .filter((entry) => {
      if (!entry.key) {
        return false;
      }

      const touchedAt = Math.max(
        toTimestamp(entry.firstFailureAt),
        toTimestamp(entry.lastFailureAt),
        toTimestamp(entry.backoffUntil),
        toTimestamp(entry.lockUntil)
      );

      return entry.failureCount > 0 || touchedAt > nowMs - LOGIN_GUARD_RETENTION_MS;
    });
}

function ensureLoginGuards(data) {
  data.loginGuards = normalizeLoginGuards(data.loginGuards);
  return data.loginGuards;
}

function pruneLoginControls(data, nowMs = Date.now()) {
  const loginGuards = ensureLoginGuards(data);
  loginGuards.hr.byIp = pruneLoginGuardEntries(loginGuards.hr.byIp, nowMs);
  loginGuards.hr.byAccount = pruneLoginGuardEntries(loginGuards.hr.byAccount, nowMs);
  loginGuards.webmaster.byIp = pruneLoginGuardEntries(loginGuards.webmaster.byIp, nowMs);
  loginGuards.webmaster.byAccount = pruneLoginGuardEntries(loginGuards.webmaster.byAccount, nowMs);
  loginGuards.employee.byIp = pruneLoginGuardEntries(loginGuards.employee.byIp, nowMs);
  loginGuards.employee.byAccount = pruneLoginGuardEntries(loginGuards.employee.byAccount, nowMs);
  data.securityEvents = Array.isArray(data.securityEvents) ? data.securityEvents.slice(0, SECURITY_EVENT_LIMIT) : [];
  return loginGuards;
}

function findOrCreateLoginGuard(entries, key) {
  const normalizedKey = normalizeSecurityKey(key);
  let entry = entries.find((candidate) => candidate.key === normalizedKey);

  if (!entry) {
    entry = normalizeLoginGuardEntry({ key: normalizedKey });
    entries.push(entry);
  }

  return entry;
}

function describeLoginGuardBlock(entry, nowMs = Date.now()) {
  if (!entry) {
    return null;
  }

  refreshLoginGuardEntry(entry, nowMs);

  const lockUntil = toTimestamp(entry.lockUntil);

  if (lockUntil > nowMs) {
    return {
      mode: "lockout",
      blockedUntil: lockUntil,
      failureCount: Number(entry.failureCount || 0)
    };
  }

  const backoffUntil = toTimestamp(entry.backoffUntil);

  if (backoffUntil > nowMs) {
    return {
      mode: "backoff",
      blockedUntil: backoffUntil,
      failureCount: Number(entry.failureCount || 0)
    };
  }

  return null;
}

function selectLongerBlock(left, right) {
  if (!left) {
    return right || null;
  }

  if (!right) {
    return left;
  }

  return left.blockedUntil >= right.blockedUntil ? left : right;
}

function updateLoginGuardFailure(entry, nowMs = Date.now()) {
  refreshLoginGuardEntry(entry, nowMs);
  const nextCount = Number(entry.failureCount || 0) + 1;
  const nowText = new Date(nowMs).toISOString();
  const backoffMs = nextCount >= LOGIN_BACKOFF_START_FAILURE
    ? Math.min(LOGIN_BACKOFF_MAX_MS, LOGIN_BACKOFF_BASE_MS * (2 ** (nextCount - LOGIN_BACKOFF_START_FAILURE)))
    : 0;
  const lockoutMs = nextCount >= LOGIN_LOCKOUT_START_FAILURE
    ? Math.min(LOGIN_LOCKOUT_MAX_MS, LOGIN_LOCKOUT_STEP_MS * (nextCount - LOGIN_LOCKOUT_START_FAILURE + 1))
    : 0;

  entry.failureCount = nextCount;
  entry.firstFailureAt = entry.firstFailureAt || nowText;
  entry.lastFailureAt = nowText;
  entry.backoffUntil = backoffMs ? new Date(nowMs + backoffMs).toISOString() : "";
  entry.lockUntil = lockoutMs ? new Date(nowMs + lockoutMs).toISOString() : "";

  return describeLoginGuardBlock(entry, nowMs);
}

function clearLoginGuards(bucket, accountKey, sourceIp) {
  const normalizedAccountKey = normalizeSecurityKey(accountKey);
  const normalizedSourceIp = normalizeSecurityKey(sourceIp);
  bucket.byAccount = bucket.byAccount.filter((entry) => entry.key !== normalizedAccountKey);
  bucket.byIp = bucket.byIp.filter((entry) => entry.key !== normalizedSourceIp);
}

function createSecurityEvent(input = {}) {
  return normalizeSecurityEvent({
    id: crypto.randomUUID(),
    createdAt: nowIso(),
    ...input
  });
}

function appendSecurityEvent(data, event) {
  const current = Array.isArray(data.securityEvents) ? data.securityEvents : [];
  data.securityEvents = [event, ...current].slice(0, SECURITY_EVENT_LIMIT);
  return event;
}

function createLoginAttemptState(data, actor, accountKey, clientIp) {
  const nowMs = Date.now();
  const loginGuards = pruneLoginControls(data, nowMs);
  const bucket = actor === 'employee'
    ? loginGuards.employee
    : actor === 'webmaster'
      ? loginGuards.webmaster
      : loginGuards.hr;
  const normalizedAccountKey = actor === 'employee'
    ? (normalizeUsername(accountKey) || 'unknown')
    : actor === 'webmaster'
      ? 'webmaster'
      : 'hr';
  const normalizedSourceIp = normalizeSecurityKey(clientIp);
  const ipGuard = bucket.byIp.find((entry) => entry.key === normalizedSourceIp);
  const accountGuard = bucket.byAccount.find((entry) => entry.key === normalizedAccountKey);

  return {
    actor,
    nowMs,
    bucket,
    accountKey: normalizedAccountKey,
    sourceIp: normalizedSourceIp,
    block: selectLongerBlock(
      describeLoginGuardBlock(ipGuard, nowMs),
      describeLoginGuardBlock(accountGuard, nowMs)
    )
  };
}

function loginThrottleMessage(block) {
  const retryIn = formatDurationMs(Math.max(1000, Number(block?.blockedUntil || 0) - Date.now()));
  return block?.mode === "lockout"
    ? `Too many failed sign-in attempts. Access is temporarily locked. Try again in ${retryIn}.`
    : `Too many failed sign-in attempts. Please wait ${retryIn} before trying again.`;
}

function createFailedAttemptResult(data, attempt, errorMessage, detail, userAgent, statusCode = 400) {
  const ipGuard = findOrCreateLoginGuard(attempt.bucket.byIp, attempt.sourceIp);
  const accountGuard = findOrCreateLoginGuard(attempt.bucket.byAccount, attempt.accountKey);
  const ipBlock = updateLoginGuardFailure(ipGuard, attempt.nowMs);
  const accountBlock = updateLoginGuardFailure(accountGuard, attempt.nowMs);
  const activeBlock = selectLongerBlock(ipBlock, accountBlock);
  const event = appendSecurityEvent(data, createSecurityEvent({
    type: `${attempt.actor}_login_failed`,
    actor: attempt.actor,
    accountKey: attempt.accountKey,
    sourceIp: attempt.sourceIp,
    outcome: activeBlock ? activeBlock.mode : "denied",
    detail,
    userAgent
  }));

  return {
    ok: false,
    statusCode,
    error: errorMessage,
    event
  };
}

function createThrottledAttemptResult(data, attempt, userAgent) {
  const event = appendSecurityEvent(data, createSecurityEvent({
    type: `${attempt.actor}_login_throttled`,
    actor: attempt.actor,
    accountKey: attempt.accountKey,
    sourceIp: attempt.sourceIp,
    outcome: attempt.block?.mode || "blocked",
    detail: "retry-later",
    userAgent
  }));

  return {
    ok: false,
    statusCode: 429,
    error: loginThrottleMessage(attempt.block),
    event
  };
}

function logSecurityEvent(event) {
  if (!event) {
    return;
  }

  console.warn([
    "[security]",
    event.type || "event",
    `outcome=${event.outcome || "unknown"}`,
    event.actor ? `actor=${event.actor}` : "",
    event.accountKey ? `account=${event.accountKey}` : "",
    event.sourceIp ? `ip=${event.sourceIp}` : "",
    event.detail ? `detail=${event.detail}` : ""
  ].filter(Boolean).join(" "));
}

function employeeAccessResponse(employee, session) {
  return {
    authorized: true,
    employee: {
      id: employee.id,
      name: employee.name,
      username: employee.username
    },
    sessionExpiresAt: session.expiresAt
  };
}

function validateEmployeePassword(password) {
  if (String(password || "").length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
}

function validateAdminPassword(password) {
  if (String(password || "").length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Admin password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
}

function adminAccessResponse(session) {
  return {
    authorized: true,
    setupRequired: false,
    sessionExpiresAt: session.expiresAt,
    csrfToken: session.csrfToken
  };
}

function findValidRoleSession(sessions, sessionId) {
  if (!sessionId) {
    return null;
  }

  const session = sessions.find((entry) => entry.id === sessionId);

  if (!session || session.revokedAt || isSessionExpired(session)) {
    return null;
  }

  return session;
}

function activeCookieValue(req = {}, names = []) {
  const cookies = parseCookies(req.headers?.cookie || '');

  for (const name of names) {
    if (cookies[name]) {
      return cookies[name];
    }
  }

  return '';
}

function findValidAdminSession(data, sessionId) {
  return findValidRoleSession(data.adminSessions, sessionId);
}

function revokeOtherSessions(sessions, activeSessionId, changedAt) {
  return sessions.map((session) => {
    if (session.id === activeSessionId) {
      return {
        ...session,
        updatedAt: changedAt,
        revokedAt: ""
      };
    }

    if (session.revokedAt || isSessionExpired(session)) {
      return session;
    }

    return {
      ...session,
      revokedAt: changedAt,
      updatedAt: changedAt
    };
  });
}

function clearRoleLoginGuards(data, actor) {
  const loginGuards = ensureLoginGuards(data);
  const bucket = actor === "webmaster"
    ? loginGuards.webmaster
    : actor === "employee"
      ? loginGuards.employee
      : loginGuards.hr;

  bucket.byIp = [];
  bucket.byAccount = [];
}

export { normalizeSecurityState };

export function createSecurityStore({ dataFile } = {}) {
  const backend = dataFile ? "file" : "memory";
  let initPromise = null;
  let writeQueue = Promise.resolve();
  let memoryState = normalizeSecurityState();
  let initializedAt = "";
  const HR_RECOVERY_CODE_TTL_MS = 15 * 60 * 1000;
  const HR_RECOVERY_REQUEST_COOLDOWN_MS = 60 * 1000;

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
        initializedAt = nowIso();
        return readStoredState();
      });
    }

    return initPromise;
  }

  async function readData() {
    await init();
    const data = await readStoredState();
    return runtimeSnapshot(data, initializedAt);
  }

  async function writeData(data) {
    await init();

    const next = writeQueue.then(async () => {
      const stored = await writeStoredState(data);
      return runtimeSnapshot(stored, initializedAt);
    });

    writeQueue = next.catch(() => {});
    return next;
  }

  async function updateData(mutator) {
    await init();

    const next = writeQueue.then(async () => {
      const data = await readStoredState();
      const result = await mutator(data);
      const stored = await writeStoredState(data);
      return {
        result,
        snapshot: runtimeSnapshot(stored, initializedAt)
      };
    });

    writeQueue = next.catch(() => {});
    return next;
  }

  async function readSecurityState() {
    await init();
    return readStoredState();
  }

  async function checkHrAccess(req = {}) {
    await init();
    const data = await readStoredState();
    const adminConfigured = Boolean(data.admin.passwordSalt && data.admin.passwordHash);

    if (!adminConfigured) {
      return {
        authorized: false,
        setupRequired: true,
        sessionExpiresAt: '',
        csrfToken: ''
      };
    }

    const cookieNames = getAccessCookieNames();
    const session = findValidAdminSession(data, activeCookieValue(req, [cookieNames.hr, cookieNames.legacyHr]));

    if (!session) {
      return {
        authorized: false,
        setupRequired: false,
        sessionExpiresAt: '',
        csrfToken: ''
      };
    }

    return adminAccessResponse(session);
  }

  async function checkWebmasterAccess(req = {}) {
    await init();
    const data = await readStoredState();
    const hrAccess = await checkHrAccess(req);
    const webmasterConfigured = Boolean(data.webmaster.passwordSalt && data.webmaster.passwordHash);

    if (!webmasterConfigured) {
      return {
        authorized: false,
        setupRequired: true,
        hrAuthorized: Boolean(hrAccess.authorized),
        sessionExpiresAt: '',
        csrfToken: ''
      };
    }

    const cookieNames = getAccessCookieNames();
    const session = findValidRoleSession(data.webmasterSessions, activeCookieValue(req, [cookieNames.webmaster]));

    if (!session) {
      return {
        authorized: false,
        setupRequired: false,
        hrAuthorized: Boolean(hrAccess.authorized),
        sessionExpiresAt: '',
        csrfToken: ''
      };
    }

    return {
      ...adminAccessResponse(session),
      hrAuthorized: Boolean(hrAccess.authorized)
    };
  }

  async function checkEmployeeAccess(req = {}) {
    await init();
    const data = await readStoredState();
    const cookieNames = getAccessCookieNames();
    const sessionId = parseCookies(req.headers?.cookie || "")[cookieNames.employee];

    if (!sessionId) {
      return {
        authorized: false,
        sessionExpiresAt: "",
        employee: null
      };
    }

    const session = data.employeeSessions.find((entry) => entry.id === sessionId);

    if (!session || session.revokedAt || isSessionExpired(session)) {
      return {
        authorized: false,
        sessionExpiresAt: "",
        employee: null
      };
    }

    const employee = data.employees.find((entry) => entry.id === session.employeeId);

    if (!employee || employee.active === false || Number(employee.sessionVersion || 0) !== Number(session.sessionVersion || 0)) {
      return {
        authorized: false,
        sessionExpiresAt: "",
        employee: null
      };
    }

    return employeeAccessResponse(employee, session);
  }

  async function authenticateEmployee({ username, password, userAgent = "", clientIp = "" } = {}) {
    const normalizedUsername = normalizeUsername(username);
    const passwordText = String(password || "");

    if (!normalizedUsername || !passwordText) {
      throw new Error("Username and password are required.");
    }

    return updateData((data) => {
      const attempt = createLoginAttemptState(data, "employee", normalizedUsername, clientIp);

      if (attempt.block) {
        return createThrottledAttemptResult(data, attempt, userAgent);
      }

      const employee = data.employees.find((entry) => entry.username === normalizedUsername);

      if (!employee || employee.active === false) {
        return createFailedAttemptResult(data, attempt, "Invalid username or password.", employee ? "inactive-account" : "unknown-username", userAgent);
      }

      if (!verifyPassword(passwordText, employee.passwordSalt, employee.passwordHash)) {
        return createFailedAttemptResult(data, attempt, "Invalid username or password.", "invalid-password", userAgent);
      }

      clearLoginGuards(attempt.bucket, normalizedUsername, clientIp);
      const session = createEmployeeSession(employee, userAgent);
      employee.lastLoginAt = nowIso();
      employee.updatedAt = employee.lastLoginAt;
      data.employeeSessions = [
        session,
        ...data.employeeSessions.filter((entry) => entry.id !== session.id && !isSessionExpired(entry) && !entry.revokedAt)
      ];

      return {
        ok: true,
        session,
        employee: publicEmployeeRecord(employee, data.employeeSessions)
      };
    }).then(({ result }) => {
      if (!result.ok) {
        logSecurityEvent(result.event);
        const error = new Error(result.error);
        error.statusCode = result.statusCode;
        throw error;
      }

      return {
        ...employeeAccessResponse(
          {
            id: result.employee.id,
            name: result.employee.name,
            username: result.employee.username
          },
          result.session
        ),
        sessionId: result.session.id
      };
    });
  }

  async function setupAdminAccess({ password, userAgent = "" } = {}) {
    validateAdminPassword(password);

    return updateData((data) => {
      if (data.admin.passwordSalt && data.admin.passwordHash) {
        throw new Error("Admin access is already configured.");
      }

      const nextPassword = createPasswordHash(password);
      const session = createAdminSession(userAgent);
      data.admin = {
        passwordSalt: nextPassword.salt,
        passwordHash: nextPassword.hash,
        updatedAt: nowIso()
      };
      data.adminSessions = [session];
      data.hr = { ...data.admin };
      data.hrSessions = data.adminSessions;
      return { session };
    }).then(({ result }) => ({
      ...adminAccessResponse(result.session),
      sessionId: result.session.id
    }));
  }

  async function authenticateAdmin({ password, userAgent = '', clientIp = '' } = {}) {
    const passwordText = String(password || '');

    if (!passwordText) {
      throw new Error('Password is required.');
    }

    return updateData((data) => {
      const attempt = createLoginAttemptState(data, 'hr', 'hr', clientIp);

      if (attempt.block) {
        return createThrottledAttemptResult(data, attempt, userAgent);
      }

      if (!data.admin.passwordSalt || !data.admin.passwordHash) {
        throw new Error('Admin access has not been configured.');
      }

      if (!verifyPassword(passwordText, data.admin.passwordSalt, data.admin.passwordHash)) {
        return createFailedAttemptResult(data, attempt, 'Invalid password.', 'invalid-password', userAgent);
      }

      clearLoginGuards(attempt.bucket, 'hr', clientIp);
      const session = createAdminSession(userAgent);
      data.admin.updatedAt = nowIso();
      data.adminSessions = [
        session,
        ...data.adminSessions.filter((entry) => entry.id !== session.id && !isSessionExpired(entry) && !entry.revokedAt)
      ];
      data.hr = { ...data.admin };
      data.hrSessions = data.adminSessions;
      return {
        ok: true,
        session
      };
    }).then(({ result }) => {
      if (!result.ok) {
        logSecurityEvent(result.event);
        const error = new Error(result.error);
        error.statusCode = result.statusCode;
        throw error;
      }

      return {
        ...adminAccessResponse(result.session),
        sessionId: result.session.id
      };
    });
  }

  async function setupWebmasterAccess({ password, userAgent = '' } = {}) {
    validateAdminPassword(password);

    return updateData((data) => {
      if (data.webmaster.passwordSalt && data.webmaster.passwordHash) {
        throw new Error('Webmaster access is already configured.');
      }

      const nextPassword = createPasswordHash(password);
      const session = createAdminSession(userAgent);
      data.webmaster = {
        passwordSalt: nextPassword.salt,
        passwordHash: nextPassword.hash,
        updatedAt: nowIso()
      };
      data.webmasterSessions = [session];
      return { session };
    }).then(({ result }) => ({
      ...adminAccessResponse(result.session),
      sessionId: result.session.id
    }));
  }

  async function authenticateWebmaster({ password, userAgent = '', clientIp = '' } = {}) {
    const passwordText = String(password || '');

    if (!passwordText) {
      throw new Error('Password is required.');
    }

    return updateData((data) => {
      const attempt = createLoginAttemptState(data, 'webmaster', 'webmaster', clientIp);

      if (attempt.block) {
        return createThrottledAttemptResult(data, attempt, userAgent);
      }

      if (!data.webmaster.passwordSalt || !data.webmaster.passwordHash) {
        throw new Error('Webmaster access has not been configured.');
      }

      if (!verifyPassword(passwordText, data.webmaster.passwordSalt, data.webmaster.passwordHash)) {
        return createFailedAttemptResult(data, attempt, 'Invalid password.', 'invalid-password', userAgent);
      }

      clearLoginGuards(attempt.bucket, 'webmaster', clientIp);
      const session = createAdminSession(userAgent);
      data.webmaster.updatedAt = nowIso();
      data.webmasterSessions = [
        session,
        ...data.webmasterSessions.filter((entry) => entry.id !== session.id && !isSessionExpired(entry) && !entry.revokedAt)
      ];
      return {
        ok: true,
        session
      };
    }).then(({ result }) => {
      if (!result.ok) {
        logSecurityEvent(result.event);
        const error = new Error(result.error);
        error.statusCode = result.statusCode;
        throw error;
      }

      return {
        ...adminAccessResponse(result.session),
        sessionId: result.session.id
      };
    });
  }

  async function logoutAdmin(req = {}) {
    await init();
    const cookieNames = getAccessCookieNames();
    const sessionId = activeCookieValue(req, [cookieNames.hr, cookieNames.legacyHr]);

    if (!sessionId) {
      return { removed: false };
    }

    return updateData((data) => {
      const session = data.adminSessions.find((entry) => entry.id === sessionId);

      if (!session) {
        return { removed: false };
      }

      session.revokedAt = nowIso();
      session.updatedAt = session.revokedAt;
      data.hrSessions = data.adminSessions;
      return { removed: true };
    }).then(({ result }) => result);
  }

  async function logoutWebmaster(req = {}) {
    await init();
    const cookieNames = getAccessCookieNames();
    const sessionId = activeCookieValue(req, [cookieNames.webmaster]);

    if (!sessionId) {
      return { removed: false };
    }

    return updateData((data) => {
      const session = data.webmasterSessions.find((entry) => entry.id === sessionId);

      if (!session) {
        return { removed: false };
      }

      session.revokedAt = nowIso();
      session.updatedAt = session.revokedAt;
      return { removed: true };
    }).then(({ result }) => result);
  }

  async function logoutEmployee(req = {}) {
    await init();
    const cookieNames = getAccessCookieNames();
    const sessionId = parseCookies(req.headers?.cookie || "")[cookieNames.employee];

    if (!sessionId) {
      return { removed: false };
    }

    return updateData((data) => {
      const session = data.employeeSessions.find((entry) => entry.id === sessionId);

      if (!session) {
        return { removed: false };
      }

      session.revokedAt = nowIso();
      session.updatedAt = session.revokedAt;
      return { removed: true };
    }).then(({ result }) => result);
  }

  async function listSecurityEvents({ limit = 100 } = {}) {
    await init();
    const data = await readStoredState();
    const max = Math.max(1, Math.min(200, Number(limit) || 100));
    return {
      events: Array.isArray(data.securityEvents) ? data.securityEvents.slice(0, max) : []
    };
  }

  async function listEmployees() {
    const data = await readSecurityState();
    return data.employees
      .map((employee) => publicEmployeeRecord(employee, data.employeeSessions.filter((session) => session.employeeId === employee.id)))
      .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  }

  async function createEmployeeAccount({ name, username, password } = {}) {
    const employeeName = cleanText(name, 120);
    const employeeUsername = normalizeUsername(username);

    if (!employeeName) {
      throw new Error("Employee name is required.");
    }

    if (!employeeUsername) {
      throw new Error("Username is required.");
    }

    validateEmployeePassword(password);

    return updateData((data) => {
      const duplicate = data.employees.some((employee) => employee.username === employeeUsername);

      if (duplicate) {
        throw new Error("That username is already in use.");
      }

      const passwordHash = createPasswordHash(password);
      const createdAt = nowIso();
      const employee = normalizeEmployee({
        id: crypto.randomUUID(),
        name: employeeName,
        username: employeeUsername,
        passwordSalt: passwordHash.salt,
        passwordHash: passwordHash.hash,
        active: true,
        sessionVersion: 0,
        lastLoginAt: "",
        createdAt,
        updatedAt: createdAt,
        disabledAt: ""
      });

      data.employees.unshift(employee);
      return employee;
    }).then(({ result, snapshot }) => ({
      employee: publicEmployeeRecord(result, []),
      snapshot
    }));
  }

  async function setEmployeeActive(employeeId, active) {
    const targetId = cleanText(employeeId, 80);

    if (!targetId) {
      throw new Error("Employee id is required.");
    }

    return updateData((data) => {
      const employee = data.employees.find((entry) => entry.id === targetId);

      if (!employee) {
        throw new Error("Employee not found.");
      }

      const nextActive = Boolean(active);
      employee.active = nextActive;
      employee.updatedAt = nowIso();
      employee.disabledAt = nextActive ? "" : employee.updatedAt;
      employee.sessionVersion = Number(employee.sessionVersion || 0) + 1;

      data.employeeSessions = data.employeeSessions.map((session) => (
        session.employeeId === employee.id
          ? {
              ...session,
              revokedAt: session.revokedAt || employee.updatedAt,
              updatedAt: employee.updatedAt
            }
          : session
      ));

      return employee;
    }).then(({ result, snapshot }) => ({
      employee: publicEmployeeRecord(result, []),
      snapshot
    }));
  }

  async function changeAdminPassword(req = {}, { currentPassword, password, userAgent = "", clientIp = "" } = {}) {
    const currentPasswordText = String(currentPassword || "");
    const nextPasswordText = String(password || "");

    if (!currentPasswordText) {
      throw new Error("Current password is required.");
    }

    validateAdminPassword(nextPasswordText);

    return updateData((data) => {
      const cookieNames = getAccessCookieNames();
      const activeSessionId = activeCookieValue(req, [cookieNames.hr, cookieNames.legacyHr]);
      const session = findValidAdminSession(data, activeSessionId);

      if (!session) {
        throw new Error("You must be signed in as HR.");
      }

      if (!data.admin.passwordSalt || !data.admin.passwordHash) {
        throw new Error("Admin access has not been configured.");
      }

      if (!verifyPassword(currentPasswordText, data.admin.passwordSalt, data.admin.passwordHash)) {
        throw new Error("Current password is incorrect.");
      }

      if (verifyPassword(nextPasswordText, data.admin.passwordSalt, data.admin.passwordHash)) {
        throw new Error("Choose a new password.");
      }

      const changedAt = nowIso();
      const nextPassword = createPasswordHash(nextPasswordText);
      const activeSession = {
        ...session,
        updatedAt: changedAt
      };

      data.admin = {
        passwordSalt: nextPassword.salt,
        passwordHash: nextPassword.hash,
        updatedAt: changedAt
      };
      data.hr = { ...data.admin };
      data.adminSessions = revokeOtherSessions(data.adminSessions, session.id, changedAt);
      data.hrSessions = data.adminSessions;
      clearRoleLoginGuards(data, "hr");
      appendSecurityEvent(data, createSecurityEvent({
        type: "hr_password_changed",
        actor: "hr",
        accountKey: "hr",
        sourceIp: normalizeSecurityKey(clientIp),
        outcome: "success",
        detail: "password-updated",
        userAgent
      }));

      return { session: activeSession };
    }).then(({ result }) => ({
      ...adminAccessResponse(result.session),
      sessionId: result.session.id
    }));
  }

  async function changeWebmasterPassword(req = {}, { currentPassword, password, userAgent = "", clientIp = "" } = {}) {
    const currentPasswordText = String(currentPassword || "");
    const nextPasswordText = String(password || "");

    if (!currentPasswordText) {
      throw new Error("Current password is required.");
    }

    validateAdminPassword(nextPasswordText);

    return updateData((data) => {
      const cookieNames = getAccessCookieNames();
      const activeSessionId = activeCookieValue(req, [cookieNames.webmaster]);
      const session = findValidRoleSession(data.webmasterSessions, activeSessionId);

      if (!session) {
        throw new Error("You must be signed in as Webmaster.");
      }

      if (!data.webmaster.passwordSalt || !data.webmaster.passwordHash) {
        throw new Error("Webmaster access has not been configured.");
      }

      if (!verifyPassword(currentPasswordText, data.webmaster.passwordSalt, data.webmaster.passwordHash)) {
        throw new Error("Current password is incorrect.");
      }

      if (verifyPassword(nextPasswordText, data.webmaster.passwordSalt, data.webmaster.passwordHash)) {
        throw new Error("Choose a new password.");
      }

      const changedAt = nowIso();
      const nextPassword = createPasswordHash(nextPasswordText);
      const activeSession = {
        ...session,
        updatedAt: changedAt
      };

      data.webmaster = {
        passwordSalt: nextPassword.salt,
        passwordHash: nextPassword.hash,
        updatedAt: changedAt
      };
      data.webmasterSessions = revokeOtherSessions(data.webmasterSessions, session.id, changedAt);
      clearRoleLoginGuards(data, "webmaster");
      appendSecurityEvent(data, createSecurityEvent({
        type: "webmaster_password_changed",
        actor: "webmaster",
        accountKey: "webmaster",
        sourceIp: normalizeSecurityKey(clientIp),
        outcome: "success",
        detail: "password-updated",
        userAgent
      }));

      return { session: activeSession };
    }).then(({ result }) => ({
      ...adminAccessResponse(result.session),
      sessionId: result.session.id
    }));
  }

  async function resetWebmasterPasswordByHr(req = {}, { password, userAgent = "", clientIp = "" } = {}) {
    const nextPasswordText = String(password || "");
    validateAdminPassword(nextPasswordText);

    return updateData((data) => {
      const cookieNames = getAccessCookieNames();
      const activeSessionId = activeCookieValue(req, [cookieNames.hr, cookieNames.legacyHr]);
      const session = findValidAdminSession(data, activeSessionId);

      if (!session) {
        throw new Error("You must be signed in as HR.");
      }

      const changedAt = nowIso();
      const nextPassword = createPasswordHash(nextPasswordText);

      data.webmaster = {
        passwordSalt: nextPassword.salt,
        passwordHash: nextPassword.hash,
        updatedAt: changedAt
      };

      data.webmasterSessions = data.webmasterSessions.map((entry) => ({
        ...entry,
        revokedAt: entry.revokedAt || changedAt,
        updatedAt: changedAt
      }));

      clearRoleLoginGuards(data, "webmaster");
      appendSecurityEvent(data, createSecurityEvent({
        type: "webmaster_password_reset_by_hr",
        actor: "hr",
        accountKey: "webmaster",
        sourceIp: normalizeSecurityKey(clientIp),
        outcome: "success",
        detail: "password-reset",
        userAgent
      }));

      return {
        resetAt: changedAt
      };
    }).then(({ result }) => result);
  }

  async function issueHrRecoveryCode({ email, userAgent = "", clientIp = "" } = {}) {
    const targetEmail = cleanText(email, 200);

    if (!targetEmail) {
      throw new Error("HR recovery email is not configured.");
    }

    return updateData((data) => {
      const existing = normalizeRecoveryChallenge(data.recovery?.hr);
      const requestedAt = toTimestamp(existing.requestedAt);
      const nowMs = Date.now();

      if (requestedAt && (nowMs - requestedAt) < HR_RECOVERY_REQUEST_COOLDOWN_MS) {
        throw new Error("Wait a moment before requesting another recovery code.");
      }

      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
      const hashed = createPasswordHash(code);
      const requestedAtIso = nowIso();
      const expiresAt = new Date(nowMs + HR_RECOVERY_CODE_TTL_MS).toISOString();

      data.recovery = normalizeRecoveryState(data.recovery);
      data.recovery.hr = {
        codeSalt: hashed.salt,
        codeHash: hashed.hash,
        email: targetEmail,
        requestedAt: requestedAtIso,
        expiresAt,
        consumedAt: ""
      };

      appendSecurityEvent(data, createSecurityEvent({
        type: "hr_recovery_requested",
        actor: "recovery",
        accountKey: "hr",
        sourceIp: normalizeSecurityKey(clientIp),
        outcome: "issued",
        detail: "email-code",
        userAgent
      }));

      return {
        code,
        email: targetEmail,
        expiresAt,
        requestedAt: requestedAtIso
      };
    }).then(({ result }) => result);
  }

  async function recoverAdminAccessByCode({ code, password, userAgent = "", clientIp = "" } = {}) {
    const codeText = cleanText(code, 32);
    const nextPasswordText = String(password || "");

    if (!codeText) {
      throw new Error("Recovery code is required.");
    }

    validateAdminPassword(nextPasswordText);

    return updateData((data) => {
      const challenge = normalizeRecoveryChallenge(data.recovery?.hr);

      if (!challenge.codeSalt || !challenge.codeHash) {
        throw new Error("No HR recovery code is active.");
      }

      if (challenge.consumedAt) {
        throw new Error("That recovery code has already been used.");
      }

      if (toTimestamp(challenge.expiresAt) <= Date.now()) {
        throw new Error("That recovery code has expired.");
      }

      if (!verifyPassword(codeText, challenge.codeSalt, challenge.codeHash)) {
        throw new Error("Recovery code is invalid.");
      }

      const changedAt = nowIso();
      const nextPassword = createPasswordHash(nextPasswordText);
      const session = createAdminSession(userAgent);

      data.admin = {
        passwordSalt: nextPassword.salt,
        passwordHash: nextPassword.hash,
        updatedAt: changedAt
      };
      data.hr = { ...data.admin };
      data.adminSessions = [session];
      data.hrSessions = data.adminSessions;
      data.recovery = normalizeRecoveryState(data.recovery);
      data.recovery.hr = {
        ...challenge,
        codeSalt: "",
        codeHash: "",
        consumedAt: changedAt
      };

      clearRoleLoginGuards(data, "hr");
      appendSecurityEvent(data, createSecurityEvent({
        type: "hr_access_recovered",
        actor: "recovery",
        accountKey: "hr",
        sourceIp: normalizeSecurityKey(clientIp),
        outcome: "success",
        detail: "email-recovery",
        userAgent
      }));

      return { session };
    }).then(({ result }) => ({
      ...adminAccessResponse(result.session),
      sessionId: result.session.id
    }));
  }

  async function recoverAdminAccess({ password, userAgent = "", clientIp = "" } = {}) {
    const nextPasswordText = String(password || "");
    validateAdminPassword(nextPasswordText);

    return updateData((data) => {
      const changedAt = nowIso();
      const nextPassword = createPasswordHash(nextPasswordText);
      const session = createAdminSession(userAgent);

      data.admin = {
        passwordSalt: nextPassword.salt,
        passwordHash: nextPassword.hash,
        updatedAt: changedAt
      };
      data.hr = { ...data.admin };
      data.adminSessions = [session];
      data.hrSessions = data.adminSessions;
      data.recovery = normalizeRecoveryState(data.recovery);
      data.recovery.hr = {
        ...normalizeRecoveryChallenge(data.recovery.hr),
        codeSalt: "",
        codeHash: "",
        consumedAt: changedAt
      };

      clearRoleLoginGuards(data, "hr");
      appendSecurityEvent(data, createSecurityEvent({
        type: "hr_access_recovered",
        actor: "recovery",
        accountKey: "hr",
        sourceIp: normalizeSecurityKey(clientIp),
        outcome: "success",
        detail: "deployment-recovery",
        userAgent
      }));

      return { session };
    }).then(({ result }) => ({
      ...adminAccessResponse(result.session),
      sessionId: result.session.id
    }));
  }

  async function resetEmployeePassword(employeeId, password) {
    const targetId = cleanText(employeeId, 80);

    if (!targetId) {
      throw new Error("Employee id is required.");
    }

    validateEmployeePassword(password);

    return updateData((data) => {
      const employee = data.employees.find((entry) => entry.id === targetId);

      if (!employee) {
        throw new Error("Employee not found.");
      }

      const nextPassword = createPasswordHash(password);
      employee.passwordSalt = nextPassword.salt;
      employee.passwordHash = nextPassword.hash;
      employee.updatedAt = nowIso();
      employee.sessionVersion = Number(employee.sessionVersion || 0) + 1;

      data.employeeSessions = data.employeeSessions.map((session) => (
        session.employeeId === employee.id
          ? {
              ...session,
              revokedAt: session.revokedAt || employee.updatedAt,
              updatedAt: employee.updatedAt
            }
          : session
      ));

      return employee;
    }).then(({ result, snapshot }) => ({
      employee: publicEmployeeRecord(result, []),
      snapshot
    }));
  }

  async function revokeEmployeeSessions(employeeId) {
    const targetId = cleanText(employeeId, 80);

    if (!targetId) {
      throw new Error("Employee id is required.");
    }

    return updateData((data) => {
      const employee = data.employees.find((entry) => entry.id === targetId);

      if (!employee) {
        throw new Error("Employee not found.");
      }

      const revokedAt = nowIso();
      employee.sessionVersion = Number(employee.sessionVersion || 0) + 1;
      employee.updatedAt = revokedAt;
      data.employeeSessions = data.employeeSessions.map((session) => (
        session.employeeId === employee.id
          ? {
              ...session,
              revokedAt: session.revokedAt || revokedAt,
              updatedAt: revokedAt
            }
          : session
      ));

      return employee;
    }).then(({ result, snapshot }) => ({
      employee: publicEmployeeRecord(result, []),
      snapshot
    }));
  }

  function getAccessCookieNames() {
    return {
      admin: "palziv_hr_auth",
      hr: "palziv_hr_auth",
      legacyHr: "palziv_admin_auth",
      webmaster: "palziv_webmaster_auth",
      employee: "palziv_employee_auth"
    };
  }

  async function close() {
    return undefined;
  }

  return {
    backend,
    init,
    readData,
    readSecurityState,
    writeData,
    updateData,
    close,
    getAccessCookieNames,
    setupAdminAccess,
    setupWebmasterAccess,
    authenticateAdmin,
    authenticateWebmaster,
    logoutAdmin,
    logoutWebmaster,
    checkHrAccess,
    checkWebmasterAccess,
    checkEmployeeAccess,
    authenticateEmployee,
    logoutEmployee,
    listSecurityEvents,
    listEmployees,
    createEmployeeAccount,
    setEmployeeActive,
    changeAdminPassword,
    changeWebmasterPassword,
    issueHrRecoveryCode,
    recoverAdminAccessByCode,
    resetWebmasterPasswordByHr,
    recoverAdminAccess,
    resetEmployeePassword,
    revokeEmployeeSessions
  };
}
