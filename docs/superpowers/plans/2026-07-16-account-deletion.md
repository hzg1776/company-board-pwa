# Account Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add permanent, guarded account deletion for HR employee/HR-admin records and IT-managed admin records, including removal or anonymization of every account-linked artifact.

**Architecture:** `security.js` owns deletion authorization, current-user and last-admin guardrails, stored identity/session cleanup, login-guard cleanup, and security-event anonymization. `server.js` coordinates employee cleanup across the security, notification, and board stores before committing the security deletion. `public/app.js` exposes confirmed destructive actions in the existing HR and IT directories, and `public/styles.css` supplies one shared danger treatment.

**Tech Stack:** Node.js 22 ES modules, built-in `node:test`, file-backed JSON stores, vanilla HTML/CSS/JavaScript.

## Global Constraints

- HR can delete employee accounts and HR-only admin accounts.
- IT can delete any permitted non-current admin account.
- System Ops does not gain deletion authority.
- A signed-in administrator cannot delete their own current admin account.
- The last active configured IT admin and last active configured HR admin cannot be deleted.
- Employee deletion also removes linked HR access, sessions, push subscriptions, acknowledgements, account login guards, and direct identifiers in security events.
- Admin deletion does not delete an employee record with the same username.
- No new dependencies or component libraries.
- Use existing route, store, table, message, icon, token, and responsive patterns.

---

## File Structure

- Modify `security.js`: account-deletion validation, deletion helpers, cleanup counts, and store exports.
- Modify `server.js`: employee cross-store cleanup plus three `DELETE` API routes.
- Modify `public/app.js`: HR employee and HR/IT admin delete forms, confirmations, handlers, and refresh messages.
- Modify `public/styles.css`: final-cascade danger styling for destructive ghost buttons.
- Modify `test/security.test.js`: store-level cascade, anonymization, boundary, self-delete, last-admin, and same-username employee tests.
- Modify `test/server-security.test.js`: authenticated API deletion and cross-store artifact cleanup tests.
- Modify `test/ui-design-contract.test.js`: deletion-control scope, confirmation copy, handler routes, and final CSS contract.

### Task 1: Security-store deletion primitives and guardrails

**Files:**
- Modify: `security.js`
- Test: `test/security.test.js`

**Interfaces:**
- Produces: `previewEmployeeDeletion(req, employeeId) -> { employee: { id, name, username }, linkedAdminUserId }`
- Produces: `deleteEmployeeAccount(req, employeeId) -> { ok, employeeId, username, employeeSessionsRemoved, adminUsersRemoved, adminSessionsRemoved, loginGuardsRemoved, securityEventsAnonymized }`
- Produces: `deleteAdminUser(req, adminUserId, options) -> { ok, adminUserId, username, sessionsRemoved, loginGuardsRemoved, securityEventsAnonymized }`
- Produces: `deleteItAdminUser(req, adminUserId, options) -> same shape as deleteAdminUser`

- [ ] **Step 1: Write failing employee-deletion tests**

Add a test that provisions two HR admins, creates and authenticates an employee, links the employee to HR, seeds employee and HR login guards/security events with `store.updateData`, then asserts:

```js
const preview = await store.previewEmployeeDeletion(hrReq, employee.employee.id);
assert.equal(preview.employee.username, "maria.lopez");
assert.ok(preview.linkedAdminUserId);

const deleted = await store.deleteEmployeeAccount(hrReq, employee.employee.id);
assert.equal(deleted.ok, true);
assert.equal(deleted.employeeSessionsRemoved, 1);
assert.equal(deleted.adminUsersRemoved, 1);
assert.equal(deleted.adminSessionsRemoved, 1);

const state = await store.readSecurityState();
assert.equal(state.employees.some((entry) => entry.id === employee.employee.id), false);
assert.equal(state.employeeSessions.some((entry) => entry.employeeId === employee.employee.id), false);
assert.equal(state.adminUsers.some((entry) => entry.username === "maria.lopez"), false);
assert.equal(state.adminSessions.some((entry) => entry.adminUserId === preview.linkedAdminUserId), false);
assert.equal(state.loginGuards.employee.byAccount.some((entry) => entry.key === "maria.lopez"), false);
assert.equal(state.loginGuards.hr.byAccount.some((entry) => entry.key === "maria.lopez"), false);
assert.equal(state.securityEvents.some((entry) => entry.employeeId === employee.employee.id), false);
assert.equal(state.securityEvents.some((entry) => entry.accountKey === "maria.lopez"), false);
assert.equal(state.securityEvents.some((entry) => entry.accountKey === "deleted-account"), true);
```

