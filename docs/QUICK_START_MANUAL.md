# Quick Start: Build and Share the Full App Manual

## 1) What this manual covers

The main source file now documents:

- Launcher login
- Employee login and feed use
- HR login and HR features
- Systems login and Systems features
- IT login and IT governance features
- MFA, invitations, recovery, push alerts, and troubleshooting

## 2) Generate the PDF (5 minutes)

From the project root:

```powershell
$env:PORT = "3116"
npm start
```

In a second terminal:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-user-manual-pdf.ps1
```

The output will be in:

- `docs/manual-artifacts/Communications_And_Alert_Center_User_Manual.pdf`
- `docs/manual-artifacts/Communications_And_Alert_Center_User_Manual.html`
- `docs/manual-artifacts/screenshots/`

## 3) Generate signed-in workflow screenshots

If you want the PDF to show authenticated employee, HR, Systems, and IT screens instead of public login routes, set temporary manual-build credentials in the current shell and run:

```powershell
$env:MANUAL_EMPLOYEE_USERNAME = "employee-username"
$env:MANUAL_EMPLOYEE_PASSWORD = "employee-password"
$env:MANUAL_HR_USERNAME = "hr-username"
$env:MANUAL_HR_PASSWORD = "hr-password"
$env:MANUAL_WEBMASTER_USERNAME = "systems-username"
$env:MANUAL_WEBMASTER_PASSWORD = "systems-password"
$env:MANUAL_IT_USERNAME = "it-username"
$env:MANUAL_IT_PASSWORD = "it-password"
powershell -ExecutionPolicy Bypass -File .\scripts\build-user-manual-pdf.ps1 -BaseUrl "http://localhost:3116" -AuthenticatedScreenshots
```

The script now logs in, saves temporary browser storage state, captures the signed-in screens, and rebuilds the PDF.

## 4) Update the content first

Edit the manual text in:

- `docs/USER_MANUAL.md`

Then rerun step 2 to update the PDF.

## 5) What to send to your team

1. Send the PDF link to users.
2. For support staff, share the same PDF and point them to the login and troubleshooting sections first.
3. Keep one copy in your internal docs folder for onboarding.

## 6) What to do when something fails

If the build fails:

1. Confirm Node is running at `http://localhost:3116/palzivalerts` or the local URL you started it on.
2. Re-run script:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-user-manual-pdf.ps1
```

3. If screenshots are blank/missing, open the app URLs manually and verify the routes.
4. Re-run the command once routes are correct.

## 7) One-line distribution text (copy/paste)

"Your Communications and Alert Center manual is ready. It covers how to log in to every part of the app and how to use each major feature. Open the PDF for onboarding, training, and support."
