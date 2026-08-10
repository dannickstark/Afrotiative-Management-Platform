# U1 — Studio shell, rail and modes — Design

**Date:** 2026-08-10
**Status:** Validated in workshop (visual companion) — ready for a plan
**Programme:** `2026-08-10-afrotiative-studio-ux-roadmap.md` — sub-project U1 of U1→U5
**Depends on:** V2's editor (shipped). **No engine, schema or migration changes.**

**Goal.** Rebuild the editor's shell so the canvas has room, the render preview becomes a mode
instead of a cramped panel, geometry stops being the last thing you can reach, and inserting a
layer bound to article data becomes something you can discover by browsing.

---

## 1. Why this comes first

Everything else in the programme lands *inside* this shell. The `Éléments` gallery must exist before
U3 can add shape tiles to it; render mode must exist before it can hold a format filmstrip; the
pinned geometry strip must exist before U2 can put align/distribute controls in it. U1 changes no
schema and no rendering, so it can ship without touching a single template.

---

## 2. What replaces what

Today `editor-shell.tsx:287` is `grid-cols-[220px_1fr_300px]`: layers, canvas, and a right column
carrying **both** the property panel and the render preview stacked. That last column is the problem
— 674 lines of controls and a live preview competing for 300px of width and the same vertical space.

The new shell, left to right:

1. **Icon rail** — labelled icons, ~62px, selected state a filled pill.
2. **Docked panel** — ~212px, one per rail category, collapsible by a chevron on its edge and by
   `⌘/`. Collapsed state persists per user.
3. **Canvas** — takes the remaining space. Floating chips top-left (format name and pixel size, zoom
   percentage). Mode switch floating top-centre.
4. **Properties rail** — pinned geometry strip on top, collapsible type sections below.

---

## 3. The rail and its panels

Six categories. Each panel has the same skeleton: a search field, **one** primary action, then
sections.

| Category | Primary action | Sections |
|---|---|---|
| **Modèles** | « Nouveau gabarit vierge » | Existing templates to duplicate, grouped by context. This is what a newly created template opens onto. |
| **Éléments** | — | « Utilisés récemment », then « Formes ». **Only what exists**: rectangle and QR today. U3 adds ellipse, line and the polygon family as tiles. No disabled buttons for unbuilt shapes. |
| **Texte** | « Ajouter une zone de texte » | « Styles » (Titre / Sous-titre / Corps, each rendered at its real size), then « Texte dynamique » — see §4. |
| **Images** | « Importer un fichier » | Uploaded assets, plus the image slots available in this context. |
| **Marque** | — | Uploaded fonts, the brand logo, category colours. Read-only surfaces onto what the asset and font libraries already hold. |
| **Calques** | — | The layer list — order, visibility, lock, rename. Moves here from its own column. |

**Reuse rather than rewrite.** `asset-library.tsx`, `asset-picker.tsx`, `token-picker.tsx` and
`templates-table.tsx` already exist; they migrate from modals and pages into panels. A panel that
duplicates one of those surfaces instead of hosting it is a review finding, not an implementation
choice.

---

## 4. « Texte dynamique » — the part specific to this product

Canva's equivalent section offers stock content. Here it lists the **tokens** available in this
template's context, and a click inserts a text layer **already bound** to that token, styled from the
matching preset:

| Row | Inserts |
|---|---|
| Titre de l'article | text layer bound to `title`, Titre preset |
| Chapô | text layer bound to `excerpt`, Corps preset |
| Rubrique | text layer bound to `category.name`, Sous-titre preset |
| Signature | text layer bound to `article.byline`, Corps preset |
| Date | text layer bound to `article.date`, Corps preset |

Tokens **illegal in this template's context** appear disabled with the reason — `tokens.ts` already
knows the rule, this reads it. `article.url` is offered under `Éléments` as a QR tile rather than as
text, matching how the QR layer actually works.

Two properties this must hold: the inserted layer is a normal layer with no special status, and a
designer can rebind or unbind it afterwards from the properties rail exactly as today.

**This does not include U4's work.** The token picker *inside* property fields, and `parseScene`
reporting all errors rather than the first, stay in U4. U1 only reads legality to grey a row.

---

## 5. Modes

A floating segmented control, centred above the artboard, in both states:
`Montage ⇄ Rendu réel`. Keyboard: `R`.

