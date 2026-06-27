# Communications and Alert Center User Manual

## 1. Purpose

Communications and Alert Center is a secure internal communications application with separate entry points for:

- Launcher
- Employee access
- HR operations
- Systems and analytics
- IT governance

This manual explains how each group signs in, what each area is for, and how to use the major features safely.

---

## 2. Portal Map

### 2.1 Main URLs

- Launcher: `https://<your-host>/palzivalerts`
- Employee: `https://<your-host>/palzivalerts/employee`
- HR: `https://<your-host>/palzivalerts/hr`
- Systems: `https://<your-host>/palzivalerts/webmaster`
- IT: `https://<your-host>/palzivalerts/it`

Legacy routes such as `/employee`, `/hr`, `/webmaster`, and `/it` redirect into the `/palzivalerts` path.

### 2.2 Who Uses What

| Entry | Intended user | Main purpose |
|---|---|---|
| Launcher | Internal staff | Choose the correct sign-in area |
| Employee | Employees | Read updates, enable alerts, mark required notices as read |
| HR | HR admins | Publish updates, manage employee accounts, review auth events |
| Systems | System Ops admins | Monitor health, traffic, diagnostics, content state, and admin settings |
| IT | IT admins | Govern privileged admin accounts, audit events, emergency readiness |

### 2.3 Sign-In Rules

- Employee accounts use employee usernames and passwords.
- HR, Systems, and IT use separate named admin accounts.
- HR and Systems use separate sessions and separate cookies.
- IT is a separate privileged role with its own sign-in and oversight screens.
- Admin invitations can require the invited user to create a password before first use.
- Multi-factor authentication may be required for HR, Systems, and IT.

---

## 3. Login Guide For Every Entry Point

### 3.1 Launcher

Use the launcher when internal staff need one shared starting point.

1. Open `/palzivalerts`.
2. Select one of the four buttons:
   - Employee Login
   - HR Login
   - Systems and Analytics Login
   - IT Login
3. Continue on the selected route.

The launcher itself does not grant access. It only routes users to the correct login screen.

### 3.2 Employee Login

1. Open `/palzivalerts/employee`.
2. Enter the employee username.
3. Enter the employee password.
4. Select `Sign In`.

If the employee was created with a temporary password, HR may require a password reset during onboarding or reissue a password manually.

### 3.3 HR Login

1. Open `/palzivalerts/hr`.
2. If HR has not been configured yet, the first administrator must complete first-run setup:
   - Enter the deployment setup secret.
   - Create the first HR username.
   - Create the first HR password.
   - Select `Save Credentials`.
3. If HR already exists, enter the HR username and password.
4. If prompted, complete Google Authenticator verification.

If the password is forgotten, use `Forgot Password?` on the HR sign-in screen and recover with the configured recovery key or recovery system.

### 3.4 Systems Login

1. Open `/palzivalerts/webmaster`.
2. If Systems has not been provisioned yet, HR must sign in first and create or enable Systems access.
3. Enter the Systems username and password.
4. If prompted, complete Google Authenticator verification.

Systems setup is intentionally blocked until HR access already exists.

### 3.5 IT Login

1. Open `/palzivalerts/it`.
2. If IT has not been configured yet, the first IT administrator must complete first-run setup:
   - Enter the deployment setup secret.
   - Create the first IT username.
   - Create the first IT password.
   - Select `Save Credentials`.
3. If IT already exists, enter the IT username and password.
4. If prompted, complete Google Authenticator verification.

The IT sign-in does not use the HR recovery screen. IT access is intended to remain tightly controlled.

### 3.6 Accepting An Admin Invitation

Some admin accounts are provisioned by invitation.

1. Open the invitation link.
2. Confirm the displayed name, username, and role.
3. Create a password.
4. Confirm the password.
5. Select `Accept Invite`.
6. Complete MFA enrollment if the portal requires it.

If the invitation is expired or invalid, the user must request a new invitation from the appropriate admin owner.

### 3.7 Multi-Factor Authentication

When MFA is enabled for an admin role:

