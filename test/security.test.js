import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSecurityStore } from "../security.js";

function decodeBase32(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const normalized = String(secret || "").toUpperCase().replace(/=+$/g, "");
  let bits = "";

  for (const character of normalized) {
    const index = alphabet.indexOf(character);
    if (index < 0) {
      throw new Error(`Invalid base32 character: ${character}`);
    }

    bits += index.toString(2).padStart(5, "0");
  }

  const bytes = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }

  return Buffer.from(bytes);
}

function generateTotp(secret, timeMs = Date.now(), periodSeconds = 30, digits = 6) {
  const counter = Math.floor(timeMs / 1000 / periodSeconds);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuffer.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac("sha1", decodeBase32(secret)).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = (
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  );
  const code = binary % (10 ** digits);
  return String(code).padStart(digits, "0");
}

test("createSecurityStore provisions admin and revokes disabled employee access", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-security-managed-"));
  const dataFile = path.join(tempDir, "security.json");

  try {
    const store = createSecurityStore({ dataFile });
    await store.init();

    const initialHrAccess = await store.checkHrAccess({ headers: {} });
    assert.deepEqual(initialHrAccess, {
      authorized: false,
      setupRequired: true,
      sessionExpiresAt: "",
      csrfToken: ""
    });

    const adminSetup = await store.setupAdminAccess({
      username: "hr",
      password: "ManagerSecret1!",
      userAgent: "test"
    });
    assert.equal(Boolean(adminSetup.authorized), true);
    assert.ok(adminSetup.sessionId);
    assert.ok(adminSetup.csrfToken);

    await assert.rejects(
      store.authenticateAdmin({
        password: "ManagerSecret1!",
        userAgent: "test"
      }),
      /HR username is required\./
    );

    const adminLogin = await store.authenticateAdmin({
      username: "hr",
      password: "ManagerSecret1!",
      userAgent: "test"
    });
    assert.equal(Boolean(adminLogin.authorized), true);

    const hrAccess = await store.checkHrAccess({
      headers: {
        cookie: `palziv_hr_auth=${adminLogin.sessionId}`
      }
    });
    assert.equal(Boolean(hrAccess.authorized), true);

    const initialWebmasterAccess = await store.checkWebmasterAccess({ headers: {} });
    assert.equal(Boolean(initialWebmasterAccess.authorized), false);
    assert.equal(Boolean(initialWebmasterAccess.setupRequired), true);

    const webmasterSetup = await store.setupWebmasterAccess({
      username: "webmaster",
      password: "WebmasterSecret1!",
      userAgent: "test"
    });
    assert.equal(Boolean(webmasterSetup.authorized), true);

    await assert.rejects(
      store.authenticateWebmaster({
        password: "WebmasterSecret1!",
        userAgent: "test"
      }),
      /Webmaster username is required\./
    );

    const webmasterLogin = await store.authenticateWebmaster({
      username: "webmaster",
      password: "WebmasterSecret1!",
      userAgent: "test"
    });
    assert.equal(Boolean(webmasterLogin.authorized), true);

    const webmasterAccess = await store.checkWebmasterAccess({
      headers: {
        cookie: `palziv_webmaster_auth=${webmasterLogin.sessionId}`
      }
    });
    assert.equal(Boolean(webmasterAccess.authorized), true);

    const employeeResult = await store.createEmployeeAccount({
      name: "Maria Lopez",
      username: "maria.lopez",
      password: "EmployeePass1!"
    });
    assert.equal(employeeResult.employee.username, "maria.lopez");

    const employeeLogin = await store.authenticateEmployee({
      username: "maria.lopez",
      password: "EmployeePass1!",
      userAgent: "test"
    });
    assert.equal(Boolean(employeeLogin.authorized), true);

    const employeeAccess = await store.checkEmployeeAccess({
      headers: {
        cookie: `palziv_employee_auth=${employeeLogin.sessionId}`
      }
    });
    assert.equal(Boolean(employeeAccess.authorized), true);
    assert.equal(employeeAccess.employee?.username, "maria.lopez");

    await store.setEmployeeActive(employeeResult.employee.id, false);

    const revokedAccess = await store.checkEmployeeAccess({
      headers: {
        cookie: `palziv_employee_auth=${employeeLogin.sessionId}`
      }
    });
    assert.equal(Boolean(revokedAccess.authorized), false);

    const snapshot = await store.readData();
    assert.equal(snapshot.accessModel, "managed-accounts");
    assert.equal(snapshot.admin.enabled, true);
    assert.equal(snapshot.employees.active, 0);
    assert.equal(snapshot.employees.inactive, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("legacy webmaster records normalize to the default webmaster username", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-security-webmaster-legacy-"));
  const dataFile = path.join(tempDir, "security.json");

  try {
    const store = createSecurityStore({ dataFile });
    await store.init();
    await store.setupWebmasterAccess({
      username: "webmaster",
      password: "WebmasterSecret1!",
      userAgent: "test"
    });

    await store.updateData((data) => {
      const webmasterUser = data.adminUsers.find((user) => Array.isArray(user.roles) && user.roles.includes("webmaster"));
      delete webmasterUser.username;
    });

    const login = await store.authenticateWebmaster({
      username: "webmaster",
      password: "WebmasterSecret1!",
      userAgent: "test"
    });
    assert.equal(Boolean(login.authorized), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("security store ignores legacy role-specific admin session arrays", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-security-legacy-session-arrays-"));
  const dataFile = path.join(tempDir, "security.json");

  try {
    const store = createSecurityStore({ dataFile });
    await store.init();

    const hrSetup = await store.setupAdminAccess({
      username: "hr.owner",
      password: "ManagerSecret1!",
      userAgent: "test"
    });
    const webmasterSetup = await store.setupWebmasterAccess({
      username: "webmaster.owner",
      password: "WebmasterSecret1!",
      userAgent: "test"
    });
    const itSetup = await store.setupItAccess({
      username: "it.owner",
      password: "OwnerSecret1!",
      userAgent: "test"
    });

    const seededState = await store.readSecurityState();
    const hrSession = seededState.adminSessions.find((session) => session.id === hrSetup.sessionId);
    const webmasterSession = seededState.adminSessions.find((session) => session.id === webmasterSetup.sessionId);
    const itSession = seededState.adminSessions.find((session) => session.id === itSetup.sessionId);

    seededState.adminSessions = [];
    seededState.hrSessions = [hrSession];
    seededState.webmasterSessions = [webmasterSession];
    seededState.itSessions = [itSession];
    await store.writeData(seededState);

    const reloadedState = await store.readSecurityState();
    assert.equal(reloadedState.adminSessions.length, 0);

    const hrAccess = await store.checkHrAccess({
      headers: {
        cookie: `palziv_hr_auth=${hrSetup.sessionId}`
      }
    });
    assert.equal(Boolean(hrAccess.authorized), false);

    const webmasterAccess = await store.checkWebmasterAccess({
      headers: {
        cookie: `palziv_webmaster_auth=${webmasterSetup.sessionId}`
      }
    });
    assert.equal(Boolean(webmasterAccess.authorized), false);

    const itAccess = await store.checkItAccess({
      headers: {
        cookie: `palziv_it_auth=${itSetup.sessionId}`
      }
    });
    assert.equal(Boolean(itAccess.authorized), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("security store ignores malformed canonical admin sessions", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-security-malformed-admin-sessions-"));
  const dataFile = path.join(tempDir, "security.json");

  try {
    const store = createSecurityStore({ dataFile });
    await store.init();

    const hrSetup = await store.setupAdminAccess({
      username: "hr.owner",
      password: "ManagerSecret1!",
      userAgent: "test"
    });

    const seededState = await store.readSecurityState();
    const validSession = seededState.adminSessions.find((session) => session.id === hrSetup.sessionId);

    seededState.adminSessions = [
      {
        ...validSession,
        adminUserId: "",
        role: ""
      }
    ];
    await store.writeData(seededState);

    const reloadedState = await store.readSecurityState();
    assert.equal(reloadedState.adminSessions.length, 0);

    const access = await store.checkHrAccess({
      headers: {
        cookie: `palziv_hr_auth=${hrSetup.sessionId}`
      }
    });
    assert.equal(Boolean(access.authorized), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("admin role assignments reject composite privileged accounts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-security-single-role-admin-"));
  const dataFile = path.join(tempDir, "security.json");

  try {
    const store = createSecurityStore({ dataFile });
    await store.init();

    const itSetup = await store.setupItAccess({
      username: "it.primary",
      password: "OwnerSecret1!",
      userAgent: "test"
    });
    const itReq = {
      headers: {
        cookie: `palziv_it_auth=${itSetup.sessionId}`
      }
    };

    await assert.rejects(
      store.createItAdminUser({
        displayName: "Composite Ops",
        email: "composite.ops@example.com",
        username: "composite.ops",
        password: "CompositeSecret1!",
        roles: ["hr", "webmaster"]
      }),
      /single privileged role/i
    );

    await assert.rejects(
      store.inviteItAdminUser({
        displayName: "Composite Invite",
        email: "composite.invite@example.com",
        username: "composite.invite",
        roles: ["it", "hr"],
        userAgent: "test",
        clientIp: "198.51.100.12"
      }),
      /single privileged role/i
    );

    const created = await store.createItAdminUser({
      displayName: "HR Lead",
      email: "hr.lead@example.com",
      username: "hr.lead",
      password: "HrLeadSecret1!",
      roles: ["hr"]
    });
    assert.deepEqual(created.adminUser.roles, ["hr"]);

    await assert.rejects(
      store.updateItAdminUserRoles(itReq, created.adminUser.id, ["hr", "webmaster"]),
      /single privileged role/i
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("security store exposes canonical IT-only access cookie names and APIs", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-security-it-migration-"));
  const dataFile = path.join(tempDir, "security.json");

  try {
    const store = createSecurityStore({ dataFile });
    await store.init();
    assert.equal(typeof store.setupItAccess, "function");
    assert.equal(typeof store.authenticateIt, "function");
    assert.equal(typeof store.logoutIt, "function");
    assert.equal(typeof store.checkItAccess, "function");
    assert.equal(typeof store.listItAdminUsers, "function");
    assert.equal(typeof store.createItAdminUser, "function");
    assert.equal(typeof store.inviteItAdminUser, "function");
    assert.equal(typeof store.updateItAdminUserProfile, "function");
    assert.equal(typeof store.updateItAdminUserRoles, "function");
    assert.equal(typeof store.setItAdminUserActive, "function");
    assert.equal(typeof store.resendItAdminInvite, "function");
    assert.equal(typeof store.resetItAdminUserPassword, "function");
    assert.equal(typeof store.revokeItAdminUserSessions, "function");
    assert.equal(store.setupOwnerAccess, undefined);
    assert.equal(store.authenticateOwner, undefined);
    assert.equal(store.logoutOwner, undefined);
    assert.equal(store.checkOwnerAccess, undefined);
    assert.equal(store.listOwnerAdminUsers, undefined);
    assert.equal(store.createOwnerAdminUser, undefined);
    assert.equal(store.inviteOwnerAdminUser, undefined);
    assert.equal(store.updateOwnerAdminUserProfile, undefined);
    assert.equal(store.updateOwnerAdminUserRoles, undefined);
    assert.equal(store.setOwnerAdminUserActive, undefined);
    assert.equal(store.resendOwnerAdminInvite, undefined);
    assert.equal(store.resetOwnerAdminUserPassword, undefined);
    assert.equal(store.revokeOwnerAdminUserSessions, undefined);

    const cookieNames = store.getAccessCookieNames();
    assert.equal(cookieNames.it, "palziv_it_auth");
    assert.equal(cookieNames.legacyIt, undefined);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("webmaster admin management stays scoped to webmaster-role admin accounts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-security-webmaster-admins-"));
  const dataFile = path.join(tempDir, "security.json");

  try {
    const store = createSecurityStore({ dataFile });
    await store.init();

    const hrSetup = await store.setupAdminAccess({
      username: "hr.owner",
      password: "ManagerSecret1!",
      userAgent: "test"
    });
    const webmasterSetup = await store.setupWebmasterAccess({
      username: "webmaster.owner",
      password: "WebmasterSecret1!",
      userAgent: "test"
    });
    const webmasterReq = {
      headers: {
        cookie: `palziv_webmaster_auth=${webmasterSetup.sessionId}`
      }
    };

    const scopedList = await store.listWebmasterAdminUsers({
      currentUserId: webmasterSetup.user.id
    });
    assert.equal(scopedList.length, 1);
    assert.equal(scopedList[0].username, "webmaster.owner");
    assert.equal(scopedList[0].currentUser, true);
    assert.equal(scopedList.some((adminUser) => adminUser.username === "hr.owner"), false);

    await assert.rejects(
      store.inviteWebmasterAdminUser({
        displayName: "Only HR",
        email: "only.hr@example.com",
        username: "only.hr",
        roles: ["hr"],
        userAgent: "test",
        clientIp: "198.51.100.60"
      }),
      /Webmaster admin accounts must include the webmaster role/i
    );

    const invited = await store.inviteWebmasterAdminUser({
      displayName: "Avery Webmaster",
      email: "avery.webmaster@example.com",
      username: "avery.webmaster",
      roles: ["webmaster"],
      userAgent: "test",
      clientIp: "198.51.100.61"
    });
    assert.equal(invited.adminUser.credentialsConfigured, false);
    assert.equal(invited.adminUser.invitePending, true);
    assert.equal(invited.preferredRoute, "webmaster");

    const preview = await store.previewAdminInvite({
      token: invited.inviteToken
    });
    assert.equal(preview.adminUser.username, "avery.webmaster");
    assert.equal(preview.preferredRoute, "webmaster");

    const accepted = await store.acceptAdminInvite({
      token: invited.inviteToken,
      password: "WebmasterSecret2!",
      userAgent: "test",
      clientIp: "198.51.100.62"
    });
    assert.deepEqual(accepted.roles, ["webmaster"]);
    assert.ok(accepted.sessions.webmaster?.id);

    await assert.rejects(
      store.updateWebmasterAdminUserRoles(webmasterReq, invited.adminUser.id, ["hr", "webmaster"]),
      /single privileged role/i
    );

    await assert.rejects(
      store.updateWebmasterAdminUserRoles(webmasterReq, invited.adminUser.id, ["hr"]),
      /must include the webmaster role/i
    );

    await store.updateWebmasterAdminUserProfile(webmasterReq, invited.adminUser.id, {
      displayName: "Avery Operations",
      email: "avery.operations@example.com"
    });

    await store.resetWebmasterAdminUserPassword(webmasterReq, invited.adminUser.id, {
      password: "WebmasterSecret3!",
      userAgent: "test",
      clientIp: "198.51.100.63"
    });

    await assert.rejects(
      store.updateWebmasterAdminUserRoles(webmasterReq, hrSetup.user.id, ["webmaster"]),
      /Webmaster can only manage webmaster accounts/i
    );

    const listAgain = await store.listWebmasterAdminUsers({
      currentUserId: webmasterSetup.user.id
    });
    const invitedAdmin = listAgain.find((adminUser) => adminUser.username === "avery.webmaster");
    assert.deepEqual(invitedAdmin?.roles, ["webmaster"]);
    assert.equal(invitedAdmin?.displayName, "Avery Operations");
    assert.equal(invitedAdmin?.email, "avery.operations@example.com");
    assert.equal(Boolean(invitedAdmin?.credentialsConfigured), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("HR recovery codes lock out after repeated invalid guesses", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-security-recovery-"));
  const dataFile = path.join(tempDir, "security.json");

  try {
    const store = createSecurityStore({ dataFile });
    await store.init();
    await store.setupAdminAccess({
      username: "hr",
      password: "ManagerSecret1!",
      userAgent: "test"
    });

    const issued = await store.issueHrRecoveryCode({
      email: "hr@example.com",
      userAgent: "test",
      clientIp: "198.51.100.10"
    });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await assert.rejects(
        store.recoverAdminAccessByCode({
          code: "000000",
          password: "ReplacementSecret1!",
          userAgent: "test",
          clientIp: "198.51.100.10"
        }),
        /Recovery code is invalid\./
      );
    }

    await assert.rejects(
      store.recoverAdminAccessByCode({
        code: "000000",
        password: "ReplacementSecret1!",
        userAgent: "test",
        clientIp: "198.51.100.10"
      }),
      /Too many invalid recovery attempts\. Request a new recovery code\./
    );

    await assert.rejects(
      store.recoverAdminAccessByCode({
        code: issued.code,
        password: "ReplacementSecret1!",
        userAgent: "test",
        clientIp: "198.51.100.10"
      }),
      /No HR recovery code is active\./
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("logoutAdmin only honors the canonical HR session cookie", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-security-logout-"));
  const dataFile = path.join(tempDir, "security.json");

  try {
    const store = createSecurityStore({ dataFile });
    await store.init();
    await store.setupAdminAccess({
      username: "hr",
      password: "ManagerSecret1!",
      userAgent: "test"
    });

    const currentSession = await store.authenticateAdmin({
      username: "hr",
      password: "ManagerSecret1!",
      userAgent: "current"
    });

    const legacyCookieAccess = await store.checkHrAccess({
      headers: {
        cookie: `palziv_admin_auth=${currentSession.sessionId}`
      }
    });
    assert.equal(Boolean(legacyCookieAccess.authorized), false);

    const logoutResult = await store.logoutAdmin({
      headers: {
        cookie: `palziv_hr_auth=${currentSession.sessionId}`
      }
    });
    assert.equal(logoutResult.removed, true);

    const currentAccess = await store.checkHrAccess({
      headers: {
        cookie: `palziv_hr_auth=${currentSession.sessionId}`
      }
    });
    assert.equal(Boolean(currentAccess.authorized), false);

    const legacyAccess = await store.checkHrAccess({
      headers: {
        cookie: `palziv_admin_auth=${currentSession.sessionId}`
      }
    });
    assert.equal(Boolean(legacyAccess.authorized), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("HR password changes do not revoke another admin user's webmaster session", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-security-admin-sessions-"));
  const dataFile = path.join(tempDir, "security.json");

  try {
    const store = createSecurityStore({ dataFile });
    await store.init();

    const hrSetup = await store.setupAdminAccess({
      username: "hr.owner",
      password: "ManagerSecret1!",
      userAgent: "test"
    });
    await store.setupWebmasterAccess({
      username: "webmaster.owner",
      password: "WebmasterSecret1!",
      userAgent: "test"
    });
    const webmasterLogin = await store.authenticateWebmaster({
      username: "webmaster.owner",
      password: "WebmasterSecret1!",
      userAgent: "test"
    });

    const hrChange = await store.changeAdminPassword({
      headers: {
        cookie: `palziv_hr_auth=${hrSetup.sessionId}`
      }
    }, {
      currentPassword: "ManagerSecret1!",
      password: "ManagerSecret2!",
      userAgent: "test",
      clientIp: "198.51.100.20"
    });

    assert.equal(Boolean(hrChange.authorized), true);

    const webmasterAccess = await store.checkWebmasterAccess({
      headers: {
        cookie: `palziv_webmaster_auth=${webmasterLogin.sessionId}`
      }
    });
    assert.equal(Boolean(webmasterAccess.authorized), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Webmaster can reset the HR password and revoke existing HR sessions", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-security-hr-reset-"));
  const dataFile = path.join(tempDir, "security.json");

  try {
    const store = createSecurityStore({ dataFile });
    await store.init();

    const hrSetup = await store.setupAdminAccess({
      username: "hr.owner",
      password: "ManagerSecret1!",
      userAgent: "test"
    });
    const webmasterSetup = await store.setupWebmasterAccess({
      username: "webmaster.owner",
      password: "WebmasterSecret1!",
      userAgent: "test"
    });

    const resetResult = await store.resetHrPasswordByWebmaster({
      headers: {
        cookie: `palziv_webmaster_auth=${webmasterSetup.sessionId}`
      }
    }, {
      password: "ManagerSecret2!",
      userAgent: "test",
      clientIp: "198.51.100.25"
    });

    assert.ok(resetResult.resetAt);

    const revokedHrAccess = await store.checkHrAccess({
      headers: {
        cookie: `palziv_hr_auth=${hrSetup.sessionId}`
      }
    });
    assert.equal(Boolean(revokedHrAccess.authorized), false);

    const webmasterAccess = await store.checkWebmasterAccess({
      headers: {
        cookie: `palziv_webmaster_auth=${webmasterSetup.sessionId}`
      }
    });
    assert.equal(Boolean(webmasterAccess.authorized), true);

    const hrRelogin = await store.authenticateAdmin({
      username: "hr.owner",
      password: "ManagerSecret2!",
      userAgent: "test"
    });
    assert.equal(Boolean(hrRelogin.authorized), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("HR admin management stays scoped to HR-only admin accounts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-security-admin-management-"));
  const dataFile = path.join(tempDir, "security.json");

  try {
    const store = createSecurityStore({ dataFile });
    await store.init();

    const hrSetup = await store.setupAdminAccess({
      username: "hr.owner",
      password: "ManagerSecret1!",
      userAgent: "test"
    });
    const hrReq = {
      headers: {
        cookie: `palziv_hr_auth=${hrSetup.sessionId}`
      }
    };
    const webmasterSetup = await store.setupWebmasterAccess({
      username: "webmaster.owner",
      password: "WebmasterSecret1!",
      userAgent: "test"
    });

    const adminList = await store.listAdminUsers({
      currentUserId: hrSetup.user.id
    });
    assert.equal(adminList.length, 1);
    assert.equal(adminList[0].username, "hr.owner");
    assert.equal(adminList.some((adminUser) => adminUser.username === "webmaster.owner"), false);

    await assert.rejects(
      store.createAdminUser({
        displayName: "Ops Webmaster",
        email: "ops.webmaster@example.com",
        username: "ops.webmaster",
        password: "OpsSecret1!",
        roles: ["webmaster"]
      }),
      /HR cannot assign webmaster roles/i
    );

    const created = await store.createAdminUser({
      displayName: "Ops Admin",
      email: "ops.admin@example.com",
      username: "ops.admin",
      password: "OpsSecret1!",
      roles: ["hr"]
    });
    assert.equal(created.adminUser.displayName, "Ops Admin");
    assert.equal(created.adminUser.email, "ops.admin@example.com");
    assert.deepEqual(created.adminUser.roles, ["hr"]);

    const scopedList = await store.listAdminUsers({
      currentUserId: hrSetup.user.id
    });
    assert.equal(scopedList.length, 2);
    assert.equal(scopedList.some((adminUser) => adminUser.currentUser), true);
    assert.equal(scopedList.some((adminUser) => adminUser.username === "webmaster.owner"), false);

    const updated = await store.updateAdminUserRoles(hrReq, created.adminUser.id, ["hr"]);
    assert.deepEqual(updated.adminUser.roles, ["hr"]);

    const adminLogin = await store.authenticateAdmin({
      username: "ops.admin",
      password: "OpsSecret1!",
      userAgent: "test"
    });
    assert.equal(Boolean(adminLogin.authorized), true);

    await store.resetAdminUserPassword(hrReq, created.adminUser.id, {
      password: "OpsSecret2!",
      userAgent: "test",
      clientIp: "198.51.100.40"
    });
    await store.revokeAdminUserSessions(hrReq, created.adminUser.id, {
      userAgent: "test",
      clientIp: "198.51.100.40"
    });
    const revokedAccess = await store.checkHrAccess({
      headers: {
        cookie: `palziv_hr_auth=${adminLogin.sessionId}`
      }
    });
    assert.equal(Boolean(revokedAccess.authorized), false);

    await store.setAdminUserActive(hrReq, created.adminUser.id, false);
    await assert.rejects(
      store.authenticateAdmin({
        username: "ops.admin",
        password: "OpsSecret2!",
        userAgent: "test"
      }),
      /Invalid username or password\./
    );

    await assert.rejects(
      store.inviteAdminUser({
        displayName: "Avery Webmaster",
        email: "avery.webmaster@example.com",
        username: "avery.webmaster",
        roles: ["webmaster"],
        userAgent: "test",
        clientIp: "198.51.100.44"
      }),
      /HR cannot assign webmaster roles/i
    );

    await assert.rejects(
      store.updateAdminUserProfile(hrReq, webmasterSetup.user.id, {
        displayName: "Updated Webmaster",
        email: "updated.webmaster@example.com"
      }),
      /HR cannot manage webmaster accounts/i
    );

    await assert.rejects(
      store.updateAdminUserRoles(hrReq, webmasterSetup.user.id, ["hr"]),
      /HR cannot manage webmaster accounts/i
    );

    await assert.rejects(
      store.setAdminUserActive(hrReq, webmasterSetup.user.id, false),
      /HR cannot manage webmaster accounts/i
    );

    await assert.rejects(
      store.resetAdminUserPassword(hrReq, webmasterSetup.user.id, {
        password: "WebmasterSecret2!",
        userAgent: "test",
        clientIp: "198.51.100.45"
      }),
      /HR cannot manage webmaster accounts/i
    );

    await assert.rejects(
      store.revokeAdminUserSessions(hrReq, webmasterSetup.user.id, {
        userAgent: "test",
        clientIp: "198.51.100.45"
      }),
      /HR cannot manage webmaster accounts/i
    );

    await assert.rejects(
      store.resendAdminInvite(hrReq, webmasterSetup.user.id, {
        userAgent: "test",
        clientIp: "198.51.100.45"
      }),
      /HR cannot manage webmaster accounts/i
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("admin invitations support identity edits, resend, and invite acceptance", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-security-admin-invites-"));
  const dataFile = path.join(tempDir, "security.json");

  try {
    const store = createSecurityStore({ dataFile });
    await store.init();

    const hrSetup = await store.setupAdminAccess({
      username: "hr.owner",
      password: "ManagerSecret1!",
      userAgent: "test"
    });
    const hrReq = {
      headers: {
        cookie: `palziv_hr_auth=${hrSetup.sessionId}`
      }
    };

    const invited = await store.inviteAdminUser({
      displayName: "Avery Ops",
      email: "avery.ops@example.com",
      username: "avery.ops",
      roles: ["hr"],
      userAgent: "test",
      clientIp: "198.51.100.50"
    });
    assert.equal(invited.adminUser.credentialsConfigured, false);
    assert.equal(invited.adminUser.invitePending, true);

    const preview = await store.previewAdminInvite({
      token: invited.inviteToken
    });
    assert.equal(preview.adminUser.displayName, "Avery Ops");
    assert.equal(preview.adminUser.email, "avery.ops@example.com");

    await store.updateAdminUserProfile(hrReq, invited.adminUser.id, {
      displayName: "Avery Operations",
      email: "avery.operations@example.com"
    });
    await assert.rejects(
      store.previewAdminInvite({
        token: invited.inviteToken
      }),
      /Invitation is invalid or expired\./
    );

    const resent = await store.resendAdminInvite(hrReq, invited.adminUser.id, {
      userAgent: "test",
      clientIp: "198.51.100.51"
    });
    assert.notEqual(resent.inviteToken, invited.inviteToken);

    const accepted = await store.acceptAdminInvite({
      token: resent.inviteToken,
      password: "OpsSecret1!",
      userAgent: "test",
      clientIp: "198.51.100.52"
    });
    assert.deepEqual(accepted.roles, ["hr"]);
    assert.ok(accepted.sessions.hr?.id);

    const hrAccess = await store.checkHrAccess({
      headers: {
        cookie: `palziv_hr_auth=${accepted.sessions.hr.id}`
      }
    });
    assert.equal(Boolean(hrAccess.authorized), true);

    const adminList = await store.listAdminUsers({
      currentUserId: hrSetup.user.id
    });
    const acceptedAdmin = adminList.find((adminUser) => adminUser.username === "avery.ops");
    assert.equal(acceptedAdmin?.displayName, "Avery Operations");
    assert.equal(acceptedAdmin?.email, "avery.operations@example.com");
    assert.equal(Boolean(acceptedAdmin?.credentialsConfigured), true);
    assert.equal(acceptedAdmin?.inviteState, "accepted");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("admin MFA supports Google Authenticator enrollment and step-up verification after grace expiry", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-security-admin-mfa-"));
  const dataFile = path.join(tempDir, "security.json");

  try {
    const store = createSecurityStore({ dataFile, adminMfaEnabled: true });
    await store.init();

    const hrSetup = await store.setupAdminAccess({
      username: "hr.owner",
      password: "ManagerSecret1!",
      userAgent: "test"
    });
    assert.equal(hrSetup.user?.mfa?.status, "grace");

    const hrReq = {
      headers: {
        cookie: `palziv_hr_auth=${hrSetup.sessionId}`
      }
    };

    const enrollment = await store.beginAdminMfaEnrollment(hrReq, {
      role: "hr"
    });
    assert.match(String(enrollment.otpauthUrl || ""), /^otpauth:\/\/totp\//);
    assert.match(String(enrollment.otpauthUrl || ""), /issuer=/i);
    assert.ok(enrollment.manualEntryKey);

    const enableResult = await store.verifyAdminMfaEnrollment(hrReq, {
      role: "hr",
      code: generateTotp(enrollment.manualEntryKey),
      userAgent: "test",
      clientIp: "198.51.100.70"
    });
    assert.equal(Boolean(enableResult.user?.mfa?.enabled), true);

    const challengedLogin = await store.authenticateAdmin({
      username: "hr.owner",
      password: "ManagerSecret1!",
      userAgent: "test"
    });
    assert.equal(Boolean(challengedLogin.authorized), false);
    assert.equal(Boolean(challengedLogin.mfaRequired), true);
    assert.ok(challengedLogin.sessionId);

    const verifiedLogin = await store.verifyAdminMfaChallenge({
      headers: {
        cookie: `palziv_hr_auth=${challengedLogin.sessionId}`
      }
    }, {
      role: "hr",
      code: generateTotp(enrollment.manualEntryKey),
      userAgent: "test",
      clientIp: "198.51.100.70"
    });
    assert.equal(Boolean(verifiedLogin.authorized), true);

    const securityState = await store.readSecurityState();
    const hrUser = securityState.adminUsers.find((adminUser) => adminUser.username === "hr.owner");
    hrUser.mfaGraceUntil = "2000-01-01T00:00:00.000Z";
    await store.writeData(securityState);

    const expiredGraceLogin = await store.authenticateAdmin({
      username: "hr.owner",
      password: "ManagerSecret1!",
      userAgent: "test"
    });
    assert.equal(Boolean(expiredGraceLogin.mfaRequired), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("admin MFA can be disabled globally without blocking existing admin logins", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-security-admin-mfa-disabled-"));
  const dataFile = path.join(tempDir, "security.json");

  try {
    const store = createSecurityStore({ dataFile, adminMfaEnabled: false });
    await store.init();

    const hrSetup = await store.setupAdminAccess({
      username: "hr.owner",
      password: "ManagerSecret1!",
      userAgent: "test"
    });
    const securityState = await store.readSecurityState();
    const hrUser = securityState.adminUsers.find((adminUser) => adminUser.username === "hr.owner");
    hrUser.mfaSecret = "JBSWY3DPEHPK3PXP";
    hrUser.mfaEnabledAt = "2026-06-22T12:00:00.000Z";
    hrUser.mfaGraceUntil = "";
    await store.writeData(securityState);

    const login = await store.authenticateAdmin({
      username: "hr.owner",
      password: "ManagerSecret1!",
      userAgent: "test"
    });
    assert.equal(Boolean(login.authorized), true);
    assert.equal(Boolean(login.mfaRequired), false);
    assert.equal(Boolean(login.user?.mfa?.available), false);

    await assert.rejects(
      store.beginAdminMfaEnrollment({
        headers: {
          cookie: `palziv_hr_auth=${hrSetup.sessionId}`
        }
      }, {
        role: "hr"
      }),
      /disabled/i
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("HR recovery provisions a separate emergency HR account instead of replacing the live HR admin", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-security-emergency-hr-"));
  const dataFile = path.join(tempDir, "security.json");

  try {
    const store = createSecurityStore({ dataFile });
    await store.init();
    await store.setupAdminAccess({
      username: "hr.primary",
      password: "ManagerSecret1!",
      userAgent: "test"
    });

    const recovered = await store.recoverAdminAccess({
      password: "EmergencySecret1!",
      userAgent: "test",
      clientIp: "198.51.100.81"
    });
    assert.equal(recovered.user?.username, "emergency.hr.recovery");
    assert.equal(Boolean(recovered.user?.recoveryOnly), true);

    const originalLogin = await store.authenticateAdmin({
      username: "hr.primary",
      password: "ManagerSecret1!",
      userAgent: "test"
    });
    assert.equal(Boolean(originalLogin.authorized), true);

    await assert.rejects(
      store.authenticateAdmin({
        username: "hr.primary",
        password: "EmergencySecret1!",
        userAgent: "test"
      }),
      /Invalid username or password\./
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("employee accounts retain extended identity and lifecycle metadata", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-security-employee-metadata-"));
  const dataFile = path.join(tempDir, "security.json");

  try {
    const store = createSecurityStore({ dataFile });
    await store.init();

    const created = await store.createEmployeeAccount({
      name: "Maria Lopez",
      username: "maria.lopez",
      password: "EmployeePass1!",
      externalEmployeeId: "EMP-1001",
      email: "maria.lopez@example.com",
      recoveryEmail: "maria.personal@example.com",
      department: "Operations",
      location: "Dallas",
      identityProvider: "local",
      inviteSentAt: "2026-06-22T10:00:00.000Z",
      passwordResetRequired: true
    });

    assert.equal(created.employee.externalEmployeeId, "EMP-1001");
    assert.equal(created.employee.email, "maria.lopez@example.com");
    assert.equal(created.employee.recoveryEmail, "maria.personal@example.com");
    assert.equal(created.employee.department, "Operations");
    assert.equal(created.employee.location, "Dallas");
    assert.equal(created.employee.identityProvider, "local");
    assert.equal(Boolean(created.employee.passwordResetRequired), true);

    const employees = await store.listEmployees();
    assert.equal(employees[0]?.externalEmployeeId, "EMP-1001");
    assert.equal(employees[0]?.department, "Operations");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("admin management blocks unsafe self-service actions for the current HR account", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-security-admin-guardrails-"));
  const dataFile = path.join(tempDir, "security.json");

  try {
    const store = createSecurityStore({ dataFile });
    await store.init();

    const hrSetup = await store.setupAdminAccess({
      username: "hr.owner",
      password: "ManagerSecret1!",
      userAgent: "test"
    });
    const hrReq = {
      headers: {
        cookie: `palziv_hr_auth=${hrSetup.sessionId}`
      }
    };

    await assert.rejects(
      store.setAdminUserActive(hrReq, hrSetup.user.id, false),
      /cannot disable your own admin account/i
    );

    await assert.rejects(
      store.updateAdminUserRoles(hrReq, hrSetup.user.id, ["webmaster"]),
      /cannot remove your own HR role/i
    );

    await assert.rejects(
      store.resetAdminUserPassword(hrReq, hrSetup.user.id, {
        password: "ManagerSecret2!",
        userAgent: "test",
        clientIp: "198.51.100.41"
      }),
      /Use account settings to change your own password/i
    );

    await assert.rejects(
      store.revokeAdminUserSessions(hrReq, hrSetup.user.id, {
        userAgent: "test",
        clientIp: "198.51.100.41"
      }),
      /Use Sign Out to end your own current admin session/i
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
