# Backup and Restore

## Backup

Use the automation script:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\backup-data.ps1
```

Default behavior:

- reads data from `.\data`
- writes timestamped zip archives into `.\backups`
- writes a manifest JSON next to the zip

Optional parameters:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\backup-data.ps1 -ProjectRoot C:\Users\admin\Documents\Codex\Project-A -OutputRoot C:\Backups\CompanyBoard
```

## Restore

Use the restore script during a maintenance window:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restore-data.ps1 -BackupZip .\backups\company-board-backup-YYYYMMDD-HHMMSS.zip
```

Optional controlled restart:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restore-data.ps1 -BackupZip .\backups\company-board-backup-YYYYMMDD-HHMMSS.zip -RestartApp
```

## Restore Safety Rules

- do not restore over live data without taking a fresh backup first
- do not restore from an unknown or manually edited zip
- do not restart blindly without checking `PUBLIC_BASE_URL` and proxy configuration

## Validation After Restore

Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\health-check.ps1 -BaseUrl https://itotexpress.com
```

Confirm:

- launcher loads
- employee page loads
- HR page loads
- webmaster page loads
- API health returns `200`
