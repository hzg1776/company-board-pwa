# HR Users Full-Width Directory Implementation Plan

**Goal:** Make the HR Users workspace desktop-wide and replace the horizontally scrolling employee table with a searchable, filterable accordion directory.

**Architecture:** Keep the existing HR APIs and employee mutation handlers. Render each employee as a native `<details>` entry, filter the already-rendered entries without invoking the global rerender, and scope the wide desktop shell to the HR Users tab.

**Tech Stack:** Existing browser JavaScript in `public/app.js` and the existing CSS design system in `public/styles.css`.

**Status:** Implemented and handed off without testing or QA by explicit user direction.

## Global Constraints

- Do not change server APIs, storage, authentication, authorization, or runtime data.
- Do not add dependencies or a component library.
- Preserve every existing employee-management `data-*` selector and confirmation flow.
- Keep HR Feed, HR Settings, System Ops, and IT layouts unchanged.
- Preserve unrelated dirty-worktree changes.
- Do not add, modify, or run tests.
- Do not perform browser, responsive, console, accessibility, or visual QA.
- Hand off the result explicitly as untested.

## Files

- Modify `public/app.js`: employee filter matcher, accordion entries, toolbar, targeted filter handlers, and HR Users shell class.
- Modify `public/styles.css`: HR Users-only desktop width and responsive directory/card/form layout.

## Task 1: Employee Directory Interaction

- [ ] Add `employeeMatchesDirectoryFilters(employee, filters)` for case-insensitive name/username search, Active/Disabled status, and messaging-group membership.
- [ ] Replace the employee table renderer with native `<details class="employee-directory-card">` entries.
- [ ] Keep all existing employee group, password, device, session, access, HR-role, and deletion form selectors and fields.
- [ ] Add labeled search, status, and messaging-group controls plus a live visible-result count and no-result message.
- [ ] Add `applyEmployeeDirectoryFilters(root = app)` to hide nonmatching rendered entries without calling `render()`.
- [ ] Wire search through the delegated `input` listener and selects through the existing delegated `change` listener.
- [ ] Add `hr-shell-users` only when the active HR tab is `share`.

## Task 2: Full-Width Responsive Styling

- [ ] Add a final desktop override for `.page-shell.hr-shell.hr-shell-users` using `min(1680px, calc(100vw - 64px))`.
- [ ] Add a three-column directory toolbar on desktop.
- [ ] Style compact employee summaries and three-column expanded management bodies.
- [ ] Remove inherited minimum widths from forms inside employee directory cards.
- [ ] Make action buttons fill their available card column.
- [ ] Stack the toolbar, summary, and management body at `max-width: 920px`.
- [ ] Override the batch credential table's inherited employee-table minimum width.

## Task 3: Untested Handoff

- [ ] Review the edited source diff only to ensure no unrelated files were intentionally changed.
- [ ] Do not run syntax checks, automated tests, the local app, browser inspection, responsive inspection, or any QA command.
- [ ] Report the exact files changed and state clearly that the result is untested.
