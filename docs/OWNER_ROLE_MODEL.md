# IT Role Model

## Purpose

Add a true IT governance account tier without turning daily HR or Systems accounts into shared superuser accounts.

The IT role is for governance, recovery, billing, company settings, and audit oversight. HR and Systems remain daily operational roles.

## Role Hierarchy

1. IT
   - Controls company-level settings, billing, all admin accounts, audit exports, and emergency access.
   - Can invite, disable, reset, and assign roles for HR and Systems admins.
   - Can grant or remove IT role only when at least one other active IT account remains.
   - Should not be used as a daily posting or technical-operations account.

2. HR Admin
   - Manages employees, announcements, alerts, acknowledgement tracking, HR settings, and HR-visible security events.
   - Can manage HR admins, but cannot create or assign IT accounts.
   - Cannot disable the last active HR admin.

3. Systems Admin
   - Manages technical operations, uptime views, service settings, Systems admins, and system diagnostics.
   - Can reset HR access only through audited recovery workflows.
   - Cannot create or assign IT accounts.
   - Cannot disable the last active Systems admin.

4. Employee
   - Reads announcements and alerts.
   - Acknowledges important posts.
   - Has no administrative permissions.

## Best-Practice Rules

- Use named accounts only. No shared `master`, `root`, or `superuser` login.
- Enforce authorization server-side on every privileged route.
- Deny by default: a role gets only the permissions explicitly assigned to it.
- Keep IT separate from routine HR and Systems workflows.
- Require at least one active IT admin, one active HR admin, and one active Systems admin once those roles are configured.
- Prevent self-lockout:
  - IT cannot remove their own IT role when they are the last active IT admin.
  - HR admins cannot remove their own HR role when they are the last active HR admin.
  - Systems admins cannot remove their own Systems role when they are the last active Systems admin.
- Revoke active sessions after role removal, account disablement, and password reset.
- Log all role, password, invite, disablement, and emergency-access events.
- Future production hardening should add MFA for IT and admin accounts.

## Permission Matrix

| Capability | IT | HR | Systems | Employee |
| --- | --- | --- | --- | --- |
| Publish announcements | Optional | Yes | No | No |
| Manage employees | Oversight | Yes | No | No |
| View acknowledgement detail | Yes | Yes | No | No |
| Manage HR admins | Yes | Scoped | No | No |
| Manage Systems admins | Yes | No | Scoped | No |
| Assign IT role | Yes | No | No | No |
| Reset HR password | Yes | No | Audited Recovery | No |
| View audit/security events | Yes | HR Events | System Events | No |
| Manage company/billing settings | Yes | No | No | No |
| Manage system diagnostics | Oversight | No | Yes | No |

## Implementation Plan

1. Data model
   - Use `it` as the canonical admin role.
   - Preserve existing `hr` and `webmaster` roles during migration.
   - Add IT access summary to runtime security snapshots.

2. Session and auth
   - Support IT role sessions.
   - Add IT access checks and mutation checks.
   - Add canonical IT login/check/logout/password endpoints.

3. Server enforcement
   - Add IT-only admin governance APIs.
   - Move full cross-role admin management to IT APIs.
   - Keep HR and Systems management scoped to their current responsibilities.

4. UI
   - Add `/palzivalerts/it` as the canonical governance route.
   - Add IT dashboard sections:
     - Admin Accounts
     - Company Settings
     - Audit Log
     - Emergency Access
   - Keep HR and Systems screens focused on daily work.

5. Tests
   - IT can create and manage HR/Systems admins.
   - HR admins cannot create IT accounts.
   - Systems admins cannot create IT accounts.
   - Last active IT admin cannot be disabled or stripped of IT role.
   - Session revocation works after role removal, disablement, and password reset.
   - Existing HR/Systems login behavior remains compatible.

## Rollout

Phase 1 should add the IT role, IT-facing APIs, tests, and a small governance dashboard.

Phase 2 should add MFA, audit export, billing/company settings, and recovery-code management.

## Implementation Status

Completed:
- `it` is now the canonical normalized admin role with dedicated sessions, CSRF, cookie, login throttling, and runtime snapshot status.
- `/api/it/check`, `/api/it/setup`, `/api/it/login`, `/api/it/logout`, and IT admin-management APIs are the only supported governance endpoints.
- HR and Systems admin creation paths reject IT role assignment server-side.
- IT role removal and IT account disablement protect against self-lockout and require at least one active IT admin.
- Automated tests cover IT governance boundaries and the existing full suite passes.

Next:
- Add the `/palzivalerts/it` dashboard UI on top of the governance APIs.
- Add IT profile, invite, password-reset, session-revoke, audit export, and MFA workflows.
