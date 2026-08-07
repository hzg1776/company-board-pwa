# Project-A Manual Index

**Last reviewed:** August 7, 2026
**Application revision reviewed:** `deae9f1`

This file is the starting point for finding Project-A manuals and deciding whether a document is safe to use.

## Authority Rules

1. Use the generated files under `docs/manual-artifacts/` for distribution only when their generated date matches the current reviewed source.
2. Use the matching Markdown file under `docs/` as the editable source.
3. Treat documents marked `Needs refresh` or `Partial` as references, not complete operator procedures.
4. Files under `.worktrees/`, `output/`, `tmp/`, or an external USB package are not the main-branch authority unless an approved runbook explicitly says otherwise.
5. Never distribute browser storage-state JSON, credentials, recovery keys, setup secrets, or MFA material with a manual bundle.

## Current User And Training Manuals

| Manual | Location | Status | Audience |
| --- | --- | --- | --- |
| Quick Start | `docs/QUICK_START_MANUAL.md` | Current - verified August 7, 2026 | Employees, HR, Systems, IT |
| Quick Start PDF/HTML | `docs/manual-artifacts/Communications_And_Alert_Center_Quick_Start.pdf` and `.html` | Current after the August 6 rebuild | Distribution copy |
| Full User Manual | `docs/USER_MANUAL.md` | Current - verified August 7, 2026 | Employees and all admin roles |
| Full User Manual PDF/HTML | `docs/manual-artifacts/Communications_And_Alert_Center_User_Manual.pdf` and `.html` | Current after the August 6 rebuild | Distribution copy |
| Black/Blank Screen Guide | `docs/BEGINNER_BLACK_SCREEN_GUIDE.md` plus `docs/manual-artifacts/black-screen-guide/Beginner_Black_Screen_Guide.pdf` | Current - public health first; protected diagnostics for Systems/IT | Employees and support |
| Test Group Rollout Guide | `docs/TEST_GROUP_ROLLOUT_GUIDE.md` | Current targeted-delivery workflow; confirm the named roster before use | Pilot operator and HR |
| Rollout Announcements | `docs/ROLLOUT_ANNOUNCEMENTS.md` | Mostly current; deployment-specific copy needs owner review before reuse | Rollout coordinator |

## Manual Build And Maintenance

| Document or tool | Location | Status |
| --- | --- | --- |
| Manual build guide | `docs/MANUAL_BUILD_GUIDE.md` | Current |
| Full/quick manual builder | `scripts/build-user-manual-pdf.ps1` | Current after August 7 release verification |
| Optional auth-state helper | `scripts/capture-manual-screenshots.mjs` | Use only through the builder with disposable nonproduction accounts; MFA-enforced sessions are rejected |
| Black-screen guide builder | `scripts/build-beginner-black-screen-guide-pdf.ps1` | Current after August 7 release verification; build only against a safe local/demo runtime |

## Operator, Deployment, And Governance Documents

These are part of the documentation set, but they are not all current.

| Document | Location | Freshness verdict | Main issue |
| --- | --- | --- | --- |
| Project overview and local run guide | `README.md` | Partial | Core routes/port are useful; feature and production guidance is incomplete |
| Access control list | `ACCESS_CONTROL_LIST.md` | Needs refresh | Omits the implemented IT role and contains outdated role/UI claims |
| Windows + Cloudflare deployment | `DEPLOY_CLOUDFLARE.md` | Partial - high risk for upgrades | Does not define a verified stop/restart/served-revision release procedure |
| Operations runbook | `docs/OPERATIONS_RUNBOOK.md` | Stale - do not use its June rollback baseline | Names an obsolete release and backup as current |
| Rollback procedure | `docs/ROLLBACK.md` | Stale - do not use its June rollback baseline | Current release authority and recovery point are not documented |
| Backup and restore | `docs/BACKUP_AND_RESTORE.md` | Partial | Commands match scripts, but integrity verification and a safe restore drill are missing |
| Pilot launch checklist | `docs/PILOT_LAUNCH_CHECKLIST.md` | Needs refresh | Omits current IT/MFA/group-targeting and current release authority |
| Pilot onboarding | `docs/PILOT_ONBOARDING.md` | Needs refresh | Predates current IT/MFA/group-targeting workflows |
| Secret rotation | `docs/SECRET_ROTATION.md` | Incomplete | Missing complete IT, MFA, Cloudflare, invitation, and VAPID custody procedures |
| IT role model | `docs/OWNER_ROLE_MODEL.md` | Partly obsolete | Still labels implemented IT UI work as future work and mentions removed acknowledgements |
| OWASP operational controls | `docs/security/OWASP_OPERATIONAL_CONTROLS.md` | Useful policy, not current proof | Several required host/backup controls do not have current operator evidence |

## Migration And Handoff Instructions

| Document set | Location | Status |
| --- | --- | --- |
| Debian host-prep easy instructions | `DEBIAN-HOST-PREP-EASY-INSTRUCTIONS.txt` | Current for its exact one-attempt guarded handoff; not a general deployment runbook |
| USB migration bundle source instructions | `deploy/usb-migration/README-FIRST.txt` and `ISOLATION-BOUNDARY.txt` | Current bundle-source templates |
| USB host-prep bundle source instructions | `deploy/usb-host-prep/README-FIRST.txt` and `ISOLATION-BOUNDARY.txt` | Current bundle-source templates |
| Proxmox migration runbook and generated DOCX | `.worktrees/proxmox-migration/docs/PROXMOX_MIGRATION_RUNBOOK.md` and `docs/manual-artifacts/Project-A-Proxmox-Migration-Runbook.docx` inside that worktree | Working-copy artifacts, not main-branch authority |
| Two-phase migration easy instructions | `.worktrees/proxmox-migration/docs/USB-TWO-PHASE-MIGRATION-EASY-INSTRUCTIONS.txt` | Working-copy artifact; use only through the approved USB handoff process |

The migration worktree contains multiple evolving paths. Do not improvise between generic VM, two-phase USB, and appliance instructions. Follow only the currently approved phase and require the expected operator evidence before cutover.

## Legacy Or Non-Authoritative Outputs

| File | Status |
| --- | --- |
| `output/pdf/Palziv_Phone_Installation_Guide.pdf` | Legacy, ignored output from July 10. It uses the old `Subscribe` label and has no maintained source in the main docs set. Use the current Quick Start instead. |
| `artifacts/audits/**` and `output/playwright/**` | QA evidence, not manuals. Screens may show older UI. |
| `docs/superpowers/specs/**` and `docs/superpowers/plans/**` | Engineering design/history, not operator or end-user manuals. |
| `docs/DESIGN_SYSTEM_TEMPLATE.md` | Engineering design reference, not an app-use manual. |
| `docs/CODEX_MCP_TOOLING_CHECKLIST.md` | Engineering tooling reference, not an app-use manual. |

## Next Documentation Priority

The user manuals are refreshed. The next required documentation project is a production-operator refresh covering:

1. One authoritative Windows production release and served-revision verification procedure.
2. A current rollback authority and recovery-point process without hard-coded retired backups.
3. Integrity-checked backup/restore and a documented restore drill.
4. Updated access-control, IT/MFA, pilot, and secret-custody procedures.
5. One approved migration path with superseded working instructions clearly archived.