Add rejection assertions for deleting an employee whose linked HR identity is the current actor and for deleting an employee whose linked HR identity is the last active configured HR administrator.

- [ ] **Step 2: Write failing admin-deletion tests**

Add store tests proving:

```js
await assert.rejects(
  store.deleteAdminUser(hrReq, hrSetup.user.id),
  /cannot delete your own admin account/i
);

await assert.rejects(
  store.deleteAdminUser(hrReq, webmasterSetup.user.id),
  /HR cannot manage webmaster accounts/i
);

const deletedHr = await store.deleteAdminUser(hrReq, backupHr.adminUser.id);
assert.equal(deletedHr.ok, true);

const deletedByIt = await store.deleteItAdminUser(itReq, webmasterSetup.user.id);
assert.equal(deletedByIt.ok, true);

const state = await store.readSecurityState();
assert.equal(state.adminUsers.some((entry) => entry.id === webmasterSetup.user.id), false);
assert.equal(state.employees.some((entry) => entry.username === "same.username"), true);
```

Also assert that deleting the final active configured IT or HR account fails with `At least one active ... admin is required.`

- [ ] **Step 3: Run store tests and verify RED**

Run:

```powershell
node --test test/security.test.js
```

Expected: FAIL because the deletion store methods do not exist.

- [ ] **Step 4: Implement shared deletion helpers**

Add helpers near the existing management guardrails:

```js
function createNotFoundError(message) {
  const error = new Error(message);
  error.statusCode = 404;
  return error;
}

function removeAccountLoginGuards(data, actor, username) {
  const bucket = loginGuardBucketForActor(ensureLoginGuards(data), actor);
  const accountKey = normalizeUsername(username);
  const originalLength = bucket.byAccount.length;
  bucket.byAccount = bucket.byAccount.filter((entry) => entry.key !== accountKey);
  return originalLength - bucket.byAccount.length;
}

function anonymizeSecurityEvents(data, { employeeId = "", username = "" } = {}) {
  let changed = 0;
  data.securityEvents = data.securityEvents.map((event) => {
    const matchesEmployee = employeeId && event.employeeId === employeeId;
    const matchesAccount = username && event.accountKey === username;
    if (!matchesEmployee && !matchesAccount) return event;
    changed += 1;
    return {
      ...event,
      employeeId: matchesEmployee ? "" : event.employeeId,
      accountKey: matchesAccount ? "deleted-account" : event.accountKey
    };
  });
  return changed;
}
```

Add one validation helper for admin deletion that checks the current actor and projected active-role counts before mutation. Use it from HR, IT, and linked-HR employee deletion.

- [ ] **Step 5: Implement employee preview and deletion**

Use `requireHrManagerAccess`, find the employee or throw a 404 error, find a linked HR-only admin by username, enforce self/last-HR guardrails, then physically filter the employee, employee sessions, linked admin, and linked admin sessions. Remove employee/HR account login guards, anonymize matching security events, append an `employee_deleted` audit event without the deleted username, and return cleanup counts.

- [ ] **Step 6: Implement HR and IT admin deletion**

Use `requireHrManagedAdminTarget` for HR and `requireItManagedAdminTarget` for IT. Enforce self-delete and projected last-active HR/IT checks. Physically filter the admin and its sessions, remove role-specific login guards, anonymize matching account-key events, append `admin_deleted_by_hr` or `admin_deleted_by_it`, and leave same-username employees untouched.

