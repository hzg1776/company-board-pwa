# Local Hardware + Cloudflare Tunnel Deployment

This repo is meant to run on your own Windows machine and be published through Cloudflare Tunnel.

## 1. Prepare The Host Machine

- Install Node.js 22 or newer.
- Make sure the repo is on the Windows machine that will host the app.
- Use the existing project folder: `C:\Users\admin\Documents\Codex\Project-A`

## 2. Install Dependencies

```powershell
cd "C:\Users\admin\Documents\Codex\Project-A"
npm install
```

## 3. Start The App Locally

Manual launches use `PORT` and default to `3000`.
The boot script below uses `3116` so the tunnel can stay fixed to the current host port.

```powershell
$env:PORT = "3000"
npm start
```

Verify the local app:

```powershell
Invoke-WebRequest -Uri "http://localhost:3000/api/health" -UseBasicParsing
```

## 4. Install cloudflared

Run PowerShell as Administrator:

```powershell
winget install -e --id Cloudflare.cloudflared
cloudflared --version
```

## 5. Create The Cloudflare Tunnel

1. Open the Cloudflare Dashboard.
2. Go to `Zero Trust` -> `Networks` -> `Tunnels`.
3. Select `Create a tunnel`.
4. Choose `Cloudflared`.
5. Name it `palziv-portal-pwa`.
6. Select `Save tunnel`.
7. Choose `Windows`.
8. Copy the exact Windows service command Cloudflare shows and run it in Administrator PowerShell on the host machine.

## 6. Configure The Public Hostname

In the same tunnel, set:

```text
Subdomain: leave blank or use www
Domain: your-domain.example
Type: HTTP
URL: localhost:3116
```

Make sure both your root hostname and the `www` hostname point to the tunnel if you want either hostname to work from mobile browsers.

If you use the boot script below, it starts the app on port 3116 so the tunnel can stay pointed here.
The boot script also checks `/api/health`, clears stale listeners on port `3116` if needed, and avoids creating duplicate tunnel processes.
It also trusts the local loopback proxy hop for client IP forwarding so Cloudflare Tunnel traffic does not collapse all users onto `127.0.0.1` for login throttling.

## 6b. Rename The App

Set these environment variables on the Windows host if you want the displayed product name to change:

- `SITE_NAME` for the base name
- `SITE_NAME_SUFFIX` optional regional suffix if you ever need one
- `SITE_SHORT_NAME` for the compact label on phones
- `SITE_SUBTITLE` for the subheading under the logo

Example in PowerShell:

```powershell
$env:SITE_NAME = "Palziv"
$env:SITE_SHORT_NAME = "Palziv"
$env:SITE_SUBTITLE = "Updates & Alerts Portal"
```

For a permanent host rename, set the same values with `setx` or in Windows System Properties before the startup task runs.

## 7. Verify Public Access

```powershell
Invoke-WebRequest -Uri "https://your-domain.example/api/health" -UseBasicParsing
```

Open:

```text
https://www.your-domain.example/palzivalerts
https://www.your-domain.example/palzivalerts/employee
https://www.your-domain.example/palzivalerts/hr
https://www.your-domain.example/palzivalerts/webmaster
https://your-domain.example/palzivalerts
https://your-domain.example/palzivalerts/employee
https://your-domain.example/palzivalerts/hr
https://your-domain.example/palzivalerts/webmaster
```

## 8. Windows Startup Script

Use the combined startup script to bring the host back after a reboot:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\admin\Documents\Codex\Project-A\scripts\windows-startup.ps1"
```

To create the actual boot task, run:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\admin\Documents\Codex\Project-A\scripts\install-startup-task.ps1"
```

Run that from an elevated PowerShell window. A non-elevated shell will get `Access is denied` when Windows tries to register the task.
The elevated path also moves runtime state under `C:\ProgramData\Palziv\runtime` and applies hardened ACLs there.

The installer now does four things:

- Registers the app startup task so the portal comes back after boot.
- Registers a recurring recovery task that reruns the same startup script every 5 minutes so the host self-heals after a crash or service drop.
- Repairs or installs the `cloudflared` Windows service, enables failure recovery, and points it at `localhost:3116`.

It also registers a tunnel watchdog:

- runs every 1 minute
- compares public `/api/health` to local `http://127.0.0.1:3116/api/health`
- restarts `cloudflared` when the origin is healthy but the tunnel path is failing
- writes to `logs\tunnel-watchdog.log`
- writes Windows Application Event Log entries under source `CompanyBoardPWA`
- can send a webhook alert when you pass `-AlertWebhookUrl`

Example:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\admin\Documents\Codex\Project-A\scripts\install-startup-task.ps1" -AlertWebhookUrl "https://your-alert-endpoint.example/webhook"
```

If elevation is available, the startup and recovery tasks run as `SYSTEM`. Otherwise, the installer cannot complete the self-healing registration from this session.

## 9. Update Workflow

When you change code:

```powershell
cd "C:\Users\admin\Documents\Codex\Project-A"
git pull
npm install
$env:PORT = "3000"
npm start
```

The tunnel can stay pointed at the same local port.
