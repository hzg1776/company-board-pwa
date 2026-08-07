# Test Group Rollout Guide

**Document status:** Targeted-delivery workflow verified August 6, 2026.

## Purpose

Use this guide to roll the Communications and Alert Center out to a controlled test group of employees and HR users.

## Important Delivery Rule

The current `Audience` control is a real visibility and delivery filter.

- `All Employees` makes the post visible to every active employee and attempts push delivery to every eligible subscribed employee device.
- `Selected groups` limits feed visibility and eligible push delivery to employees who belong to at least one selected messaging group.

For a controlled test, create a dedicated active messaging group, assign only the pilot employees, and publish the test message to that group. Recheck the audience immediately before selecting `Publish update`.

## Links To Use

- Employee app: `https://itotexpress.com/palzivalerts/employee`
- HR console: `https://itotexpress.com/palzivalerts/hr`
- Systems console for push/device checks: `https://itotexpress.com/palzivalerts/webmaster`
- Launcher for internal staff only: `https://itotexpress.com/palzivalerts`

Do not send HR, Systems, IT, or launcher links in employee-facing messages. Employees should receive only the employee app link.

## Before The Test

1. Confirm the public app loads at `https://itotexpress.com/palzivalerts/employee`.
2. Confirm HR can sign in at `https://itotexpress.com/palzivalerts/hr`.
3. Confirm Systems can sign in at `https://itotexpress.com/palzivalerts/webmaster`.
4. Create a fresh runtime backup before inviting employees.
5. Choose the test roster and keep it small.
6. In HR `Users`, create a dedicated group such as `Pilot Test`.
7. Assign only the intended pilot employees to that group.

Recommended first test group:

- 1 HR publisher
- 2 to 5 employee users
- At least one iPhone
- At least one Android phone

## Current Test Group

This roster contains employee contact information and should be treated as internal rollout material.

| Name | Email | Suggested username | HR setup status | Phone setup status |
| --- | --- | --- | --- | --- |
| Liza Gfeller | lgfeller@palzivna.com | `lgfeller` | Not created | Not enrolled |
| Herman Goldstein | hgoldstein@palzivna.com | `hgoldstein` | Not created | Not enrolled |
| Christy Jenkins | cjenkins@palzivna.com | `cjenkins` | Not created | Not enrolled |
| Jimmy Mardlin | jmardlin@palzivna.com | `jmardlin` | Not created | Not enrolled |
| Marco Sifuentes | msifuentes@palzivna.com | `msifuentes` | Not created | Not enrolled |
| David Wilkerson | dwilkerson@palzivna.com | `dwilkerson` | Not created | Not enrolled |

## Batch Upload Payloads For This Group

In HR, open `Users`, then open `Batch Upload`. Paste one of these payloads or upload a `.json`, `.yaml`, or `.yml` file. The app generates temporary passwords and shows them once after import.

JSON:

```json
{
  "employees": [
    { "name": "Liza Gfeller", "email": "lgfeller@palzivna.com", "passwordResetRequired": true },
    { "name": "Herman Goldstein", "email": "hgoldstein@palzivna.com", "passwordResetRequired": true },
    { "name": "Christy Jenkins", "email": "cjenkins@palzivna.com", "passwordResetRequired": true },
    { "name": "Jimmy Mardlin", "email": "jmardlin@palzivna.com", "passwordResetRequired": true },
    { "name": "Marco Sifuentes", "email": "msifuentes@palzivna.com", "passwordResetRequired": true },
    { "name": "David Wilkerson", "email": "dwilkerson@palzivna.com", "passwordResetRequired": true }
  ]
}
```

YAML:

```yaml
employees:
  - name: Liza Gfeller
    email: lgfeller@palzivna.com
    passwordResetRequired: true
  - name: Herman Goldstein
    email: hgoldstein@palzivna.com
    passwordResetRequired: true
  - name: Christy Jenkins
    email: cjenkins@palzivna.com
    passwordResetRequired: true
  - name: Jimmy Mardlin
    email: jmardlin@palzivna.com
    passwordResetRequired: true
  - name: Marco Sifuentes
    email: msifuentes@palzivna.com
    passwordResetRequired: true
  - name: David Wilkerson
    email: dwilkerson@palzivna.com
    passwordResetRequired: true
```

Do not store temporary passwords in this file. HR should create passwords inside the app and store them only in the approved password vault or deliver them through the approved internal credential handoff process.

## Set Up HR Test Users

1. Open `https://itotexpress.com/palzivalerts/hr`.
2. Sign in with an existing HR admin account.
3. Open the HR settings/admin account area.
4. Create the HR test user with:
   - display name
   - username
   - temporary password
   - HR role
5. Give the HR tester the HR console link only through a secure internal channel.
6. Have the HR tester sign in and confirm the HR Control Center opens.

If HR account management is being handled by IT instead, open `https://itotexpress.com/palzivalerts/it` and create the HR-role admin account from the IT admin accounts area.

## Set Up Employee Test Accounts

1. Open `https://itotexpress.com/palzivalerts/hr`.
2. Sign in as HR.
3. Open `Users`.
4. For the current roster, open `Batch Upload`, paste the JSON or YAML payload above, and click `Import Employees`.
5. Copy the generated temporary credentials immediately after import.
6. For one-off users, open `Create User` and create the account with:
   - name
   - username
   - temporary password
   - `Require password reset on first use` enabled when appropriate
7. Give each employee only:
   - employee URL
   - their username
   - their temporary password

Employee URL:

```text
https://itotexpress.com/palzivalerts/employee
```

