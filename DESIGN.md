---
name: Afrotiative Media — Console éditoriale
description: A warm, dense editorial back-office where AI proposes and the human disposes.
colors:
  primary: "oklch(0.555 0.163 48.998)"
  primary-foreground: "oklch(0.987 0.022 95.277)"
  accent-brand: "oklch(0.62 0.15 47)"
  accent-brand-foreground: "oklch(0.98 0 0)"
  foreground: "oklch(0.153 0.006 107.1)"
  background: "oklch(1 0 0)"
  card: "oklch(1 0 0)"
  muted: "oklch(0.966 0.005 106.5)"
  muted-foreground: "oklch(0.58 0.031 107.3)"
  border: "oklch(0.93 0.007 106.5)"
  sidebar: "oklch(0.988 0.003 106.5)"
  canvas-backdrop: "oklch(0.965 0.008 75)"
  status-draft: "oklch(0.42 0.02 260)"
  status-pending: "oklch(0.42 0.15 75)"
  status-in-review: "oklch(0.42 0.16 265)"
  status-approved: "oklch(0.4 0.16 150)"
  status-rejected: "oklch(0.44 0.2 25)"
  destructive: "oklch(0.577 0.245 27.325)"
typography:
  display:
    fontFamily: "Lora, Georgia, serif"
    fontSize: "1.875rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "Lora, Georgia, serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.25
  title:
    fontFamily: "Lora, Georgia, serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.4
rounded:
  sm: "0.375rem"
  md: "0.5rem"
  lg: "0.625rem"
  xl: "0.875rem"
  pill: "9999px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  button-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  button-ghost:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  input-field:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    padding: "4px 10px"
    height: "32px"
  card-surface:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.xl}"
    padding: "16px"
  badge-status:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.pill}"
    padding: "2px 8px"
    height: "20px"
---

# Design System: Afrotiative Media — Console éditoriale

## Overview

**Creative North Star: "The Editorial Atelier"**

This is a craftsman's workshop for a small newsroom, not a marketing dashboard. The system's job is to make a flood of raw feed items into finished, human-approved French business & finance articles — and to make the human's control over that flow feel fast, traceable, and confident. The atmosphere is warm and worked-in: surfaces carry a subtle warm-neutral cast (hue ~107 for the UI chrome, ~75 for the Studio canvas) rather than the cold blue-grey of generic SaaS, so the tool reads as a place where editorial craft happens rather than a utility console. Density is medium-to-high — compact tables, tight controls, little decorative whitespace — because this is a tool used all day, every day.

The governing product truth ("l'IA propose, l'humain dispose") is a visual mandate, not just a policy: AI-generated content must always look traceable to its sources and never be dressed up as already-verified. The one warm accent — a terracotta/amber that evokes African *élan* without flags or decorative motifs — is reserved almost entirely for primary actions and the brand mark. Its scarcity is what gives a decision weight. The explicit anti-reference is the "marketing dashboard": no oversized decorative charts, no gradient hero cards, no consumer-app spaciousness.

**Key Characteristics:**
- Warm-neutral surfaces (never cold blue-grey), flat and hairline-defined.
- One scarce terracotta accent, actions-only — never a page background.
- Editorial serif (Lora) for headings and article body; Inter for dense UI.
- Compact, confident controls (32px default height) built for daily repetition.
- A dedicated, WCAG-verified editorial status palette that reads at a glance.

## Colors

A warm-neutral foundation carrying a single terracotta accent and a purpose-built status palette. All values are OKLCH; the light theme is normative here, with each token carrying a distinct dark-theme lightness (see the sidecar).

### Primary
- **Terracotta** (`oklch(0.555 0.163 48.998)`): The default action color — primary buttons, active states, links. A warm amber-clay hue that carries the Afrotiative identity.
- **Brand Ember** (`oklch(0.62 0.15 47)`, `--accent-brand`): The brand-mark chip and attention accents. A sibling of Terracotta, slightly lighter and more saturated; this is the color on the "A" monogram.