1. After password sign-in, select the QR setup action if enrollment is still required.
2. Scan the QR code with Google Authenticator.
3. Enter the 6-digit code.
4. Select `Verify`.

When MFA is already active, the portal will ask only for the current 6-digit code after username and password entry.

---

## 4. Employee Manual

### 4.1 What Employees Can Do

- Sign in to the employee board
- Read current company updates
- Enable push alerts on their device
- Install the app to the home screen when supported
- Mark required notices as read
- Sign out

### 4.2 First-Time Employee Setup

1. Open the employee URL on the device that will receive alerts.
2. Sign in with employee credentials.
3. Review the setup prompts shown on the page.
4. Enable notifications when the browser asks.
5. If using iPhone, add the site to the home screen and reopen the installed web app before finishing push setup.
6. Use the push setup action until the device shows as ready or active.

### 4.3 Reading The Feed

The employee feed shows live updates in reverse chronological order.

Each post can include:

- Title
- Message body
- Category such as News, Weather, Shift, Safety, or HR
- Priority such as Normal, Important, or Urgent
- Audience label
- Read acknowledgement status when required

### 4.4 Marking A Required Notice As Read

Some posts require acknowledgement.

1. Open the notice.
2. Select `Mark read`.
3. Confirm the badge changes to show it was read.

HR can later review who has and has not acknowledged those posts.

### 4.5 Push Alerts

Employees can enable or disable push alerts on the current device.

Important points:

- Push enrollment is tied to the signed-in employee session.
- A device may need a refresh or re-enrollment if permissions changed.
- A disabled employee account should no longer remain an authorized alert target.

### 4.6 Employee Sign Out

Use `Sign Out` at the bottom of the employee screen when leaving a shared device.

---

## 5. HR Manual

### 5.1 What HR Can Do

- Publish new updates
- View update history
- Delete updates
- Review read acknowledgements
- Export acknowledgement CSV files
- Create employee accounts
- Reset employee passwords
- Disable or re-enable employee access
- Revoke employee sessions
- Unenroll employee devices
- Change the HR password
- Review recent authentication events

### 5.2 HR Screen Layout

The HR Control Center has three main tabs:

- `Publish`
- `Users`
- `History`

### 5.3 Publish A New Update

1. Open the `Publish` tab.
2. Enter a title.
3. Enter the message body.
4. Choose:
   - Category
   - Priority
   - Audience
   - Retention period
5. Publish the update.

Use urgent messages carefully. Employees see those notices on the feed, and push-enabled notices can trigger alerts to subscribed devices.

### 5.4 View Published History

Use the `History` tab to review past and active messages.

HR can:

- Filter by status or type
- Review active and urgent items
- Delete an existing post
- Open acknowledgement detail
- Export acknowledgements to CSV

### 5.5 Review Read Acknowledgements

For posts that require acknowledgement:

1. Open the post from `History`.
2. Select `Review`.
3. Inspect:
   - Employees who marked the notice as read
   - Employees still pending
4. Export the CSV when a record is needed.

### 5.6 Create An Employee Account

1. Open the `Users` tab.
2. Expand `Create User`.
3. Enter:
   - Employee name
   - Username
   - Temporary password
4. Leave `Require password reset on first use` enabled unless there is a business reason not to.
5. Select `Create Account`.

### 5.7 Manage Existing Employee Accounts

From the employee accounts table, HR can:

- See whether the account is active or disabled
- See last login timing
- See active session count
- See enrolled and authorized device counts
- Reset a password
- Disable or re-enable access
- Sign out all active sessions
- Unenroll devices

### 5.8 Review Security Events

The HR access area also exposes recent persisted authentication events.

Use this to review:

- Failed sign-ins
- Throttled attempts
- Recent login pressure
- Source IP and event timing

### 5.9 Change The HR Password

Use the HR settings/password controls to rotate the current HR password.

Best practice:

- Change it after staffing changes
- Change it after suspected exposure
- Use a unique password not shared with Systems or IT

### 5.10 Recover HR Access

If the HR password is forgotten:

1. Open the HR sign-in page.
2. Select `Forgot Password?`
3. Enter the recovery key if that recovery path is enabled.
4. Create and confirm a new password.

