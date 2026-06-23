# Quick Start: Using the Palziv User Manual

## 1) Generate the PDF (5 minutes)

From the project root:

```powershell
npm start
```

In a second terminal:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-user-manual-pdf.ps1
```

The output will be in:

- [docs/manual-artifacts/Palziv_User_Manual.pdf](/C:/Users/admin/Documents/Codex/Project-A/docs/manual-artifacts/Palziv_User_Manual.pdf)
- [docs/manual-artifacts/Palziv_User_Manual.html](/C:/Users/admin/Documents/Codex/Project-A/docs/manual-artifacts/Palziv_User_Manual.html)
- [docs/manual-artifacts/screenshots/](/C:/Users/admin/Documents/Codex/Project-A/docs/manual-artifacts/screenshots/)

## 2) Update the content first

Edit the manual text in:

- [docs/USER_MANUAL.md](/C:/Users/admin/Documents/Codex/Project-A/docs/USER_MANUAL.md)

Then rerun step 1 to update the PDF.

## 3) What to send to your team

1. Send the PDF link to users.
2. For support staff, share the same PDF and the troubleshooting section first.
3. Keep one copy in your internal docs folder for onboarding.

## 4) What to do when something fails

If the build fails:

1. Confirm Node is running at `http://localhost:3000/palzivalerts` or the local URL you started it on.
2. Re-run script:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-user-manual-pdf.ps1
```

3. If screenshots are blank/missing, open the app URLs manually and verify the routes.
4. Re-run the command once routes are correct.

## 5) One-line distribution text (copy/paste)

“Your new Palziv user manual is ready. Open the PDF, and use the screenshot pages to train new staff quickly. If you need updates, edit `docs/USER_MANUAL.md` and rerun the PDF build script.”
