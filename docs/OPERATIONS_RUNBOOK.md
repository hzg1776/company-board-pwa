# Company Board PWA Operations Runbook

## Purpose

This runbook is the day-to-day operating guide for the live pilot deployment of Company Board PWA.

## Deployment Baseline

- Application host: Windows machine running the Node app on port `3116`
- Public URL: `https://itotexpress.com`
- Reverse proxy: Cloudflare Tunnel
- App startup: scheduled tasks
- Tunnel watchdog: scheduled task every 1 minute
- Runtime root: `C:\ProgramData\Palziv\runtime`
- Data storage: local JSON files in `C:\ProgramData\Palziv\runtime\data`

## Required Configuration

Set and maintain these core values for every production restart:

- `PUBLIC_BASE_URL`
- `TRUST_PROXY_ADDRESSES`

Keep these security controls configured on the host when you rely on bootstrap or recovery workflows:

- `ADMIN_SETUP_TOKEN` for protected first-admin bootstrap
- `ADMIN_RECOVERY_TOKEN` or `ADMIN_DAILY_RECOVERY_SEED` for operator-driven HR recovery

Recommended values:

- `PUBLIC_BASE_URL=https://itotexpress.com`
- `TRUST_PROXY_ADDRESSES=loopback` for the local Cloudflare Tunnel deployment path
- `TRUST_PROXY_ADDRESSES=<real reverse proxy IPs only>` for non-local reverse proxies

Do not:

- leave `PUBLIC_BASE_URL` unset
- trust `loopback` unless the proxy really terminates locally on the same host
- commit runtime security state to source control

## Daily Operator Checks

Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\health-check.ps1 -BaseUrl https://itotexpress.com
```

Expected:

- `/api/health` returns `200`
- `/palzivalerts/` returns `200`
- `/palzivalerts/employee` returns `200`
- `/palzivalerts/hr` returns `200`
- `/palzivalerts/webmaster` returns `200`

Automatic tunnel recovery:

- the watchdog checks local origin health against public health every minute
- if local origin is healthy but public health is failing, it restarts `cloudflared`
- it writes to `C:\ProgramData\Palziv\runtime\logs\tunnel-watchdog.log`
- it writes Windows Application Event Log entries under source `CompanyBoardPWA`
- if `AlertWebhookUrl` is configured in the watchdog task, it also posts a JSON alert payload

## Before Any Release

1. Run the local regression suite.
2. Confirm backup success.
3. Confirm current live health.
4. Promote the build.
5. Run non-destructive live health checks.

## After Any Release

1. Run [health-check.ps1](C:/Users/admin/Documents/Codex/Project-A/scripts/health-check.ps1).
2. Confirm launcher returns `200`, not `308`.
3. Confirm HR, Employee, and Systems pages load.
4. Review application stderr/stdout for startup or proxy warnings.

## Backup Policy

- Frequency: before every release and at least daily
- Retention:
  - daily backups for 14 days
  - weekly backups for 8 weeks
- Storage:
  - local backup directory
  - one off-machine copy if possible

Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\backup-data.ps1 -RuntimeRoot C:\ProgramData\Palziv\runtime
```

## Recovery Policy

Use [restore-data.ps1](C:/Users/admin/Documents/Codex/Project-A/scripts/restore-data.ps1) only during a controlled maintenance window.

Always:

1. take a fresh backup first
2. stop or restart the application cleanly
3. validate the restored app with health checks

## Secret Rotation Triggers

Rotate immediately if:

- a repo secret leak is suspected
- an operator device is compromised
- an admin password is shared outside approved operators
- a staging/prod config boundary was crossed incorrectly

See [SECRET_ROTATION.md](C:/Users/admin/Documents/Codex/Project-A/docs/SECRET_ROTATION.md).

## Rollback Triggers

Rollback if:

- public health checks fail after release
- auth flows fail in production
- push delivery fails due to a release regression
- reverse proxy origin handling behaves incorrectly

See [ROLLBACK.md](C:/Users/admin/Documents/Codex/Project-A/docs/ROLLBACK.md).

## Logs To Review

- application stdout log
- application stderr log
- Windows Task Scheduler last run result
- Cloudflare tunnel/service status
- watchdog log and watchdog state

## Pilot Support Workflow

1. Confirm user-reported issue category:
   - access/login
   - publishing
   - employee feed
   - push notifications
   - deployment availability
2. Run health checks.
3. Check whether issue is data-specific or deployment-wide.
4. Backup current data before risky recovery work.
5. Apply minimal fix.
6. Re-run health checks.

## Single Operator Rule

During pilot, one named operator should own:

- releases
- secret rotation
- backups
- restores
- rollback decisions

This removes ambiguity during incidents.
