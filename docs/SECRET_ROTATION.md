# Secret Rotation Procedure

## Secrets In Scope

- `ADMIN_SETUP_TOKEN`
- `ADMIN_RECOVERY_TOKEN`
- `ADMIN_DAILY_RECOVERY_SEED`
- HR password
- Systems password
- employee credentials if compromise is suspected
- any deployment-specific API keys or push credentials managed outside the app

## Rotation Order

1. stabilize access to the server
2. back up current data
3. rotate deployment bootstrap and recovery secrets
4. rotate HR credentials
5. rotate Systems credentials
6. rotate employee credentials only if incident scope requires it
7. restart and validate public health

## Deployment Secret Rotation

1. generate new random values for any in-use bootstrap or recovery secret
2. update the production startup configuration
3. restart the app
4. confirm existing app behavior is normal

Note:

- the setup token is mainly for protected bootstrap and emergency reprovisioning controls
- the recovery token or daily recovery seed controls operator-driven HR recovery
- after stable production bootstrap, keep it secret and out of source control

## HR And Systems Password Rotation

Use a controlled operator workflow:

1. notify affected admins
2. choose a maintenance window
3. rotate one privileged account at a time
4. confirm separate login paths still work
5. review security events for repeated failures after the change

## Post-Rotation Validation

Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\health-check.ps1 -BaseUrl https://itotexpress.com
```

Review:

- live auth pages load
- no startup config errors
- no obvious spike in security events

## Incident Notes

If a secret was exposed in a public repo, chat, or screenshot:

1. treat it as compromised
2. rotate it immediately
3. document when the exposure happened
4. document what was rotated and when
