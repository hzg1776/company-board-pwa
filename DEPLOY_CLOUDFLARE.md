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
5. Name it `company-board-pwa`.
6. Select `Save tunnel`.
7. Choose `Windows`.
8. Copy the exact Windows service command Cloudflare shows and run it in Administrator PowerShell on the host machine.

## 6. Configure The Public Hostname

In the same tunnel, set:

```text
Subdomain: leave blank or use www
Domain: itotexpress.com
Type: HTTP
URL: localhost:3116
```

If you use the boot script below, it starts the app on port 3116 so the tunnel can stay pointed here.

## 7. Verify Public Access

```powershell
Invoke-WebRequest -Uri "https://itotexpress.com/api/health" -UseBasicParsing
```

Open:

```text
https://itotexpress.com/employee
https://itotexpress.com/admin
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

If elevation is available, the task runs at startup as `SYSTEM`. Otherwise, the installer cannot complete the registration from this session.

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