If recovery is not configured, a server-side recovery method must be enabled first.

---

## 6. Systems Manual

### 6.1 What Systems Can Do

- View systems overview metrics
- Inspect route and health snapshots
- Review push subscription roster
- Review traffic totals and recent failing routes
- Inspect host runtime and browser diagnostics
- Review content inventory and recent posts
- Copy a prepared Codex incident brief
- Change the Systems password
- Configure Systems MFA
- Manage System Ops admin accounts
- Reset the HR password from the Systems settings area

### 6.2 Systems Screen Layout

The Systems Command Center has these sections:

- `Overview`
- `Traffic`
- `System`
- `Content`
- `Codex`
- `Settings`

### 6.3 Overview

Use `Overview` for the fastest operational snapshot.

It includes:

- Launcher, HR, and employee route references
- Latest published update
- Push enrollment counts
- Runtime probe timings
- Device delivery roster
- Diagnostics and route status links

### 6.4 Traffic

Use `Traffic` to inspect live request behavior.

It shows:

- Total requests
- API calls
- Page views
- Status code mix
- Route mix
- Recent requests
- Recent failing routes
- Average response timing

This is the first place to look when users report loading failures or inconsistent route behavior.

### 6.5 System Diagnostics

Use `System` to inspect:

- Node version
- Platform and uptime
- Memory use
- Data file locations
- Browser secure-context state
- Service worker state
- Push support
- Connection details
- Probe timings
- Browser load performance

### 6.6 Content

Use `Content` to verify what employees are actually seeing.

It includes:

- Total and active post counts
- Urgent and important post counts
- Notification-enabled post counts
- Expiring-soon counts
- Type, priority, and audience breakdowns
- Recent posts in feed order

### 6.7 Codex Incident Brief

Use `Codex` when handing a live issue to an engineer or support workflow.

It provides:

- A copyable incident brief
- A raw JSON snapshot of the current Systems summary

### 6.8 Systems Settings

The `Settings` section includes:

- Systems password change
- Systems MFA setup or verification
- System Ops admin account management
- HR password reset

### 6.9 Manage System Ops Admin Accounts

From Systems settings, authorized users can:

- Create a named System Ops account
- Edit display names
- Enable or disable access
- Reset passwords
- Revoke live sessions

System Ops accounts stay single-purpose inside the Systems area.

### 6.10 Reset HR Password From Systems

If the organization needs operational recovery and the current user is authorized:

1. Open `Settings`.
2. Find the HR recovery panel.
3. Enter a new HR password.
4. Confirm it.
5. Submit the reset.

This is a privileged recovery action and should be tightly controlled.

---

## 7. IT Manual

### 7.1 What IT Can Do

- View all named admin accounts
- Create privileged admin accounts
- Assign exactly one privileged role per account
- Review audit and recent auth events
- Check emergency readiness
- Review MFA readiness for IT
- Use future business-control features as they are enabled

### 7.2 IT Screen Layout

The IT Control Center has these sections:

- `Admin Accounts`
- `Company Settings`
- `Audit Log`
- `Emergency Access`

### 7.3 Admin Accounts

The `Admin Accounts` area is the main governance surface.

IT can:

- Create HR, Systems, or IT admin accounts
- Assign one privileged role to each named account
- Edit display names
- Disable or re-enable access
- Reset passwords
- Revoke live sessions

This is the only area where role assignment across privileged admin types is centrally governed.

### 7.4 Company Settings

The `Company Settings` area is present as a planned control surface.

It currently indicates future scope such as:

- Billing configuration
- Retention controls
- Broader company-level business controls

Treat this area as informational unless additional product work enables those controls.

### 7.5 Audit Log

IT can review the same recent persisted authentication event stream used for admin security visibility.

Use it to inspect:

- Failed admin or employee logins
- Throttling and backoff events
- Source IPs
- Recent access pressure

### 7.6 Emergency Access

This section helps IT verify governance resilience.

It highlights:

- Number of active IT accounts
- Whether a backup IT administrator exists
- Current MFA posture for IT

Best practice:

