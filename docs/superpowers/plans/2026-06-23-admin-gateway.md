# Admin Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide all privileged sign-in surfaces behind a private admin gateway while preserving normal signed-in admin use.

**Architecture:** Add a dedicated client-side `admin` route that acts as the only unauthenticated entry point for HR, Systems, and IT logins. Track a short-lived gateway pass in app state and browser session storage; unauthenticated direct hits to `/hr`, `/webmaster`, or `/it` are redirected to the launcher unless a valid gateway pass is present.

**Tech Stack:** Vanilla client JavaScript in `public/app.js`, existing Node test harness in `test/server-security.test.js`

---

### Task 1: Define admin gateway route coverage in tests

**Files:**
- Modify: `C:\Users\admin\Documents\Codex\Project-A\test\server-security.test.js`
- Test: `C:\Users\admin\Documents\Codex\Project-A\test\server-security.test.js`

- [ ] **Step 1: Write the failing test**

```js
test("launcher hides admin links and admin routes require gateway entry before login", async (t) => {
  // Start a temp server.
  // Verify launcher HTML includes Employee Login but not HR Login, Systems Login, or IT Login.
  // Verify direct /palzivalerts/hr shows launcher content instead of HR sign-in.
  // Verify /palzivalerts/admin shows the admin gateway choices.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server-security.test.js`
Expected: FAIL because the launcher still exposes HR and direct admin routes still render their login pages.

- [ ] **Step 3: Write minimal implementation**

```js
// Add a browser-style integration test that fetches:
// - /palzivalerts
// - /palzivalerts/hr
// - /palzivalerts/admin
// and asserts the new route gating copy.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/server-security.test.js`
Expected: PASS for the new gateway coverage test.

- [ ] **Step 5: Commit**

```bash
git add test/server-security.test.js
git commit -m "test: cover admin gateway entry flow"
```

### Task 2: Implement launcher and direct-route gateway behavior

**Files:**
- Modify: `C:\Users\admin\Documents\Codex\Project-A\public\app.js`

- [ ] **Step 1: Add gateway state and route helpers**

```js
// Add constants/helpers for:
// - admin routes set
// - sessionStorage key
// - create/read/clear gateway pass
// - route normalization for "admin"
```

- [ ] **Step 2: Gate unauthenticated admin routes**

```js
// Before rendering HR/webmaster/it auth screens:
// - allow if already authorized
// - allow if invite token is present
// - allow if valid gateway pass exists
// - otherwise send the app back to launcher
```

- [ ] **Step 3: Add hidden admin gateway page**

```js
// Render a new /admin screen with:
// - HR Login
// - Systems Login
// - IT Login
// Clicking one grants a short-lived gateway pass and routes to the target login page.
```

- [ ] **Step 4: Remove remaining public admin launcher cards**

```js
// Launcher renders only Employee Login.
```

- [ ] **Step 5: Commit**

```bash
git add public/app.js
git commit -m "feat: add hidden admin gateway"
```

### Task 3: Verify the full change

**Files:**
- Modify: `C:\Users\admin\Documents\Codex\Project-A\public\app.js` (only if verification finds a bug)
- Test: `C:\Users\admin\Documents\Codex\Project-A\test\server-security.test.js`

- [ ] **Step 1: Run focused tests**

Run: `node --test test/server-security.test.js`
Expected: PASS

- [ ] **Step 2: Run full suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 3: Spot-check browser behavior**

```text
Open /palzivalerts and confirm only Employee Login is visible.
Open /palzivalerts/hr directly and confirm it returns to launcher when signed out.
Open /palzivalerts/admin and confirm HR, Systems, and IT choices appear there.
```

- [ ] **Step 4: Commit**

```bash
git add public/app.js test/server-security.test.js docs/superpowers/plans/2026-06-23-admin-gateway.md
git commit -m "docs: add admin gateway plan"
```
