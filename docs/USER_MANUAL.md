# Communications and Alert Center User Manual

**Document status:** Verified against the release-candidate application source on August 7, 2026 (revision `3ef50a1`).

## 1. Purpose

The Communications and Alert Center provides five role-specific entry points:

- A shared launcher
- An employee updates feed
- An HR publishing and user-management console
- A Systems monitoring and recovery console
- An IT governance console

This manual explains the current visible workflows. It does not document planned controls as if they are already available.

## 2. Portal Map

### 2.1 Main URLs

Replace `<your-host>` with the deployed hostname.

| Area | URL | Primary user |
| --- | --- | --- |
| Launcher | `https://<your-host>/palzivalerts` | Internal staff |
| Employee | `https://<your-host>/palzivalerts/employee` | Employees |
| HR | `https://<your-host>/palzivalerts/hr` | HR admins |
| Systems | `https://<your-host>/palzivalerts/webmaster` | System Ops admins |
| IT | `https://<your-host>/palzivalerts/it` | IT admins |

Legacy routes such as `/employee`, `/hr`, `/webmaster`, and `/it` redirect to the matching `/palzivalerts` route.

### 2.2 What Each Area Does

| Area | Current purpose |
| --- | --- |
| Launcher | Opens the four role-specific sign-in routes |
| Employee | Shows weather and the signed-in employee's current updates; supports alert enrollment |
| HR | Publishes updates, targets messaging groups, and manages employee and HR accounts |
| Systems | Monitors health, traffic, content, diagnostics, and push-delivery state |
| IT | Governs privileged accounts, audit visibility, MFA policy, and emergency readiness |

### 2.3 Account Boundaries

- Employees use employee usernames and passwords.
- HR, Systems, and IT use named privileged accounts with role-scoped access.
- Use the route for the account's assigned role.
- MFA may be required after an admin password is accepted.
- Do not share privileged credentials or reuse one person's account for another person.

## 3. Sign-In And Access

### 3.1 Employee Sign-In

1. Open `/palzivalerts/employee`.
2. Enter the employee username.
3. Enter the employee password.
4. Select `Sign In`.

### 3.2 Employee Password Change

1. Sign in to `/palzivalerts/employee` with the current username and password.
2. Scroll below the updates feed and open `Change Password`.
3. Enter the current password.
4. Enter the new password twice. It must contain at least 10 characters and must differ from the current password.
5. Select `Save New Password`.

The current device remains signed in and the employee's other sessions are signed out. Notification enrollment remains attached to its existing devices. Employees who also have HR access must sign in to HR again with the new password.

### 3.3 Admin Sign-In

1. Open the HR, Systems, or IT route.
2. Enter the named admin username and password.
3. Select `Sign In`.
4. If prompted, complete Google Authenticator setup or enter the current 6-digit code.

The header shows the signed-in admin identity. Confirm it before changing accounts, publishing, or performing recovery work.

### 3.4 First-Run Admin Setup

For a new deployment:

1. Start the application with the required runtime configuration.
2. Open `/palzivalerts/hr`.
3. Enter the deployment setup secret and create the first HR username and password.
4. Sign in to HR and create the required employee and HR accounts.
5. Provision Systems access, then verify `/palzivalerts/webmaster`.
6. Open `/palzivalerts/it` and use the deployment setup secret to create the first IT account.
7. Configure and test MFA for privileged accounts.
8. Test employee sign-in and alert enrollment on a real device.

Systems first-run setup remains blocked until HR is authorized.

### 3.5 Admin Invitation Links

If an authorized operator provides an admin invitation URL:

1. Open the original URL before it expires.
2. Confirm the displayed name, username, and role.
3. Create and confirm a password.
4. Select `Accept Invite`.
5. Complete MFA if prompted.

If the link is invalid or expired, request a new authorized setup path. Do not forward invitation URLs.

### 3.6 Multi-Factor Authentication

When MFA setup is required:

1. Select the Google Authenticator setup action.
2. Scan the QR code or enter the manual key in the authenticator app.
3. Enter the current 6-digit code.
4. Select `Verify Authenticator`.

When MFA is already enrolled, enter the current 6-digit code after password sign-in. IT can control the application-level admin MFA requirement when the server configuration allows it.

### 3.7 New Portal Update Banner

If the page shows `New portal update available`, select `Reload now`. The reload clears stale service-worker assets and opens the current portal build.

