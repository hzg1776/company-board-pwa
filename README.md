# Company Board PWA

An installable company communication app for HR news, weather, safety notices, shift updates, and read-only employee viewing.

## What This Is

- Employees open the portal from any modern phone browser, sign in with their assigned employee ID and PIN, and can install it to their home screen.
- HR signs into a simple dashboard and publishes updates.
- Employee mode is read-only.
- HR can create employee PINs, reset PINs, revoke employee access, and see recent employee login/page presence.
- HR can customize the company name, logo URL, and board colors from the dashboard.
- The MVP uses a small Node server and a JSON data file, so it runs without paid services.

## Run Locally

```powershell
npm start
```

Open:

- Employee board: http://localhost:3000/#employee
- HR dashboard: http://localhost:3000/#admin

Clean phone-friendly routes also work:

- Employee portal: http://localhost:3000/employee
- HR dashboard: http://localhost:3000/admin

Default local HR PIN:

```text
2468
```

Set a real PIN before any real deployment:

```powershell
$env:HR_PIN="change-this-pin"
npm start
```

## Free Render Demo Deployment

This repo includes `render.yaml` for Render's free web service path.

1. Push this project to GitHub.
2. In Render, choose **New > Blueprint**.
3. Select the GitHub repository.
4. Render will read `render.yaml`.
5. When prompted for `HR_PIN`, enter a private PIN for HR.
6. Click **Apply**.

Render will provide a public HTTPS URL. Employees can open that URL on iPhone or Android and add it to their home screen.

After deploy, HR should open `/admin`, sign in, create employee access records, and have employees scan the QR code on the HR login page. Employees must use the employee ID and PIN HR assigns.

Important: this first Render setup is a demo deployment. It stores updates in `data/board.json`, which is not the right storage model for production hosting. When you approve the demo, upgrade storage to Supabase, Cloudflare D1, or another managed database before real company use.

## Phone Install Notes

For production phone installs, deploy the app on HTTPS. Modern iPhone and Android browsers require HTTPS for reliable home-screen installation and offline caching.

Recommended low-cost hosting path:

- App server: Render, Railway, Fly.io, Azure App Service, or a small VPS.
- Data upgrade: Supabase Postgres, Firebase, or managed Postgres when multiple locations and audit history matter.
- Domain: board.yourcompany.com.

## Files

- `server.js`: no-dependency Node server and JSON API.
- `data/board.json`: current posts, weather status, branding, employee access records, and employee login activity.
- `public/index.html`: PWA entry point.
- `public/app.js`: employee board and HR dashboard logic.
- `public/styles.css`: mobile-first UI.
- `public/manifest.webmanifest`: installable app metadata.
- `public/sw.js`: offline shell and API cache.
- `public/assets/logo.svg`: app icon.

## Production Upgrade Checklist

- Replace HR PIN access with real HR login.
- Move `data/board.json` to a database.
- Move employee sessions and audit logs to a database.
- Add push notifications for urgent alerts.
- Add image/file attachments.
- Add role-based access for HR, safety, managers, and admins.
- Add weather API integration by location.
