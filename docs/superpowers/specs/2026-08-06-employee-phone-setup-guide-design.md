# Employee Phone Setup Guide Design

## Purpose

Create a very simple, standalone employee guide that explains how to open the Communications and Alert Center website, add it to a phone Home Screen, and allow notifications.

## Audience

Employees who are not comfortable with phone or browser settings. The guide must use short sentences, familiar button names, and one action per numbered step.

## Deliverable

Create `docs/EMPLOYEE_PHONE_SETUP.md` as a copy-and-paste-friendly guide titled `How to Put the Employee App on Your Phone`.

The guide will:

- Put the production employee link at the top: `https://itotexpress.com/palzivalerts/employee`.
- Provide separate numbered sections for iPhone and Android.
- Use the exact application action `Sign up for alerts`.
- Tell users to select `Allow` when the phone requests notification permission.
- Remind users to reopen the installed app from its Home Screen icon before enabling alerts.
- Include one short troubleshooting section for notifications that were previously blocked.
- Exclude administrator workflows, technical explanations, local-development URLs, and unrelated portal features.

## iPhone Flow

1. Open the employee link in Safari.
2. Sign in with the employee username and password.
3. Select the Safari Share button.
4. Select `Add to Home Screen`, then confirm by selecting `Add`.
5. Close Safari and open the new app icon from the Home Screen.
6. Sign in again if requested.
7. Select `Sign up for alerts`.
8. Select `Allow` when the iPhone asks about notifications.

The guide will explicitly state that iPhone notifications require using the installed Home Screen app, not only a Safari tab.

## Android Flow

1. Open the employee link in Chrome.
2. Sign in with the employee username and password.
3. Open the three-dot browser menu.
4. Select `Install app` or `Add to Home screen`, then confirm.
5. Open the new app icon from the Home Screen.
6. Sign in again if requested.
7. Select `Sign up for alerts`.
8. Select `Allow` when Android asks about notifications.

## Troubleshooting

If notifications were blocked, the guide will tell the employee to enable notifications for the installed app in the phone's Settings, reopen the Home Screen app, and select `Sign up for alerts` again if that action appears.

The guide will direct employees to HR or Systems if setup still fails. It will not include privileged routes or internal diagnostic instructions.

## Existing Documentation

The new guide is intentionally standalone. Existing uncommitted changes in `docs/QUICK_START_MANUAL.md`, `docs/USER_MANUAL.md`, generated manual artifacts, and related files will not be overwritten or included in this change.

## Verification

- Confirm the production employee route responds successfully.
- Compare button names and platform instructions with `public/app.js`.
- Check the new Markdown for a clear sequence, working link, and no technical jargon.
- Run `git diff --check` on the new file.
