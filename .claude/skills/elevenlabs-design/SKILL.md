---
name: elevenlabs-design
description: Visual design system for this repo. Use whenever creating or modifying any component, page, or style.
---

# whatsapp-os design system

Editorial, near-monochrome, serif display over sans body. Derived from
`DESIGN-elevenlabs.md` at the repo root. The implementation lives in
`apps/web/app/globals.css` — that file is the single source of truth for raw
values, and `/styleguide` renders every token by parsing it at build time.

## The one hard rule

**No literal hex, px, rem or radius value anywhere outside `globals.css`.**

Everything is a `--wa-*` custom property. `apps/web/tailwind.config.ts` maps
Tailwind utility names onto those properties and contains no literal values at
all — so `bg-canvas`, `text-ink`, `rounded-pill`, `p-lg`, `text-display-xl` all
resolve to tokens. Changing a brand value means editing one line, in one file.

Sole existing exception: `viewport.themeColor` in `app/layout.tsx`, which is
emitted as a `<meta>` tag and cannot take a CSS variable.

If you need a value the tokens do not have, add a token. Do not inline the
literal, and do not reach for Tailwind's default palette (`bg-gray-900`,
`text-slate-500`, `rounded-md` with its built-in scale) — those are outside the
system.

---

## Tokens

### Surface
| Token | Value | Use |
| --- | --- | --- |
| `--wa-canvas` | `#f5f5f5` | off-white page floor |
| `--wa-canvas-soft` | `#fafafa` | lighter alternating band |
| `--wa-canvas-deep` | `#0c0a09` | rare dark-mode hero |
| `--wa-surface-card` | `#ffffff` | pure white card |
| `--wa-surface-strong` | `#f0efed` | badges, voice-icon plates |
| `--wa-surface-dark` | `#0c0a09` | dark hero / CTA band |
| `--wa-surface-dark-elevated` | `#1c1917` | card on dark canvas |

### Ink & action
The only CTA colour in the system. There is no saturated brand action colour.

| Token | Value | Use |
| --- | --- | --- |
| `--wa-ink` | `#0c0a09` | near-black ink: headings, rules, focus rings |
| `--wa-primary` | `#292524` | primary CTA pill fill |
| `--wa-primary-active` | `#0c0a09` | primary CTA press state |

Note `ink` is *darker* than `primary`. That is intentional and comes from the
design doc's token block, which is authoritative over its own prose. There is
no `--wa-ink-deep`; it was removed as a duplicate of `--wa-ink`.

### Text
`--wa-body` `#4e4e4e` · `--wa-body-strong` `#292524` · `--wa-muted` `#777169` ·
`--wa-muted-soft` `#a8a29e` · `--wa-on-primary` `#ffffff` ·
`--wa-on-dark` `#ffffff` · `--wa-on-dark-soft` `#a8a29e`

### Hairlines
`--wa-hairline` `#e7e5e4` (default 1px divider) ·
`--wa-hairline-soft` `#f0efed` · `--wa-hairline-strong` `#d6d3d1`

### Atmospheric gradients — decoration only
`--wa-gradient-mint` `#a7e5d3` · `peach` `#f4c5a8` · `lavender` `#c8b8e0` ·
`sky` `#a8c8e8` · `rose` `#e8b8c4`

Use them **only** through the `.wa-orb` class / `GradientOrb` component: blurred,
absolutely positioned, `pointer-events: none`, `aria-hidden`, accepts no
children. Never a button fill, never a text colour, never a component surface.

### Semantic
`--wa-success` `#16a34a` · `--wa-error` `#dc2626`

Green appears here and **only** here. It is never an action colour and never
clickable. A checked switch is ink, not green — a toggle is an action.

### Type
Two families: `--wa-font-display` (EB Garamond) and `--wa-font-body` (Inter).

Steps, each carrying size + line-height + tracking + weight in one utility:
`display-mega` 64px · `display-xl` 48px · `display-lg` 36px · `display-md` 32px ·
`display-sm` 24px · `title-md` 20px · `title-sm` 18px · `body-md` 16px ·
`body-strong` 16px/500 · `body-sm` 15px · `caption` 14px ·
`caption-uppercase` 12px/600/+0.96px · `button` 15px · `nav-link` 15px.

Base tracking on `<body>` is `+0.15px`.

### Radius
`none` 0 · `xs` 4 · `sm` 6 · `md` 8 · `lg` 12 · `xl` 16 · `xxl` 24 ·
`pill` / `full` 9999px

### Spacing — 4px base unit
`xxs` 4 · `xs` 8 · `sm` 12 · `base` 16 · `md` 20 · `lg` 24 · `xl` 32 ·
`xxl` 48 · `section` 96

### Elevation
Hairlines first. There is exactly one drop tier:
`--wa-shadow-soft-drop: 0 4px 16px rgba(0,0,0,0.04)`. Do not invent a second.

### Component metrics
container `1200px` · nav `64px` · button `40px` · input `44px` ·
voice icon `32px` · footer padding `64px` / `48px`

Breakpoints: `tablet` 640 · `desktop` 1024 · `wide` 1280.

---

## EB Garamond — settled, do not revisit

The display face is **EB Garamond at weight 400**.

Google Fonts ships EB Garamond on a **400–800 axis. There is no 300 cut**
(`wght@300` returns HTTP 400), so the design doc's specified 300 is
unavailable. `--wa-display-weight` is 400, the lightest weight the face
actually has.

- **Never bold display copy.** Bolding shifts the voice from editorial to
  consumer marketing. This is the single most load-bearing rule in the system.
- **Do not "fix" the 400 to 300.** It is not an oversight. Changing it silently
  breaks the font load.
- If a literal 300 is ever genuinely required, swap the face to **Cormorant
  Garamond** (which does ship one) in `app/layout.tsx` and set the token to
  300. Nothing else changes.
- **Never drop body Inter to 300** to match the display face. Legibility first.

---

## Do

- Reserve the ink pill for the **single** primary action in a view.
- Keep display copy at the light weight — it is the editorial signature.
- Run body Inter at 400/500 with roughly +0.15px tracking.
- Use gradient orbs as atmosphere behind content.
- Use pill geometry for every CTA and badge.
- Separate with hairlines before reaching for the shadow.

## Don't

- Introduce a saturated brand action colour. The ink pill is the only CTA fill.
- Bold display copy.
- Use a gradient orb as a button fill, a text colour or a component background.
- Put sharp 0px corners on a CTA.
- Drop body Inter to 300 to match the display face.
- Use green for anything clickable.

---

## Working in this system

- Inputs are the one place that is **not** a pill: 8px radius, 44px tall,
  hairline border thickening to an ink ring on focus.
- shadcn/ui components come in with a default palette. Swap every class for
  `--wa-*` tokens before committing — `apps/web/components/ui/` is the
  reference for how that looks.
- After a token change, check `/styleguide`. It parses `globals.css` rather
  than restating it, so if your change is not visible there, it did not land.
- `apps/web/components/brand/` holds the composed brand blocks (hero band, CTA
  band, pricing tier, voice row, waveform card, orb card). Reuse before adding.
