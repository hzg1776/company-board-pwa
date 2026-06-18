# Palziv Portal

An installable employee portal with a branded launcher at `/palzivalerts`, HR publishing, weather, push alerts, and read-only employee viewing.

## What This Is

- Employees open the portal from any modern phone browser and can install it to their home screen.
- A top-level launcher page sends people to the feed, HR console, or webmaster tools.
- HR opens the HR portal and publishes updates.
- Employee mode is read-only.
- The app uses a fixed portal header and the Palziv brand assets.
- HR can enter a location to pull live weather from Open-Meteo and save the result to the portal.
- Important and urgent updates can be broadcast as push notifications to every employee device that opts in.
- Local hardware storage is the only storage path.

## Rename The App

The displayed name is controlled by environment variables:

- `SITE_NAME` for the base name
- `SITE_NAME_SUFFIX` optional regional suffix if you ever need one
- `SITE_SHORT_NAME` for the compact install label
- `SITE_SUBTITLE` for the subheading under the logo

Example:

```powershell
$env:SITE_NAME = "Palziv"
$env:SITE_SHORT_NAME = "Palziv"
$env:SITE_SUBTITLE = "Updates & Alerts Portal"
npm start
```

For a permanent Windows host, set the same values with `setx` or in System Properties so the startup task inherits them on reboot.

## Run Locally

```powershell
npm start
```

Open:

- Launcher: http://localhost:3000/palzivalerts
- Employee portal: http://localhost:3000/palzivalerts/employee
- HR portal: http://localhost:3000/palzivalerts/hr
- Webmaster portal: http://localhost:3000/palzivalerts/webmaster

Clean phone-friendly routes also work:

- Employee portal: http://localhost:3000/palzivalerts/employee
- HR portal: http://localhost:3000/palzivalerts/hr
- Webmaster portal: http://localhost:3000/palzivalerts/webmaster

Old routes like `/employee`, `/hr`, `/webmaster`, and `/admin` now redirect into the branded `/palzivalerts` path.

To receive push alerts, open the employee portal on each device once and tap `Enable alerts`. The browser must support service workers and notifications. Some embedded or headless browser environments can reject push registration even when permission is granted, so validate the final experience in a normal Chrome or Safari session on the deployed HTTPS site.

## Free Online Path

Run the app on your own Windows hardware and publish it with Cloudflare Tunnel.

- Start the app locally with `npm start`, or use `scripts/windows-startup.ps1` to boot the app and tunnel together on port `3116`.
- Install `cloudflared` on the same machine.
- Point the tunnel at `localhost:3116`.
- Use your branded public hostname for the employee, HR, and webmaster routes if you want both hostnames to work.
- Use your branded public hostname for the `/palzivalerts` launcher and its employee, HR, and webmaster routes if you want both hostnames to work.
- Run `scripts/install-startup-task.ps1` from an elevated PowerShell window so Windows registers both the boot task and the recurring recovery task.

This keeps the hosting path free on your side and still gives the app HTTPS for phone installs and home-screen access.

The startup installer also repairs or installs the `cloudflared` Windows service, configures service failure recovery, and adds a recurring self-heal task so the app and tunnel come back automatically after a reboot and keep pointing at `localhost:3116`.

## Files

- `server.js`: Node server and API layer.
- `storage.js`: file-backed persistence.
- `data/board.json`: local seed and dev storage.
- `scripts/runtime-state.ps1`: shared runtime root, migration, and ACL helper for Windows deployment scripts.
- `public/index.html`: PWA entry point.
- `public/app.js`: employee portal, HR portal, and webmaster logic.
- `public/styles.css`: mobile-first UI.
- `public/manifest.webmanifest`: installable app metadata.
- `public/sw.js`: offline shell and API cache.
- `public/assets/logo.svg`: legacy SVG wrapper around the brand icon.
- `public/assets/palziv-logo.png`: brand icon source.
- `public/assets/palziv-wordmark.png`: brand wordmark source.
- `data/push.json`: local dev push key and subscription store. Production runtime state should live under `C:\ProgramData\Palziv\runtime\data`.
- `DEPLOY_CLOUDFLARE.md`: local hardware + Cloudflare Tunnel runbook.
- `scripts/windows-phase1-cleanup.ps1`: safe Windows cleanup and reinstall helper.
- `scripts/windows-startup.ps1`: boot and recovery script for the app and cloudflared service.
- `scripts/install-startup-task.ps1`: registers the Windows startup task, the recurring recovery task, and cloudflared service recovery.

## Production Upgrade Checklist

- Replace the single shared HR account with named admin users and roles.
- Add image/file attachments.
- Add role-based access for HR, safety, managers, and admins.
- Add richer weather alerts or multi-location weather portals if needed.
