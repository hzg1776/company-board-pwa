# ASVS Level 2 and Strict CSP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a reproducible OWASP ASVS 5.0.0 Level 2 compliance matrix, remove all `unsafe-inline` allowances from the application CSP, and document the security controls that depend on Windows and Cloudflare operations.

**Architecture:** Keep browser configuration synchronous without inline JavaScript by serving it from a same-origin `/app-config.js` endpoint before the ES module. Replace the two application-generated inline-style cases with shared CSS classes so `style-src 'self'` is enforceable. Generate the complete Level 2 matrix from OWASP's pinned v5.0.0 CSV and merge repository-owned evidence records without treating unreviewed requirements as passing.

**Tech Stack:** Node.js 22, native Node test runner, HTML, CSS, PowerShell for verification, OWASP ASVS 5.0.0 CSV.

## Global Constraints

- Do not add dependencies.
- Preserve the existing `/palzivalerts` route family, PWA behavior, site configuration, and user-visible UI.
- Preserve unrelated untracked phone-installation guide files.
- Never mark an ASVS requirement compliant without repository or operational evidence.
- Do not create a commit or push changes unless the user separately requests it.

---

### Task 1: Strict CSP and external application configuration

**Files:**
- Modify: `test/server-security.test.js`
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Modify: `server.js`

**Interfaces:**
- Consumes: `renderIndexHtml()`, `resolveAssetVersion()`, `siteConfig`, and the static-route dispatcher in `server.js`.
- Produces: `GET /app-config.js`, which assigns a safely serialized object to `window.__BOARD_CONFIG__` with `Content-Type: text/javascript; charset=utf-8` and `Cache-Control: no-store`.

- [ ] **Step 1: Write the failing security regression test**

Add assertions to the existing baseline-security-header integration test:

```js
assert.doesNotMatch(csp, /'unsafe-inline'/);
assert.match(csp, /script-src 'self'/);
assert.match(csp, /style-src 'self'/);
assert.doesNotMatch(shellHtml, /<script>(?!\s*<\/script>)/);
assert.match(shellHtml, /<script src="\/app-config\.js\?v=[^"]+"><\/script>/);

const configResponse = await fetch(`${server.baseUrl}/app-config.js`);
assert.equal(configResponse.status, 200);
assert.match(configResponse.headers.get("content-type") || "", /^text\/javascript/);
assert.equal(configResponse.headers.get("cache-control"), "no-store");
assert.match(await configResponse.text(), /^window\.__BOARD_CONFIG__ = /);
```

- [ ] **Step 2: Verify the test fails for the current weakness**

Run: `node --test --test-name-pattern="baseline security headers" test/server-security.test.js`

Expected: FAIL because the current CSP contains `'unsafe-inline'` and the shell contains an inline configuration script.

- [ ] **Step 3: Implement the external configuration boundary**

Change the CSP directives to:

```js
"script-src 'self'",
"style-src 'self'",
```

Replace `<!-- BOARD_CONFIG -->` with:

```html
<script src="/app-config.js?v=__ASSET_VERSION__"></script>
```

Add a handler that returns:

```js
window.__BOARD_CONFIG__ = ${serializeForScript({
  ...siteConfig,
  assetVersion
})};
```

before `app.js` executes.

- [ ] **Step 4: Remove application inline styles**

Change the clipboard textarea to use `className = "clipboard-fallback-input"` and the MFA QR image to use `class="authenticator-qr-code"`. Add the following shared CSS:

```css
.clipboard-fallback-input {
  position: fixed;
  top: -9999px;
  opacity: 0;
}

.authenticator-qr-code {
  width: 100%;
  max-width: 220px;
  height: auto;
}
```

- [ ] **Step 5: Verify strict CSP behavior**

Run: `node --test --test-name-pattern="baseline security headers" test/server-security.test.js`

Expected: PASS with no `unsafe-inline` token, an external configuration script, and a working same-origin configuration response.

---

### Task 2: Reproducible ASVS 5.0.0 Level 2 matrix

**Files:**
- Create: `scripts/build-asvs-level2-matrix.mjs`
- Create: `docs/security/asvs-5.0-level2-assessments.json`
- Generate: `docs/security/ASVS_5.0_LEVEL_2_MATRIX.csv`
- Create: `test/asvs-compliance.test.js`

**Interfaces:**
- Consumes: the pinned OWASP source URL `https://raw.githubusercontent.com/OWASP/ASVS/v5.0.0/5.0/docs_en/OWASP_Application_Security_Verification_Standard_5.0.0_en.csv`.
- Produces: a deterministic 253-row CSV containing all requirements whose original ASVS level is 1 or 2, plus Project-A status, evidence, owner, and notes.

- [ ] **Step 1: Write the failing artifact-contract test**

The test must assert:

```js
assert.equal(rows.length, 253);
assert.deepEqual(new Set(rows.map((row) => row.status)), new Set(["Not assessed"]));
assert.ok(rows.every((row) => /^V\d+\.\d+\.\d+$/.test(row.requirement_id)));
assert.ok(rows.every((row) => ["1", "2"].includes(row.asvs_level)));
```

