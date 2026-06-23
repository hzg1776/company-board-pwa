# Owner Role Model

## Purpose

Add a true business-owner account tier without turning daily HR or Systems accounts into shared superuser accounts.

The Owner role is for governance, recovery, billing, company settings, and audit oversight. HR and Systems remain daily operational roles.

## Role Hierarchy

1. Owner
   - Controls company-level settings, billing, all admin accounts, audit exports, and emergency access.
   - Can invite, disable, reset, and assign roles for HR and Systems admins.
   - Can grant or remove Owner role only when at least one other active Owner remains.
   - Should not be used as a daily posting or technical-operations account.

2. HR Admin
   - Manages employees, announcements, alerts, acknowledgement tracking, HR settings, and HR-visible security events.
   - Can manage HR admins, but cannot create or assign Owner accounts.
   - Cannot disable the last active HR admin.

3. Systems Admin
   - Manages technical operations, uptime views, service settings, Systems admins, and system diagnostics.
   - Can reset HR access only through audited recovery workflows.
   - Cannot create or assign Owner accounts.
   - Cannot disable the last active Systems admin.

4. Employee
   - Reads announcements and alerts.
   - Acknowledges important posts.
   - Has no administrative permissions.

## Best-Practice Rules

- Use named accounts only. No shared `master`, `root`, or `superuser` login.
- Enforce authorization server-side on every privileged route.
- Deny by default: a role gets only the permissions explicitly assigned to it.
- Keep Owner separate from routine HR and Systems workflows.
- Require at least one active Owner, one active HR admin, and one active Systems admin once those roles are configured.
- Prevent self-lockout:
  - Owner cannot remove their own Owner role when they are the last active Owner.
  - HR admins cannot remove their own HR role when they are the last active HR admin.
  - Systems admins cannot remove their own Systems role when they are the last active Systems admin.
- Revoke active sessions after role removal, account disablement, and password reset.
- Log all role, password, invite, disablement, and emergency-access events.
- Future production hardening should add MFA for Owner and admin accounts.

## Permission Matrix

| Capability | Owner | HR | Systems | Employee |
| --- | --- | --- | --- | --- |
| Publish announcements | Optional | Yes | No | No |
| Manage employees | Oversight | Yes | No | No |
| View acknowledgement detail | Yes | Yes | No | No |
| Manage HR admins | Yes | Scoped | No | No |
| Manage Systems admins | Yes | No | Scoped | No |
| Assign Owner role | Yes | No | No | No |
| Reset HR password | Yes | No | Audited Recovery | No |
| View audit/security events | Yes | HR Events | System Events | No |
| Manage company/billing settings | Yes | No | No | No |
| Manage system diagnostics | Oversight | No | Yes | No |

## Implementation Plan

1. Data model
   - Add `owner` to normalized admin roles.
   - Preserve existing `hr` and `webmaster` roles during migration.
   - Add Owner access summary to runtime security snapshots.

2. Session and auth
   - Support Owner role sessions.
   - Add Owner access checks and mutation checks.
   - Add Owner login/check/logout/password endpoints.

3. Server enforcement
   - Add Owner-only admin governance APIs.
   - Move full cross-role admin management to Owner APIs.
   - Keep HR and Systems management scoped to their current responsibilities.

4. UI
   - Add `/palzivalerts/owner`.
   - Add Owner dashboard sections:
     - Admin Accounts
     - Company Settings
     - Audit Log
     - Emergency Access
   - Keep HR and Systems screens focused on daily work.

5. Tests
   - Owner can create and manage HR/Systems admins.
   - HR admins cannot create Owner accounts.
   - Systems admins cannot create Owner accounts.
   - Last active Owner cannot be disabled or stripped of Owner role.
   - Session revocation works after role removal, disablement, and password reset.
   - Existing HR/Systems login behavior remains compatible.

## Rollout

Phase 1 should add the Owner role, APIs, tests, and a small Owner dashboard.

Phase 2 should add MFA, audit export, billing/company settings, and recovery-code management.

## Implementation Status

Completed:
- `owner` is now a normalized admin role with dedicated sessions, CSRF, cookie, login throttling, and runtime snapshot status.
- `/api/owner/check`, `/api/owner/setup`, `/api/owner/login`, `/api/owner/logout`, and Owner admin-management APIs are implemented.
- HR and Systems admin creation paths reject Owner role assignment server-side.
- Owner role removal and Owner account disablement protect against self-lockout and require at least one active Owner.
- Automated tests cover Owner governance boundaries and the existing full suite passes.

Next:
- Add the `/palzivalerts/owner` dashboard UI on top of the new Owner APIs.
- Add Owner profile, invite, password-reset, session-revoke, audit export, and MFA workflows.