### Neutral
- **Warm Ink** (`oklch(0.153 0.006 107.1)`): Primary text and the dark-theme background. Near-black with a warm cast, never pure `#000`.
- **Paper White** (`oklch(1 0 0)`): Page and card background in light mode.
- **Warm Muted** (`oklch(0.966 0.005 106.5)`): Muted fills, hover backgrounds, secondary surfaces.
- **Muted Ink** (`oklch(0.58 0.031 107.3)`): Captions, placeholders, secondary text.
- **Hairline** (`oklch(0.93 0.007 106.5)`): Borders, dividers, input strokes.
- **Sidebar Wash** (`oklch(0.988 0.003 106.5)`): The sidebar surface, one step off the page.
- **Atelier Canvas** (`oklch(0.965 0.008 75)`, `--canvas-backdrop`): The Studio editor backdrop — a deliberately *warmer* neutral (hue ~75) than the UI chrome, so the canvas reads as a workshop surface, not a utility panel.

### Status (editorial workflow — a signature system)
- **Draft** (`oklch(0.42 0.02 260)`): Neutral slate — not yet in play.
- **Pending** (`oklch(0.42 0.15 75)`): Amber — waiting on the pipeline.
- **In Review** (`oklch(0.42 0.16 265)`): Indigo — a human has it.
- **Approved / Published** (`oklch(0.4 0.16 150)`): Green — cleared the human gate / live.
- **Rejected** (`oklch(0.44 0.2 25)`): Red — sent back.

### Named Rules
**The Actions-Only Rule.** The terracotta accent appears only on primary actions and attention elements — never as a page or section background. Its rarity is the signal; a screen where terracotta is everywhere has lost its one voice.

**The Never-Pre-Verified Rule.** AI-generated content is never styled to look already-approved. Status color, source links, and confidence signals must stay visible on generated drafts.

## Typography

**Display Font:** Lora (with Georgia, serif fallback) — the editorial serif, `--font-editorial` / `--font-heading`.
**Body/UI Font:** Inter (with system-ui fallback) — `--font-sans`.

**Character:** Lora gives headings and the article body a press/editorial voice, so a draft in the editor already "looks like" the published result. Inter keeps dense tables and controls legible and neutral. The pairing is the whole thesis in two fonts: editorial craft (serif) framed by an efficient tool (sans).

### Hierarchy
- **Display** (Lora, 600, ~1.875rem / `text-3xl`, tight): Page heroes and the dashboard headline.
- **Headline** (Lora, 600, ~1.5rem / `text-2xl`): Page titles.
- **Title** (Lora, 600, ~1.125rem / `text-lg`): Section headings.
- **Body** (Inter, 400, 0.875rem / `text-sm`): The default UI text size — lists, tables, forms.
- **Label** (Inter, 500, 0.75rem / `text-xs`, often `muted-foreground`): Captions, metadata, table meta.

### Named Rules
**The Serif-for-Editorial Rule.** Lora is reserved for headings and rendered article body — the places where "editorial" is the message. UI chrome (buttons, tables, menus) stays in Inter. Don't set control labels in the serif.

## Layout

A fixed-shell, single-scroll-region application. The `<body>` is bounded to viewport height (`h-full overflow-hidden`) so the header and sidebar stay immobile and a single `<main class="overflow-auto">` is the only scroll container. Left sidebar (collapsible to an icon rail), top header carrying the role badge and controls, content region below.

Density is medium-to-high: compact tables (TanStack Table), tight control heights, minimal decorative whitespace. The radius scale derives from one base (`--radius: 0.625rem`) via multipliers (sm 0.6× → 4xl 2.6×), so corner language stays proportional everywhere. Spacing follows Tailwind's 4px base; cards use a 16px internal rhythm (`--card-spacing`, 12px in `size=sm`).

Responsive posture is **desktop-first, tablet correct, mobile secondary** — the deep work (review, editing) is a desktop job; mobile is for quick consult/approve. Footer height steps up at `xl` (`--footer-height`).

## Elevation & Depth

**Flat by default, hairline-defined.** This system does not use resting drop shadows. Depth is conveyed by (1) hairline borders and rings — cards sit on a `ring-1 ring-foreground/10` rather than a shadow — and (2) tonal layering between `sidebar` → `background`/`card` → `muted`. Shadows are reserved for genuinely transient, floating surfaces (Studio floating toolbar, context menus, sheets), never for static cards.

