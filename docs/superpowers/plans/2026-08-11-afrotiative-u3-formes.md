# U3 — Système de formes — Spec & Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the studio a real shape vocabulary — ellipse, line, and a polygon family — instead of the single rectangle it has today, **after proving the engine can actually draw them**.

**Architecture:** Shapes are described once, in a pure module, and consumed by **both** render paths. The engine work is a `clipPath` spike that either succeeds or changes the plan.

**Tech Stack:** Satori + resvg + sharp · Bun test · React 19 · the U0 DOM harness

**Spec + plan combined**, as U0 and U2 did.

**Programme:** `docs/superpowers/specs/2026-08-10-afrotiative-studio-ux-roadmap.md` — U3 of U1 → U5.

---

## 0. The structural fact this plan is built around, found before writing it

**There are TWO independent shape-painting implementations, and neither knows about the other:**

| Path | File | What it feeds |
|---|---|---|
| Export | `lib/studio/element.ts` → `shapeNode()` | Satori → resvg → the actual PNG |
| Editor | `components/studio/layer-view.tsx` → `ShapeContent()` | the browser canvas the designer looks at |

Both handle exactly one shape today (`rect`, via `borderRadius`). **A task that teaches one path a new shape and not the other ships an editor that disagrees with its own export** — the designer draws an ellipse, the exported image contains a rectangle, and nothing fails.

This is the same shape as plan defects #9 and #10 in U2, which is why it was looked for before this plan was written rather than discovered during it. The roadmap's instruction — *"before writing U3's plan, ask: which earlier decision makes a file I am about to name wrong?"* — is what produced this section.

**Consequence, binding on every task below:** a new shape is not "done" until **both** paths draw it and a **completeness guard** binds `SHAPE_KINDS` to both. U1 already established this pattern once (`SHAPE_KINDS` is consumed by `z.enum` *and* by the gallery guard, so U3 cannot ship a shape no interface inserts); U3 extends the same guard to cover rendering.

## 1. The spike gate — this plan may change shape after Task 1

The roadmap records a reservation, and it is load-bearing:

> La présence de `clipPath` dans la liste vient de la documentation de Satori, pas d'un polygone effectivement rendu par ce projet.

**Nothing in this repo has ever rendered a `clipPath` through Satori.** The rest of this plan assumes it works. Task 1 is a spike that settles it against the real pipeline — Satori → resvg → sharp — not against documentation, and **not** against a browser.

If `clipPath` does not work, **stop and report**. The fallback is stated in Task 1 and changes Tasks 3–4 materially. Do not implement the fallback without checking in: choosing it silently would be the single most expensive mistake available in this sub-project.

## Global Constraints

