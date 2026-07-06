# Project-A Design System

This file documents the current UI rules for the Communications and Alert Center. The implementation source of truth is `public/styles.css`; update this document and `test/ui-design-contract.test.js` when deliberate design-system changes are made.

## Brand Personality

- Professional: operational, direct, and reliable.
- Friendly: clear labels and plain-language status copy.
- Technical: security and system states are visible without feeling noisy.
- Minimal: compact surfaces, restrained color, and low decoration.
- Bold: use priority color only for alerts, status, and action emphasis.

## Color Palette

### Core Tokens

- Background: `--bg: #eef4fb`
- Background alternate: `--bg-alt: #dce8f5`
- Surface: `--surface: #ffffff`
- Strong surface: `--surface-strong: #fbfdff`
- Text primary: `--ink: #141f2f`
- Text secondary: `--muted: #4f6177`
- Border: `--line: #a9bfd6`
- Strong border: `--line-strong: #7892ad`

### Brand and Action

- Primary/action: `--steel: #1f7ae8`
- Primary/action soft: `--steel-soft: rgba(31, 122, 232, 0.12)`
- Signal/urgent: `--signal: #e07a12`
- Signal soft: `--signal-soft: #f9e4c7`
- Safety: `--safety: #8c5a12`
- Safety soft: `--safety-soft: #f2e1bd`
- Cool/info accent: `--cool: #2d6372`
- Cool soft: `--cool-soft: #d8e5e8`

### Status

- Success: `--ok: #486654`, `--ok-soft: #dbe5dc`
- Error/danger: `--danger: #a03e2c`, `--danger-soft: #f0ddd8`
- Info tone: `--tone-info-bg: #dbeafe`, `--tone-info-text: #1d4ed8`, `--tone-info-line: #bfdbfe`
- Status tone: `--tone-status-bg: #eef2ff`, `--tone-status-text: #3730a3`, `--tone-status-line: #c7d2fe`
- Success tone: `--tone-success-bg: #dcfce7`, `--tone-success-text: #166534`, `--tone-success-line: #bbf7d0`
- Warning tone: `--tone-warning-bg: #fef3c7`, `--tone-warning-text: #a16207`, `--tone-warning-line: #fde68a`
- Danger tone: `--tone-danger-bg: #fee2e2`, `--tone-danger-text: #b42318`, `--tone-danger-line: #fecaca`
- Muted tone: `--tone-muted-bg: #f1f5f9`, `--tone-muted-text: #475569`, `--tone-muted-line: #cbd5e1`

## Typography

- Font family: `Arial, sans-serif`
- Body text: compact operational sizing, usually `1rem` or below inside dense controls.
- Small/supporting text: `0.72rem` to `0.92rem` depending on surface density.
- Headings: use restrained dashboard sizing; reserve large type for launcher/auth surfaces only.
- Buttons and pills: bold text, no forced uppercase in the late shared app-shell rules.
- Letter spacing: `0` in shared app-shell controls unless a legacy auth or brand rule explicitly overrides it.

## Spacing

Use the existing compact scale:

- 4px: micro alignment
- 6px: icon gaps and dense mobile groups
- 8px: default row gap and compact panel gap
- 10px: header/action gaps
- 12px: common card and form padding
- 14px: button/input horizontal padding
- 16px: auth and mobile entry padding
- 20px to 24px: larger surface padding and mobile max-width gutters
- 32px+: only for larger page or panel spacing

## Border Radius

- Control: `--radius-control: 18px`
- Card: `--radius-card: 24px`
- Panel: `--radius-panel: 32px`
- Soft/default: `--radius-soft: 20px`
- Full pill: use `999px` only where an existing pill/header action rule already uses it.

## Shadows

- Current final-cascade default: `--shadow: none` and `--notice-shadow: none`.
- Prefer borders and surface contrast over new shadows.
- Do not add heavy layered shadows unless the product direction changes.

## Components

### Buttons

- Primary action: `.button`
- Secondary/neutral action: `.ghost-button`
- Icon-only action: `.icon-button` with an accessible label.
- Shared app-shell controls should keep at least `44px` height in the late override layer.
- Button text must fit cleanly on mobile and desktop; do not allow mid-word breaks.

### Inputs

- Use `.field input`, `.field select`, and `.field textarea`.
- Default min height is `48px` before late compact overrides.
- Use `border: 1px solid var(--line)`, `border-radius: var(--radius-control)`, and `background: #fff`.
- Focus state should use the existing steel border and focus shadow.
- Labels and errors must be visible and clear.

### Cards and Panels

- Use `.panel-card`, `.notice-card`, `.stat-card`, `.tool-panel`, `.empty-state`, and existing route-specific card classes.
- Keep surfaces white with `var(--line)` borders and token radius.
- Do not put cards inside cards unless the existing surface already depends on a nested panel.
- Empty states should stay centered, compact, and muted.

### Tables

- Use existing admin table wrappers and chip styles.
- Wide admin tables may use horizontal scroll inside `.admin-table-wrap`.
- Do not force dense admin tables into unreadable mobile columns unless a specific mobile table design is implemented.

### Navigation

- Use `.page-actions`, `.tab-bar`, `.tab-button`, launcher cards, and route buttons already present in `public/app.js`.
- Shared HR, webmaster, IT, and employee action rows are controlled by late `public/styles.css` overrides.
- Mobile nav/actions should stack or grid without clipping.

## Layout

- Default shell width: `min(1160px, calc(100% - 20px))`.
- HR, IT, and webmaster shell width: `min(1180px, calc(100% - 20px))`.
- Employee feed column: `--employee-feed-column-width`.
- Mobile breakpoint: `720px`.
- Intermediate layout breakpoint: `920px`.
- Preserve fixed, stable dimensions for headers, pills, icon buttons, weather, and feed rows so dynamic text does not shift the layout.

## Accessibility

- Minimum contrast: use existing text and tone tokens; do not place muted text on low-contrast tinted surfaces.
- Focus state: keep visible outlines for buttons/links and focus styling for inputs.
- Keyboard support: all actions must be real buttons or links.
- Input labels: every field needs a visible or accessible label.
- Error messaging: show clear messages without leaking secrets or internal stack traces.
- Touch targets: shared controls should remain about `44px` or larger where practical.

## Responsive QA Targets

Check these widths when UI changes are made and the app can run:

- `390px` mobile
- `768px` tablet
- `1366px` desktop
- `1440px` or wider large desktop

Verify no horizontal overflow, clipped controls, overlapping text, broken grids, hidden primary actions, or unreadable tables.

## Do Not Use

- Unapproved fonts.
- New one-off button, chip, card, or table systems.
- Heavy shadows.
- Decorative gradient blobs or unrelated background art.
- Neon palettes.
- Random glass effects.
- Viewport-based font scaling.
- Mid-word text breaking.
- External design libraries without approval.