## 4. Employee Guide

### 4.1 What Employees Can Do

- Sign in to the employee feed
- See the signed-in employee name
- See current weather and its refresh age
- Read active company updates assigned to them
- Change their own local account password while signed in
- Sign up the current device for alerts when supported
- Install the portal on a phone home screen
- Sign out

There is currently no employee `Mark read` or acknowledgement workflow.

### 4.2 Reading The Feed

The feed lists active updates newest first. An item can show:

- Category
- Important or Urgent priority
- Published date or time
- Title
- Message

Expired or removed posts do not remain in the active employee feed.

### 4.3 Messaging Groups

HR may publish to `All Employees` or to one or more messaging groups.

- Employees see all-employee posts.
- Employees also see a targeted post when they belong to at least one selected group.
- Group membership is managed by HR; employees do not change it themselves.
- The employee feed does not expose internal group-management controls.

If a coworker sees a targeted post that you do not see, ask HR to verify your group assignment.

### 4.4 Sign Up For Alerts

On a supported device:

1. Open the employee route and sign in.
2. Select `Sign up for alerts` when the setup panel appears.
3. Allow notifications when the browser or installed app asks.
4. Keep the employee signed in while enrollment completes.

For iPhone:

1. Open the employee page in Safari.
2. Use Share, then `Add to Home Screen`.
3. Open the installed app from the Home Screen.
4. Sign in again if prompted.
5. Select `Sign up for alerts` and allow notifications.

If the setup panel offers `Unenroll`, it removes the current device. If that control is not visible after setup is complete, remove the site's notification permission or ask HR or Systems to unenroll the device.

### 4.5 Change Your Password

1. Scroll below the updates feed.
2. Open `Change Password`.
3. Enter the current password.
4. Enter a different new password of at least 10 characters.
5. Enter the new password again under `Confirm New Password`.
6. Select `Save New Password`.

When `Require password reset on first use` is selected, the employee's `Change Password` section opens automatically after sign-in. The news feed remains visible.

After a successful change, the current device stays signed in and the employee's other signed-in sessions end. Existing notification enrollment stays attached to its devices. An employee who also has HR access must sign in to HR again with the new password.

If the employee does not know the current password or cannot sign in, HR must reset it from `Employee Accounts` and deliver the replacement through an approved secure channel.

### 4.6 Sign Out

Select `Sign Out` at the bottom of the employee screen. Always sign out on a shared device.

## 5. HR Guide

### 5.1 HR Screen Layout

The HR Control Center has three tabs:

- `Feed`
- `Users`
- `Settings`

The header also shows the current signed-in admin and links to the launcher and employee feed.

### 5.2 Publish An Update

1. Open `Feed`.
2. Enter the title and message.
3. Choose the category and priority.
4. Under `Audience`, keep `All Employees` or choose `Selected groups` and select at least one active messaging group.
5. Choose a retention period: 24 hours, 7 days, 30 days, or manual removal.
6. Select `Publish update`.

Every newly published update is added to the selected audience's feed and attempts push delivery to eligible subscribed devices. Priority changes presentation; it does not turn push delivery on or off.

After publishing, check the result banner. It reports eligible and delivered device counts or explains why no device was eligible.

### 5.3 Manage Live Updates

The lower portion of `Feed` shows current live employee updates.

- Use the Active or Urgent summary cards to focus the list.
- Review the title, message, audience, and expiration.
- Select `Take down` to remove an announcement from the live feed.

The current UI does not provide a separate `History` tab, acknowledgement review, or acknowledgement CSV export.

### 5.4 Create And Maintain Messaging Groups

1. Open `Users`.
2. In `Messaging Groups`, enter a group name and select `Create Group`.
3. Use `Save name` to rename a group.
4. Use `Deactivate` when the group should no longer receive newly targeted posts.
5. Use `Reactivate` to make it available again.

Deactivation preserves the group's identity and existing employee membership records. Only active groups can be selected for new assignments or new targeted posts.

### 5.5 Assign Employees To Groups

1. Open `Users`.
2. Find the employee in `Employee Accounts`.
3. Select the applicable entries under `Messaging Groups`.
4. Select `Save groups`.

An employee can belong to more than one group.

### 5.6 Create One Employee Account

1. Open `Users`.
2. Expand `Create User`.
3. Enter the employee name, username, and a temporary password of at least 10 characters.
4. Select any active messaging groups.
5. Select `Create Account`.

