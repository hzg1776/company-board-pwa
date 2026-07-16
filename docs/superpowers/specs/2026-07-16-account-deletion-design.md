# Account Deletion Design

## Goal

Allow HR and IT to permanently remove unwanted managed accounts without leaving sessions, credentials, device registrations, linked access records, or legacy account references behind.

## Authorization Boundaries

- HR can delete employee accounts.
- HR can delete HR-only admin accounts visible in the existing HR admin directory.
- IT can delete any named admin account visible in the existing IT admin directory.
- System Ops does not gain account-deletion authority.
- HR cannot delete IT or System Ops admin accounts.
- A signed-in administrator cannot delete their own current admin account.
- The last active configured IT admin account cannot be deleted.
- The last active configured HR admin account cannot be deleted.

## Employee Deletion

The HR employee directory will add a destructive `Delete Account` action with a browser confirmation that states the deletion is permanent.

Deleting an employee removes:

- The employee record and password credentials.
- Every employee session for the employee ID.
- Every push subscription bound to the employee ID.
- Legacy board acknowledgements that contain the employee ID or username.
- Employee login-guard entries for the username.
- Any HR-only admin identity linked by the same username, including its admin sessions, invite metadata, MFA secret, and HR login guards.
- Direct identifiers in historical security events. Matching events remain as audit evidence, but their `employeeId` is cleared and their `accountKey` is changed to `deleted-account`.

If the linked HR identity is the current signed-in HR administrator, or removing it would delete the last active configured HR administrator, the employee deletion is rejected before external data is changed.

## Admin Deletion

The HR admin directory and IT admin directory will add a destructive `Delete Account` action with a browser confirmation.

Deleting an admin removes:

- The admin user record, password credentials, invite token, MFA secret, and recovery-only metadata stored on that record.
- Every admin session for the admin user ID.
- Login-guard entries for the account username in the deleted admin role.
- Direct identifiers in admin security events. Matching non-employee events remain as audit evidence with `accountKey` changed to `deleted-account`.

Deleting an admin identity does not delete an employee account with the same username. This lets HR or IT remove elevated access without accidentally removing the person's ordinary employee access. Deleting the employee account is the explicit operation that also cascades through linked HR access.

## Data Coordination

`security.js` remains the source of truth for account authorization, self-protection, last-admin protection, account removal, session removal, login-guard cleanup, and security-event anonymization.

`server.js` coordinates employee deletion across stores:

1. Validate the HR actor and deletion guardrails through `security.js`.
2. Remove matching push subscriptions from the notification store.
3. Remove matching legacy acknowledgements from the board store.
4. Permanently remove the employee and any linked HR identity from the security store.

External employee artifacts are removed before the account record so a failed cleanup cannot leave an already-deleted account with reachable orphan records. The security deletion revalidates the target and guardrails immediately before committing.

Admin deletion is contained in the security store because admin-owned data does not exist in the board or notification stores.

## API

- `DELETE /api/employees/:employeeId` — HR-only employee deletion with cascading cleanup.
- `DELETE /api/admin-users/:adminUserId` — HR-only deletion of HR-managed admin identities.
- `DELETE /api/it/admin-users/:adminUserId` — IT-only deletion of any permitted admin identity.

Successful responses return `ok: true` and cleanup counts where applicable. Missing accounts return `404`. Authorization and guardrail failures use the existing error-response path.

## UI and Accessibility

- Reuse the existing table action areas, ghost buttons, delete icon, message banner, and responsive table behavior.
- Destructive buttons use the existing danger visual language rather than introducing a new component system.
- Buttons have explicit visible text and remain keyboard reachable.
- Confirmation copy names the account and explains that credentials, sessions, and associated data will be permanently removed.
- The current signed-in admin's delete action is disabled in the UI, while the backend remains authoritative.
- Success and error results use the existing accessible message system.

## Testing

Tests will be written before implementation and will cover:

- HR employee deletion removes the employee, sessions, push subscriptions, acknowledgements, login guards, linked HR identity, and direct identifiers in security events.
- HR employee deletion is rejected when the linked HR identity is the current actor or last active HR admin.
- HR can delete HR-only admin accounts but cannot delete IT or System Ops accounts.
- IT can delete non-current admin accounts across roles.
- Self-deletion and last-active IT/HR deletion are rejected.
- Admin deletion leaves a same-username employee account intact.
- API routes enforce HR/IT authorization and return the expected status codes.
- The HR and IT UI render deletion controls in the correct directories and do not expose them in System Ops.
- Syntax, targeted tests, the full test suite, patch hygiene, and responsive browser checks pass.

## Out of Scope

- Recoverable soft deletion or a recycle bin.
- Bulk deletion.
- Deleting historical analytics that do not store employee or admin account identifiers.
- Giving IT a new employee-directory management surface.
- Giving System Ops deletion authority.
