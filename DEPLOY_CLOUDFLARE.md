# Docker + Cloudflare Tunnel Deployment

Domain: `itotexpress.com`

## 1. Install Docker Desktop

Run PowerShell as Administrator:

```powershell
winget install -e --id Docker.DockerDesktop
```

Restart Windows if Docker asks for it, then open Docker Desktop once.

Verify:

```powershell
docker --version
docker info
```

## 2. Stop Anything Already Using Port 3000

Run PowerShell as Administrator:

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

## 3. Build And Run The App Container

From this project folder:

```powershell
cd "C:\Users\admin\Documents\Codex\Project-A"
docker rm -f company-board-pwa 2>$null
docker volume create company-board-data
docker build -t company-board-pwa:latest .
docker run -d --name company-board-pwa --restart unless-stopped -p 3000:3000 -v company-board-data:/app/data -e NODE_ENV=production -e PORT=3000 -e DATA_FILE=/app/data/board.json company-board-pwa:latest
```

Verify locally:

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

1. Open Cloudflare Dashboard.
2. Go to `Zero Trust` -> `Networks` -> `Tunnels`.
3. Select `Create a tunnel`.
4. Choose `Cloudflared`.
5. Name it `company-board-pwa`.
6. Select `Save tunnel`.
7. Choose `Windows`.
8. Copy the exact Windows service command Cloudflare shows and run it in Administrator PowerShell.

## 6. Configure The Public Hostname

In the same tunnel:

```text
Subdomain: leave blank
Domain: itotexpress.com
Type: HTTP
URL: localhost:3000
```

Save the public hostname.

## 7. Verify Public Access

```powershell
Invoke-WebRequest -Uri "https://itotexpress.com/api/health" -UseBasicParsing
```

Open:

```text
https://itotexpress.com/employee
https://itotexpress.com/admin
```

## 8. Useful Operations

View app logs:

```powershell
docker logs -f company-board-pwa
```

Restart app:

```powershell
docker restart company-board-pwa
```

Update after code changes:

```powershell
cd "C:\Users\admin\Documents\Codex\Project-A"
docker build -t company-board-pwa:latest .
docker rm -f company-board-pwa
docker run -d --name company-board-pwa --restart unless-stopped -p 3000:3000 -v company-board-data:/app/data -e NODE_ENV=production -e PORT=3000 -e DATA_FILE=/app/data/board.json company-board-pwa:latest
```