When `Require password reset on first use` is selected, the employee's `Change Password` section opens automatically after sign-in. The news feed remains visible. The employee must know the temporary password to replace it. If the employee cannot sign in or does not know the current password, HR must reset it from `Employee Accounts` and deliver the replacement through an approved secure channel.

### 5.7 Batch Import Employees

Use batch upload for JSON or YAML rosters of up to 500 employees.

1. Open `Users`, then expand `Batch Upload`.
2. Choose `Auto`, `JSON`, or `YAML`.
3. Paste the roster or choose a `.json`, `.yaml`, or `.yml` file.
4. Select `Import Employees`.
5. Copy the generated credentials immediately.
6. Deliver credentials through an approved secure channel, then clear the result from the screen.

Example JSON:

```json
{
  "employees": [
    { "name": "Alex Smith", "email": "alex.smith@example.com", "passwordResetRequired": true }
  ]
}
```

The app can derive a username from the email and generates a temporary password when one is not supplied. Do not store temporary passwords in the roster file or ordinary email/chat.

### 5.8 Manage Employee Accounts

The employee table shows identity, password status, access state, sessions, enrolled devices, and messaging groups. Authorized HR users can:

- Reset the password
- Disable or enable access
- Sign out active sessions
- Unenroll devices
- Change messaging-group membership
- Add an active employee identity to HR
- Permanently delete an employee account

`Delete Account` is irreversible. The confirmation warns that credentials, sessions, and associated data will be removed. Verify the name and business authorization before confirming. The current linked HR identity and other protected accounts cannot be deleted through unsafe paths.

### 5.9 HR Settings

`Settings` contains:

- Weather location and refresh
- HR Google Authenticator setup/status
- HR password change
- Named HR admin account management

Changing a privileged password signs out other active sessions for that account.

### 5.10 HR Recovery

`Forgot Password?` on the HR sign-in route uses the configured recovery key to establish the dedicated emergency HR recovery identity. It is not a general reset for any named HR user.

To reset the configured primary HR account, an authorized Systems operator can use `Settings` > `Reset the HR password`. That action revokes the affected HR sessions.

## 6. Systems Guide

### 6.1 Systems Screen Layout

The Systems Command Center has six tabs:

- `Overview`
- `Traffic`
- `System`
- `Content`
- `Codex`
- `Settings`

### 6.2 Overview

Use `Overview` for the fastest operational snapshot. It includes route references, the latest update, push enrollment counts, runtime probe timings, the delivery roster, and diagnostics links.

Use `Send Test Push` only when the intended test devices and audience are understood.

### 6.3 Traffic

Use `Traffic` to review:

- Total requests, API calls, and page views
- Status-code and route mix
- Recent requests and failures
- Average response timing

### 6.4 System

Use `System` to review host/runtime information, memory and uptime, runtime data locations, browser and service-worker state, push support, connection details, and probe timing.

### 6.5 Content

Use `Content` to compare the saved content inventory with what employees should see. It includes active/urgent counts, notification-enabled counts, expiration state, audience breakdowns, and recent posts.

### 6.6 Codex Incident Brief

Use `Codex` to copy a prepared incident brief or raw JSON snapshot for an authorized engineering/support workflow. Review the copied text before sharing and remove sensitive operational details that are not required.

### 6.7 Systems Settings And HR Reset

`Settings` contains:

- Systems password change
- Systems MFA setup/status
- System Ops admin account management
- Authorized primary HR password reset

System Ops account management supports named accounts, identity edits, access enable/disable, password reset, and session revocation. System Ops accounts remain single-purpose in this console.

## 7. IT Guide

### 7.1 IT Screen Layout

The IT Control Center has four tabs:

- `Admin Accounts`
- `Company Settings`
- `Audit Log`
- `Emergency Access`

### 7.2 Admin Accounts

IT can manage named HR, System Ops, and IT accounts. Authorized actions include:

- Create an account with exactly one privileged role
- Edit the display name
- Change the assigned role where allowed
- Disable or enable access
- Reset a password
- Sign out active sessions
- Permanently delete another admin account where allowed

The current signed-in account and the last required privileged account are protected from unsafe self-lockout actions. Treat `Delete Account` as irreversible and verify the target before confirming.

### 7.3 Company Settings

