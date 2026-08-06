# Role-Specific iPhone Web Apps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an iPhone Home Screen app saved from the HR route reopen HR while preserving the existing Employee app launch and notification behavior.

**Architecture:** Keep `/manifest.webmanifest` as the backward-compatible Employee manifest and add `/manifest-hr.webmanifest` as a distinct HR manifest. The server will render route-aware manifest metadata into the shared HTML shell, and both manifests will use stable, distinct IDs and start URLs under the existing `/palzivalerts/` scope.

**Tech Stack:** Node.js HTTP server, Web Application Manifest JSON, service worker caching, Node test runner.

## Global Constraints

- Do not change authentication, HR authorization, MFA, cookies, or runtime data.
- Do not expose HR from the Employee manifest or Employee Home Screen app.
- Preserve `/manifest.webmanifest` for existing Employee installations.
- Add no dependencies and do not modify unrelated dirty files.
- Production promotion requires a fresh runtime backup, a confirmed listener replacement on port `3116`, live manifest checks, and public diagnostics remaining `401`.

---

### Task 1: Define the route-specific install contract

**Files:**
- Modify: `test/server-security.test.js:2646`
- Create: `test/app-routing.test.js`

**Interfaces:**
- Consumes: the existing `startServer(...)` integration-test helper and public HTTP routes.
- Produces: a regression contract for route-specific HTML manifest links and Employee/HR manifest payloads.

- [ ] **Step 1: Replace the single-manifest assertion with failing route-specific assertions**

  Request `/palzivalerts/employee` and assert that its HTML links `/manifest.webmanifest`. Request `/palzivalerts/hr` and assert that its HTML links `/manifest-hr.webmanifest` and uses the `Alert Center HR` Apple app title. Fetch both manifests and assert these hand-derived values:

  ```text
  Employee id/start_url: /palzivalerts/employee
  HR id/start_url:       /palzivalerts/hr
  Shared scope:          /palzivalerts/
  ```

  Assert that the Employee manifest has no HR, Systems, or IT shortcut. Assert that the HR manifest does not advertise Employee, Systems, or IT shortcuts.

- [ ] **Step 2: Run the focused test and verify RED**

  Run:

  ```powershell
  node --test --test-name-pattern="role-specific install manifests" test/server-security.test.js
  ```

  Expected result: failure because `/palzivalerts/hr` still links `/manifest.webmanifest` and `/manifest-hr.webmanifest` does not exist.

- [ ] **Step 3: Add the failing SPA transition test**

  Assert that navigation between HR and any non-HR route requires a document reload, while navigation among Launcher, Employee, Systems, and IT can remain client-side. Run `node --test test/app-routing.test.js` and expect the Launcher-to-HR case to fail before implementation.

### Task 2: Implement route-specific manifest delivery

**Files:**
- Create: `public/app-routing.js`
- Modify: `public/app.js:1-6,5118-5144`
- Modify: `public/index.html:10-12`
- Modify: `server.js:738-874`
- Modify: `server.js:3274-3318`
- Modify: `public/sw.js:5-14`

**Interfaces:**
- Consumes: the requested page pathname and existing `appPath(...)` helper.
- Produces: `installProfileForPath(pathname)`, `requiresInstallProfileReload(currentRoute, nextRoute)`, route-aware HTML metadata, the legacy Employee manifest, and a distinct HR manifest endpoint.

- [ ] **Step 1: Make the shared HTML shell route-aware**

  Replace the fixed Apple app title and manifest link with server placeholders. Render `Alert Center HR` plus `/manifest-hr.webmanifest` only for `/palzivalerts/hr`; retain `Alert Center` plus `/manifest.webmanifest` everywhere else.

- [ ] **Step 2: Add stable Employee and HR manifest profiles**

  Preserve `/manifest.webmanifest` as Employee and add `/manifest-hr.webmanifest` as HR. Include explicit IDs equal to each route's existing start URL so Employee identity remains compatible with the old implicit-ID fallback.

- [ ] **Step 3: Keep install metadata available offline**

  Add `/manifest-hr.webmanifest` and the versioned `app-routing.js` module to the service-worker shell asset list while retaining `/manifest.webmanifest`.

- [ ] **Step 4: Reload the document when the install profile changes**

  Use `window.location.assign(nextPath)` when navigation crosses between HR and a non-HR route so Safari fetches the manifest for the destination document. Retain `history.pushState` for same-profile navigation.

- [ ] **Step 5: Run the focused tests and verify GREEN**

  Run:

  ```powershell
  node --test --test-name-pattern="role-specific install manifests" test/server-security.test.js
  node --test test/app-routing.test.js
  ```

  Expected result: the focused regression test passes.

### Task 3: Verify and release

**Files:**
- Verify only: `server.js`, `public/app.js`, `security.js`, `public/sw.js`
- Commit only: `server.js`, `public/index.html`, `public/app.js`, `public/app-routing.js`, `public/sw.js`, `test/app-routing.test.js`, `test/server-security.test.js`, and this plan

**Interfaces:**
- Consumes: the tested release tree and existing Windows/Cloudflare scripts.
- Produces: a committed release, a fresh runtime backup, a restarted production listener, and live evidence for both app identities.

- [ ] **Step 1: Run local verification**

  ```powershell
  node --check server.js
  node --check public/app.js
  node --check security.js
  node --check public/sw.js
  node --test test/server-security.test.js
  node --test test/app-routing.test.js
  node --test test/service-worker-routing.test.js
  npm test
  git diff --check
  ```

- [ ] **Step 2: Review and commit only the approved files**

  Confirm `git diff -- server.js public/index.html public/app.js public/app-routing.js public/sw.js test/app-routing.test.js test/server-security.test.js docs/superpowers/plans/2026-08-06-role-specific-iphone-web-apps.md`, stage those exact paths, and commit with `fix: split employee and HR web app launches`.

- [ ] **Step 3: Prepare the production recovery point**

  ```powershell
  scripts/backup-data.ps1 -RuntimeRoot 'C:\ProgramData\Palziv\runtime'
  ```

- [ ] **Step 4: Promote and restart the actual Project-A listener**

  Integrate the approved release without staging unrelated dirty files. Confirm the process serving port `3116` is the Project-A `server.js` process, replace that listener, and run `scripts/windows-startup.ps1 -SkipCloudflared` with the intended release root.

- [ ] **Step 5: Verify production behavior and security**

  Confirm local and public `/api/health` return success; public `/api/health/diagnostics` returns `401`; `/palzivalerts/employee` links the Employee manifest; `/palzivalerts/hr` links the HR manifest; and the two live manifests have distinct IDs/start URLs. Run a real-browser console check of Employee and HR at mobile width with no release-blocking errors.