- [ ] **Step 7: Export methods and verify GREEN**

Add all four methods to the `createSecurityStore` return object, then run:

```powershell
node --test test/security.test.js
```

Expected: PASS with zero failures.

### Task 2: API routes and cross-store employee cleanup

**Files:**
- Modify: `server.js`
- Test: `test/server-security.test.js`

**Interfaces:**
- Consumes: the four security-store methods from Task 1.
- Produces: `DELETE /api/employees/:id`, `DELETE /api/admin-users/:id`, and `DELETE /api/it/admin-users/:id`.

- [ ] **Step 1: Write failing HR employee API cascade test**

Provision HR plus a deletable employee, authenticate the employee to create a session, add linked HR access, write two bound push subscriptions and one unrelated subscription, and write two matching acknowledgements plus one unrelated acknowledgement.

Call:

```js
const response = await fetch(`${server.baseUrl}/api/employees/${employeeId}`, {
  method: "DELETE",
  headers: {
    Origin: server.baseUrl,
    Cookie: hrCookie,
    "X-CSRF-Token": hrBody.csrfToken
  }
});
```

Assert `200`, `ok: true`, two push subscriptions removed, two acknowledgements removed, the employee no longer lists, employee login fails, the linked HR login fails, and unrelated push/acknowledgement records remain.

- [ ] **Step 2: Write failing admin API authorization tests**

Assert:

```js
assert.equal((await fetch(employeeDeleteUrl, { method: "DELETE" })).status, 401);
assert.equal(hrDeleteHrAdmin.status, 200);
assert.equal(hrDeleteItAdmin.status, 400);
assert.equal(itDeleteWebmasterAdmin.status, 200);
assert.equal(itDeleteCurrentSelf.status, 400);
assert.equal(deleteMissing.status, 404);
```

- [ ] **Step 3: Run server tests and verify RED**

Run:

```powershell
node --test test/server-security.test.js
```

Expected: FAIL because the new `DELETE` routes do not exist.

- [ ] **Step 4: Add employee artifact cleanup helper**

Add:

```js
async function removeEmployeeArtifacts({ employeeId, username } = {}) {
  const pushResult = await notificationHub.updateData((data) => {
    const before = data.subscriptions.length;
    data.subscriptions = data.subscriptions.filter((entry) => entry.employeeId !== employeeId);
    return { pushSubscriptionsRemoved: before - data.subscriptions.length };
  });
  const boardResult = await boardStore.updateData((data) => {
    const before = data.acknowledgements.length;
    data.acknowledgements = data.acknowledgements.filter((entry) => (
      entry.employeeId !== employeeId && entry.username !== username
    ));
    return { acknowledgementsRemoved: before - data.acknowledgements.length };
  });
  return { ...pushResult, ...boardResult };
}
```

- [ ] **Step 5: Add the three DELETE routes**

For employee deletion, call `requireHrMutationAccess`, then `previewEmployeeDeletion`, then `removeEmployeeArtifacts`, then `deleteEmployeeAccount`, and merge counts into the response.

For HR and IT admin deletion, use their existing mutation-access checks and call the corresponding security-store delete method with `userAgent` and `clientIp`.

- [ ] **Step 6: Verify GREEN**

Run:

```powershell
node --test test/server-security.test.js
```

Expected: PASS with zero failures.

### Task 3: HR and IT deletion controls

**Files:**
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Test: `test/ui-design-contract.test.js`

**Interfaces:**
- Consumes: the three DELETE routes from Task 2.
- Produces: confirmed employee/admin deletion forms and refresh behavior.

- [ ] **Step 1: Write failing UI contract tests**

Assert the employee row renders `data-delete-employee-form`, the admin row renders `data-delete-admin-form` only for `hr` and `it`, and the source contains:

```js
assert.match(app, /Delete Account/);
assert.match(app, /permanently remove/i);
assert.match(app, /method:\s*"DELETE"/);
assert.match(app, /\/api\/employees\/\$\{encodeURIComponent/);
assert.match(app, /data-delete-admin-form/);
assert.match(css, /\.ghost-button\.danger/);
```

