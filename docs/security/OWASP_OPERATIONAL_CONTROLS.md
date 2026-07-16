# OWASP Operational Security Controls

## Purpose and scope

This document separates security behavior enforced by the Project-A source code from controls that depend on the Windows host, Cloudflare, operating procedures, or independent assessment.

Project-A is an authenticated employee communications portal with privileged HR, Webmaster, and IT administration. The target verification profile is OWASP Application Security Verification Standard 5.0.0 Level 2. The source register is [ASVS_5.0_LEVEL_2_MATRIX.csv](ASVS_5.0_LEVEL_2_MATRIX.csv), generated from OWASP's pinned [ASVS v5.0.0 English source](https://github.com/OWASP/ASVS/tree/v5.0.0/5.0).

The matrix and this document are an evidence register, not an OWASP certification. A `Verified` matrix entry means the cited Project-A evidence directly covers that requirement. It does not mean OWASP or an independent assessor has certified the application.

Source code cannot guarantee Windows runtime ACLs, disk encryption, Windows time synchronization, operating-system patching, Cloudflare TLS policy, tunnel restrictions, backup execution or retention, restore success, secret custody, human log review, or independent penetration testing. Those controls require current operational evidence.

## Evidence rules

For an operational requirement to move from `Partial` or `Not assessed` to `Verified`:

1. The control owner performs the stated minimum action.
2. Evidence is captured at the stated location without including live secrets.
3. The evidence is no older than the stated frequency permits.
4. Failed checks create an incident or corrective action with an owner and completion date.
5. The ASVS matrix record cites the resulting evidence.

Evidence exports must never contain passwords, session tokens, MFA seeds, recovery codes, API keys, VAPID private keys, raw push endpoints, or unredacted authentication cookies.

## Application-enforced controls

These controls are implemented and regression-tested in the repository.

| Owner | Enforcement point | Minimum action | Evidence | Frequency | Failure response |
|---|---|---|---|---|---|
| Engineering | `server.js` and `security.js` | Enforce server-side role and object authorization for employee, HR, Webmaster, and IT routes. | `test/server-security.test.js`, `test/security.test.js`, `ACCESS_CONTROL_LIST.md` | Every change and release | Block release; repair the boundary and add a reproducing test. |
| Engineering | `server.js` | Require same-origin requests and CSRF tokens for authenticated state changes. | Same-origin and CSRF tests in `test/server-security.test.js` | Every change and release | Block release and invalidate affected sessions if exposure occurred. |
| Engineering | `server.js`, `public/index.html`, `public/app.js`, `public/styles.css` | Serve a CSP with `script-src 'self'` and `style-src 'self'`, no `unsafe-inline`, no objects, and no framing. | Baseline security-header test; live response-header capture | Every change and release | Block release; restore the strict policy before deployment. |
| Engineering | `security.js` | Hash passwords with a memory-hard KDF, generate security tokens with `node:crypto`, and require privileged MFA by default. | Authentication and MFA tests in `test/security.test.js` and `test/server-security.test.js` | Every change and release | Block release; revoke affected sessions or credentials when warranted. |
| Engineering | `security.js`, `server.js` | Apply login and recovery throttling using only trusted proxy data. | Trusted-proxy and recovery-lockout regression tests | Every change and release | Block release; review authentication events for active abuse. |
| Engineering | `runtime-files.js` and runtime stores | Keep runtime paths inside the managed data directory, reject unsafe links, and write JSON atomically. | `test/runtime-files.test.js`, store tests, and server runtime-path tests | Every change and release | Block release; isolate the runtime tree and restore from a known-good backup if corruption occurred. |
| Engineering | `notifications.js` and `url-safety.js` | Restrict server-contacted push endpoints and application navigation targets. | `test/notifications.test.js`, `test/url-safety.test.js`, service-worker routing tests | Every change and release | Block release; disable the affected integration until validation is restored. |

## Windows host controls

These controls must be verified on the actual host running the production process.

