# Manual Build Guide

**Document status:** Verified August 6, 2026.

Use this guide to rebuild the current Quick Start, full User Manual, HTML files, PDF files, and route screenshots.

## 1. Sources And Outputs

Editable sources:

- `docs/QUICK_START_MANUAL.md`
- `docs/USER_MANUAL.md`

Generated outputs:

- `docs/manual-artifacts/Communications_And_Alert_Center_Quick_Start.html`
- `docs/manual-artifacts/Communications_And_Alert_Center_Quick_Start.pdf`
- `docs/manual-artifacts/Communications_And_Alert_Center_User_Manual.html`
- `docs/manual-artifacts/Communications_And_Alert_Center_User_Manual.pdf`
- `docs/manual-artifacts/screenshots/01-launcher.png` through `05-it.png`

Do not edit generated HTML or PDF files directly.

## 2. Prerequisites

- Node.js 22 or newer
- The project dependencies installed with `npm install`
- PowerShell
- Network or an existing npm cache for the transient `marked` and Playwright commands used by the builder
- A Playwright Chromium browser available to the current user
- The current app running on a safe local or demo URL

The builder derives the project root from its own location. It does not require the repository to stay at one hard-coded Windows path.

## 3. Start A Safe Local App

From the project root:

```powershell
$env:PORT = "3116"
npm start
```

For a documentation-only review, prefer a local/demo runtime with no production credentials or sensitive data.

## 4. Build With Public Sign-In Screens

In a second PowerShell window:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-user-manual-pdf.ps1 -BaseUrl "http://localhost:3116"
```

This default mode captures the launcher and public sign-in pages. The PDF captions identify them as sign-in pages, not signed-in dashboards.

## 5. Optional Authenticated Screenshots

Authenticated capture is optional and should use disposable nonproduction accounts only.

Do not use production credentials. Do not disable production MFA for a manual build.

Set temporary credentials in the current shell:

```powershell
$env:MANUAL_EMPLOYEE_USERNAME = "demo-employee"
$env:MANUAL_EMPLOYEE_PASSWORD = "temporary-demo-password"
$env:MANUAL_HR_USERNAME = "demo-hr"
$env:MANUAL_HR_PASSWORD = "temporary-demo-password"
$env:MANUAL_WEBMASTER_USERNAME = "demo-systems"
$env:MANUAL_WEBMASTER_PASSWORD = "temporary-demo-password"
$env:MANUAL_IT_USERNAME = "demo-it"
$env:MANUAL_IT_PASSWORD = "temporary-demo-password"
powershell -ExecutionPolicy Bypass -File .\scripts\build-user-manual-pdf.ps1 -BaseUrl "http://localhost:3116" -AuthenticatedScreenshots
```

The builder requires each login response to be fully authorized. It fails when MFA still needs setup or verification. Browser storage-state files are created under a temporary workspace directory and removed in a `finally` cleanup; they must never appear under `docs/manual-artifacts/`.

After an authenticated demo capture, revoke the demo sessions and clear the temporary environment variables.

## 6. Required Verification

After every rebuild:

1. Confirm all four role screenshots and the launcher screenshot have current visible labels.
2. Confirm screenshot captions match the capture mode.
3. Open both generated HTML files.
4. Render and inspect every page of both PDFs.
5. Confirm no clipping, overlap, broken images, blank pages, or credential/session files.
6. Search the generated artifacts for removed wording such as `Mark read`, acknowledgement CSV, or obsolete HR tabs.
7. Run the repository's relevant syntax/tests and `git diff --check`.

Do not distribute a PDF only because the build command exited successfully. The visible PDF and screenshots are part of the product surface and require review.

## 7. Distribution

- Send most users the Quick Start PDF.
- Use the full User Manual PDF for onboarding, training, and support.
- Keep operator and migration runbooks separate; consult `docs/MANUAL_INDEX.md` before sharing them.
- Never include passwords, browser storage-state JSON, recovery material, or MFA secrets in the distributed folder.
