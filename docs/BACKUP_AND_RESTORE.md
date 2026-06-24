# Backup and Restore

## Backup

Use the automation script:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\backup-data.ps1 -RuntimeRoot C:\ProgramData\Palziv\runtime
```

Default behavior:

- when run elevated on the Windows host, targets `C:\ProgramData\Palziv\runtime` automatically if that runtime exists
- otherwise reads data from the repo-local runtime data directory at `runtime\data`
- writes timestamped zip archives into the selected runtime backup directory
- writes a manifest JSON next to the zip

Optional parameters:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\backup-data.ps1 -ProjectRoot C:\Users\admin\Documents\Codex\Project-A -RuntimeRoot C:\ProgramData\Palziv\runtime -OutputRoot C:\ProgramData\Palziv\runtime\backups
```

If you override `-OutputRoot`, put it in a directory with the same ACL hardening as the runtime root. Backup zips and manifests contain live runtime state.

## Restore

Use the restore script during a maintenance window:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restore-data.ps1 -BackupZip C:\ProgramData\Palziv\runtime\backups\company-board-backup-YYYYMMDD-HHMMSS.zip -RuntimeRoot C:\ProgramData\Palziv\runtime
```

Optional controlled restart:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restore-data.ps1 -BackupZip C:\ProgramData\Palziv\runtime\backups\company-board-backup-YYYYMMDD-HHMMSS.zip -RuntimeRoot C:\ProgramData\Palziv\runtime -RestartApp
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
- Systems page loads
- API health returns `200`