| Owner | Enforcement point | Minimum action | Evidence | Frequency | Failure response |
|---|---|---|---|---|---|
| IT | NTFS permissions on `C:\ProgramData\Palziv\runtime` | Restrict the runtime ACL to `SYSTEM`, `BUILTIN\Administrators`, and the approved service account; disable inheritance and remove broad user groups. | Dated `icacls C:\ProgramData\Palziv\runtime /save` output stored in the restricted operations evidence directory | Monthly and after installation, restore, or service-account changes | Stop the service if unauthorized principals have access; repair permissions and review the tree for disclosure or tampering. |
| IT | Windows service or scheduled-task identity | Run Node and cloudflared under approved least-privilege identities; do not use an interactive daily-use account. | Scheduled-task or service configuration export with secrets redacted | Quarterly and after task changes | Disable the incorrect task, correct the identity, rotate exposed credentials, and restart under the approved account. |
| IT | BitLocker or equivalent volume protection | Enable volume encryption for runtime data, logs, backups, and temporary files, with recovery keys held outside the host. | Redacted `manage-bde -status` output and key-custody record | Quarterly | Treat an unencrypted production volume as a data-protection exception; restrict service until approved or remediated. |
| IT | Windows Time service | Keep time synchronization enabled and confirm the host offset is within the organization's incident-response tolerance. | Dated `w32tm /query /status` output | Monthly and after clock or domain changes | Correct synchronization immediately; annotate affected logs with the observed offset. |
| IT | Windows Update and Node.js runtime | Apply critical security patches within 72 hours, high-severity patches within 7 days, moderate patches within 30 days, and other supported updates within 90 days. | Patch inventory, Node version output, and approved exception records | Weekly review and before each release | Open a tracked exception with compensating controls or remove the exposed service until patched. |
| IT | Host firewall and listener configuration | Bind the application only as required for the tunnel and block direct public access to the Node listener. | Firewall export, listener inventory, and external origin-reachability check | Monthly and after network changes | Block direct exposure immediately and rotate session or application secrets if the origin was publicly reachable. |
| IT | Endpoint protection and administrative access | Keep endpoint protection active and restrict local or remote administrative access to named administrators with MFA where supported. | Protection status and administrator-group review | Monthly | Remove unauthorized administrators, isolate the host when compromise is suspected, and begin incident response. |

## Cloudflare controls

Cloudflare terminates public TLS and carries traffic to the private Windows origin through the named tunnel.

| Owner | Enforcement point | Minimum action | Evidence | Frequency | Failure response |
|---|---|---|---|---|---|
| IT | Cloudflare SSL/TLS policy | Permit TLS 1.2 and TLS 1.3 only, prefer TLS 1.3, keep a publicly trusted certificate active, and redirect user-facing HTTP traffic to HTTPS. | Dated Cloudflare SSL/TLS settings export plus an external TLS scan | Quarterly and after zone changes | Roll back the change or disable public access until trusted HTTPS is restored. |
| IT | Cloudflare Tunnel ingress | Route only the approved production hostname and application service to the expected local listener; return an explicit terminal 404 for unmatched ingress. | Redacted tunnel configuration and dashboard route export | Monthly and after tunnel changes | Remove unauthorized ingress, rotate tunnel credentials, and inspect access logs. |
| IT | Origin exposure | Keep inbound public firewall ports closed so the origin is reachable only through the tunnel or approved local administration. | External port scan and Windows firewall export | Monthly | Block the exposed port immediately and investigate all access during the exposure window. |
| IT | Proxy identity boundary | Set `TRUST_PROXY_ADDRESSES` only to the actual local proxy path and set `PUBLIC_BASE_URL` to the canonical HTTPS production origin. | Redacted scheduled-task environment and `/api/health/diagnostics` configuration output from a privileged session | Each deployment and after tunnel changes | Stop the service if forwarded headers can be spoofed; correct configuration before restart. |
| IT | Cloudflare account access and change history | Require MFA for Cloudflare administrators, keep at least two named administrators, and review zone and tunnel changes. | Account-access review and audit-log export | Monthly | Revoke unexpected access, rotate tunnel credentials, and begin incident review. |
| IT | cloudflared lifecycle | Run a supported cloudflared version and apply critical fixes within 72 hours, high-severity fixes within 7 days, and other supported updates within 90 days. | `cloudflared --version`, release review, and exception record | Weekly review | Upgrade or disable the affected tunnel until a compensating control is approved. |

## Operator controls

These controls depend on recurring human or automated operations.

