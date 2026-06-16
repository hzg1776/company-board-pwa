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
      password: "ManagerSecret1!",
      userAgent: "test"
    });
    assert.equal(Boolean(adminSetup.authorized), true);
    assert.ok(adminSetup.sessionId);
    assert.ok(adminSetup.csrfToken);

    const hrAccess = await store.checkHrAccess({
      headers: {
        cookie: `palziv_hr_auth=${adminSetup.sessionId}`
      }
    });
    assert.equal(Boolean(hrAccess.authorized), true);

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