Extract `renderAdminDirectoryRow` and assert its deletion form is conditional on `scopeValue !== "webmaster"` and disabled for `isCurrentUser`.

- [ ] **Step 2: Run UI contract and verify RED**

Run:

```powershell
node --test test/ui-design-contract.test.js
```

Expected: FAIL because deletion controls and styling are absent.

- [ ] **Step 3: Add employee delete form**

In `renderEmployeeDirectoryRow`, add:

```html
<form data-delete-employee-form>
  <input type="hidden" name="employeeId" value="${escapeHtml(employee.id)}">
  <input type="hidden" name="employeeName" value="${escapeHtml(employee.name || employee.username)}">
  <button class="ghost-button danger" type="submit">${icon("delete")} Delete Account</button>
</form>
```

- [ ] **Step 4: Add scoped admin delete form**

In `renderAdminDirectoryRow`, render the form only when `scopeValue !== "webmaster"` and disable it for the current user:

```html
<form data-delete-admin-form data-admin-scope="${escapeHtml(scopeValue)}">
  <input type="hidden" name="adminUserId" value="${escapeHtml(adminUser.id)}">
  <input type="hidden" name="adminName" value="${escapeHtml(adminUser.displayName || adminUser.username)}">
  <button class="ghost-button danger" type="submit"${isCurrentUser ? " disabled" : ""}>
    ${icon("delete")} Delete Account
  </button>
</form>
```

- [ ] **Step 5: Add confirmed submit handlers**

Add `handleDeleteEmployeeSubmit` and `handleDeleteAdminSubmit`. Each must call `window.confirm` with the account name and permanent-cleanup warning, return without a request when cancelled, call the correct DELETE route when confirmed, refresh `refreshAdminData()` or `refreshAdminManagementScope(scope)`, and use the existing message system.

Register both forms in the document submit dispatcher.

- [ ] **Step 6: Add final-cascade danger styling**

Append a final override:

```css
.ghost-button.danger {
  color: var(--tone-danger-text) !important;
  background: var(--tone-danger-bg) !important;
  border-color: var(--tone-danger-line) !important;
}

.ghost-button.danger:hover,
.ghost-button.danger:focus-visible {
  color: var(--danger) !important;
  border-color: var(--danger) !important;
}
```

- [ ] **Step 7: Verify GREEN**

Run:

```powershell
node --check public/app.js
node --test test/ui-design-contract.test.js
```

Expected: both commands exit `0`.

### Task 4: Full verification and responsive QA

**Files:**
- Verify only; change the files above only if verification exposes a task-caused defect.

- [ ] **Step 1: Run syntax checks**

```powershell
node --check security.js
node --check server.js
node --check public/app.js
```

- [ ] **Step 2: Run targeted tests**

```powershell
node --test test/security.test.js
node --test test/server-security.test.js
node --test test/ui-design-contract.test.js
```

- [ ] **Step 3: Run full suite and patch hygiene**

```powershell
npm test
git diff --check
```

- [ ] **Step 4: Run a temporary local server**

Start on an unused test port with temporary `DATA_FILE`, `PUSH_DATA_FILE`, `ANALYTICS_DATA_FILE`, and `SECURITY_DATA_FILE` paths so live production data is untouched.

- [ ] **Step 5: Browser-check the affected directories**

At approximately `390px`, `768px`, `1366px`, and `1440px`, verify:

- HR employee rows show a keyboard-reachable red `Delete Account`.
- HR admin rows show deletion except for the current signed-in HR account.
- IT admin rows show deletion except for the current signed-in IT account.
- System Ops rows do not show deletion.
- Confirm cancellation performs no request.
- Confirmed deletion removes the row, shows success copy, and leaves no horizontal overflow or clipped action text.

- [ ] **Step 6: Review scope**

Run `git status --short` and `git diff --stat`. Confirm only the approved spec/plan and the seven implementation/test files changed, with no runtime JSON data or unrelated files modified.
