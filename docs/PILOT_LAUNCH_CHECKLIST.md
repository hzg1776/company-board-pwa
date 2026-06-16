# Pilot Launch Checklist

## Purpose

Use this checklist to launch and support the current pilot deployment without improvising.

## Go / No-Go Rule

Do not onboard a pilot customer unless every `Launch Day` item below is complete.

## Launch Day

1. Confirm public health:
   - `https://itotexpress.com/api/health` returns `200`
   - `https://itotexpress.com/palzivalerts/` returns `200`
   - `https://itotexpress.com/palzivalerts/hr` returns `200`
   - `https://itotexpress.com/palzivalerts/webmaster` returns `200`
2. Confirm local origin health:
   - `http://127.0.0.1:3116/api/health` returns `200`
3. Confirm the live app is listening on port `3116`.
4. Confirm the public hostname resolves to the working Cloudflare tunnel path.
5. Confirm the tunnel watchdog task exists:
   - `CompanyBoardPWA Startup Tunnel Watchdog`
6. Confirm the recurring recovery task exists:
   - `CompanyBoardPWA Startup Recovery`
7. Confirm a fresh backup exists from today.
8. Confirm `HR` login works.
9. Confirm `Webmaster` login works.
10. Confirm `HR` password change works.
11. Confirm `Webmaster` password change works.
12. Confirm the admin UI shows:
   - last password changed
   - other active sessions signed out
13. Confirm employee feed loads.
14. Confirm weather panel loads.
15. Confirm notice publishing works.
16. Confirm push config loads.
17. Confirm at least one test push can be sent if a pilot device is enrolled.

## Operator Credentials

Before onboarding:

1. Set a known `HR` password.
2. Set a known `Webmaster` password.
3. Store both in your secure operator vault, not in chat or source control.
4. Confirm the current operator can sign in with both roles.

## Backup And Recovery

Before any onboarding session:

1. Run a fresh backup.
2. Verify the newest backup zip exists.
3. Verify the newest backup manifest exists.
4. Confirm you know the rollback owner.

Commands:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\backup-data.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\health-check.ps1 -BaseUrl https://itotexpress.com
```

## Customer Onboarding Flow

1. Sign in as `HR`.
2. Sign in as `Webmaster`.
3. Create the first employee account.
4. Publish the first notice.
5. Verify the notice appears on the employee feed.
6. Enroll one real employee device for push.
7. Send one test push.
8. Confirm the device receives it.
9. Walk the customer through:
   - how to publish a notice
   - how to disable an employee
   - how to reset an employee password
   - how to change `HR` and `Webmaster` passwords

## Daily Pilot Ops

1. Run the public health check.
2. Review `logs\tunnel-watchdog.log`.
3. Check whether any auth failures or throttles look suspicious.
4. Confirm yesterday's backup exists.
5. Confirm no unexpected service or tunnel outage occurred.

## Incident Triage

If the public site is down:

1. Check `https://itotexpress.com/api/health`
2. Check `http://127.0.0.1:3116/api/health`
3. If local is healthy and public is failing:
   - review the tunnel watchdog log
   - review Cloudflare tunnel state
4. If local is unhealthy:
   - restart the app
   - re-run health checks
5. If recovery is not immediate:
   - stop onboarding
   - preserve logs
   - prepare rollback

## Pilot Exit Criteria

The pilot is operationally healthy if:

1. admins can sign in reliably
2. admins can rotate their own passwords
3. notices publish without manual intervention
4. employee feed stays reachable
5. backups are current
6. tunnel outages self-recover or fail loudly enough to act quickly

## Current Recommendation

This app is ready for controlled pilot use if this checklist is completed before each onboarding or release touchpoint.
