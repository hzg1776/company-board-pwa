# Company Board PWA

An installable company communication app for HR news, weather, safety notices, shift updates, and read-only employee viewing.

## What This Is

- Employees open the board from any modern phone browser and can install it to their home screen.
- HR opens a simple dashboard and publishes updates.
- Employee mode is read-only.
- The app uses a fixed board header and Palziv color scheme.
- HR can enter a location to pull live weather from Open-Meteo and save the result to the board.
- Production uses managed PostgreSQL through `DATABASE_URL`.
- Local development still falls back to the JSON file if no database is configured.

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

## Render Blueprint Deployment

This repo includes `render.yaml` for Render Blueprint deployment with free Render web hosting and a free Render Postgres database.

1. Push this project to GitHub.
2. In Render, choose **New > Blueprint**.
3. Select the GitHub repository.
4. Render will read `render.yaml`.
5. Review the service and database settings.
6. Click **Apply**.

Render will provide a public HTTPS URL and a PostgreSQL database. Employees can open that URL on iPhone or Android and add it to their home screen.

After deploy, HR should open `/admin` to publish updates. Employees should open `/employee` to see the read-only board.

Important: the HR dashboard is still open. The storage layer is now durable and production-grade, but the dashboard still needs real authentication before company-wide use.

## Phone Install Notes

For production phone installs, deploy the app on HTTPS. Modern iPhone and Android browsers require HTTPS for reliable home-screen installation and offline caching.

Recommended low-cost hosting path:

- App server: Render, Railway, Fly.io, Azure App Service, or a small VPS.
- Data layer: managed PostgreSQL for durable posts and weather snapshots.
- Domain: board.yourcompany.com.

## Files

- `server.js`: Node server and API layer.
- `storage.js`: file fallback plus PostgreSQL persistence.
- `data/board.json`: local fallback seed and dev storage when no database is configured.
- `public/index.html`: PWA entry point.
- `public/app.js`: employee board and HR dashboard logic.
- `public/styles.css`: mobile-first UI.
- `public/manifest.webmanifest`: installable app metadata.
- `public/sw.js`: offline shell and API cache.
- `public/assets/logo.svg`: app icon.

## Production Upgrade Checklist

- Add real HR login before production company use.
- Add push notifications for urgent alerts.
- Add image/file attachments.
- Add role-based access for HR, safety, managers, and admins.
- Add richer weather alerts or multi-location weather boards if needed.