## Employee Pilot Invite

Send this only after HR has created each employee account.

```text
Subject: Communications and Alert Center pilot access

You are in the first test group for the Communications and Alert Center.

Open this link on your phone:
https://itotexpress.com/palzivalerts/employee

Sign in with the username and temporary password provided separately.

After you sign in:
1. Add the app to your Home Screen.
2. Reopen it from the Home Screen.
3. Tap Sign up for alerts.
4. Allow notifications when your phone asks.

Please confirm back when you can see the employee feed and your phone shows the device as active or ready.
```

Send each username and temporary password separately from the invite message.

## HR Publisher Pilot Message

Send this to the HR user who will publish the first test notice.

```text
Open the HR console:
https://itotexpress.com/palzivalerts/hr

Use Feed -> Publish update.

First pilot post:
Title: Pilot test notice
Message: This is a test notice for the Communications and Alert Center pilot. No action is required.
Category: News
Priority: Normal
Audience: Selected groups - Pilot Test
Retention: 24 Hours

After publishing, confirm the success message and verify the notice appears under Live employee updates.
```

## Set Up An Employee Phone

Use the employee phone that should receive alerts. Push enrollment is tied to the signed-in employee session and the current device.

### iPhone

1. Open Safari.
2. Go to `https://itotexpress.com/palzivalerts/employee`.
3. Sign in with the employee username and password.
4. Tap the Safari share button.
5. Tap `Add to Home Screen`.
6. Open the installed app from the Home Screen.
7. Sign in again if prompted.
8. Tap `Sign up for alerts`.
9. Allow notifications when iOS asks.
10. Ask Systems to confirm the device is enrolled and active.

If notifications were blocked, re-enable notifications for the installed app in iOS Settings, reopen the app, and use `Sign up for alerts` again if the setup control appears.

### Android

1. Open Chrome.
2. Go to `https://itotexpress.com/palzivalerts/employee`.
3. Sign in with the employee username and password.
4. Use the Chrome menu to install the app or add it to the Home Screen.
5. Open the installed app from the Home Screen.
6. Sign in again if prompted.
7. Tap `Sign up for alerts`.
8. Allow notifications when Android asks.
9. Ask Systems to confirm the device is enrolled and active.

If push registration fails on Android, confirm the employee is using Chrome and that Google Play Services is enabled.

## Verify Devices Before Publishing

1. Open `https://itotexpress.com/palzivalerts/webmaster`.
2. Sign in as Systems.
3. Open the overview/enrollment area.
4. Confirm subscribed and active device counts match the test group.
5. Use `Send Test Push`.
6. Confirm each test phone receives the push.

Do not use HR publishing as the first push test if non-test employees already have active devices.

## Use The HR Publishing Portion

1. Open `https://itotexpress.com/palzivalerts/hr`.
2. Sign in as HR.
3. Open `Feed`.
4. In `Publish update`, fill out:
   - `Title`
   - `Message`
   - `Category`
   - `Priority`
   - `Audience`
   - `Retention`
5. For a pilot-only message, select `Selected groups` and choose the dedicated pilot group.
6. Click `Publish update`.
7. Watch the success message:
   - `Published and notified X/Y eligible subscribed devices` means targeted push delivery was attempted.
   - `Published. No eligible devices are subscribed for alerts.` means the targeted feed post exists, but no eligible phone received push.
   - `Published, but alert delivery failed` means the post exists, but push delivery had an error.
8. Confirm the post appears in `Live employee updates` with the intended audience.
9. Open a pilot employee phone and confirm the post appears.
10. Open or ask about one non-pilot employee account and confirm the pilot-only post does not appear.

Recommended first pilot post:

```text
Title: Pilot test notice
Message: This is a test notice for the Communications and Alert Center pilot. No action is required.
Category: News
Priority: Normal
Audience: Selected groups - Pilot Test
Retention: 24 Hours
```

## What HR Should Know

HR can:

- publish new updates
- view live employee updates
- create and maintain messaging groups
- target updates to selected groups
- create employee accounts
- batch import employee accounts
- reset employee passwords
- disable employee access
- revoke sessions
- unenroll employee devices
- permanently delete employee accounts when authorized

HR should not:

- publish test messages to production employees accidentally
- share HR links with employees
- reuse HR passwords for employee accounts
- keep old pilot accounts active after the test ends

## Troubleshooting

### Employee Cannot Sign In

1. Confirm the employee is using `https://itotexpress.com/palzivalerts/employee`.
2. Confirm the username is exact.
3. Reset the employee password from HR if needed.
4. Confirm the employee account is active.

### Phone Does Not Receive Push

1. Confirm the employee signed in on that phone.
2. Confirm notifications are allowed.
3. Confirm the app was installed and reopened from the Home Screen.
4. Reopen the app and use `Sign up for alerts` if the setup control appears.
5. Check Systems device counts.
6. Send another test push from Systems.

### Published Notice Does Not Show

1. Refresh the employee app.
2. Confirm the employee is signed in.
3. Confirm HR sees the post in `Live employee updates`.
4. Confirm the post was not removed.
5. Confirm the employee is using the current `/palzivalerts/employee` route.
6. Confirm the employee belongs to at least one messaging group selected for the post.

## End Of Test

After the pilot:

1. Ask HR for feedback on publishing.
2. Ask employees if sign-in, install, and notifications worked.
3. Remove stale test notices if needed.
4. Disable test accounts that should not remain active.
5. Unenroll test devices that should stop receiving alerts.
6. Deactivate the pilot messaging group when it should no longer receive new targeted posts.
