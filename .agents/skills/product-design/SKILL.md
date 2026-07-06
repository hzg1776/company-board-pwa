---
name: product-design
description: Use when implementing, refining, or reviewing product UI, turning a brief, screenshot, Figma design, or design reference into maintainable frontend code that follows the project design system.
---

# Product Design Implementation Skill

Use this skill for UI creation, design-to-code work, frontend polish, product screens, components, dashboards, forms, landing pages, and visual refinement.

## Workflow

1. Inspect existing UI patterns before building.
2. Identify the styling system.
3. Find reusable components.
4. Check design tokens, theme files, CSS variables, and Tailwind config.
5. Confirm the intended user flow.
6. Implement the smallest clean version.
7. Reuse existing components before creating new ones.
8. Check accessibility and responsiveness.
9. Run verification commands.
10. Report changes clearly.

## Design Implementation Rules

- Follow the existing design system.
- Use shared components when they exist.
- Avoid duplicate one-off components.
- Keep layout and spacing consistent.
- Prefer clean hierarchy over decorative noise.
- Do not invent random effects, gradients, shadows, or animations.
- Do not add a design dependency unless it is justified.
- Do not hardcode design values if tokens exist.
- Do not break existing screens to polish one screen.

## Required UI States

For product-quality UI, consider:

- Default state
- Hover state
- Focus state
- Disabled state
- Loading state
- Empty state
- Error state
- Success state
- Mobile layout
- Tablet layout
- Desktop layout

## Accessibility Checklist

Check:

- Semantic HTML
- Keyboard navigation
- Focus indicators
- Contrast
- ARIA labels where needed
- Input labels
- Error descriptions
- Button/link clarity
- Touch target size

## Output Requirements

After implementation, report:

- What was built
- Files changed
- Design system decisions
- Accessibility considerations
- Responsive behavior
- Commands run
- Remaining risks
- Next best action
