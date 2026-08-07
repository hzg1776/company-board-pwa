# HR Users Full-Width Directory Design

Date: August 6, 2026
Status: Implemented; initially handed off untested by explicit user direction; release verification resumed August 7, 2026

## Problem

The HR Users workspace is constrained by the shared 720px control-center column while the Employee Accounts table has a 1120px minimum width. With 58 accounts and control-heavy rows, HR must scroll horizontally to reach forms and actions, and the full expanded roster is difficult to scan.

## Goals

- Use the available desktop width on the HR Users tab.
- Remove horizontal scrolling from employee account management.
- Collapse each employee into a compact, keyboard-accessible summary.
- Search employees by name or username.
- Filter employees by access status and messaging group.
- Preserve every existing employee management action and API contract.
- Keep mobile and tablet layouts readable without changing the Feed or Settings tabs.
- Make every HR section headed by an `<h3>` collapsible from its complete heading row.

## Non-Goals

- No server API, database, authentication, or authorization changes.
- No pagination or server-side search for the current roster size.
- No redesign of HR Feed, HR Settings, System Ops, or IT pages.
- No new UI dependency or component library.

## Approved Interaction Design

### Desktop width

Only the HR Users tab receives a wide shell modifier. At desktop widths, its header, summary, tabs, and content use the available viewport up to a restrained large-desktop maximum. HR Feed and Settings keep the existing operational column width.

### Directory toolbar

The Employee Accounts panel starts with:

- A labeled search field for employee name or username.
- A status select with All, Active, and Disabled.
- A messaging-group select with All Groups plus the current group list.
- A live visible-result count and a clear empty-result message.

Filtering uses the employee data already loaded for the authorized HR session. It does not make additional requests.

### Employee entries

The eight-column table is replaced with native `<details>` entries:

- The collapsed summary shows name, username, Active/Disabled status, session count, and enrolled-device count.
- Expanding an entry reveals messaging-group assignment, password reset, device unenrollment, session revocation, access enable/disable, Add to HR, and account deletion.
- Existing `data-*` form selectors and submission handlers remain unchanged.
- Entries are collapsed by default so a large roster stays compact.

### HR section headings

Every HR panel whose visible section title is an `<h3>` uses that full heading row as a native collapse control. Each section is open by default, and collapsing it hides the entire section body. The behavior applies to New Announcement, Live Employee Updates, Messaging Groups, Employee Accounts, HR Google Authenticator, and HR Admin Accounts without changing System Ops or IT panels.

### Search and filtering behavior

A pure matcher evaluates name, username, status, and group membership. Input/change handlers apply the matcher directly to rendered directory entries instead of calling the global `render()` function. This preserves search focus, caret position, and each employee's open/closed state while filtering.

Filtered entries are hidden with the standard `hidden` attribute. Because every employee is already authorized HR-only data, this is a presentation filter rather than an access boundary.

## Responsive Layout

- Large desktop: wide HR Users shell, three-column toolbar, multi-column expanded management grid.
- Desktop: wide shell within viewport padding; controls wrap without horizontal overflow.
- Tablet: two-column toolbar and management grid where space permits.
- Mobile: existing narrow shell width; toolbar, summaries, forms, and actions stack in one column.
- Buttons and inputs retain the existing minimum touch-target and focus styles.

## Accessibility

- Use native `<details>` and `<summary>` for keyboard and screen-reader support.
- Keep visible labels on search and filter controls.
- Announce the visible result count through `aria-live="polite"`.
- Keep action button wording and destructive confirmations unchanged.
- Ensure hidden filtered entries are removed from keyboard navigation.

## Implementation Boundaries

- `public/app.js`: pure filter matcher, accordion rendering, directory toolbar, and targeted DOM filter handlers.
- `public/styles.css`: HR Users-only desktop width override and responsive directory/card layouts in the final cascade.
- Existing test files and QA infrastructure remain untouched.

## Testing And QA Exclusion

At the user's explicit direction, this task will not add or modify tests, run automated checks, perform browser QA, or perform responsive QA. The implementation will be handed back as untested.

## Definition of Done

The HR Users tab implements the approved desktop width, search, filters, and independently expandable employee entries without intentionally changing unrelated runtime behavior. Testing and QA are outside this task by explicit user direction.
