import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSecurityStore } from "../security.js";

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

test("shared admin user table can hold both HR and webmaster roles for one named account", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "palziv-security-shared-admin-"));
  const dataFile = path.join(tempDir, "security.json");

  try {
    const store = createSecurityStore({ dataFile });
    await store.init();

    const hrSetup = await store.setupAdminAccess({
      username: "alex.admin",
      password: "ManagerSecret1!",
      userAgent: "test"
    });
    const webmasterSetup = await store.setupWebmasterAccess({
      username: "alex.admin",
      password: "ManagerSecret1!",
      userAgent: "test"
    });

    const securityState = await store.readSecurityState();
    assert.equal(securityState.adminUsers.length, 1);
    assert.deepEqual(securityState.adminUsers[0].roles, ["hr", "webmaster"]);
    assert.equal(securityState.adminSessions.filter((session) => session.role === "hr").length, 1);
    assert.equal(securityState.adminSessions.filter((session) => session.role === "webmaster").length, 1);

    const hrLogin = await store.authenticateAdmin({
      username: "alex.admin",
      password: "ManagerSecret1!",
      userAgent: "test"
    });
    const webmasterLogin = await store.authenticateWebmaster({
      username: "alex.admin",
      password: "ManagerSecret1!",
      userAgent: "test"
    });

    assert.equal(Boolean(hrLogin.authorized), true);
    assert.equal(Boolean(webmasterLogin.authorized), true);
    assert.equal(hrSetup.user?.username, "alex.admin");
    assert.equal(webmasterSetup.user?.username, "alex.admin");
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

test("logoutAdmin revokes both current and legacy HR sessions", async () => {
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

    const legacySession = await store.authenticateAdmin({
      username: "hr",
      password: "ManagerSecret1!",
      userAgent: "legacy"
    });
    const currentSession = await store.authenticateAdmin({
      username: "hr",
      password: "ManagerSecret1!",
      userAgent: "current"
    });

    const logoutResult = await store.logoutAdmin({
      headers: {
        cookie: `palziv_hr_auth=${currentSession.sessionId}; palziv_admin_auth=${legacySession.sessionId}`
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
        cookie: `palziv_admin_auth=${legacySession.sessionId}`
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