**Montage** is the shell described above. **Rendu réel** hides the rail, the panel and the properties
rail entirely; the render takes the workspace:

- current format rendered large, fit to the viewport, zoomable to 100% to inspect type;
- the other seven formats as a filmstrip beneath, each clickable to promote it to the large slot;
- provenance stated — sample values or a chosen article, since `manual-generate.tsx` already offers
  that choice;
- a stale badge, because the render is asynchronous, plus « ↻ rendre »;
- the engine's `degraded` flag surfaced when a font fell back. That state exists in the engine today
  and is invisible in the UI.

Selection, zoom and scroll survive the round trip in both directions.

**Known honest limitation:** until U5 delivers re-layout, seven of the eight filmstrip renders show a
design built for a different aspect ratio. That is useful feedback rather than a bug, and the UI
should not pretend otherwise — no "adapt" affordance that doesn't exist yet.

---

## 6. The properties rail

**Pinned strip**, never scrolls: X, Y, width, height, rotation, opacity — the existing
`NumberField` primitives in a tighter grid rather than one per row. U2 later adds align/distribute
here, and U5 adds the anchor widget; the strip is designed with room for both rather than retrofitted.

**Collapsible sections** below, per layer type, each remembering its open state per type — so a
designer who never uses `Contour` stops scrolling past it. The current order for a text layer
(Texte → Police → Apparence → Ombre → Contour → Cadre) becomes Cadre-first via the pinned strip,
then the type sections in their present order.

**Rejected:** tabs inside the rail (Style / Cadre / Effets). Less scrolling, but it hides related
properties from each other — you lose sight of the shadow while adjusting the colour it falls from.

---

## 7. Canvas chrome

Rulers, grid, guides and safe areas were all chosen. U1 ships the **surround** for them; U2 ships the
behaviour:

- **U1**: floating format and zoom chips; rulers and grid rendered, **available but off by default**,
  state remembered per user; the artboard visually distinct from its surround.
- **U2**: snapping and smart guides, safe-area bands, the gesture modifiers, multi-select.

Safe areas default **on** for `story` and `ig_portrait`, off for link formats — but the toggle and its
persistence live in U1 so U2 only supplies the bands.

---

## 8. Save state

The indicator moves out of the header to sit beside the mode switch, with three states:
« Enregistré » · « Enregistrement… » · « Échec — réessayer ». The third does not exist today: a failed
autosave currently leaves no affordance to retry, which is one of the V2 deferred defects. The retry
action re-attempts the same scene rather than requiring an edit to trigger a fresh save.

---

## 9. Testing

The shell is UI, so the tests are behavioural rather than visual:

- mode switch: `R` toggles; selection, zoom and scroll are preserved across a round trip; render mode
  renders no editing chrome.
- rail: each category opens its panel; collapse persists across a reload; `⌘/` toggles.
- « Texte dynamique »: clicking a row inserts a layer bound to that token; a token illegal in the
  context is disabled and clicking it inserts nothing.
- `Éléments` shows exactly the shapes that exist — a test that fails when a shape is added to the
  registry without a tile, mirroring the existing channel/guide completeness tests.
- properties: the pinned strip stays visible while the sections scroll; section open state persists
  per layer type.
- save state: a failed autosave surfaces « Échec — réessayer », and the retry re-attempts the save.
- the panels host the existing library components rather than reimplementing them — asserted by
  those components' own tests continuing to pass unmodified.

---

## 10. Risks

1. **The largest single-surface rewrite in the studio's history.** `editor-shell.tsx` and
   `property-panel.tsx` both change structurally, and the existing studio tests were written against
   today's arrangement. Expect test churn that is real work, not incidental.
2. **The client/server boundary.** The studio panels will want data from the asset, font and template
   queries. This repo has put `pg` in a client bundle three times; anything a `"use client"` panel
   needs arrives as a prop from a Server Component, and only a real build catches a violation.
3. **`⌘/` may collide** with a browser or OS binding on some platforms. Verify before committing to
   it; a fallback of `⌘.` or a rail-click-only collapse is acceptable.
4. **Scope creep toward U2.** Guides and snapping will feel conspicuously absent once the shell looks
   finished. They are not in U1, and adding "just snapping" here would make U2 incoherent.
