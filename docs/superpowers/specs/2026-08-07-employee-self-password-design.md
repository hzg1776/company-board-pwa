# Employee Self-Service Password Change Design

Date: August 7, 2026
Status: Approved for implementation

## Problem

Employees can sign in with local credentials, but only HR can currently replace an employee password. The employee page has no account settings surface, even though employee records already carry a `passwordResetRequired` status. Employees therefore cannot replace a temporary or known password without asking HR.

Employees who have also been promoted into HR use the same username and synchronized password in two credential records. Any employee self-service path must preserve that invariant without changing protected composite administrator accounts.

## Goals

- Let a signed-in local employee change their own password.
- Require the current password before accepting a replacement.
- Keep the current employee session signed in and revoke the employee's other sessions.
- Clear `passwordResetRequired` after a successful change.
- Keep an HR-managed credential synchronized when the employee also has HR access.
- Revoke linked HR sessions after the shared credential changes.
- Preserve push subscriptions, device enrollment, message groups, acknowledgements, and employee profile data.
- Record concise security events for successful changes and rejected current-password attempts.
- Use the existing Project-A UI and authentication patterns without new dependencies.

## Non-Goals

- No forgot-password, email, SMS, or recovery-code flow.
- No employee username changes.
- No password-history service or third-party identity provider integration.
- No change to account deletion, HR account creation, or notification enrollment.
- No password change for an externally managed SSO identity.

## Approved Employee Experience

The signed-in employee page gains a compact native `<details>` account section immediately above the existing Sign Out action. Its summary is **Change Password** and its form contains:

- Current Password
- New Password
- Confirm New Password
- Save New Password

The new and confirmation values must match in the browser before a request is sent. All password inputs retain visible labels, appropriate autocomplete values, a ten-character minimum, keyboard access, existing focus treatment, and mobile-friendly touch targets.

When `passwordResetRequired` is true, the account section starts open and shows a clear temporary-password notice. The news feed remains visible so an employee is not prevented from reading an urgent announcement while completing the change.

After success, the form clears and the page reports: **Password changed. Other devices were signed out.** If the employee also has HR access, the success message also explains that HR requires a fresh sign-in.

## Authentication And Data Flow

### API contract

Add `POST /api/employee/password` with the JSON body:

```json
{
  "currentPassword": "current value",
  "password": "new value"
}
```

The route must:

1. Require the existing same-origin boundary.
2. Require a valid active employee session from the HttpOnly employee cookie.
3. Pass the request, current password, new password, user agent, and client IP to the security store.
4. Return the refreshed employee access response plus an `hrReauthenticationRequired` boolean, without returning password material.

The endpoint never accepts an employee id from the client. The authenticated session determines the account being changed.

### Security-store operation

Add `changeEmployeePassword(req, options)` beside the existing privileged password-change operations. It must:

1. Resolve the current employee session and employee record.
2. Reject an inactive, expired, revoked, missing, or non-local employee account.
3. Require and verify the current password against the employee's stored scrypt hash.
4. Apply the existing ten-character password rule.
5. Reject a new password that matches the current password.
6. Create a new salt and scrypt hash.
7. Update only the authenticated employee's password fields, `updatedAt`, and `passwordResetRequired` status.
8. Keep the current employee session active and revoke every other active employee session for that employee.
9. Clear employee login guards for the authenticated identity after success.
10. Append an `employee_password_changed` security event.

A rejected current password returns **Current password is incorrect.** and appends an `employee_password_change_failed` event without changing credentials or sessions. Other validation errors use the existing password-policy messages.

The same-origin check, SameSite employee cookie, active session requirement, and current-password reauthentication protect the mutation. No password value is logged, persisted in events, or returned by the API.

## Linked HR Credential Boundary

If a matching administrator record has the same normalized username, includes the HR role, and is an HR-managed account, the operation copies the new salt and hash into that record. All active HR sessions for that linked administrator are revoked because the shared credential changed.

Protected composite administrator records remain untouched, matching the existing employee-password-reset boundary. A shared internal helper must own the linked HR-managed credential update and HR-session revocation for both HR reset and employee self-change so the synchronization rule cannot drift.

## Session And Notification Behavior

- The current employee session remains valid and keeps its current expiration.
- Other employee sessions for the same employee receive `revokedAt` and `updatedAt` timestamps.
- The employee session version is not incremented by self-change because that would invalidate the current session.
- Linked HR sessions are revoked.
- Push subscriptions and device authorization records are not deleted or disabled.
- A later HR-initiated password reset continues to revoke all employee sessions.

## Client State And Error Handling

The employee access response exposes `passwordResetRequired` for the authenticated employee. After a successful change, the client merges the refreshed access response into `state.access.employee`, clears the form, rerenders, and displays the success banner. When `hrReauthenticationRequired` is true, the banner also states that HR requires a fresh sign-in.

The client handles these cases without losing the feed:

- New password and confirmation do not match.
- Current password is incorrect.
- New password is shorter than ten characters.
- New password matches the current password.
- Employee session expired and a fresh sign-in is required.
- The account is externally managed and cannot change a local password.

## Responsive And Accessibility Requirements

- Reuse `.panel-card`, `.settings-collapse`, `.field`, `.button`, and existing employee-shell patterns.
- Place the section within the existing employee content width with no horizontal overflow.
- Verify approximately 390px, 768px, 1366px, and 1440px widths.
- Keep visible field labels and native form semantics.
- Use `autocomplete="current-password"` and `autocomplete="new-password"`.
- Move focus predictably and expose the result through the existing visible message banner.

## Tests And Verification

Security-store tests must prove:

- Correct current password changes the employee password.
- Old password fails and new password succeeds after the change.
- Incorrect current password changes nothing.
- Same-as-current and short passwords are rejected.
- `passwordResetRequired` clears.
- The current employee session remains valid while another employee session is revoked.
- Unrelated employee sessions remain valid.
- A linked HR-managed password is synchronized and its HR sessions are revoked.
- A protected composite administrator credential remains unchanged.
- Push/device data remains unchanged.

Server tests must prove:

- Same-origin and signed-in access are required.
- The endpoint changes only the authenticated employee.
- Invalid input returns the expected error status and message.
- The response and cookie behavior do not expose password data.

UI contract and browser checks must cover the form, temporary-password notice, mismatch handling, success handling, mobile layout, desktop layout, and a clean browser console.

Run:

```powershell
node --check security.js
node --check server.js
node --check public/app.js
node --test test/security.test.js
node --test test/server-security.test.js
node --test test/ui-design-contract.test.js
npm test
git diff --check
```

## Documentation And Release

Update the employee instructions in `docs/USER_MANUAL.md` and the generated HTML/PDF manual artifacts. The release must be merged to `main`, deployed through the existing Windows production process, and verified on the live employee route with the served asset version confirmed.

## Definition Of Done

A signed-in local employee can safely change their own password from the employee page. The current session remains active, other employee sessions are revoked, linked HR credentials stay synchronized, linked HR sessions are revoked, notification enrollment remains intact, the temporary-password status clears, all relevant automated tests pass, responsive browser checks pass, documentation is current, and the merged production release is verified live.
