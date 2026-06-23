# Palziv Portal

An installable employee portal with a branded launcher at `/palzivalerts`, employee login, HR publishing, systems operations, weather, and push alerts.

## What This Is

- Employees open the portal from any modern phone browser and can install it to their home screen.
- Employees sign in with named employee accounts before viewing the feed.
- A top-level launcher page sends people to the feed, HR console, or Systems tools.
- HR opens the HR portal to publish updates and manage employee accounts.
- HR and Systems both use named admin accounts, invitations, password rotation, and scoped admin management.
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
- Systems portal: http://localhost:3000/palzivalerts/webmaster

Clean phone-friendly routes also work:

- Employee portal: http://localhost:3000/palzivalerts/employee
- HR portal: http://localhost:3000/palzivalerts/hr
- Systems portal: http://localhost:3000/palzivalerts/webmaster

Old routes like `/employee`, `/hr`, `/webmaster`, and `/admin` now redirect into the branded `/palzivalerts` path.

To receive push alerts, open the employee portal on each device once and tap `Enable alerts`. The browser must support service workers and notifications. Some embedded or headless browser environments can reject push registration even when permission is granted, so validate the final experience in a normal Chrome or Safari session on the deployed HTTPS site.

## Free Online Path

Run the app on your own Windows hardware and publish it with Cloudflare Tunnel.

- Start the app locally with `npm start`, or use `scripts/windows-startup.ps1` to boot the app and tunnel together on port `3116`.
- Install `cloudflared` on the same machine.
- Point the tunnel at `localhost:3116`.
- Use your branded public hostname for the employee, HR, and Systems routes if you want both hostnames to work.
- Use your branded public hostname for the `/palzivalerts` launcher and its employee, HR, and Systems routes if you want both hostnames to work.
- Run `scripts/install-startup-task.ps1` from an elevated PowerShell window so Windows registers the boot task, the recurring recovery task, the tunnel watchdog task, and the Cloudflared service.

This keeps the hosting path free on your side and still gives the app HTTPS for phone installs and home-screen access.

The startup installer also repairs or installs the `cloudflared` Windows service, configures service failure recovery, and adds recurring self-heal/watchdog tasks so the app and tunnel come back automatically after a reboot and keep pointing at `localhost:3116`.

## Files

- `server.js`: Node server and API layer.
- `security.js`: named admin, employee auth, invite, recovery, and audit logic.
- `storage.js`: file-backed persistence.
- `data/board.json`: local seed and dev storage.
- `scripts/runtime-state.ps1`: shared runtime root, migration, and ACL helper for Windows deployment scripts.
- `public/index.html`: PWA entry point.
- `public/app.js`: employee portal, HR portal, and Systems logic.
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
- `scripts/install-startup-task.ps1`: registers the startup, recovery, and tunnel watchdog tasks and configures the `cloudflared` Windows service.

## Production Upgrade Checklist

- Add image/file attachments.
- Add broader non-admin role separation beyond the current HR/Systems admin model.
- Add richer weather alerts or multi-location weather portals if needed.
- Add advanced analytics/reporting exports if pilot customers ask for them.