`Company Settings` is currently a planned control surface. Billing, retention, and broader business controls shown there are informational until separately implemented.

### 7.4 Audit Log

Use `Audit Log` to review persisted authentication and account-security activity, including failed sign-ins, throttling, account changes, source information, and event timing.

### 7.5 Emergency Access And Admin MFA Policy

`Emergency Access` shows:

- Active IT account count
- Whether a backup IT administrator exists
- IT MFA readiness
- The effective admin MFA requirement
- Whether a server override prevents in-app MFA enforcement

When the control is available, IT can require or disable MFA for admin accounts and record a reason. Disabling privileged MFA should be limited to a documented emergency window and reversed immediately afterward.

Keep at least two active IT accounts and test both before an emergency occurs.

## 8. Operating Checklists

### 8.1 Employee Support

- Confirm the employee is using `/palzivalerts/employee`.
- Confirm the account is active and the username is correct.
- If the employee is already signed in, have them open `Change Password` and replace the temporary or known password.
- If the employee cannot sign in or does not know the current password, have HR reset it from `Employee Accounts` and deliver the replacement through an approved secure channel.
- Confirm the employee belongs to the required messaging groups.
- Confirm browser notification permission and device enrollment when alerts are expected.
- On iPhone, confirm the portal was opened from its Home Screen icon.

### 8.2 HR Daily Check

- Confirm the signed-in identity.
- Review active and urgent updates.
- Verify audience selection before publishing.
- Check publish-delivery results.
- Disable departed employee accounts promptly.
- Review group assignments when targeted messages are reported missing.

### 8.3 Systems Daily Check

- Review route health, errors, and runtime probes.
- Review push-device counts and stale delivery states.
- Compare recent content with intended communications.
- Escalate repeated failures with a sanitized incident brief.

### 8.4 IT Weekly Check

- Review all privileged accounts and roles.
- Confirm disabled accounts remain disabled.
- Confirm backup IT access and MFA.
- Review audit events for suspicious activity.
- Rotate credentials or recovery procedures after staffing or incident changes.

## 9. Troubleshooting

### 9.1 Employee Cannot Sign In

- Verify the direct employee URL, username, and password.
- Confirm the employee account is active.
- If the employee is already signed in, have them open `Change Password` and replace the temporary or known password.
- If the employee cannot sign in or does not know the current password, ask HR to reset it from `Employee Accounts` and deliver the replacement through an approved secure channel.

### 9.2 Admin Cannot Sign In

- Confirm the correct role route and assigned role.
- Complete the MFA step if requested.
- Check for throttling after repeated failures.
- Use only the approved recovery path for that role.

### 9.3 Employee Cannot See A Targeted Update

- Confirm the update is still live.
- Confirm HR selected the intended group.
- Confirm the employee belongs to at least one selected group.
- Reload if a `New portal update available` banner appears.

### 9.4 Push Alerts Do Not Arrive

- Confirm the employee signed in on that device.
- Confirm notification permission is granted.
- On iPhone, open the installed Home Screen app.
- Reopen the employee portal and use the setup action if it reappears.
- Ask HR or Systems to inspect and, if needed, unenroll the stale device.

### 9.5 Page Looks Stale Or Incorrect

- Select `Reload now` when the portal-update banner appears.
- Confirm the correct role route.
- Sign out and sign back in when identity appears wrong.
- Use Systems health/diagnostics only with authorized Systems or IT access.

## 10. Security Rules

- Use named accounts and least-privilege roles.
- Keep HR, Systems, and IT credentials distinct.
- Enable MFA for privileged roles except during a documented emergency.
- Never place passwords, setup secrets, recovery keys, invite links, MFA keys, or browser storage-state files in documentation or screenshots.
- Deliver temporary passwords through an approved secure channel.
- Verify names before permanent account deletion.
- Sign out on shared devices.

## 11. Manual Verification And Stewardship

After changing application behavior or this source file:

1. Verify the launcher and four role routes.
2. Confirm Employee, HR, Systems, and IT labels match the current UI.
3. Confirm HR can publish to all employees and selected groups.
4. Confirm an employee sees only eligible active posts.
5. Confirm batch import, account-management, and MFA instructions match the current controls.
6. Regenerate the HTML, PDF, and route screenshots.
7. Inspect every PDF page before distribution.

Use `docs/MANUAL_INDEX.md` for the complete documentation catalog and freshness status.
