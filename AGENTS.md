# AGENTS.md

## Working Agreement

Work as a senior product engineer and UI implementation agent for this repo. Prefer completed, verified work over explanation. Inspect the current project structure, UI patterns, CSS cascade, scripts, and documentation before changing files.

When the safe next action is clear, do it directly. Ask first only when the decision affects cost, credentials, production data, privacy, legal exposure, destructive operations, or core product direction.

## Project Map

- `server.js` owns the HTTP server, API routes, runtime configuration, and route delivery.
- `security.js` owns authentication, sessions, managed accounts, recovery flows, and access boundaries.
- `public/app.js` owns the client router, rendered UI, interaction handlers, and visible copy.
- `public/styles.css` is the design system source of truth for tokens, layout, components, responsive rules, and late override layers.
- `test/ui-design-contract.test.js` is the fast contract layer for important visual and CSS behavior.
- `weather.js`, `notifications.js`, `analytics.js`, `storage.js`, and `runtime-files.js` own shared app services.
- `docs/` contains operator, manual, launch, backup, rollback, and security runbooks.

Keep context focused on the files that affect the requested change. Do not read or rewrite unrelated files.

## Existing Design System

Follow the existing CSS system before introducing new styles:

- Tokens live in `public/styles.css` under `:root` and late override token blocks.
- The current UI font is `Arial, sans-serif`.
- Core colors include `--bg`, `--surface`, `--ink`, `--muted`, `--line`, `--steel`, `--signal`, `--ok`, `--danger`, and status tone variables.
- Radius tokens are `--radius-control`, `--radius-card`, `--radius-panel`, and `--radius-soft`.
- Shared controls use `.button`, `.ghost-button`, `.icon-button`, `.tab-button`, pill/chip classes, `.field`, `.panel-card`, `.notice-card`, `.empty-state`, `.page-shell`, `.page-head`, and `.page-actions`.
- Late cascade rules near the bottom of `public/styles.css` intentionally normalize shared pills, typography, card density, page widths, and mobile behavior. Check the final cascade before assuming an earlier rule wins.
- When changing a deliberate CSS contract, update `test/ui-design-contract.test.js` with the same final-cascade expectation.

Do not add Tailwind, a new component library, or new UI dependencies unless the user approves and there is a clear product need.

## Visual Style Rules

- Build operational, scan-friendly interfaces for repeated business use.
- Keep layouts dense but readable; avoid oversized marketing-style hero layouts for admin and employee workflows.
- Use the established light operational palette, borders, compact spacing, rounded controls, and restrained surfaces.
- Do not introduce random gradients, neon colors, unapproved fonts, heavy shadows, decorative blobs, or one-off button/card styles.
- Use icons only when they improve scannability, and keep icon-only actions labeled with `aria-label` or visible text.
- Treat visible wording, role labels, help text, date formatting, and manual text as product correctness.

## Accessibility Rules

All UI changes must consider:

- Semantic HTML where practical.
- Keyboard-reachable controls.
- Visible focus states.
- Sufficient text/background contrast.
- Labels for inputs and clear button/link text.
- Reasonable touch targets.
- Screen-reader-friendly labels for icons, status, and error states.
- Clear error messages that do not expose sensitive data.

## Responsiveness Rules

When UI changes are made, check mobile, tablet, desktop, and large desktop behavior when the app can run. Use the relevant route and at least these representative widths when practical:

- Mobile: about `390px`
- Tablet: about `768px`
- Desktop: about `1366px`
- Large desktop: about `1440px` or wider

Verify no horizontal overflow, broken navigation, clipped text, unreadable controls, layout shift, stale loading state, or overlapping UI.

## Verification Commands

Use the commands that exist in this repo. Do not claim unavailable commands were run.

- Start locally on the expected host port:
  ```powershell
  $env:PORT = "3116"; npm start
  ```
- Default ad hoc server when `PORT` is unset:
  ```powershell
  npm start
  ```
- Fast syntax checks:
  ```powershell
  node --check public/app.js
  node --check server.js
  node --check security.js
  ```
- Targeted visual contract test:
  ```powershell
  node --test test/ui-design-contract.test.js
  ```
- Full test suite:
  ```powershell
  npm test
  ```
- Whitespace and patch hygiene:
  ```powershell
  git diff --check
  ```

This repo does not currently define formatter, linter, type-check, or build scripts in `package.json`. Report those as unavailable instead of inventing substitutes.

## Visual QA Rules

When the project can run locally:

1. Start the app on port `3116` unless the task requires another port.
2. Check the relevant route, usually one of:
   - `http://localhost:3116/palzivalerts`
   - `http://localhost:3116/palzivalerts/employee`
   - `http://localhost:3116/palzivalerts/hr`
   - `http://localhost:3116/palzivalerts/webmaster`
   - `http://localhost:3116/palzivalerts/it`
3. Inspect page identity, visible content, console errors, layout, interaction state, and responsive breakpoints.
4. Fix obvious layout drift, overflow, broken interactions, or polish issues caused by the current task.
5. Report exactly what was checked and what remains unverified.

`/api/health` only proves the server is alive. Use a real page route for UI verification.

## Figma and References

Use Figma-based guidance only when a Figma file, screenshot, reference image, or design brief is available. When citing Figma-based guidance, include the original article title, file name, or URL from available reference metadata. Do not invent Figma guidelines, source titles, URLs, design rules, or library details.

If no visual reference exists, state that clearly and follow the existing Project-A design system.

## MCP and External Tool Rules

Use external tools only when they solve a real workflow problem:

- Browser inspection is useful for rendered UI QA.
- Playwright screenshot scripts are useful for manual artifacts and responsive checks.
- Figma MCP is useful only if the design source actually lives in Figma.
- Accessibility tooling is useful when forms, dashboards, and public flows change.
- Visual regression tooling is useful after stable screens need repeated review.

Do not add tools or dependencies just because they are available.

## Definition of Done

A task is not done until:

- The requested change is implemented or the blocker is documented.
- The design follows the existing system.
- Responsive behavior has been considered.
- Relevant commands were run or unavailable commands were documented.
- No unrelated files were changed.
- No unnecessary dependencies were added.
- Remaining risks are clearly listed.
- The final response includes files changed, commands run, verification result, visual QA result, and next best action.

## Required Final Response Format

For meaningful build, debugging, architecture, product, or strategy tasks, use:

```text
## Result
## CEO Brief
## Technical Details
## How to Test
## What Still Needs Attention
## Next Action I Will Perform
```

For design-workflow audits, use the `design-workflow-audit` compliance report format.