- **Read the Next.js docs** under `node_modules/next/dist/docs/01-app/` before touching a page or Server Action. This sub-project should need neither.
- **Engine ceiling** (`docs/.../studio-ux-roadmap.md` §« Le plafond du moteur »): flexbox, absolute, transform, border-radius, box-shadow, gradients. **No CSS Grid, no `z-index`, no `calc()`, no `backdrop-filter`, no WOFF2.** Paint order **is** layer array order.
- **A `"use client"` component must never value-import a module reaching `@/db`**, except through a file-level `"use server"` module (see U2's plan for the measured carve-out: 31 such paths repo-wide, 7 in the studio, **0 real violations**). `bun run build` is **not** evidence — trace value imports, and `bun build --target=browser` plus grep for certainty.
- **`tests/publish-due.test.ts` and `tests/wp-publish.test.ts` must stay green AND unmodified.**
- **Do not weaken, convert or delete an existing assertion.**
- **Never two `bun test` invocations at once**; **foreground only**, never backgrounded.
- **NEVER run the full suite** — its count is not reproducible on this repo. Focused files only; re-run a failure alone before concluding anything.
- **Three suite failures are pre-existing:** `tests/pipeline-web-search.test.ts` (a) and (d), `tests/pipeline-pause-resume.test.ts` pause checkpoint (b).
- French user-facing strings; **Base UI** (`render` prop, never `asChild`).
- Commit messages in **French**, prefix `feat(studio):` or `fix(studio):`, ending with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

### Method carried from U2, because it is what actually found defects

- **Mutation is the gate.** For every fix and every new behaviour, name the mutation that now fails. If no mutation can redden it, either the code is dead or the test is missing — both are findings. (U2's own author wrote a delta-wrap, then deleted it after a mutation proved it dead.)
- **Sweep every choice function for continuity.** All four of U2's invisible defects were choice functions, each holding every asserted property *at every point tested* while jumping *between* points — up to 2593 px. **List the choice functions you introduce and sweep each.** In U3 the obvious candidate is any "which polygon vertex does this corner radius apply to" or "which shape does this gallery tile insert" mapping.
- **Ask of each test: what would have to be true for this to fail?** Seven assertions in U2 could not fail, including a supposed anti-vacuity guard that was itself vacuous, and two naive-substring traps (`not.toContain("disabled")` matches `disabled:pointer-events-none`; React serialises `height: 0` as `height:0`, never `height:0px`).
- **Do not spend effort on** `expect()`-count monotonicity or `bun run build` as evidence — the U2 review found neither earned its keep.
- **Report any defect in this plan rather than implementing around it.** Eleven were found that way in U1+U2, every one by an implementer who checked rather than transcribed.

---

### Task 1: The `clipPath` spike — settle the reservation before building on it

**Files:** create `tests/studio-render-clippath.test.ts`; touch no production file.

**This task's deliverable is knowledge, not a feature.** It answers one question with evidence: *can this project's real render pipeline draw a non-rectangular shape, and by what mechanism?*

**Verify first:** how `lib/studio/render.ts` invokes Satori and resvg, and what it returns; whether a test can call it without network or database. If rendering requires assets or fonts that a test cannot obtain, say so in your report and spike the narrowest thing that still answers the question.

- [ ] **Step 1: Render a triangle through the real pipeline.** Build the smallest scene that should produce a clearly non-rectangular fill, render it, and **inspect the output pixels** — not the intermediate SVG, and not a browser. A `clipPath: polygon(50% 0, 100% 100%, 0 100%)` on a solid fill either clips or it does not.

  **The property to establish, and it must be a pixel assertion:** a pixel near a corner the polygon excludes (say 5% in from the top-left) is **background**, while a pixel at the centre is **fill**. Asserting "the PNG is non-empty" or "no error was thrown" proves nothing — a `clipPath` silently ignored produces a perfectly valid full rectangle.

- [ ] **Step 2: Try the alternatives, in this order, and record which work.** Even if step 1 succeeds, establish what else does — Tasks 3–4 need to know which mechanisms are available:
  1. `clipPath` with `polygon()`
  2. `borderRadius: "50%"` for an ellipse (cheapest possible ellipse, and likely to work since border-radius is on the supported list)
  3. An inline `<svg>` node, if Satori accepts one
  4. A rotated `div` for a line/diagonal

- [ ] **Step 3: Write the finding down where the next reader will hit it.** Append a dated section to this plan file recording, for each mechanism: works / does not work / works with caveats, **with the evidence**. This is the artefact the roadmap's reservation was waiting for.

- [ ] **Step 4: Commit.** `test(studio): la vérification clipPath — ce que le moteur sait réellement dessiner`

- [ ] **Step 5: STOP AND REPORT.** State plainly which mechanisms work. **If `clipPath` does not work**, do not proceed and do not improvise: the fallback (an SVG-node shape family, or a reduced shape set of ellipse + line only) changes Tasks 3 and 4 materially and is the human's decision.

---

### Task 2: One description of a shape, consumed by both paths

**Files:** create `lib/studio/shapes.ts`; modify `lib/studio/scene.ts`, `lib/studio/element.ts`, `components/studio/layer-view.tsx`; tests.

**Verify first:** `SHAPE_KINDS` at `lib/studio/scene.ts:84` (today `["rect"]`), `shapeNode()` at `lib/studio/element.ts:79`, and `ShapeContent()` at `components/studio/layer-view.tsx:86`. Read §0 above before starting.

**The module.** A pure description of each shape: its kind, its French label, and **the CSS it needs in order to be painted** — expressed once, so that `shapeNode` (Satori) and `ShapeContent` (browser) can each ask for it instead of each carrying its own `switch`. Use only mechanisms Task 1 proved.

**This task must not add a single new shape.** It refactors `rect` onto the shared description and proves the two paths agree, so that Task 3 adds shapes in one place. Shipping the refactor and the new shapes together would make it impossible to tell which broke what.

**Properties:**
- For **every** kind in `SHAPE_KINDS`, both paths produce the shape's declared CSS — asserted by iterating `SHAPE_KINDS` itself, **never a hand-copied list** (U1 shipped exactly that defect, and U2's harness shipped it again).
- `rect` renders **byte-identically to before** on both paths — this is a refactor, and that is how you prove it.
- A kind present in `SHAPE_KINDS` but unhandled by either path is a **test failure**, not a silent fallback to a rectangle.

- [ ] Step 1: failing tests · [ ] Step 2: confirm red · [ ] Step 3: implement · [ ] Step 4: green, incl. `studio-element`/`studio-render` and the layer-view tests · [ ] Step 5: commit

---

### Task 3: Ellipse, line, and the polygon family

**Files:** `lib/studio/shapes.ts`, `lib/studio/scene.ts`, `lib/studio/shape-gallery.ts`, tests.

**Verify first:** Task 2's module, and `SHAPE_GALLERY` at `lib/studio/shape-gallery.ts:35` with the completeness guard U1 built around it.

**The shapes**, subject to Task 1's findings: **ellipse**, **line**, **triangle**, **star**, **hexagon**, **arrow**, **speech bubble**. If a mechanism did not survive Task 1, ship fewer and say which and why — **a shape that renders differently in the editor and the export must not ship at all.**

**Properties:**
- Each new kind is in `SHAPE_KINDS`, insertable from the gallery, and rendered by **both** paths — the guard from Task 2 enforces this, so adding a kind without rendering it fails.
- A **line** has a real height and remains selectable and draggable; decide and document what a "line" is geometrically (a thin rectangle? a rotated one?) rather than leaving it implicit.
- `radius` still applies where it means something, and is ignored — **not misapplied** — where it does not.
- Every shape survives a **rotation**, a **resize to `minSize`**, and a **non-uniform aspect** without becoming degenerate. Test the extremes; U2's defects all lived at extremes.

- [ ] Step 1: failing tests · [ ] Step 2: confirm red · [ ] Step 3: implement · [ ] Step 4: green · [ ] Step 5: commit

---

### Task 4: Shadows on shapes, and per-corner radius

**Files:** `lib/studio/scene.ts`, `lib/studio/shapes.ts`, `lib/studio/element.ts`, `components/studio/layer-view.tsx`, `components/studio/property-panel.tsx`, tests.

**Verify first:** how `box-shadow` is already used (U1's artboard shadow was **clipped** by an `overflow-hidden` container — a green test over an unmet property, and the same trap is available here), and the existing `radius` field.

**Per-corner radius** (`borderRadius: "8px 24px 8px 24px"`) and a **shadow** on shape layers. Both are on the engine's supported list, so this task is about the model and the controls, not about whether it can draw.

**Properties:**
- A per-corner radius round-trips through `parseScene` and renders on both paths.
- A **scalar** `radius` still parses — existing scenes must not break. State the migration explicitly.
- The shadow is **visible**, not merely present in the markup: assert against the composition, the way U2 Task 6's band test does with a real containment check.
- Radius on a clipped polygon: decide whether it applies, is ignored, or is hidden in the UI, and **say so in the interface** rather than letting the control do nothing (U2's precedent: `snap-rotation-note`, `safe-areas-none`).

- [ ] Step 1: failing tests · [ ] Step 2: confirm red · [ ] Step 3: implement · [ ] Step 4: green · [ ] Step 5: commit

---

### Task 5: The accessibility defect U2 deferred

**Files:** `components/studio/mode-switch.tsx`, tests.

`role="radiogroup"` sits above children that are not `radio` — they carry `aria-pressed`. A real accessibility bug, **older than U2**, deferred by U2's final review with the ruling *"acceptable for merge, carry to U3"*.

Fix it coherently: either the children become real radios, or the container stops claiming to be a radiogroup. **Assert the resulting role/state pair**, and check the keyboard behaviour matches whatever you choose — a radiogroup implies arrow-key navigation, and claiming the role without it is the same defect in a new coat.

- [ ] Step 1: failing test · [ ] Step 2: confirm red · [ ] Step 3: implement · [ ] Step 4: green · [ ] Step 5: commit

---

## Self-Review

**Coverage:** the roadmap's U3 line asks for ellipse, line, polygon family via `clipPath`, per-corner radius and shadows on shapes → Tasks 3 and 4, gated by Task 1's spike. Its explicit instruction to *"commence par la vérification `clipPath`"* → Task 1, with a stop-and-report. U2's deferred a11y item → Task 5.

**Placeholder scan:** none. Task 1 deliberately has an unknown outcome; that is its purpose, and the branch point is stated rather than assumed away.

**Type consistency:** `SHAPE_KINDS` is the single list, already consumed by `z.enum` and the gallery guard; Task 2 extends the same guard to both render paths rather than introducing a second list.

**The risk this plan carries:** Task 2 is a pure refactor with no user-visible result, and there is a standing temptation to fold it into Task 3. Don't. The two render paths have been silently independent since V1, and merging the refactor with the feature would hide which of the two caused any divergence — which is precisely the failure §0 exists to prevent.

---

## Résultat de la sonde clipPath — 2026-08-11 (Tâche 1)

**La réserve de la feuille de route est levée : `clipPath` + `polygon()` FONCTIONNE dans le pipeline réel de ce projet (satori 0.29.0 → @resvg/resvg-js 2.6.2 → sharp 0.35.3).** Établi par pixels de sortie, pas par documentation, pas par navigateur. Preuves : `tests/studio-render-clippath.test.ts` (23 tests, 71 assertions).

**Trois réserves sévères l'accompagnent.** Elles sont plus importantes que le « oui » lui-même : chacune produit une image FAUSSE sans lever d'erreur.

### Ce qui a réellement été mesuré, et ce qui ne pouvait pas l'être

`ShapeLayer` (`lib/studio/scene.ts`) n'a aujourd'hui **aucun champ capable de porter un `clipPath`**, et `shapeNode()` (`lib/studio/element.ts`) n'en émet aucun. Le chemin de production **ne peut donc pas exprimer un polygone** avant la Tâche 2 : `renderScene()` n'était pas pilotable de bout en bout pour ce mécanisme, et la Tâche 1 avait interdiction de modifier un fichier de production.

La sonde reconstruit donc les étapes 5 de `renderScene()` à l'identique, et **le prouve** : sur une scène que le schéma sait exprimer, `probe(sceneToElement(scene, new Map()))` et `renderScene(scene)` produisent des **octets strictement identiques** (2667 octets, JPEG q86 mozjpeg). Ce témoin de fidélité rougit dès qu'un seul paramètre de la réplique dérive (vérifié : `quality: 86 → 85` ⇒ 2577 ≠ 2667). Ce qui est mesuré est donc le moteur de production, à l'arbre de nœuds près.

Les mécanismes **exprimables aujourd'hui** (rotation, `radius` numérique) sont, eux, mesurés à travers `renderScene()` directement. Aucun réseau, aucune base, aucune police d'asset : un rendu de forme n'a besoin que de la police de repli embarquée.

Couleurs témoins : remplissage `#FF0000`, fond `#0000FF`, bordure `#00FF00`. Le JPEG de production les restitue à ±1.

### Mécanisme 1 — `clipPath: polygon(…)` : **FONCTIONNE, avec trois réserves**

Triangle `polygon(50% 0,100% 100%,0 100%)` plein canevas 400×400 :

| point | avec `clipPath` | TÉMOIN sans `clipPath` |
|---|---|---|
| (20,20) — 5 % du coin haut-gauche, exclu | `rgba(0,0,254,255)` **fond** | `rgba(254,0,0,255)` remplissage |
| (380,20) — coin haut-droit, exclu | `rgba(0,0,254,255)` **fond** | `rgba(254,0,0,255)` remplissage |
| (200,200) — centre | `rgba(254,0,0,255)` remplissage | `rgba(254,0,0,255)` remplissage |
| (60,390) — bas-gauche, inclus | `rgba(254,0,0,255)` remplissage | — |

Une étoile à 10 sommets se découpe aussi (creux entre branches à (200,380) = fond), et un remplissage en **dégradé** (`backgroundImage`, l'autre chemin de `shapeNode`) se découpe comme un aplat.

#### RÉSERVE 1 — la géométrie percentuelle dépend de l'ESPACEMENT de la chaîne

`satori/src/parser/shape.ts`, `parsePolygon` :

```
points.split(',').map((v) => v.split(' ').map((k, i) =>
  lengthToNumber(k, …, i === 0 ? width : height, …)))
```

Un **espace après une virgule** fabrique un premier jeton vide dans le point suivant : l'abscisse glisse à l'indice 1 et se résout alors contre la **hauteur** du cadre au lieu de sa **largeur**.

Sur un cadre **carré**, l'erreur est invisible (largeur == hauteur) — c'est exactement pourquoi elle peut traverser une revue. Sur 800×400 :

| chaîne | `<polygon points=…>` émis | (700,380), DANS le triangle voulu |
|---|---|---|
| `polygon(50% 0, 100% 100%, 0 100%)` (avec espaces — **la chaîne littérale du plan**) | `400 0, 400 400, 0 400` | `rgba(0,0,254,255)` **fond — moitié droite perdue** |
| `polygon(50% 0,100% 100%,0 100%)` (compacte) | `400 0,800 400,0 400` | `rgba(254,0,0,255)` remplissage |
| `polygon(400px 0px, 800px 400px, 0px 400px)` (unités absolues) | — | `rgba(254,0,0,255)` remplissage |

Aucune erreur n'est levée. **Conséquence pour la Tâche 2 :** la chaîne de `clipPath` doit être **générée** par `lib/studio/shapes.ts`, jamais recopiée à la main, et générée **sans espace après les virgules**. Un test doit rendre chaque forme du catalogue sur un cadre **non carré** — sur un carré, ce défaut est indétectable.

#### RÉSERVE 2 — `transform` ne fait PAS tourner le découpage

`satori/src/builder/rect.ts` : lorsque `style.transform` est présent, le rectangle de remplissage reçoit `clip-path: undefined` et l'ensemble est enveloppé dans `<g clip-path="url(#satori_cp-…)">`. Le groupe vit dans le repère du **parent** : le remplissage tourne, le masque non.

| | (200,30) sommet NON pivoté | (380,200) sommet ATTENDU après 90° |
|---|---|---|
| triangle découpé + `rotate(90deg)` | `rgba(254,0,0,255)` remplissage | `rgba(0,0,254,255)` fond |
| triangle découpé, sans rotation | `rgba(254,0,0,255)` remplissage | `rgba(0,0,254,255)` fond |

**Identiques : la rotation n'a aucun effet visible sur une forme découpée.** Ce n'est pas « satori ignore `transform` » — témoin : un carré 200×200 non découpé pivoté de 45° perd bien son ancien coin (115,115) = `rgba(0,0,254,255)` et gagne la pointe (200,80) = `rgba(254,0,2,255)`.

**Contournement mesuré :** faire tourner les **coordonnées** du polygone. `polygon(400px 200px,0px 400px,0px 0px)` (le triangle tourné de 90° à la main) donne (380,200) = `rgba(254,0,0,255)` et (200,30) = `rgba(0,0,254,255)` — le sommet est bien passé à droite.

**Conséquence pour la Tâche 3** (« Every shape survives a rotation ») : la propriété ne peut PAS être tenue par `layer.rotation` seule pour les formes découpées. Deux options, à trancher : (a) `shapes.ts` applique la rotation aux sommets du polygone et n'émet pas de `transform` ; (b) les formes polygonales n'acceptent pas la rotation, et l'interface le dit. **Une troisième option — laisser `layer.rotation` en place et ne rien faire — livrerait un contrôle de rotation qui ne fait rien sur la moitié du catalogue**, exactement le défaut que la Tâche 4 est chargée d'éviter ailleurs (`snap-rotation-note`, `safe-areas-none`).

#### RÉSERVE 3 — la bordure ÉCHAPPE au découpage

`rect.ts` dessine la bordure avec `clip-path: url(#rectClipId)` — le masque de **bordure**, jamais `currentClipPath`. Triangle découpé + bordure 20 px verte :

| point | résultat |
|---|---|
| (8,8) coin haut-gauche, **exclu par le polygone** | `rgba(0,255,1,255)` **bordure peinte quand même** |
| (200,8) milieu du bord haut | `rgba(0,255,1,255)` bordure |
| (60,40) intérieur exclu par le polygone, hors du trait | `rgba(0,0,254,255)` fond |
| (200,200) centre | `rgba(254,0,0,255)` remplissage |
| TÉMOIN sans bordure : (8,8) | `rgba(0,0,254,255)` fond |

Le contour reste **rectangulaire** alors que le remplissage est triangulaire. Seul le trait échappe (l'intérieur exclu reste du fond). **Conséquence :** `border` sur une forme polygonale produit une image incohérente. La Tâche 3 ou 4 doit soit masquer le contrôle de bordure pour ces formes, soit dessiner le contour comme un second polygone — pas laisser `shapeNode` émettre `border*` tel quel.

#### Composition avec `borderRadius` : intersection propre, sans surprise

Triangle rectangle `polygon(0 0,100% 100%,0 100%)` et `borderRadius: 150`, 400×400. P1 (30,370) est dans le triangle et hors du rectangle arrondi ; P2 (350,60) l'inverse ; P3 (100,300) dans les deux.

| | P1 (30,370) | P2 (350,60) | P3 (100,300) |
|---|---|---|---|
| `clipPath` seul | `rgba(254,0,0,255)` | `rgba(0,0,254,255)` | `rgba(254,0,0,255)` |
| `borderRadius` seul | `rgba(0,0,254,255)` | `rgba(254,0,0,255)` | `rgba(254,0,0,255)` |
| les deux | `rgba(0,0,254,255)` | `rgba(0,0,254,255)` | `rgba(254,0,0,255)` |

C'est bien l'**intersection** : aucun des deux n'écrase l'autre. Utile à la Tâche 4 (« Radius on a clipped polygon ») — la réponse est « le rayon s'applique, et il ronge le polygone » ; s'il ne doit rien faire, il faut l'empêcher explicitement.

### Mécanisme 2 — `borderRadius: "50%"` (ellipse) : **FONCTIONNE**

Cadre 800×400, ellipse cx=400 cy=200 rx=400 ry=200. (100,60) est **hors** de l'ellipse ((300/400)² + (140/200)² = 1,05) ; (150,80) est **dedans** (0,75). Aucune autre géométrie ne sépare ces deux points.

| point | `borderRadius: "50%"` | TÉMOIN sans rayon |
|---|---|---|
| (100,60) hors ellipse | `rgba(0,1,254,255)` **fond** | `rgba(254,0,0,255)` remplissage |
| (150,80) dans l'ellipse | `rgba(254,0,0,255)` remplissage | `rgba(254,0,0,255)` remplissage |
| (5,5) coin | `rgba(0,0,254,255)` fond | `rgba(254,0,0,255)` remplissage |

**RÉSERVE :** le champ `radius` de `ShapeLayer` est un `z.number()` — donc des pixels. Mesuré **à travers `renderScene()`** sur 800×400 avec `radius: 200` (le plus grand rayon utile) : (100,60) = remplissage et (400,5) = remplissage — c'est un **stade** (deux demi-cercles + un rectangle), **pas une ellipse**. La Tâche 3 doit faire porter la chaîne `"50%"` par le modèle ; un nombre ne suffit pas. C'est aussi une contrainte pour la Tâche 4 (`borderRadius: "8px 24px 8px 24px"` est une chaîne, pas un nombre : la migration du champ `radius` sert les deux tâches).

### Mécanisme 3 — nœud `<svg>` en ligne : **FONCTIONNE**

satori accepte un sous-arbre `<svg>` et le sérialise en `data:image/svg+xml` porté par un `<image>` — le **même chemin, déjà éprouvé dans ce dépôt**, que le QR code de `render.ts`. Le `<polygon>` n'apparaît donc pas tel quel dans le SVG de sortie ; seuls les pixels le confirment. Triangle `<polygon points="200,0 400,400 0,400">` en 400×400 : (20,20) = `rgba(0,0,254,255)` fond, (380,20) = `rgba(0,0,254,255)` fond, (200,200) = `rgba(254,0,0,255)` remplissage, (60,390) = `rgba(254,0,0,255)` remplissage.

**Repli disponible si `clipPath` posait problème** — mais il n'en pose pas ; et il a un coût que `clipPath` n'a pas : le second chemin de rendu (`components/studio/layer-view.tsx`, navigateur) devrait alors dupliquer la géométrie SVG au lieu de partager une simple chaîne CSS, ce qui va contre le §0 de ce plan.

### Mécanisme 4 — `div` pivoté (ligne / diagonale) : **FONCTIONNE, de bout en bout**

Mesuré à travers `renderScene()` — `layer.rotation` est exprimable par le schéma actuel. Calque `frame {x:50, y:196, w:300, h:8}`, `rotation: 45`, 400×400 : (140,140) et (260,260) = `rgba(254,0,0,255)` remplissage (sur la diagonale) ; (140,260) et (260,140) = `rgba(0,0,254,255)` fond. TÉMOIN sans rotation : (140,140) et (260,260) = fond, (200,200) = remplissage (la barre horizontale).

Une **ligne** peut donc être un rectangle fin pivoté. Attention à la réserve 2 : ce mécanisme fonctionne **parce qu'il n'y a pas de `clipPath`**. Une ligne implémentée par polygone découpé ne pourrait pas tourner.

### Ce que la sonde n'a PAS établi

- Le chemin **éditeur** (`layer-view.tsx`, navigateur) n'a pas été mesuré — hors périmètre, et le §0 rappelle que c'est une implémentation indépendante. Les réserves 1 à 3 sont des défauts de **satori**, donc probablement **absents** du navigateur : les deux chemins divergeront exactement là où le §0 prévient qu'ils divergent en silence.
- `box-shadow` sur une forme découpée n'a pas été testé (Tâche 4).
- Aucun rendu en **WebP** ni sur canevas transparent : la sonde utilise l'encodage JPEG par défaut de `renderScene`.

### La mutation, puisqu'elle est la garde

Quatre mutations exécutées, chacune fait rougir exactement ce qu'elle doit :

| mutation | résultat |
|---|---|
| `TRIANGLE = "polygon(…)"` → `"none"` | **6 tests rouges** (mécanisme 1, réserves 2 et 3) |
| `probe()` : `quality: 86` → `85` | **1 test rouge** — le témoin de fidélité (2577 ≠ 2667) |
| réserve 1 : chaîne à espaces → chaîne compacte | **1 test rouge** — l'assertion porte bien sur les espaces |
| témoin « la rotation fonctionne » : `rotate(45deg)` → rien | **1 test rouge** |
