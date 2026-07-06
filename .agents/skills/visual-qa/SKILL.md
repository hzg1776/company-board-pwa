---
name: visual-qa
description: Use when checking UI quality, browser rendering, layout drift, responsive behavior, accessibility basics, screenshots, console errors, or visual polish before considering a frontend task complete.
---

# Visual QA Skill

Use this skill before declaring UI work complete.

## Visual QA Procedure

If the project can run locally:

1. Find the correct start command.
2. Start the app.
3. Open the relevant route or screen.
4. Inspect the page visually.
5. Check browser console errors.
6. Test interactions related to the task.
7. Check responsive widths.
8. Fix issues caused by the current work.
9. Re-run checks after fixes.

If the project cannot run locally, document the exact blocker.

## Required Breakpoints

Check:

- Mobile: approximately 375px wide
- Tablet: approximately 768px wide
- Desktop: approximately 1440px wide
- Large desktop: approximately 1920px wide, if relevant

## Check For

- Horizontal overflow
- Broken navigation
- Crowded text
- Misaligned content
- Inconsistent spacing
- Poor hierarchy
- Weak contrast
- Broken forms
- Invisible focus states
- Components touching screen edges
- Cards or grids collapsing badly
- Tables that do not work on mobile
- Console errors
- Broken images or icons
- Loading and empty state issues

## Output Requirements

Report:

- Screens checked
- Breakpoints checked
- Issues found
- Fixes made
- Commands run
- Remaining risks
- Whether the UI is ready for review
