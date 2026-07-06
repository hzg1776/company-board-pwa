# Codex MCP and Tooling Checklist

Use this checklist before adding external tools to Project-A. Add a tool only when it improves a real recurring workflow and can be maintained by the project.

## Current Project-A Tooling State

| Tool / Integration | Status | Use Now | Notes |
|---|---|---:|---|
| Browser inspection | Available in Codex sessions when the Browser plugin is installed | Yes | Use for rendered UI QA, console checks, screenshots, and responsive validation. |
| Playwright screenshots | Used by existing manual artifact scripts | Yes | `scripts/build-user-manual-pdf.ps1`, `scripts/build-beginner-black-screen-guide-pdf.ps1`, and screenshot capture scripts already depend on it. |
| Node test runner | Configured | Yes | `npm test` runs `node --test`; targeted tests can run with `node --test test/<file>.test.js`. |
| UI design contract tests | Configured | Yes | `test/ui-design-contract.test.js` protects CSS/layout contracts. Update it when intentional visual contracts change. |
| Figma MCP | Not configured | Optional | Add only when a real Figma file is the source of truth for a requested design change. |
| Mobbin or inspiration workflow | Not configured | Optional | Use only when visual direction is unclear and the user wants outside references. |
| Accessibility tooling | Not configured | Optional | Useful if form, auth, or dashboard accessibility work becomes recurring. |
| Visual regression tooling | Not configured | Optional | Useful after stable screens need repeated screenshot comparison. |
| Formatter | Not configured in `package.json` | No | Do not claim formatting was run unless a formatter is added. |
| Linter | Not configured in `package.json` | No | Do not claim linting was run unless a linter is added. |
| Type checker | Not configured | No | This is a plain JavaScript app; use syntax checks and tests instead. |
| Build command | Not configured | No | There is no bundling build step currently. |

## Add a Tool Only If

- The needed context lives outside the repository.
- The information changes frequently and manual lookup is error-prone.
- The workflow will be repeated.
- The team can maintain the setup.
- The tool improves quality or speed enough to justify the added moving parts.

## Recommended Design Workflow

1. Read `AGENTS.md`.
2. Check `public/styles.css`, `public/app.js`, and relevant tests.
3. Use `docs/DESIGN_SYSTEM_TEMPLATE.md` as the design reference.
4. Run targeted syntax/tests first, then `npm test`.
5. Use browser inspection for rendered UI and responsive QA when the app can run.
6. Add Figma MCP only when a real Figma design is available and needs to drive implementation.

## Do Not Add

- New UI libraries for isolated fixes.
- MCPs that duplicate local scripts or tests.
- Reference/inspiration tools without a specific design task.
- Visual regression infrastructure before stable target screens are defined.
