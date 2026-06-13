# Company Board PWA

An installable company communication app for HR news, weather, safety notices, shift updates, and read-only employee viewing.

## What This Is

- Employees open the board from any modern phone browser and can install it to their home screen.
- HR opens a simple dashboard and publishes updates.
- Employee mode is read-only.
- The app uses a fixed board header and Palziv color scheme.
- HR can enter a location to pull live weather from Open-Meteo and save the result to the board.
- Local hardware storage is the only storage path.

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

## Free Online Path

Run the app on your own Windows hardware and publish it with Cloudflare Tunnel.

- Start the app locally with `npm start`, or use `scripts/windows-startup.ps1` to boot the app and tunnel together on port `3116`.
- Install `cloudflared` on the same machine.
- Point the tunnel at `localhost:3116`.
- Use `https://itotexpress.com/employee` and `https://itotexpress.com/admin`.

This keeps the hosting path free on your side and still gives the app HTTPS for phone installs and home-screen access.

## Files

- `server.js`: Node server and API layer.
- `storage.js`: file-backed persistence.
- `data/board.json`: local seed and dev storage.
- `public/index.html`: PWA entry point.
- `public/app.js`: employee board and HR dashboard logic.
- `public/styles.css`: mobile-first UI.
- `public/manifest.webmanifest`: installable app metadata.
- `public/sw.js`: offline shell and API cache.
- `public/assets/logo.svg`: app icon.
- `DEPLOY_CLOUDFLARE.md`: local hardware + Cloudflare Tunnel runbook.
- `scripts/windows-phase1-cleanup.ps1`: safe Windows cleanup and reinstall helper.
- `scripts/windows-startup.ps1`: boot script for the app and cloudflared service.
- `scripts/install-startup-task.ps1`: registers the Windows startup task.

## Production Upgrade Checklist

- Add real HR login before production company use.
- Add push notifications for urgent alerts.
- Add image/file attachments.
- Add role-based access for HR, safety, managers, and admins.
- Add richer weather alerts or multi-location weather boards if needed.
