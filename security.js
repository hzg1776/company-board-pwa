import crypto from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const EMPLOYEE_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const ADMIN_SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const MIN_PASSWORD_LENGTH = 10;
const ADMIN_INVITE_TTL_MS = 1000 * 60 * 60 * 72;
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

function normalizeEmail(value) {
  return cleanText(value, 200).toLowerCase();
}

function formatDisplayNameFromUsername(username) {
  const normalizedUsername = normalizeUsername(username);

  if (!normalizedUsername) {
    return "Admin";
  }

  return normalizedUsername
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function normalizeAdminDisplayName(value, username = "") {
  return cleanText(value, 120) || formatDisplayNameFromUsername(username);
}

function digestInviteToken(token) {
  return crypto.createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

function createInviteSecret() {
  const token = crypto.randomBytes(32).toString("hex");
  return {
    token,
    tokenHash: digestInviteToken(token),
    expiresAt: new Date(Date.now() + ADMIN_INVITE_TTL_MS).toISOString()
  };
}

function isInviteExpired(expiresAt = "") {
  return toTimestamp(expiresAt) <= Date.now();
}

function adminInviteState(user = {}) {
  if (!cleanText(user.inviteTokenHash, 256)) {
    return cleanText(user.inviteAcceptedAt, 40) ? "accepted" : "none";
  }

  return isInviteExpired(user.inviteExpiresAt) ? "expired" : "pending";
}

function hasActiveInvite(user = {}) {
  return adminInviteState(user) === "pending";
}

function clearAdminInviteMetadata(user = {}, inviteAcceptedAt = "") {
  return {
    ...user,
    inviteTokenHash: "",
    inviteSentAt: "",
    inviteExpiresAt: "",
    inviteAcceptedAt: cleanText(inviteAcceptedAt, 40) || cleanText(user.inviteAcceptedAt, 40)
  };
}

function preferredAdminRoute(user = {}) {
  if (adminUserHasRole(user, "hr")) {
    return "hr";
  }

  if (adminUserHasRole(user, "webmaster")) {
    return "webmaster";
  }

  return "hr";
}

function defaultAdminUsername() {
  return "hr";
}

function defaultWebmasterUsername() {
  return "webmaster";
}

function accessCookieNames() {
  return {
    admin: "palziv_hr_auth",
    hr: "palziv_hr_auth",
    legacyHr: "palziv_admin_auth",
    webmaster: "palziv_webmaster_auth",
    employee: "palziv_employee_auth"
  };
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

function normalizeAdmin(input = {}, defaultUsername = "") {
  const passwordSalt = cleanText(input.passwordSalt, 128);
  const passwordHash = cleanText(input.passwordHash, 256);
  const createdAt = cleanText(input.createdAt, 40) || cleanText(input.updatedAt, 40) || nowIso();
  const updatedAt = cleanText(input.updatedAt, 40) || createdAt;
  const username = normalizeUsername(
    input.username || (passwordSalt && passwordHash ? defaultUsername : "")
  );
  const email = normalizeEmail(input.email);

  return {
    id: cleanText(input.id, 80) || crypto.randomUUID(),
    displayName: normalizeAdminDisplayName(input.displayName, username),
    email,
    username,
    passwordSalt,
    passwordHash,
    roles: normalizeAdminRoles(input.roles),
    active: input.active !== false,
    lastLoginAt: cleanText(input.lastLoginAt, 40),
    createdAt,
    updatedAt,
    disabledAt: cleanText(input.disabledAt, 40),
    inviteTokenHash: cleanText(input.inviteTokenHash, 256),
    inviteSentAt: cleanText(input.inviteSentAt, 40),
    inviteExpiresAt: cleanText(input.inviteExpiresAt, 40),
    inviteAcceptedAt: cleanText(input.inviteAcceptedAt, 40)
  };
}

function normalizeAdminRoles(input) {
  const rawRoles = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? [input]
      : [];
  const seen = new Set();
  const roles = [];

  for (const rawRole of rawRoles) {
    const role = cleanText(rawRole, 40).toLowerCase();

    if ((role === "hr" || role === "webmaster") && !seen.has(role)) {
      seen.add(role);
      roles.push(role);
    }
  }

  return roles;
}

function defaultUsernameForRoles(roles = []) {
  if (roles.includes("hr")) {
    return defaultAdminUsername();
  }

  if (roles.includes("webmaster")) {
    return defaultWebmasterUsername();
  }

  return "";
}

function normalizeAdminUser(input = {}) {
  const roles = normalizeAdminRoles(input.roles);
  return normalizeAdmin({
    ...input,
    roles
  }, defaultUsernameForRoles(roles));
}

function hasConfiguredAdminRecord(input = {}) {
  return Boolean(
    cleanText(input.username, 80) &&
    cleanText(input.passwordSalt, 128) &&
    cleanText(input.passwordHash, 256)
  );
}

function hasConfiguredAdminUser(input = {}) {
  return hasConfiguredAdminRecord(input) && Array.isArray(input.roles) && input.roles.length > 0;
}

function hasKnownAdminUser(input = {}) {
  return Boolean(
    cleanText(input.username, 80) &&
    Array.isArray(input.roles) &&
    input.roles.length > 0
  );
}

function adminUserHasRole(user = {}, role = "") {
  return Array.isArray(user.roles) && user.roles.includes(role);
}

function mergeAdminRoles(...roleLists) {
  return normalizeAdminRoles(roleLists.flat());
}

function choosePreferredAdminRecord(left = {}, right = {}) {
  const leftUpdatedAt = new Date(left.updatedAt || 0).getTime();
  const rightUpdatedAt = new Date(right.updatedAt || 0).getTime();
  return rightUpdatedAt > leftUpdatedAt ? right : left;
}

function mergeAdminUsers(existing = {}, incoming = {}) {
  const preferred = choosePreferredAdminRecord(existing, incoming);
  const fallback = preferred === existing ? incoming : existing;

  return {
    ...fallback,
    ...preferred,
    id: cleanText(existing.id, 80) || cleanText(incoming.id, 80) || crypto.randomUUID(),
    displayName: normalizeAdminDisplayName(preferred.displayName || fallback.displayName, preferred.username || fallback.username),
    email: normalizeEmail(preferred.email || fallback.email),
    username: normalizeUsername(preferred.username || fallback.username),
    roles: mergeAdminRoles(existing.roles, incoming.roles),
    active: existing.active !== false && incoming.active !== false,
    lastLoginAt: cleanText(preferred.lastLoginAt || fallback.lastLoginAt, 40),
    createdAt: cleanText(existing.createdAt, 40) || cleanText(incoming.createdAt, 40) || cleanText(preferred.updatedAt || fallback.updatedAt, 40) || nowIso(),
    updatedAt: cleanText(preferred.updatedAt || fallback.updatedAt, 40) || cleanText(existing.createdAt || incoming.createdAt, 40) || nowIso(),
    disabledAt: cleanText(preferred.disabledAt || fallback.disabledAt, 40),
    inviteTokenHash: cleanText(preferred.inviteTokenHash || fallback.inviteTokenHash, 256),
    inviteSentAt: cleanText(preferred.inviteSentAt || fallback.inviteSentAt, 40),
    inviteExpiresAt: cleanText(preferred.inviteExpiresAt || fallback.inviteExpiresAt, 40),
    inviteAcceptedAt: cleanText(preferred.inviteAcceptedAt || fallback.inviteAcceptedAt, 40)
  };
}

function createLegacyRoleAdminUser(record, role, defaultUsername) {
  const normalized = normalizeAdmin(record, defaultUsername);

  if (!hasConfiguredAdminRecord(normalized)) {
    return null;
  }

  return {
    ...normalized,
    roles: [role]
  };
}

function normalizeAdminUsers(input = {}) {
  const users = [];
  const insert = (candidate) => {
    if (!candidate || !hasKnownAdminUser(candidate)) {
      return;
    }

    const existingIndex = users.findIndex((entry) => (
      (candidate.id && entry.id === candidate.id) ||
      (candidate.username && entry.username === candidate.username && sameAdminCredentials(entry, candidate))
    ));

    if (existingIndex >= 0) {
      users[existingIndex] = mergeAdminUsers(users[existingIndex], candidate);
      return;
    }

    users.push(candidate);
  };

  if (Array.isArray(input.adminUsers)) {
    for (const rawUser of input.adminUsers) {
      insert(normalizeAdminUser(rawUser));
    }
  }

  insert(createLegacyRoleAdminUser(selectCanonicalAdminRecord(input.hr, input.admin), "hr", defaultAdminUsername()));
  insert(createLegacyRoleAdminUser(input.webmaster, "webmaster", defaultWebmasterUsername()));

  return users.filter((user) => hasKnownAdminUser(user));
}

function selectCanonicalAdminRecord(primary, fallback) {
  return hasConfiguredAdminRecord(primary) ? primary : fallback;
}

function sameAdminCredentials(left = {}, right = {}) {
  return (
    cleanText(left.passwordSalt, 128) &&
    cleanText(left.passwordSalt, 128) === cleanText(right.passwordSalt, 128) &&
    cleanText(left.passwordHash, 256) &&
    cleanText(left.passwordHash, 256) === cleanText(right.passwordHash, 256)
  );
}

function normalizeAdminSession(input = {}, fallback = {}) {
  const createdAt = cleanText(input.createdAt, 40) || nowIso();
  const updatedAt = cleanText(input.updatedAt, 40) || createdAt;
  const expiresAt = cleanText(input.expiresAt, 40);
  const role = cleanText(input.role || fallback.role, 40).toLowerCase();

  return {
    id: cleanText(input.id, 120),
    adminUserId: cleanText(input.adminUserId || fallback.adminUserId, 80),
    role: role === "webmaster" ? "webmaster" : role === "hr" ? "hr" : "",
    createdAt,
    updatedAt,
    expiresAt,
    revokedAt: cleanText(input.revokedAt, 40),
    csrfToken: cleanText(input.csrfToken, 120),
    userAgent: cleanText(input.userAgent, 240)
  };
}

function normalizeAdminSessions(input = {}, adminUsers = []) {
  const sessions = [];
  const addSessions = (items, fallback = {}) => {
    if (!Array.isArray(items)) {
      return;
    }

    for (const item of items) {
      const session = normalizeAdminSession(item, fallback);

      if (!session.id || !session.csrfToken || !session.adminUserId || !session.role) {
        continue;
      }

      if (!adminUsers.some((user) => user.id === session.adminUserId && adminUserHasRole(user, session.role))) {
        continue;
      }

      const existingIndex = sessions.findIndex((entry) => entry.id === session.id);

      if (existingIndex >= 0) {
        sessions[existingIndex] = choosePreferredAdminRecord(sessions[existingIndex], session);
      } else {
        sessions.push(session);
      }
    }
  };
  const hrUser = findConfiguredRoleUser(adminUsers, "hr");
  const webmasterUser = findConfiguredRoleUser(adminUsers, "webmaster");
  const canonicalAdminSessions = Array.isArray(input.adminSessions) ? input.adminSessions : [];
  const legacyAdminSessions = Array.isArray(input.hrSessions) ? input.hrSessions : [];
  const legacyWebmasterSessions = Array.isArray(input.webmasterSessions) ? input.webmasterSessions : [];

  addSessions(
    canonicalAdminSessions.filter((session) => cleanText(session?.adminUserId, 80) && cleanText(session?.role, 40)),
    {}
  );
  addSessions(
    canonicalAdminSessions.filter((session) => !cleanText(session?.adminUserId, 80) || !cleanText(session?.role, 40)),
    hrUser ? { adminUserId: hrUser.id, role: "hr" } : {}
  );
  addSessions(legacyAdminSessions, hrUser ? { adminUserId: hrUser.id, role: "hr" } : {});
  addSessions(legacyWebmasterSessions, webmasterUser ? { adminUserId: webmasterUser.id, role: "webmaster" } : {});

  return sessions;
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
    userAgent: cleanText(input.userAgent, 240),
    employeeId: cleanText(input.employeeId, 80),
    browser: cleanText(input.browser, 60),
    platform: cleanText(input.platform, 60),
    step: cleanText(input.step, 80),
    errorMessage: cleanText(input.errorMessage, 240)
  };
}

function normalizeRecoveryChallenge(input = {}) {
  return {
    codeSalt: cleanText(input.codeSalt, 128),
    codeHash: cleanText(input.codeHash, 256),
    email: cleanText(input.email, 200),
    requestedAt: cleanText(input.requestedAt, 40),
    expiresAt: cleanText(input.expiresAt, 40),
    consumedAt: cleanText(input.consumedAt, 40),
    failedAttempts: Math.max(0, Number(input.failedAttempts || 0) || 0),
    lastFailedAt: cleanText(input.lastFailedAt, 40),
    lockedUntil: cleanText(input.lockedUntil, 40)
  };
}

function normalizeRecoveryState(input = {}) {
  return {
    hr: normalizeRecoveryChallenge(input.hr)
  };
}

function normalizeSecurityState(input = {}) {
  const adminUsers = normalizeAdminUsers(input);
  const employees = Array.isArray(input.employees)
    ? input.employees
      .map((employee) => normalizeEmployee(employee))
      .filter((employee) => employee.username && employee.passwordSalt && employee.passwordHash)
    : [];
  const adminSessions = normalizeAdminSessions(input, adminUsers);
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
    adminUsers,
    adminSessions,
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

function publicAdminAccessUser(user = {}) {
  return {
    id: user.id || "",
    displayName: user.displayName || "",
    email: user.email || "",
    username: user.username || "",
    roles: Array.isArray(user.roles) ? [...user.roles] : []
  };
}

function publicAdminUserRecord(user = {}, sessions = [], currentUserId = "") {
  const activeSessions = sessions.filter((session) => (
    session.adminUserId === user.id &&
    !session.revokedAt &&
    new Date(session.expiresAt).getTime() > Date.now()
  ));
  const inviteState = adminInviteState(user);

  return {
    id: user.id || "",
    displayName: user.displayName || "",
    email: user.email || "",
    username: user.username || "",
    roles: Array.isArray(user.roles) ? [...user.roles] : [],
    credentialsConfigured: hasConfiguredAdminRecord(user),
    active: user.active !== false,
    activeSessions: activeSessions.length,
    lastLoginAt: user.lastLoginAt || "",
    createdAt: user.createdAt || "",
    updatedAt: user.updatedAt || "",
    disabledAt: user.disabledAt || "",
    inviteState,
    invitePending: inviteState === "pending",
    inviteSentAt: user.inviteSentAt || "",
    inviteExpiresAt: user.inviteExpiresAt || "",
    inviteAcceptedAt: user.inviteAcceptedAt || "",
    preferredRoute: preferredAdminRoute(user),
    currentUser: Boolean(currentUserId) && user.id === currentUserId
  };
}

function findAdminUserById(users = [], userId = "") {
  if (!userId) {
    return null;
  }

  return users.find((user) => user.id === userId) || null;
}

function findAdminUsersByUsername(users = [], username = "") {
  const normalizedUsername = normalizeUsername(username);

  if (!normalizedUsername) {
    return [];
  }

  return users.filter((user) => user.username === normalizedUsername);
}

function findAdminUsersByEmail(users = [], email = "") {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    return [];
  }

  return users.filter((user) => normalizeEmail(user.email) === normalizedEmail);
}

function findAdminUserByInviteToken(users = [], token = "") {
  const normalizedToken = cleanText(token, 200);

  if (!normalizedToken) {
    return null;
  }

  const tokenHash = digestInviteToken(normalizedToken);
  return users.find((user) => cleanText(user.inviteTokenHash, 256) === tokenHash) || null;
}

function findConfiguredRoleUser(users = [], role = "") {
  return users.find((user) => user.active !== false && hasConfiguredAdminUser(user) && adminUserHasRole(user, role)) || null;
}

function findConfiguredRoleUserByUsername(users = [], role = "", username = "") {
  const normalizedUsername = normalizeUsername(username);

  if (!normalizedUsername) {
    return null;
  }

  return users.find((user) => (
    user.active !== false &&
    hasConfiguredAdminUser(user) &&
    adminUserHasRole(user, role) &&
    user.username === normalizedUsername
  )) || null;
}

function replaceAdminUser(users = [], nextUser = {}) {
  return users.map((user) => (user.id === nextUser.id ? nextUser : user));
}

function validateAdminRoles(roles, label = "admin account") {
  const normalizedRoles = normalizeAdminRoles(roles);

  if (!normalizedRoles.length) {
    throw new Error(`Select at least one role for the ${label}.`);
  }

  return normalizedRoles;
}

function validateAdminDisplayName(displayName) {
  const normalizedDisplayName = cleanText(displayName, 120);

  if (!normalizedDisplayName) {
    throw new Error("Display name is required.");
  }

  return normalizedDisplayName;
}

function validateAdminEmail(email) {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    throw new Error("Email is required.");
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new Error("Enter a valid email address.");
  }

  return normalizedEmail;
}

function countActiveAdminUsersWithRole(users = [], role = "") {
  return users.filter((user) => (
    user.active !== false &&
    hasConfiguredAdminUser(user) &&
    adminUserHasRole(user, role)
  )).length;
}

function findAdminUserOrThrow(users = [], adminUserId = "") {
  const targetId = cleanText(adminUserId, 80);
  const adminUser = findAdminUserById(users, targetId);

  if (!adminUser) {
    throw new Error("Admin account not found.");
  }

  return adminUser;
}

function upsertRoleAdminUser(data, role, username, passwordSalt, passwordHash, changedAt, lastLoginAt = "") {
  const existingRoleUser = findConfiguredRoleUser(data.adminUsers, role)
    || data.adminUsers.find((user) => adminUserHasRole(user, role))
    || null;
  const sameUsernameUser = findAdminUsersByUsername(data.adminUsers, username)[0] || null;
  const baseUser = existingRoleUser || sameUsernameUser;
  const nextUser = normalizeAdminUser(clearAdminInviteMetadata({
    ...baseUser,
    username: baseUser?.username || username,
    passwordSalt,
    passwordHash,
    roles: mergeAdminRoles(baseUser?.roles, [role]),
    active: true,
    lastLoginAt: lastLoginAt || baseUser?.lastLoginAt || "",
    createdAt: baseUser?.createdAt || changedAt,
    updatedAt: changedAt,
    disabledAt: ""
  }));

  if (baseUser) {
    data.adminUsers = replaceAdminUser(data.adminUsers, nextUser);
  } else {
    data.adminUsers.unshift(nextUser);
  }

  return nextUser;
}

function roleAccessSummary(state = {}, role = "", initializedAt = "") {
  const roleUser = findConfiguredRoleUser(Array.isArray(state.adminUsers) ? state.adminUsers : [], role);
  const activeSessions = (Array.isArray(state.adminSessions) ? state.adminSessions : [])
    .filter((session) => session.role === role && !session.revokedAt && new Date(session.expiresAt).getTime() > Date.now())
    .length;

  return {
    enabled: Boolean(roleUser),
    access: roleUser ? "password" : role === "webmaster" ? "hr-provisioned" : "setup-required",
    updatedAt: roleUser?.updatedAt || initializedAt || nowIso(),
    activeSessions,
    username: roleUser?.username || ""
  };
}

function runtimeSnapshot(state, initializedAt) {
  const adminUsers = Array.isArray(state?.adminUsers) ? state.adminUsers : [];
  const employees = Array.isArray(state?.employees) ? state.employees : [];
  const adminSessions = Array.isArray(state?.adminSessions) ? state.adminSessions : [];
  const employeeSessions = Array.isArray(state?.employeeSessions) ? state.employeeSessions : [];
  const activeEmployees = employees.filter((employee) => employee.active !== false).length;
  const adminSummary = roleAccessSummary(state, "hr", initializedAt);
  const webmasterSummary = roleAccessSummary(state, "webmaster", initializedAt);

  return {
    admin: adminSummary,
    hr: adminSummary,
    webmaster: webmasterSummary,
    accessModel: adminUsers.length || employees.length ? 'managed-accounts' : 'open',
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

function createAdminSession(adminUser, role, userAgent = "") {
  const createdAt = nowIso();

  return {
    id: crypto.randomBytes(32).toString("hex"),
    adminUserId: cleanText(adminUser?.id, 80),
    role: role === "webmaster" ? "webmaster" : "hr",
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
  const normalizedAccountKey = normalizeUsername(accountKey)
    || (actor === 'webmaster' ? defaultWebmasterUsername() : actor === 'employee' ? 'unknown' : defaultAdminUsername());
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
    event.employeeId ? `employeeId=${event.employeeId}` : "",
    event.sourceIp ? `ip=${event.sourceIp}` : "",
    event.browser ? `browser=${event.browser}` : "",
    event.platform ? `platform=${event.platform}` : "",
    event.step ? `step=${event.step}` : "",
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

function validateAdminUsername(username) {
  return validateRoleUsername(username, "HR");
}

function validateWebmasterUsername(username) {
  return validateRoleUsername(username, "Webmaster");
}

function validateRoleUsername(username, label) {
  const normalizedUsername = normalizeUsername(username);

  if (!normalizedUsername) {
    throw new Error(`${label} username is required.`);
  }

  return normalizedUsername;
}

function adminAccessResponse(session) {
  return {
    authorized: true,
    setupRequired: false,
    sessionExpiresAt: session.expiresAt,
    csrfToken: session.csrfToken
  };
}

function findActiveAdminSession(sessions, sessionId) {
  if (!sessionId) {
    return null;
  }

  const session = sessions.find((entry) => entry.id === sessionId);

  if (!session || session.revokedAt || isSessionExpired(session)) {
    return null;
  }

  return session;
}

function findValidRoleSession(data, role, sessionId) {
  const session = findActiveAdminSession(data.adminSessions, sessionId);

  if (!session || session.role !== role) {
    return null;
  }

  const adminUser = findAdminUserById(data.adminUsers, session.adminUserId);

  if (!adminUser || adminUser.active === false || !hasConfiguredAdminUser(adminUser) || !adminUserHasRole(adminUser, role)) {
    return null;
  }

  return {
    session,
    adminUser
  };
}

function activeCookieValue(req = {}, names = []) {
  return activeCookieValues(req, names)[0] || '';
}

function activeCookieValues(req = {}, names = []) {
  const cookies = parseCookies(req.headers?.cookie || '');
  const values = [];

  for (const name of names) {
    if (cookies[name]) {
      values.push(cookies[name]);
    }
  }

  return [...new Set(values)];
}

function findValidAdminSession(data, sessionId) {
  const session = findActiveAdminSession(data.adminSessions, sessionId);

  if (!session) {
    return null;
  }

  const adminUser = findAdminUserById(data.adminUsers, session.adminUserId);

  if (!adminUser || adminUser.active === false || !hasConfiguredAdminUser(adminUser)) {
    return null;
  }

  return {
    session,
    adminUser
  };
}

function requireHrManagerAccess(data, req = {}) {
  const cookieNames = accessCookieNames();
  const access = findValidRoleSession(data, "hr", activeCookieValue(req, [cookieNames.hr, cookieNames.legacyHr]));

  if (!access) {
    throw new Error("You must be signed in as HR.");
  }

  return access;
}

function isHrManagedAdminUser(user = {}) {
  return !adminUserHasRole(user, "webmaster");
}

function assertHrManagedAdminRoles(roles = []) {
  if (roles.includes("webmaster")) {
    throw new Error("HR cannot assign webmaster roles.");
  }
}

function requireHrManagedAdminTarget(data, req = {}, adminUserId = "") {
  const hrManager = requireHrManagerAccess(data, req);
  const targetUser = findAdminUserOrThrow(data.adminUsers, adminUserId);

  if (!isHrManagedAdminUser(targetUser)) {
    throw new Error("HR cannot manage webmaster accounts.");
  }

  return {
    hrManager,
    targetUser
  };
}

function revokeOtherSessionsForUser(sessions, activeSessionId, adminUserId, changedAt) {
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

    if (cleanText(session.adminUserId, 80) !== cleanText(adminUserId, 80)) {
      return session;
    }

    return {
      ...session,
      revokedAt: changedAt,
      updatedAt: changedAt
    };
  });
}

function revokeAllSessionsForUser(sessions, adminUserId, changedAt, roleFilter = "") {
  return sessions.map((session) => {
    if (cleanText(session.adminUserId, 80) !== cleanText(adminUserId, 80)) {
      return session;
    }

    if (roleFilter && cleanText(session.role, 40) !== cleanText(roleFilter, 40)) {
      return session;
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

function loginGuardBucketForActor(loginGuards, actor) {
  return actor === "webmaster"
    ? loginGuards.webmaster
    : actor === "employee"
      ? loginGuards.employee
      : loginGuards.hr;
}

function clearRoleLoginGuards(data, actor, accountKey = "", sourceIp = "") {
  const loginGuards = ensureLoginGuards(data);
  const bucket = loginGuardBucketForActor(loginGuards, actor);

  if (!accountKey && !sourceIp) {
    bucket.byIp = [];
    bucket.byAccount = [];
    return;
  }

  const normalizedAccountKey = normalizeUsername(accountKey);
  const normalizedSourceIp = cleanText(sourceIp, 160) ? normalizeSecurityKey(sourceIp) : "";

  if (normalizedAccountKey) {
    bucket.byAccount = bucket.byAccount.filter((entry) => entry.key !== normalizedAccountKey);
  }

  if (normalizedSourceIp) {
    bucket.byIp = bucket.byIp.filter((entry) => entry.key !== normalizedSourceIp);
  }
}

function clearAdminIdentityGuards(data, username, sourceIp = "") {
  clearRoleLoginGuards(data, "hr", username, sourceIp);
  clearRoleLoginGuards(data, "webmaster", username, sourceIp);
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
  const HR_RECOVERY_MAX_FAILURES = 5;
  const HR_RECOVERY_LOCKOUT_MS = 15 * 60 * 1000;

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
    const adminConfigured = findConfiguredRoleUser(data.adminUsers, "hr");

    if (!adminConfigured) {
      return {
        authorized: false,
        setupRequired: true,
        sessionExpiresAt: '',
        csrfToken: ''
      };
    }

    const cookieNames = getAccessCookieNames();
    const access = findValidRoleSession(data, "hr", activeCookieValue(req, [cookieNames.hr, cookieNames.legacyHr]));

    if (!access) {
      return {
        authorized: false,
        setupRequired: false,
        sessionExpiresAt: '',
        csrfToken: ''
      };
    }

    return {
      ...adminAccessResponse(access.session),
      user: publicAdminAccessUser(access.adminUser)
    };
  }

  async function checkWebmasterAccess(req = {}) {
    await init();
    const data = await readStoredState();
    const hrAccess = await checkHrAccess(req);
    const webmasterConfigured = findConfiguredRoleUser(data.adminUsers, "webmaster");

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
    const access = findValidRoleSession(data, "webmaster", activeCookieValue(req, [cookieNames.webmaster]));

    if (!access) {
      return {
        authorized: false,
        setupRequired: false,
        hrAuthorized: Boolean(hrAccess.authorized),
        sessionExpiresAt: '',
        csrfToken: ''
      };
    }

    return {
      ...adminAccessResponse(access.session),
      hrAuthorized: Boolean(hrAccess.authorized),
      user: publicAdminAccessUser(access.adminUser)
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

  async function setupAdminAccess({ username, password, userAgent = "" } = {}) {
    const adminUsername = validateAdminUsername(username);
    validateAdminPassword(password);

    return updateData((data) => {
      if (findConfiguredRoleUser(data.adminUsers, "hr")) {
        throw new Error("HR access is already configured.");
      }

      const changedAt = nowIso();
      const sameUsernameUsers = findAdminUsersByUsername(data.adminUsers, adminUsername);
      const mergeCandidate = sameUsernameUsers.find((user) => (
        user.active !== false &&
        hasConfiguredAdminUser(user) &&
        verifyPassword(password, user.passwordSalt, user.passwordHash)
      ));
      let adminUser;

      if (mergeCandidate) {
        adminUser = {
          ...mergeCandidate,
          roles: mergeAdminRoles(mergeCandidate.roles, ["hr"]),
          lastLoginAt: changedAt,
          updatedAt: changedAt
        };
        data.adminUsers = replaceAdminUser(data.adminUsers, adminUser);
      } else if (sameUsernameUsers.length) {
        throw new Error("That username already belongs to another admin account.");
      } else {
        const nextPassword = createPasswordHash(password);
        adminUser = normalizeAdminUser({
          username: adminUsername,
          passwordSalt: nextPassword.salt,
          passwordHash: nextPassword.hash,
          roles: ["hr"],
          active: true,
          lastLoginAt: changedAt,
          createdAt: changedAt,
          updatedAt: changedAt
        });
        data.adminUsers.unshift(adminUser);
      }

      const session = createAdminSession(adminUser, "hr", userAgent);
      data.adminSessions = [
        session,
        ...data.adminSessions.filter((entry) => entry.id !== session.id && !isSessionExpired(entry) && !entry.revokedAt)
      ];
      return { session, adminUser };
    }).then(({ result }) => ({
      ...adminAccessResponse(result.session),
      user: publicAdminAccessUser(result.adminUser),
      sessionId: result.session.id
    }));
  }

  async function authenticateAdmin({ username, password, userAgent = '', clientIp = '' } = {}) {
    const normalizedUsername = validateAdminUsername(username);
    const passwordText = String(password || '');

    if (!passwordText) {
      throw new Error('Username and password are required.');
    }

    return updateData((data) => {
      const attempt = createLoginAttemptState(data, 'hr', normalizedUsername, clientIp);

      if (attempt.block) {
        return createThrottledAttemptResult(data, attempt, userAgent);
      }

      const roleUser = findConfiguredRoleUser(data.adminUsers, "hr");

      if (!roleUser) {
        throw new Error('Admin access has not been configured.');
      }

      const adminUser = findConfiguredRoleUserByUsername(data.adminUsers, "hr", normalizedUsername);

      if (!adminUser) {
        return createFailedAttemptResult(data, attempt, 'Invalid username or password.', 'unknown-username', userAgent);
      }

      if (!verifyPassword(passwordText, adminUser.passwordSalt, adminUser.passwordHash)) {
        return createFailedAttemptResult(data, attempt, 'Invalid username or password.', 'invalid-password', userAgent);
      }

      clearLoginGuards(attempt.bucket, normalizedUsername, clientIp);
      const changedAt = nowIso();
      const session = createAdminSession(adminUser, "hr", userAgent);
      const updatedAdminUser = {
        ...adminUser,
        lastLoginAt: changedAt,
        updatedAt: changedAt
      };
      data.adminUsers = replaceAdminUser(data.adminUsers, updatedAdminUser);
      data.adminSessions = [
        session,
        ...data.adminSessions.filter((entry) => entry.id !== session.id && !isSessionExpired(entry) && !entry.revokedAt)
      ];
      return {
        ok: true,
        session,
        adminUser: updatedAdminUser
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
        user: publicAdminAccessUser(result.adminUser),
        sessionId: result.session.id
      };
    });
  }

  async function setupWebmasterAccess({ username, password, userAgent = '' } = {}) {
    const webmasterUsername = validateWebmasterUsername(username);
    validateAdminPassword(password);

    return updateData((data) => {
      if (findConfiguredRoleUser(data.adminUsers, "webmaster")) {
        throw new Error('Webmaster access is already configured.');
      }

      const changedAt = nowIso();
      const sameUsernameUsers = findAdminUsersByUsername(data.adminUsers, webmasterUsername);
      const mergeCandidate = sameUsernameUsers.find((user) => (
        user.active !== false &&
        hasConfiguredAdminUser(user) &&
        verifyPassword(password, user.passwordSalt, user.passwordHash)
      ));
      let adminUser;

      if (mergeCandidate) {
        adminUser = {
          ...mergeCandidate,
          roles: mergeAdminRoles(mergeCandidate.roles, ["webmaster"]),
          lastLoginAt: changedAt,
          updatedAt: changedAt
        };
        data.adminUsers = replaceAdminUser(data.adminUsers, adminUser);
      } else if (sameUsernameUsers.length) {
        throw new Error("That username already belongs to another admin account.");
      } else {
        const nextPassword = createPasswordHash(password);
        adminUser = normalizeAdminUser({
          username: webmasterUsername,
          passwordSalt: nextPassword.salt,
          passwordHash: nextPassword.hash,
          roles: ["webmaster"],
          active: true,
          lastLoginAt: changedAt,
          createdAt: changedAt,
          updatedAt: changedAt
        });
        data.adminUsers.unshift(adminUser);
      }

      const session = createAdminSession(adminUser, "webmaster", userAgent);
      data.adminSessions = [
        session,
        ...data.adminSessions.filter((entry) => entry.id !== session.id && !isSessionExpired(entry) && !entry.revokedAt)
      ];
      return { session, adminUser };
    }).then(({ result }) => ({
      ...adminAccessResponse(result.session),
      user: publicAdminAccessUser(result.adminUser),
      sessionId: result.session.id
    }));
  }

  async function authenticateWebmaster({ username, password, userAgent = '', clientIp = '' } = {}) {
    const normalizedUsername = validateWebmasterUsername(username);
    const passwordText = String(password || '');

    if (!passwordText) {
      throw new Error('Username and password are required.');
    }

    return updateData((data) => {
      const attempt = createLoginAttemptState(data, 'webmaster', normalizedUsername, clientIp);

      if (attempt.block) {
        return createThrottledAttemptResult(data, attempt, userAgent);
      }

      const roleUser = findConfiguredRoleUser(data.adminUsers, "webmaster");

      if (!roleUser) {
        throw new Error('Webmaster access has not been configured.');
      }

      const adminUser = findConfiguredRoleUserByUsername(data.adminUsers, "webmaster", normalizedUsername);

      if (!adminUser) {
        return createFailedAttemptResult(data, attempt, 'Invalid username or password.', 'unknown-username', userAgent);
      }

      if (!verifyPassword(passwordText, adminUser.passwordSalt, adminUser.passwordHash)) {
        return createFailedAttemptResult(data, attempt, 'Invalid username or password.', 'invalid-password', userAgent);
      }

      clearLoginGuards(attempt.bucket, normalizedUsername, clientIp);
      const changedAt = nowIso();
      const session = createAdminSession(adminUser, "webmaster", userAgent);
      const updatedAdminUser = {
        ...adminUser,
        lastLoginAt: changedAt,
        updatedAt: changedAt
      };
      data.adminUsers = replaceAdminUser(data.adminUsers, updatedAdminUser);
      data.adminSessions = [
        session,
        ...data.adminSessions.filter((entry) => entry.id !== session.id && !isSessionExpired(entry) && !entry.revokedAt)
      ];
      return {
        ok: true,
        session,
        adminUser: updatedAdminUser
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
        user: publicAdminAccessUser(result.adminUser),
        sessionId: result.session.id
      };
    });
  }

  async function logoutAdmin(req = {}) {
    await init();
    const cookieNames = getAccessCookieNames();
    const sessionIds = activeCookieValues(req, [cookieNames.hr, cookieNames.legacyHr]);

    if (!sessionIds.length) {
      return { removed: false };
    }

    return updateData((data) => {
      const activeSessionIds = new Set(sessionIds);
      const changedAt = nowIso();
      let removed = false;

      data.adminSessions = data.adminSessions.map((entry) => {
        if (!activeSessionIds.has(entry.id) || entry.role !== "hr") {
          return entry;
        }

        removed = true;
        return {
          ...entry,
          revokedAt: entry.revokedAt || changedAt,
          updatedAt: changedAt
        };
      });

      return { removed };
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
      const session = data.adminSessions.find((entry) => entry.id === sessionId && entry.role === "webmaster");

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

  async function recordPushSubscriptionFailure({
    employeeId = "",
    username = "",
    browser = "",
    platform = "",
    step = "",
    errorMessage = "",
    userAgent = "",
    clientIp = ""
  } = {}) {
    const normalizedEmployeeId = cleanText(employeeId, 80);
    const normalizedUsername = normalizeUsername(username);
    const normalizedStep = cleanText(step, 80) || "unknown";
    const normalizedErrorMessage = cleanText(errorMessage, 240) || "unknown";

    return updateData((data) => {
      const event = appendSecurityEvent(data, createSecurityEvent({
        type: "employee_push_subscribe_failed",
        actor: "employee",
        accountKey: normalizedUsername || normalizedEmployeeId || "employee",
        employeeId: normalizedEmployeeId,
        sourceIp: clientIp,
        outcome: "denied",
        detail: `${normalizedStep}: ${normalizedErrorMessage}`.slice(0, 200),
        step: normalizedStep,
        errorMessage: normalizedErrorMessage,
        browser,
        platform,
        userAgent
      }));
      logSecurityEvent(event);
      return { event };
    }).then(({ result }) => result);
  }

  async function listEmployees() {
    const data = await readSecurityState();
    return data.employees
      .map((employee) => publicEmployeeRecord(employee, data.employeeSessions.filter((session) => session.employeeId === employee.id)))
      .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  }

  async function listAdminUsers({ currentUserId = "" } = {}) {
    const data = await readSecurityState();
    return data.adminUsers
      .filter((adminUser) => isHrManagedAdminUser(adminUser))
      .map((adminUser) => publicAdminUserRecord(adminUser, data.adminSessions, currentUserId))
      .sort((left, right) => (
        Number(right.active) - Number(left.active) ||
        left.displayName.localeCompare(right.displayName) ||
        left.username.localeCompare(right.username)
      ));
  }

  async function createAdminUser({ displayName, email, username, password, roles } = {}) {
    const adminDisplayName = validateAdminDisplayName(displayName);
    const adminEmail = validateAdminEmail(email);
    const adminUsername = normalizeUsername(username);
    const adminRoles = validateAdminRoles(roles);
    assertHrManagedAdminRoles(adminRoles);

    if (!adminUsername) {
      throw new Error("Username is required.");
    }

    validateAdminPassword(password);

    return updateData((data) => {
      const duplicate = data.adminUsers.some((adminUser) => adminUser.username === adminUsername);
      const duplicateEmail = findAdminUsersByEmail(data.adminUsers, adminEmail)
        .some((adminUser) => adminUser.username !== adminUsername);

      if (duplicate) {
        throw new Error("That admin username is already in use.");
      }

      if (duplicateEmail) {
        throw new Error("That admin email is already in use.");
      }

      const nextPassword = createPasswordHash(password);
      const createdAt = nowIso();
      const adminUser = normalizeAdminUser({
        id: crypto.randomUUID(),
        displayName: adminDisplayName,
        email: adminEmail,
        username: adminUsername,
        passwordSalt: nextPassword.salt,
        passwordHash: nextPassword.hash,
        roles: adminRoles,
        active: true,
        lastLoginAt: "",
        createdAt,
        updatedAt: createdAt,
        disabledAt: ""
      });

      data.adminUsers.unshift(adminUser);
      appendSecurityEvent(data, createSecurityEvent({
        type: "admin_created",
        actor: "hr",
        accountKey: adminUser.username,
        sourceIp: normalizeSecurityKey(""),
        outcome: "success",
        detail: `roles:${adminRoles.join(",")}`
      }));
      return adminUser;
    }).then(({ result, snapshot }) => ({
      adminUser: publicAdminUserRecord(result, [], ""),
      snapshot
    }));
  }

  async function inviteAdminUser({ displayName, email, username, roles, userAgent = "", clientIp = "" } = {}) {
    const adminDisplayName = validateAdminDisplayName(displayName);
    const adminEmail = validateAdminEmail(email);
    const adminUsername = normalizeUsername(username);
    const adminRoles = validateAdminRoles(roles);
    assertHrManagedAdminRoles(adminRoles);

    if (!adminUsername) {
      throw new Error("Username is required.");
    }

    return updateData((data) => {
      const duplicate = data.adminUsers.some((adminUser) => adminUser.username === adminUsername);
      const duplicateEmail = findAdminUsersByEmail(data.adminUsers, adminEmail)
        .some((adminUser) => adminUser.username !== adminUsername);

      if (duplicate) {
        throw new Error("That admin username is already in use.");
      }

      if (duplicateEmail) {
        throw new Error("That admin email is already in use.");
      }

      const createdAt = nowIso();
      const invite = createInviteSecret();
      const adminUser = normalizeAdminUser({
        id: crypto.randomUUID(),
        displayName: adminDisplayName,
        email: adminEmail,
        username: adminUsername,
        roles: adminRoles,
        active: true,
        lastLoginAt: "",
        createdAt,
        updatedAt: createdAt,
        disabledAt: "",
        inviteTokenHash: invite.tokenHash,
        inviteSentAt: createdAt,
        inviteExpiresAt: invite.expiresAt,
        inviteAcceptedAt: ""
      });

      data.adminUsers.unshift(adminUser);
      appendSecurityEvent(data, createSecurityEvent({
        type: "admin_invited",
        actor: "hr",
        accountKey: adminUser.username,
        sourceIp: normalizeSecurityKey(clientIp),
        outcome: "success",
        detail: `roles:${adminRoles.join(",")}`,
        userAgent
      }));
      return {
        adminUser,
        inviteToken: invite.token,
        inviteExpiresAt: invite.expiresAt,
        preferredRoute: preferredAdminRoute(adminUser)
      };
    }).then(({ result, snapshot }) => ({
      adminUser: publicAdminUserRecord(result.adminUser, [], ""),
      inviteToken: result.inviteToken,
      inviteExpiresAt: result.inviteExpiresAt,
      preferredRoute: result.preferredRoute,
      snapshot
    }));
  }

  async function updateAdminUserProfile(req = {}, adminUserId, { displayName, email } = {}) {
    const adminDisplayName = validateAdminDisplayName(displayName);
    const adminEmail = validateAdminEmail(email);

    return updateData((data) => {
      const { targetUser } = requireHrManagedAdminTarget(data, req, adminUserId);
      const duplicateEmail = findAdminUsersByEmail(data.adminUsers, adminEmail)
        .some((adminUser) => adminUser.id !== targetUser.id);

      if (duplicateEmail) {
        throw new Error("That admin email is already in use.");
      }

      const changedAt = nowIso();
      const emailChanged = normalizeEmail(targetUser.email) !== adminEmail;
      const updatedUser = normalizeAdminUser({
        ...targetUser,
        displayName: adminDisplayName,
        email: adminEmail,
        updatedAt: changedAt,
        inviteTokenHash: emailChanged ? "" : targetUser.inviteTokenHash,
        inviteSentAt: emailChanged ? "" : targetUser.inviteSentAt,
        inviteExpiresAt: emailChanged ? "" : targetUser.inviteExpiresAt
      });

      data.adminUsers = replaceAdminUser(data.adminUsers, updatedUser);
      appendSecurityEvent(data, createSecurityEvent({
        type: "admin_profile_updated",
        actor: "hr",
        accountKey: updatedUser.username,
        sourceIp: normalizeSecurityKey(""),
        outcome: "success",
        detail: emailChanged ? "identity-updated-invite-cleared" : "identity-updated"
      }));

      return updatedUser;
    }).then(({ result, snapshot }) => ({
      adminUser: publicAdminUserRecord(result, [], ""),
      snapshot
    }));
  }

  async function resendAdminInvite(req = {}, adminUserId, { userAgent = "", clientIp = "" } = {}) {
    return updateData((data) => {
      const { hrManager, targetUser } = requireHrManagedAdminTarget(data, req, adminUserId);

      if (targetUser.id === hrManager.adminUser.id && hasConfiguredAdminRecord(targetUser)) {
        throw new Error("Use account settings to manage your own credentials.");
      }

      if (targetUser.active === false) {
        throw new Error("Enable this admin account before sending an invite.");
      }

      if (!targetUser.email) {
        throw new Error("Add an email address before sending an invite.");
      }

      if (hasConfiguredAdminRecord(targetUser)) {
        throw new Error("This admin already has credentials configured.");
      }

      const changedAt = nowIso();
      const invite = createInviteSecret();
      const updatedUser = normalizeAdminUser({
        ...targetUser,
        updatedAt: changedAt,
        inviteTokenHash: invite.tokenHash,
        inviteSentAt: changedAt,
        inviteExpiresAt: invite.expiresAt,
        inviteAcceptedAt: ""
      });

      data.adminUsers = replaceAdminUser(data.adminUsers, updatedUser);
      appendSecurityEvent(data, createSecurityEvent({
        type: "admin_invite_resent",
        actor: "hr",
        accountKey: updatedUser.username,
        sourceIp: normalizeSecurityKey(clientIp),
        outcome: "success",
        detail: `roles:${updatedUser.roles.join(",")}`,
        userAgent
      }));

      return {
        adminUser: updatedUser,
        inviteToken: invite.token,
        inviteExpiresAt: invite.expiresAt,
        preferredRoute: preferredAdminRoute(updatedUser)
      };
    }).then(({ result, snapshot }) => ({
      adminUser: publicAdminUserRecord(result.adminUser, [], ""),
      inviteToken: result.inviteToken,
      inviteExpiresAt: result.inviteExpiresAt,
      preferredRoute: result.preferredRoute,
      snapshot
    }));
  }

  async function previewAdminInvite({ token } = {}) {
    const inviteToken = cleanText(token, 200);

    if (!inviteToken) {
      throw new Error("Invitation token is required.");
    }

    const data = await readSecurityState();
    const targetUser = findAdminUserByInviteToken(data.adminUsers, inviteToken);

    if (!targetUser || targetUser.active === false || !hasKnownAdminUser(targetUser) || !hasActiveInvite(targetUser)) {
      throw new Error("Invitation is invalid or expired.");
    }

    return {
      adminUser: publicAdminUserRecord(targetUser, data.adminSessions, ""),
      preferredRoute: preferredAdminRoute(targetUser)
    };
  }

  async function acceptAdminInvite({ token, password, userAgent = "", clientIp = "" } = {}) {
    const inviteToken = cleanText(token, 200);

    if (!inviteToken) {
      throw new Error("Invitation token is required.");
    }

    validateAdminPassword(password);

    return updateData((data) => {
      const targetUser = findAdminUserByInviteToken(data.adminUsers, inviteToken);

      if (!targetUser || targetUser.active === false || !hasKnownAdminUser(targetUser) || !hasActiveInvite(targetUser)) {
        throw new Error("Invitation is invalid or expired.");
      }

      const changedAt = nowIso();
      const nextPassword = createPasswordHash(password);
      const updatedUser = normalizeAdminUser(clearAdminInviteMetadata({
        ...targetUser,
        passwordSalt: nextPassword.salt,
        passwordHash: nextPassword.hash,
        active: true,
        lastLoginAt: changedAt,
        updatedAt: changedAt
      }, changedAt));
      const sessions = updatedUser.roles
        .map((role) => createAdminSession(updatedUser, role, userAgent))
        .filter((session) => session.role);
      const newSessionIds = new Set(sessions.map((session) => session.id));

      data.adminUsers = replaceAdminUser(data.adminUsers, updatedUser);
      data.adminSessions = [
        ...sessions,
        ...data.adminSessions.filter((entry) => !newSessionIds.has(entry.id) && !isSessionExpired(entry) && !entry.revokedAt)
      ];
      clearAdminIdentityGuards(data, updatedUser.username, clientIp);
      appendSecurityEvent(data, createSecurityEvent({
        type: "admin_invite_accepted",
        actor: "admin",
        accountKey: updatedUser.username,
        sourceIp: normalizeSecurityKey(clientIp),
        outcome: "success",
        detail: `roles:${updatedUser.roles.join(",")}`,
        userAgent
      }));

      return {
        adminUser: updatedUser,
        sessions
      };
    }).then(({ result, snapshot }) => ({
      user: publicAdminAccessUser(result.adminUser),
      roles: [...result.adminUser.roles],
      sessions: Object.fromEntries(result.sessions.map((session) => [session.role, session])),
      preferredRoute: preferredAdminRoute(result.adminUser),
      snapshot
    }));
  }

  async function updateAdminUserRoles(req = {}, adminUserId, roles) {
    const nextRoles = validateAdminRoles(roles, "admin");

    return updateData((data) => {
      const { hrManager, targetUser } = requireHrManagedAdminTarget(data, req, adminUserId);

      if (targetUser.id === hrManager.adminUser.id && !nextRoles.includes("hr")) {
        throw new Error("You cannot remove your own HR role while signed in.");
      }

      assertHrManagedAdminRoles(nextRoles);

      const changedAt = nowIso();
      const updatedUser = normalizeAdminUser({
        ...targetUser,
        roles: nextRoles,
        updatedAt: changedAt,
        disabledAt: targetUser.active === false ? (targetUser.disabledAt || changedAt) : ""
      });
      const projectedUsers = data.adminUsers.map((adminUser) => (
        adminUser.id === targetUser.id ? updatedUser : adminUser
      ));

      if (countActiveAdminUsersWithRole(projectedUsers, "hr") === 0) {
        throw new Error("At least one active HR admin is required.");
      }

      data.adminUsers = projectedUsers;

      if (!nextRoles.includes("hr")) {
        data.adminSessions = revokeAllSessionsForUser(data.adminSessions, updatedUser.id, changedAt, "hr");
      }

      if (!nextRoles.includes("webmaster")) {
        data.adminSessions = revokeAllSessionsForUser(data.adminSessions, updatedUser.id, changedAt, "webmaster");
      }

      appendSecurityEvent(data, createSecurityEvent({
        type: "admin_roles_updated",
        actor: "hr",
        accountKey: updatedUser.username,
        sourceIp: normalizeSecurityKey(""),
        outcome: "success",
        detail: `roles:${nextRoles.join(",")}`
      }));

      return updatedUser;
    }).then(({ result, snapshot }) => ({
      adminUser: publicAdminUserRecord(result, [], ""),
      snapshot
    }));
  }

  async function setAdminUserActive(req = {}, adminUserId, active) {
    const nextActive = Boolean(active);

    return updateData((data) => {
      const { hrManager, targetUser } = requireHrManagedAdminTarget(data, req, adminUserId);

      if (targetUser.id === hrManager.adminUser.id && !nextActive) {
        throw new Error("You cannot disable your own admin account while signed in.");
      }

      const changedAt = nowIso();
      const updatedUser = normalizeAdminUser({
        ...targetUser,
        active: nextActive,
        updatedAt: changedAt,
        disabledAt: nextActive ? "" : changedAt
      });
      const projectedUsers = data.adminUsers.map((adminUser) => (
        adminUser.id === targetUser.id ? updatedUser : adminUser
      ));

      if (countActiveAdminUsersWithRole(projectedUsers, "hr") === 0) {
        throw new Error("At least one active HR admin is required.");
      }

      data.adminUsers = projectedUsers;

      if (!nextActive) {
        data.adminSessions = revokeAllSessionsForUser(data.adminSessions, updatedUser.id, changedAt);
        clearAdminIdentityGuards(data, updatedUser.username);
      }

      appendSecurityEvent(data, createSecurityEvent({
        type: nextActive ? "admin_enabled" : "admin_disabled",
        actor: "hr",
        accountKey: updatedUser.username,
        sourceIp: normalizeSecurityKey(""),
        outcome: "success",
        detail: nextActive ? "access-restored" : "access-disabled"
      }));

      return updatedUser;
    }).then(({ result, snapshot }) => ({
      adminUser: publicAdminUserRecord(result, [], ""),
      snapshot
    }));
  }

  async function resetAdminUserPassword(req = {}, adminUserId, { password, userAgent = "", clientIp = "" } = {}) {
    validateAdminPassword(password);

    return updateData((data) => {
      const { hrManager, targetUser } = requireHrManagedAdminTarget(data, req, adminUserId);

      if (targetUser.id === hrManager.adminUser.id) {
        throw new Error("Use account settings to change your own password.");
      }

      const changedAt = nowIso();
      const nextPassword = createPasswordHash(password);
      const updatedUser = normalizeAdminUser(clearAdminInviteMetadata({
        ...targetUser,
        passwordSalt: nextPassword.salt,
        passwordHash: nextPassword.hash,
        updatedAt: changedAt
      }));

      data.adminUsers = replaceAdminUser(data.adminUsers, updatedUser);
      data.adminSessions = revokeAllSessionsForUser(data.adminSessions, updatedUser.id, changedAt);
      clearAdminIdentityGuards(data, updatedUser.username, clientIp);
      appendSecurityEvent(data, createSecurityEvent({
        type: "admin_password_reset_by_hr",
        actor: "hr",
        accountKey: updatedUser.username,
        sourceIp: normalizeSecurityKey(clientIp),
        outcome: "success",
        detail: "password-reset",
        userAgent
      }));

      return updatedUser;
    }).then(({ result, snapshot }) => ({
      adminUser: publicAdminUserRecord(result, [], ""),
      snapshot
    }));
  }

  async function revokeAdminUserSessions(req = {}, adminUserId, { userAgent = "", clientIp = "" } = {}) {
    return updateData((data) => {
      const { hrManager, targetUser } = requireHrManagedAdminTarget(data, req, adminUserId);

      if (targetUser.id === hrManager.adminUser.id) {
        throw new Error("Use Sign Out to end your own current admin session.");
      }

      const changedAt = nowIso();
      data.adminSessions = revokeAllSessionsForUser(data.adminSessions, targetUser.id, changedAt);
      appendSecurityEvent(data, createSecurityEvent({
        type: "admin_sessions_revoked_by_hr",
        actor: "hr",
        accountKey: targetUser.username,
        sourceIp: normalizeSecurityKey(clientIp),
        outcome: "success",
        detail: "sessions-revoked",
        userAgent
      }));

      return targetUser;
    }).then(({ result, snapshot }) => ({
      adminUser: publicAdminUserRecord(result, [], ""),
      snapshot
    }));
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
      const access = findValidRoleSession(data, "hr", activeSessionId);

      if (!access) {
        throw new Error("You must be signed in as HR.");
      }

      const { session, adminUser } = access;

      if (!verifyPassword(currentPasswordText, adminUser.passwordSalt, adminUser.passwordHash)) {
        throw new Error("Current password is incorrect.");
      }

      if (verifyPassword(nextPasswordText, adminUser.passwordSalt, adminUser.passwordHash)) {
        throw new Error("Choose a new password.");
      }

      const changedAt = nowIso();
      const nextPassword = createPasswordHash(nextPasswordText);
      const activeSession = {
        ...session,
        updatedAt: changedAt
      };

      const updatedAdminUser = normalizeAdminUser(clearAdminInviteMetadata({
        ...adminUser,
        passwordSalt: nextPassword.salt,
        passwordHash: nextPassword.hash,
        updatedAt: changedAt
      }));
      data.adminUsers = replaceAdminUser(data.adminUsers, updatedAdminUser);
      data.adminSessions = revokeOtherSessionsForUser(data.adminSessions, session.id, adminUser.id, changedAt);
      clearAdminIdentityGuards(data, adminUser.username, clientIp);
      appendSecurityEvent(data, createSecurityEvent({
        type: "hr_password_changed",
        actor: "hr",
        accountKey: adminUser.username,
        sourceIp: normalizeSecurityKey(clientIp),
        outcome: "success",
        detail: "password-updated",
        userAgent
      }));

      return { session: activeSession, adminUser: updatedAdminUser };
    }).then(({ result }) => ({
      ...adminAccessResponse(result.session),
      user: publicAdminAccessUser(result.adminUser),
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
      const access = findValidRoleSession(data, "webmaster", activeSessionId);

      if (!access) {
        throw new Error("You must be signed in as Webmaster.");
      }

      const { session, adminUser } = access;

      if (!verifyPassword(currentPasswordText, adminUser.passwordSalt, adminUser.passwordHash)) {
        throw new Error("Current password is incorrect.");
      }

      if (verifyPassword(nextPasswordText, adminUser.passwordSalt, adminUser.passwordHash)) {
        throw new Error("Choose a new password.");
      }

      const changedAt = nowIso();
      const nextPassword = createPasswordHash(nextPasswordText);
      const activeSession = {
        ...session,
        updatedAt: changedAt
      };

      const updatedAdminUser = normalizeAdminUser(clearAdminInviteMetadata({
        ...adminUser,
        passwordSalt: nextPassword.salt,
        passwordHash: nextPassword.hash,
        updatedAt: changedAt
      }));
      data.adminUsers = replaceAdminUser(data.adminUsers, updatedAdminUser);
      data.adminSessions = revokeOtherSessionsForUser(data.adminSessions, session.id, adminUser.id, changedAt);
      clearAdminIdentityGuards(data, adminUser.username, clientIp);
      appendSecurityEvent(data, createSecurityEvent({
        type: "webmaster_password_changed",
        actor: "webmaster",
        accountKey: adminUser.username,
        sourceIp: normalizeSecurityKey(clientIp),
        outcome: "success",
        detail: "password-updated",
        userAgent
      }));

      return { session: activeSession, adminUser: updatedAdminUser };
    }).then(({ result }) => ({
      ...adminAccessResponse(result.session),
      user: publicAdminAccessUser(result.adminUser),
      sessionId: result.session.id
    }));
  }

  async function resetHrPasswordByWebmaster(req = {}, { password, userAgent = "", clientIp = "" } = {}) {
    const nextPasswordText = String(password || "");
    validateAdminPassword(nextPasswordText);

    return updateData((data) => {
      const cookieNames = getAccessCookieNames();
      const activeSessionId = activeCookieValue(req, [cookieNames.webmaster]);
      const webmasterAccess = findValidRoleSession(data, "webmaster", activeSessionId);

      if (!webmasterAccess) {
        throw new Error("You must be signed in as Webmaster.");
      }

      const hrUser = findConfiguredRoleUser(data.adminUsers, "hr");

      if (!hrUser) {
        throw new Error("HR access has not been configured.");
      }

      const changedAt = nowIso();
      const nextPassword = createPasswordHash(nextPasswordText);
      const updatedHrUser = normalizeAdminUser(clearAdminInviteMetadata({
        ...hrUser,
        passwordSalt: nextPassword.salt,
        passwordHash: nextPassword.hash,
        updatedAt: changedAt
      }));
      data.adminUsers = replaceAdminUser(data.adminUsers, updatedHrUser);
      data.adminSessions = revokeOtherSessionsForUser(
        data.adminSessions,
        webmasterAccess.adminUser.id === hrUser.id ? webmasterAccess.session.id : "",
        hrUser.id,
        changedAt
      );

      clearAdminIdentityGuards(data, hrUser.username);
      appendSecurityEvent(data, createSecurityEvent({
        type: "hr_password_reset_by_webmaster",
        actor: "webmaster",
        accountKey: hrUser.username,
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
        consumedAt: "",
        failedAttempts: 0,
        lastFailedAt: "",
        lockedUntil: ""
      };

      const recoveryUser = findConfiguredRoleUser(data.adminUsers, "hr");
      appendSecurityEvent(data, createSecurityEvent({
        type: "hr_recovery_requested",
        actor: "recovery",
        accountKey: recoveryUser?.username || defaultAdminUsername(),
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
      const nowMs = Date.now();

      if (!challenge.codeSalt || !challenge.codeHash) {
        throw new Error("No HR recovery code is active.");
      }

      if (challenge.consumedAt) {
        throw new Error("That recovery code has already been used.");
      }

      if (toTimestamp(challenge.expiresAt) <= nowMs) {
        throw new Error("That recovery code has expired.");
      }

      if (toTimestamp(challenge.lockedUntil) > nowMs) {
        const error = new Error("Too many invalid recovery attempts. Request a new recovery code.");
        error.statusCode = 429;
        throw error;
      }

      if (!verifyPassword(codeText, challenge.codeSalt, challenge.codeHash)) {
        const changedAt = nowIso();
        const failedAttempts = challenge.failedAttempts + 1;
        const invalidated = failedAttempts >= HR_RECOVERY_MAX_FAILURES;
        const recoveryUser = findConfiguredRoleUser(data.adminUsers, "hr");

        data.recovery = normalizeRecoveryState(data.recovery);
        data.recovery.hr = {
          ...challenge,
          codeSalt: invalidated ? "" : challenge.codeSalt,
          codeHash: invalidated ? "" : challenge.codeHash,
          consumedAt: invalidated ? changedAt : challenge.consumedAt,
          failedAttempts,
          lastFailedAt: changedAt,
          lockedUntil: invalidated ? new Date(nowMs + HR_RECOVERY_LOCKOUT_MS).toISOString() : challenge.lockedUntil
        };

        const event = appendSecurityEvent(data, createSecurityEvent({
          type: "hr_recovery_failed",
          actor: "recovery",
          accountKey: recoveryUser?.username || defaultAdminUsername(),
          sourceIp: normalizeSecurityKey(clientIp),
          outcome: invalidated ? "locked" : "denied",
          detail: invalidated ? "email-recovery-locked" : "email-recovery-invalid",
          userAgent
        }));

        return {
          ok: false,
          statusCode: invalidated ? 429 : 403,
          error: invalidated
            ? "Too many invalid recovery attempts. Request a new recovery code."
            : "Recovery code is invalid.",
          event
        };
      }

      const changedAt = nowIso();
      const nextPassword = createPasswordHash(nextPasswordText);
      const adminUser = upsertRoleAdminUser(
        data,
        "hr",
        defaultAdminUsername(),
        nextPassword.salt,
        nextPassword.hash,
        changedAt,
        changedAt
      );
      const session = createAdminSession(adminUser, "hr", userAgent);

      data.adminSessions = [
        session,
        ...revokeOtherSessionsForUser(data.adminSessions, "", adminUser.id, changedAt)
          .filter((entry) => entry.id !== session.id && !isSessionExpired(entry) && !entry.revokedAt)
      ];
      data.recovery = normalizeRecoveryState(data.recovery);
      data.recovery.hr = {
        ...challenge,
        codeSalt: "",
        codeHash: "",
        consumedAt: changedAt,
        failedAttempts: 0,
        lastFailedAt: "",
        lockedUntil: ""
      };

      clearAdminIdentityGuards(data, adminUser.username, clientIp);
      appendSecurityEvent(data, createSecurityEvent({
        type: "hr_access_recovered",
        actor: "recovery",
        accountKey: adminUser.username,
        sourceIp: normalizeSecurityKey(clientIp),
        outcome: "success",
        detail: "email-recovery",
        userAgent
      }));

      return {
        ok: true,
        session,
        adminUser
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
        user: publicAdminAccessUser(result.adminUser),
        sessionId: result.session.id
      };
    });
  }

  async function recoverAdminAccess({ password, userAgent = "", clientIp = "" } = {}) {
    const nextPasswordText = String(password || "");
    validateAdminPassword(nextPasswordText);

    return updateData((data) => {
      const changedAt = nowIso();
      const nextPassword = createPasswordHash(nextPasswordText);
      const adminUser = upsertRoleAdminUser(
        data,
        "hr",
        defaultAdminUsername(),
        nextPassword.salt,
        nextPassword.hash,
        changedAt,
        changedAt
      );
      const session = createAdminSession(adminUser, "hr", userAgent);

      data.adminSessions = [
        session,
        ...revokeOtherSessionsForUser(data.adminSessions, "", adminUser.id, changedAt)
          .filter((entry) => entry.id !== session.id && !isSessionExpired(entry) && !entry.revokedAt)
      ];
      data.recovery = normalizeRecoveryState(data.recovery);
      data.recovery.hr = {
        ...normalizeRecoveryChallenge(data.recovery.hr),
        codeSalt: "",
        codeHash: "",
        consumedAt: changedAt,
        failedAttempts: 0,
        lastFailedAt: "",
        lockedUntil: ""
      };

      clearAdminIdentityGuards(data, adminUser.username, clientIp);
      appendSecurityEvent(data, createSecurityEvent({
        type: "hr_access_recovered",
        actor: "recovery",
        accountKey: adminUser.username,
        sourceIp: normalizeSecurityKey(clientIp),
        outcome: "success",
        detail: "deployment-recovery",
        userAgent
      }));

      return { session, adminUser };
    }).then(({ result }) => ({
      ...adminAccessResponse(result.session),
      user: publicAdminAccessUser(result.adminUser),
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
    return accessCookieNames();
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
    recordPushSubscriptionFailure,
    listAdminUsers,
    createAdminUser,
    inviteAdminUser,
    updateAdminUserProfile,
    updateAdminUserRoles,
    setAdminUserActive,
    resendAdminInvite,
    previewAdminInvite,
    acceptAdminInvite,
    resetAdminUserPassword,
    revokeAdminUserSessions,
    listEmployees,
    createEmployeeAccount,
    setEmployeeActive,
    changeAdminPassword,
    changeWebmasterPassword,
    issueHrRecoveryCode,
    recoverAdminAccessByCode,
    resetHrPasswordByWebmaster,
    recoverAdminAccess,
    resetEmployeePassword,
    revokeEmployeeSessions
  };
}