- Keep at least two active IT accounts
- Ensure MFA is enabled and tested
- Avoid depending on one person for privileged recovery

---

## 8. First-Run Setup Order

For a brand-new deployment, use this order:

1. Start the application with the required environment variables.
2. Open `/palzivalerts/hr`.
3. Use the deployment setup secret to create the first HR account.
4. Sign in to HR.
5. Create employee accounts.
6. Provision Systems access.
7. Open `/palzivalerts/webmaster` and verify Systems login works.
8. Open `/palzivalerts/it`.
9. Use the deployment setup secret to create the first IT account if IT is required for operations.
10. Configure MFA for privileged roles.
11. Test employee sign-in and push enrollment on a real device.

---

## 9. Daily Operating Checklists

### 9.1 Employee Support Checklist

- Confirm the employee is on the `/palzivalerts/employee` route.
- Confirm the account is active.
- Confirm the password is current.
- Confirm the browser allows notifications if alerts are expected.
- Confirm the device is enrolled and active if push delivery is required.

### 9.2 HR Daily Checklist

- Verify HR login works.
- Review active and urgent posts.
- Publish new operational messages as needed.
- Review acknowledgements for required notices.
- Disable old employee accounts promptly.

### 9.3 Systems Daily Checklist

- Review traffic errors and request spikes.
- Review route health and runtime probes.
- Confirm push device counts look normal.
- Confirm recent content matches intended communications.

### 9.4 IT Weekly Checklist

- Review all privileged admin accounts.
- Confirm disabled accounts remain disabled.
- Confirm backup IT access exists.
- Review audit events for suspicious sign-in behavior.
- Rotate passwords or recovery procedures if staff changed.

---

## 10. Troubleshooting

### 10.1 Employee Cannot Sign In

- Verify the username is correct.
- Verify the password was entered exactly.
- Confirm the employee account is active.
- If needed, HR should reset the employee password.

### 10.2 Admin Cannot Sign In

- Confirm the user is on the correct role route.
- Confirm the account belongs to that role.
- Check whether MFA verification is required.
- Review recent auth events for throttling or repeated failures.

### 10.3 Systems Setup Is Blocked

- HR must already exist.
- HR may need to provision Systems access first.
- Verify you are opening `/palzivalerts/webmaster`.

### 10.4 Invitation Link Does Not Work

- Confirm the invite has not expired.
- Confirm the user opened the original invite URL.
- Reissue the invite if the token is no longer valid.

### 10.5 Push Alerts Do Not Arrive

- Confirm the employee signed in on that device.
- Confirm notification permission is granted.
- Confirm the browser supports service workers and push.
- On iPhone, confirm the app was added to the home screen and reopened from the installed icon.
- Ask the employee to refresh or re-enroll push setup.
- Review the Systems delivery roster for stale or inactive devices.

### 10.6 HR Recovery Fails

- Confirm the recovery path is configured on the server.
- Confirm the recovery key is correct.
- If unavailable, use the Systems HR reset workflow if authorized.

### 10.7 Portal Loads But Data Looks Wrong

- Review the Systems overview and traffic screens.
- Confirm the correct route was opened.
- Check whether the browser is running stale cached assets.
- Refresh and re-test before escalating.

---

## 11. Security Rules

- Use named accounts only.
- Do not share privileged credentials.
- Keep HR, Systems, and IT passwords distinct.
- Enable MFA for privileged roles whenever available.
- Remove access immediately when a person changes roles or leaves.
- Do not capture credentials in screenshots, email, or chat.
- Sign out on shared devices.

---

## 12. Testing The Manual

After updating this manual, verify these paths in the live app:

1. Launcher route loads.
2. Employee sign-in works.
3. HR sign-in works.
4. Systems sign-in works.
5. IT sign-in works.
6. HR can publish a post.
7. An employee can mark a required post as read.
8. Systems can see the traffic and content summary.
9. IT can review admin accounts.

---

## 13. Document Stewardship

- Update this manual whenever login rules, role boundaries, or major features change.
- Regenerate the PDF artifact after every source-doc change.
- Store the PDF with onboarding and operations materials.
