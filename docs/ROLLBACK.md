# Rollback Procedure

## When To Roll Back

Rollback is justified when a release creates production failure that is faster to reverse than debug live.

Examples:

- launcher or health endpoint failure
- broken login flow
- broken publishing path
- proxy/origin validation regression
- broken employee feed

## Rollback Strategy

Use the last known good release plus the latest safe data backup.

## Rollback Steps

1. announce a maintenance window
2. capture current logs
3. take a fresh backup with [backup-data.ps1](C:/Users/admin/Documents/Codex/Project-A/scripts/backup-data.ps1)
4. redeploy the last known good code
5. restore data only if the release corrupted data or schema expectations
6. restart the app
7. run [health-check.ps1](C:/Users/admin/Documents/Codex/Project-A/scripts/health-check.ps1)
8. confirm public URL behavior

## Decision Rule

- if code is bad but data is good, roll back code only
- if data is corrupted, restore both code and data

## Evidence To Capture

- release identifier
- deployment time
- exact failing endpoint or workflow
- logs before rollback
- health-check results after rollback

## Do Not Do This

- do not edit JSON data manually during incident response unless you have a recorded reason
- do not push emergency code and restore data at the same time unless you understand which layer failed