| Owner | Enforcement point | Minimum action | Evidence | Frequency | Failure response |
|---|---|---|---|---|---|
| Operations | Runtime backup task | Create a protected runtime backup, validate its manifest, retain daily backups for 14 days and weekly backups for 8 weeks, and keep at least one separate protected copy. | Backup zip, manifest, task history, and storage-location review | Daily, with weekly review | Repair the task the same day; create a manual backup and open an incident if the recovery point objective was missed. |
| Operations | Restore process | Restore the newest approved backup into an isolated runtime path, start a test instance, and verify authentication, board data, and push configuration integrity without sending live notifications. | Dated restore-test record containing backup ID, manifest result, test results, and operator | Quarterly and before a major migration | Do not rely on the failed backup; preserve evidence, select an earlier backup, and repair the backup or restore process. |
| IT | Secret rotation | Inventory bootstrap, recovery, Resend, VAPID, tunnel, and administrative recovery secrets; rotate them every 90 days and immediately after personnel changes, disclosure, or suspected compromise. | Redacted secret inventory with owner, creation date, rotation date, and revocation confirmation | Monthly review; rotation at least every 90 days | Revoke and rotate the affected secret, invalidate dependent sessions, and review security logs. |
| IT and HR | Security log review | Review failed authentication, recovery, MFA-policy changes, privileged account changes, diagnostics access, tunnel health, and watchdog failures. | Dated review record with event counts, anomalies, and disposition | Business days for authentication alerts; weekly consolidated review | Escalate suspicious activity, preserve logs, revoke affected access, and follow the incident-response runbook. |
| IT | Log retention and integrity | Restrict log access, retain security-relevant logs for at least 90 days, back them up separately, and prevent ordinary app users from modifying them. | Log ACL export, retention configuration, and archive inventory | Monthly | Correct permissions or retention; treat unexplained gaps or changes as potential tampering. |
| Engineering | Dependency and supply-chain review | Run `npm audit --omit=dev`, review the lockfile diff, and use maintained package sources. Remediate critical issues within 72 hours, high within 7 days, moderate within 30 days, and low within 90 days. | Audit output, lockfile review, release notes, and approved exception record | Weekly and every release | Block release when the SLA is exceeded unless a documented compensating control is approved. |
| Engineering and IT | Cryptographic inventory | Record password hashing, session secrets, MFA seeds, VAPID keys, recovery secrets, TLS certificates, tunnel credentials, owners, storage locations, and rotation methods. | Restricted cryptographic inventory without secret values | Quarterly and after cryptographic changes | Stop introducing new keys, identify the unknown material, assign ownership, and rotate if custody cannot be established. |
| Product owner and IT | Account and role review | Confirm active employee and privileged accounts, role assignments, backup IT access, and stale sessions. | Signed account-access review with removals and exceptions | Monthly and after personnel changes | Disable stale or unauthorized access immediately and review activity during the unauthorized period. |

## Independent verification controls

These controls must be performed by someone sufficiently independent from the implementation under review.

| Owner | Enforcement point | Minimum action | Evidence | Frequency | Failure response |
|---|---|---|---|---|---|
| Independent application-security assessor | OWASP ASVS 5.0.0 Level 2 | Review every applicable Level 1 and Level 2 requirement, reproduce cited controls, document not-applicable rationale, and preserve requirement-specific evidence. | Signed ASVS matrix, scope, tested version, methods, exceptions, and final report | Annually and after a material security-architecture change | Do not claim ASVS Level 2 verification; create remediation owners and deadlines for every gap. |
| Independent penetration test provider | Production-equivalent application and API | Perform authenticated role-boundary, IDOR/BOLA, injection, stored XSS, CSRF, session, recovery, MFA, file-handling, SSRF, rate-limit, business-logic, and deployment tests. | Penetration test report, retest evidence, tested commit, and environment scope | Annually and after a material authentication, authorization, or hosting change | Triage immediately; repair critical and high findings before continued broad production use and require retesting. |
| IT assessor independent of daily operations | Windows and Cloudflare configuration | Verify runtime ACL, disk encryption, listener exposure, service identity, TLS policy, certificate trust, tunnel ingress, account MFA, logs, patch status, backup evidence, and restore evidence. | Signed host and Cloudflare configuration review | Semiannually | Correct exposed boundaries immediately and track remaining exceptions to closure. |
| Disaster-recovery observer | Backup and restore workflow | Witness an isolated restore and confirm that the evidence matches the selected backup and documented recovery objectives. | Witnessed restore report | Annually | Treat recovery readiness as failed until a successful restore is observed. |

## Matrix maintenance

Run:

```powershell
node scripts/build-asvs-level2-matrix.mjs
node --test test/asvs-compliance.test.js
```

The generator downloads the official OWASP ASVS 5.0.0 CSV from the pinned `v5.0.0` tag, keeps all Level 1 and Level 2 requirements, and merges the local evidence records from `asvs-5.0-level2-assessments.json`.

Status changes must follow these rules:

- `Verified`: complete requirement-specific evidence exists and is current.
- `Partial`: a control exists, but a requirement condition or evidence item remains open.
- `Not verified`: the control is absent, known to be insufficient, or outside its remediation deadline.
- `Not applicable`: the technology or flow is absent and the rationale is recorded.
- `Not assessed`: no requirement-specific conclusion has been reached.

Do not bulk-promote related requirements. A passing test for one authentication behavior does not prove every authentication, session, authorization, or logging requirement.
