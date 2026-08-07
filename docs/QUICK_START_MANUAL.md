# Quick Start: Use the Communications and Alert Center

**Document status:** Verified against the shipped application source on August 6, 2026 (revision `0a523a3`).

This is the short, practical guide. Use the full [User Manual](USER_MANUAL.md) for account recovery, governance, troubleshooting, and detailed role instructions.

## 1. Open The Correct Page

Production links:

| User | Link |
| --- | --- |
| Employee | `https://itotexpress.com/palzivalerts/employee` |
| HR | `https://itotexpress.com/palzivalerts/hr` |
| Systems | `https://itotexpress.com/palzivalerts/webmaster` |
| IT | `https://itotexpress.com/palzivalerts/it` |
| Shared launcher | `https://itotexpress.com/palzivalerts` |

Send employees only the employee link. Keep HR, Systems, and IT onboarding separate.

## 2. Employee: Sign In And Read Updates

1. Open the employee link.
2. Enter the employee username and password.
3. Select `Sign In`.
4. Confirm your name appears near the top of the page.
5. Read the newest active updates below the weather card.
6. Select `Sign Out` at the bottom when using a shared device.

Employees see all-company posts plus posts sent to any messaging group assigned to them. If someone else sees a targeted post that you do not, ask HR to check your group assignment.

There is no `Mark read` button in the current app.

## 3. Employee: Install On A Phone And Get Alerts

### iPhone

1. Open the employee link in Safari and sign in.
2. Tap Share.
3. Tap `Add to Home Screen`, then confirm.
4. Open the installed app from the Home Screen.
5. Sign in again if asked.
6. Select `Sign up for alerts`.
7. Tap `Allow` when iPhone asks about notifications.

For iPhone alerts, finish setup inside the installed Home Screen app, not only in a Safari tab.

### Android

1. Open the employee link in Chrome or Samsung Internet and sign in.
2. Open the browser menu.
3. Choose `Install app`, `Add to Home screen`, or the equivalent option.
4. Open the installed app.
5. Select `Sign up for alerts`.
6. Allow notifications.

If alerts do not arrive, reopen the installed app while signed in. Ask HR or Systems to check whether the device is enrolled and active.

## 4. HR: Publish An Update

1. Open the HR link and sign in.
2. Complete Google Authenticator if prompted.
3. Open `Feed`.
4. Enter the title and message.
5. Choose category, priority, and retention.
6. Keep `All Employees`, or select `Selected groups` and choose at least one active group.
7. Select `Publish update`.
8. Read the delivery result shown after publishing.

Every publication attempts push delivery to eligible subscribed devices in the selected audience. Priority does not turn push delivery on or off.

To remove a live post, find it below the composer and select `Take down`.

## 5. HR: Set Up Groups And Employees

Open `Users`.

### Messaging groups

- Enter a name and select `Create Group`.
- Rename with `Save name`.
- Use `Deactivate` or `Reactivate` to control whether the group can receive new targeted posts.
- In an employee row, select groups and use `Save groups`.

### One employee

1. Expand `Create User`.
2. Enter name, username, and a temporary password of at least 10 characters.
3. Select messaging groups when needed.
4. Select `Create Account`.

### Many employees

1. Expand `Batch Upload`.
2. Paste or upload JSON/YAML.
3. Select `Import Employees`.
4. Copy the generated credentials immediately.
5. Deliver them through an approved secure channel, then clear the results.

The current employee portal does not force a self-service first-login password change. HR remains responsible for secure password resets.

### Existing employee controls

From the employee row, HR can reset a password, enable or disable access, sign out sessions, unenroll devices, update groups, add an active employee to HR, or permanently delete the employee account.

`Delete Account` cannot be undone. Verify the employee name before confirming.

## 6. HR: Settings

Open `Settings` to:

- Refresh the employee weather location
- Set up or verify HR Google Authenticator
- Change the HR password
- Manage named HR admin accounts

## 7. Systems: Daily Check

1. Open the Systems link and sign in.
2. Use `Overview` for route, health, and push status.
3. Use `Traffic` for request failures and timing.
4. Use `System` for runtime and browser diagnostics.
5. Use `Content` to compare saved posts and audiences with intended communications.
6. Use `Codex` only for a sanitized engineering incident brief.
7. Use `Settings` for Systems credentials, System Ops accounts, or an authorized primary HR password reset.

## 8. IT: Governance Check

1. Open the IT link and sign in.
2. Use `Admin Accounts` to review named HR, System Ops, and IT access.
3. Use `Audit Log` to review authentication and account-security events.
4. Use `Emergency Access` to confirm a backup IT account and admin MFA posture.
5. Treat `Company Settings` as informational; its broader business controls are still planned.

Permanent admin deletion and MFA-policy changes are privileged actions. Verify the target and authorization before confirming.

## 9. When The Page Looks Old Or Wrong

- If `New portal update available` appears, select `Reload now`.
- Confirm you opened the correct role link.
- Confirm the signed-in name is correct.
- Sign out and sign back in if the identity is wrong.
- For a black or blank page, first open `https://itotexpress.com/api/health`. It should show `"ok": true` when the server is responding.
- Systems or IT can then use the protected diagnostics route. Employees should send a screenshot and the time of the problem to support.

## 10. Safety Rules

- Never send passwords, recovery keys, MFA setup keys, or invitation links in ordinary chat or email.
- Do not include credentials in screenshots.
- Send temporary passwords separately through the approved secure method.
- Verify the signed-in identity before publishing, resetting, disabling, or deleting an account.

## 11. Full Documentation

- Full role guide: [USER_MANUAL.md](USER_MANUAL.md)
- Complete manual catalog and freshness status: [MANUAL_INDEX.md](MANUAL_INDEX.md)
- Manual generation instructions: [MANUAL_BUILD_GUIDE.md](MANUAL_BUILD_GUIDE.md)
