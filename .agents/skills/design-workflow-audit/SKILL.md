---
name: design-workflow-audit
description: Use when asked to verify Codex design workflow compliance, audit AGENTS.md, check UI design-system adherence, review visual QA, responsiveness, token efficiency, MCP/tooling readiness, or produce a Codex compliance report.
---

# Design Workflow Audit Skill

You are auditing whether this project follows a professional Codex design workflow.

Do not assume compliance. Inspect the repository, project structure, instructions, UI implementation, documentation, scripts, and available tools.

Where safe and in scope, fix problems directly.

## Audit Scope

Check:

1. Dedicated project context
2. `AGENTS.md`
3. Design system adherence
4. Visual reference usage
5. MCPs, plugins, and tooling
6. Skills and reusable workflows
7. UI generation quality
8. Visual QA
9. Responsiveness
10. Codex workflow fit
11. Token efficiency
12. Final verification discipline

## Required Checks

### Dedicated Project Context

Verify:

- Current working directory is correct.
- Repository structure is understandable.
- Unrelated files are not being pulled into the task.
- Build, run, lint, and test commands are discoverable.
- Context is not wasted on irrelevant files.

### AGENTS.md

Verify that `AGENTS.md` exists and includes:

- Design system rules
- Style guide
- Color palette guidance
- Typography guidance
- Spacing and layout expectations
- Accessibility expectations
- Responsive design expectations
- Visual “do not use” rules
- Build, lint, test, and review commands
- Definition of done
- Final reporting format

If missing or weak, create or improve it.

### Design System

Check:

- Colors
- Typography
- Spacing
- Components
- Layout
- Buttons
- Forms
- Cards
- Navigation
- Tables
- Empty, loading, and error states
- Accessibility
- Consistency across screens

Flag one-off styling, duplicated components, and visual drift.

### Visual Reference Usage

If a Figma file, screenshot, reference image, or design brief exists, compare the implementation against it.

Verify:

- The UI follows the intended visual direction.
- The result is not a direct copy.
- The project’s design system takes priority.
- Any missing reference is reported if the task needs one.

### MCPs and Tooling

Check whether the project would benefit from:

- Figma MCP
- Mobbin or inspiration workflow
- Browser inspection
- Screenshot testing
- Accessibility testing
- Visual regression
- Linting
- Formatting
- Type checking

Recommend only tools that solve a real workflow problem.

### Skills

Check whether repeated workflows should become skills.

Useful skills may include:

- Product design implementation
- Visual QA
- Design workflow audit
- Accessibility review
- Responsive QA
- Component creation
- UI refactoring

Create the smallest useful skill when appropriate.

### Visual QA

If runnable:

1. Start the app.
2. Open relevant screens.
3. Check layout, spacing, alignment, console errors, interactions, and breakpoints.
4. Fix issues directly.

If not runnable, document the blocker.

### Responsiveness

Check at least:

- Mobile width
- Tablet width
- Desktop width
- Large desktop width, when relevant

Verify no horizontal overflow, broken nav, unreadable text, cramped controls, or broken grids.

### Token Efficiency

Flag:

- Repeated instructions that belong in `AGENTS.md`
- Oversized prompts
- Unused context
- Duplicate files
- Redundant components
- Unnecessary dependencies
- Repeated manual workflows that should be skills

## Required Output

Return this format:

# Codex Design Workflow Compliance Report

## Overall Status

Use one:

- PASS
- PASS WITH MINOR ISSUES
- FAIL
- BLOCKED

Briefly explain why.

## Compliance Checklist

| Rule | Status | Evidence | Fix Performed | Remaining Issue |
|---|---|---|---|---|
| Dedicated project context |  |  |  |  |
| AGENTS.md |  |  |  |  |
| Design system adherence |  |  |  |  |
| Visual reference usage |  |  |  |  |
| MCPs / plugins / tools |  |  |  |  |
| Skills / reusable workflows |  |  |  |  |
| UI generation quality |  |  |  |  |
| Visual QA |  |  |  |  |
| Responsiveness |  |  |  |  |
| Codex workflow fit |  |  |  |  |
| Token efficiency |  |  |  |  |
| Final verification |  |  |  |  |

## Problems Found

For each issue include:

- Problem
- Why it matters
- File or area affected
- Whether it was fixed
- What changed
- Remaining blocker, if any

## Changes Made

List every changed file and explain why.

## Commands Run

List every command, result, and error.

## Visual QA Findings

List pages, components, breakpoints, issues, fixes, and remaining risks.

## Next Best Action

State the single best next action.

If it can be performed now, perform it.

## Final Answer

Summarize:

- What passed
- What failed
- What was fixed
- What still needs attention
- Whether the project is ready for further design implementation