### Named Rules
**The Hairline-Not-Shadow Rule.** Separation between surfaces comes from a 1px border/ring and a tonal shift, not a drop shadow. If two panels need to feel distinct, change their tone or draw a hairline — don't lift them.

## Shapes

Rounded but restrained. The base radius is 10px (`--radius`), scaled proportionally: inputs and buttons use `rounded-lg` (~10px), cards use `rounded-xl` (~14px), and badges/pills use `rounded-4xl` (fully pill). Borders are 1px hairlines in the warm neutral. There is no sharp-cornered brutalism and no heavy pill-everything softness — corners are gently curved, consistent, and derived from the single radius token so nothing feels arbitrary.

## Components

### Buttons
- **Shape:** Gently curved (`rounded-lg`, ~10px). Compact default height of **32px** (`h-8`), `px-2.5` padding.
- **Primary:** Solid terracotta (`bg-primary` / `text-primary-foreground`); hover lightens to `primary/80`.
- **Outline / Ghost:** Transparent or page-colored with a hairline border; hover fills to `muted`. The default secondary action.
- **Destructive:** *Tinted, not solid* — `bg-destructive/10 text-destructive`, hover `/20`. Destructive actions read as serious without shouting in full red.
- **Hover / Focus / Active:** All transition together; focus shows a 3px `ring-ring/50` ring; active nudges down 1px (`translate-y-px`) for a tactile press.
- **Sizes:** `xs`(24px) · `sm`(28px) · `default`(32px) · `lg`(36px), plus square icon variants — a compact ladder for a dense tool.

### Inputs / Fields
- **Style:** 32px tall, `rounded-lg`, 1px `border-input` hairline, transparent background (`bg-input/30` in dark).
- **Focus:** Border shifts to `ring` and a 3px `ring-ring/50` glow appears.
- **Error:** `aria-invalid` paints the border `destructive` with a `destructive/20` ring. Disabled dims to 50% with a muted fill.

### Cards / Containers
- **Corner:** `rounded-xl` (~14px).
- **Background:** `bg-card` (paper white / warm dark).
- **Separation:** `ring-1 ring-foreground/10` — a hairline ring, **no shadow**.
- **Internal padding:** 16px rhythm (`--card-spacing`; 12px in `size=sm`). Full-bleed images clip to the card's top/bottom radius.

### Badges & Status
- **Badge shape:** Fully pill (`rounded-4xl`), 20px tall, `text-xs`.
- **Status pill (signature):** Status text renders at 100% opacity over its own `/15` fill of the matching status color — each status carries distinct light/dark lightness so both themes clear WCAG AA (≥5.1:1). This is the at-a-glance workflow language across queue, feeds, members, and run detail.

### Navigation (Sidebar)
- **Style:** Left sidebar on `sidebar` wash, collapsible to an icon rail. Brand mark (terracotta "A" chip + "Afrotiative / Console éditoriale" lockup) anchors the top. Active item uses `sidebar-accent`; the role badge lives in the header, always visible.

## Do's and Don'ts

### Do:
- **Do** keep the terracotta accent to primary actions and attention only — never a page/section background (The Actions-Only Rule).
- **Do** use hairline borders/rings and tonal shifts for separation; reserve shadows for transient floating surfaces only.
- **Do** set headings and rendered article body in Lora; keep all UI chrome in Inter.
- **Do** render workflow status as the `/15`-fill pill with 100%-opacity status text, in both themes.
- **Do** default controls to the compact 32px height and keep table density medium-to-high.
- **Do** keep AI-generated drafts visibly traceable to sources and status — never style them as pre-verified.

### Don't:
- **Don't** add resting drop shadows to cards or panels (The Hairline-Not-Shadow Rule).
- **Don't** introduce cold blue-grey neutrals; the neutral cast is warm (hue ~107, canvas ~75).
- **Don't** build oversized decorative charts or gradient hero cards — the anti-reference is the marketing dashboard.
- **Don't** invent a second accent color or spread terracotta across a screen; it has one voice.
- **Don't** rely on national-flag colors or decorative "African" motifs for identity — the warmth carries it.