The status-set assertion is updated only after evidence-backed assessment records are added.

- [ ] **Step 2: Verify the test fails because the matrix does not exist**

Run: `node --test test/asvs-compliance.test.js`

Expected: FAIL with a missing matrix file.

- [ ] **Step 3: Implement the generator and assessment source**

The generator must:

1. Download only the pinned ASVS v5.0.0 CSV.
2. Parse quoted CSV fields without third-party dependencies.
3. Retain Level 1 and Level 2 rows.
4. Merge records by `req_id` from `asvs-5.0-level2-assessments.json`.
5. Reject unknown IDs, duplicate IDs, invalid statuses, or missing evidence for `Verified` and `Partial` records.
6. Write stable CSV columns:

```text
requirement_id,chapter,section,requirement,asvs_level,status,evidence,control_owner,notes
```

Allowed statuses are `Verified`, `Partial`, `Not verified`, `Not applicable`, and `Not assessed`.

- [ ] **Step 4: Add evidence-backed assessments**

Record only controls proved by current code, tests, or operational documentation. Keep every unresolved requirement as `Not assessed` or `Not verified`; do not infer compliance from a related control.

- [ ] **Step 5: Generate and verify the matrix**

Run:

```powershell
node scripts/build-asvs-level2-matrix.mjs
node --test test/asvs-compliance.test.js
```

Expected: 253 rows, unique requirement IDs, valid statuses, and evidence for every non-default assessed row.

---

### Task 3: Operational control boundary

**Files:**
- Create: `docs/security/OWASP_OPERATIONAL_CONTROLS.md`
- Modify: `docs/security/asvs-5.0-level2-assessments.json`
- Regenerate: `docs/security/ASVS_5.0_LEVEL_2_MATRIX.csv`
- Modify: `test/asvs-compliance.test.js`

**Interfaces:**
- Consumes: `DEPLOY_CLOUDFLARE.md`, `docs/OPERATIONS_RUNBOOK.md`, `docs/BACKUP_AND_RESTORE.md`, `docs/SECRET_ROTATION.md`, and `ACCESS_CONTROL_LIST.md`.
- Produces: an owner/action/evidence/frequency table distinguishing application-enforced, Windows-host, Cloudflare, operator, and independent-assessor controls.

- [ ] **Step 1: Add a failing documentation contract**

Assert that the operational document includes these exact ownership sections:

```text
Application-enforced controls
Windows host controls
Cloudflare controls
Operator controls
Independent verification controls
```

Also assert it contains review frequencies and evidence locations for runtime ACLs, TLS, tunnel configuration, backups, restore tests, secret rotation, log review, time synchronization, patching, and penetration testing.

- [ ] **Step 2: Verify the documentation test fails**

Run: `node --test test/asvs-compliance.test.js`

Expected: FAIL because the operational-control document is absent.

- [ ] **Step 3: Write the operational-control document**

Document each control with:

- owner
- enforcement point
- minimum action
- evidence artifact
- verification frequency
- failure response

State explicitly that source code cannot guarantee Windows ACLs, Cloudflare TLS policy, backup retention, log review, patch cadence, key custody, or independent penetration testing.

- [ ] **Step 4: Link operational evidence into the matrix**

Add only the applicable requirement IDs supported by the operational-control document, regenerate the matrix, and rerun the compliance test.

Expected: PASS with the same 253-row scope and no unsupported `Verified` status.

---

### Task 4: Final verification

**Files:**
- Verify all files changed in Tasks 1-3.

**Interfaces:**
- Consumes: the strict CSP implementation and both compliance artifacts.
- Produces: fresh automated, dependency, patch-hygiene, and live-route evidence.

- [ ] **Step 1: Run focused checks**

```powershell
node --check server.js
node --check public/app.js
node --test test/server-security.test.js test/asvs-compliance.test.js
```

- [ ] **Step 2: Run the complete repository suite and dependency audit**

```powershell
npm test
npm audit --omit=dev
```

- [ ] **Step 3: Inspect patch scope**

```powershell
git diff --check
git diff -- server.js public/index.html public/app.js public/styles.css test/server-security.test.js test/asvs-compliance.test.js scripts/build-asvs-level2-matrix.mjs docs/security
```

- [ ] **Step 4: Verify the running route**

Start the patched application on an unused local port and verify:

- `/palzivalerts` returns 200.
- CSP contains `script-src 'self'` and `style-src 'self'`.
- CSP contains no `unsafe-inline`.
- `/app-config.js` returns 200 with same-origin JavaScript configuration.
- `/api/health/diagnostics` returns 401 without a privileged session.
- The page renders without console errors at approximately 390, 768, 1366, and 1440 pixels.

- [ ] **Step 5: Report remaining uncertainty**

State that the matrix is an evidence register, not an OWASP certification, and list every requirement still marked `Partial`, `Not verified`, or `Not assessed`.
