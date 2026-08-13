# Studio Pro — Chantier C : Refonte des champs de l'inspecteur — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Donner à l'inspecteur du studio des champs de niveau pro — champs numériques « scrubby » (glisser pour balayer), un vrai sélecteur de couleur façon Figma, et des curseurs pour les valeurs bornées — sans toucher au moteur de rendu ni au schéma.

**Architecture :** Fonctions PURES d'abord (maths de couleur, de balayage, de curseur) dans `lib/studio/`, testées sans DOM ; fines coques React sur les primitives Base UI (Popover, Slider, Tabs) ; le patron `useCommitBuffer` existant et la discipline « une entrée d'historique par geste » préservés. Aucune bibliothèque nouvelle.

**Tech Stack :** Next.js 16.3, React, Base UI (`@base-ui/react`), Zod v4 (schéma inchangé), `bun test` (jsdom), Playwright (contrôleur).

## Global Constraints

- **Aucune bibliothèque nouvelle** — le sélecteur est construit sur Base UI + maths de couleur pures. Pas de `react-colorful`, `colord`, etc.
- **`lib/studio/*` reste client-safe / sans base / sans import React** — logique + types purs.
- **§0 non-régression :** le moteur de rendu Satori et `lib/studio/scene.ts` sont INCHANGÉS. Une couleur reste un `hexColor` (littéral `#RGB`/`#RRGGBB`/`#RRGGBBAA`/`transparent`, ou un `{{jeton}}`) ; `hexColor` accepte DÉJÀ 8 chiffres (alpha) — aucun changement de schéma. `layer.opacity` existe déjà (`0..1`) — on l'EXPOSE, on ne l'ajoute pas.
- **Une entrée d'historique par GESTE :** un balayage complet, un glisser dans le carré SV, un glisser de curseur = UN seul `onCommit` à la libération. `patch()` → `setLayerProp` empile une entrée à CHAQUE appel — donc ne jamais appeler `onCommit` par `pointermove`. Le tampon (`useCommitBuffer`) met à jour l'affichage LOCAL en direct ; le commit tombe au `pointerup`. (Le retour visuel sur le CANEVAS n'a lieu qu'à la libération pour v1 — un aperçu live pendant le balayage exigerait un canal d'aperçu/coalescence, DÉLIBÉRÉMENT hors périmètre.)
- **Anti-vacuité, la mutation est le juge, pas de piège de sous-chaîne** (les `aria-*`/`role` de Base UI, pas les libellés cherchés dans tout le HTML). `data-field` sur chaque contrôle.
- **Copie en français** (l'app est en français).
- **Le contrat `onCommit` est préservé** : les primitives redessinées gardent EXACTEMENT la signature que `property-panel.tsx`/`geometry-strip.tsx` appellent aujourd'hui (`onCommit: (v: number) => void` pour un nombre, `(v: string) => void` pour une couleur), pour que le §0 tienne sans toucher les appelants au-delà du strict nécessaire.

---

## File Structure

- **Create `lib/studio/color.ts`** — maths de couleur PURES (hex↔hsv↔rgb, parse, alpha, format). Feuille, aucun import React/DOM.
- **Create `lib/studio/field-scrub.ts`** — maths PURES de balayage et de curseur (`scrubValue`, `sliderValue`, `valueToFraction`, `opacityToPercent`, `percentToOpacity`). Feuille.
- **Modify `components/studio/property-fields.tsx`** — `NumberField` gagne le glisser-balayage (Tâche 3) ; nouvelle primitive `SliderField` (Tâche 5). C'est la FEUILLE commune (déjà importée par `property-panel.tsx` ET `geometry-strip.tsx`).
- **Create `components/studio/color-picker.tsx`** — le sélecteur (carré SV, teinte, alpha, hex/RGB, pipette, nuancier, récents, onglet jeton), monté dans un Popover (Tâche 4).
- **Create `components/ui/slider.tsx`** — enveloppe shadcn du `Slider` Base UI (Tâche 5 ; `components/ui/slider.tsx` n'existe pas encore ; `popover.tsx` et `tabs.tsx` existent déjà).
- **Modify `components/studio/property-panel.tsx`** — `ColorField` ouvre le sélecteur (Tâche 4) ; EXPOSE `layer.opacity` + combos curseur bornés (Tâche 5).
- **Tests :** `tests/studio-color.test.ts`, `tests/studio-field-scrub.test.ts`, `tests/studio-scrub-field.test.ts` (DOM), `tests/studio-color-picker.test.ts` (DOM), `tests/studio-slider-field.test.ts` (DOM).

---

## Task 1 : Maths de couleur pures (`lib/studio/color.ts`)

**Files:**
- Create: `lib/studio/color.ts`
- Test: `tests/studio-color.test.ts`

**Interfaces:**
- Produces:
  - `type Hsva = { h: number; s: number; v: number; a: number }` — `h` ∈ [0,360), `s`/`v`/`a` ∈ [0,1].
  - `parseColor(input: string): Hsva | null` — accepte `#RGB`, `#RRGGBB`, `#RRGGBBAA` (insensible à la casse), `"transparent"` (→ `{h:0,s:0,v:0,a:0}`) ; renvoie `null` pour tout le reste (jeton `{{…}}` inclus — le sélecteur traite les jetons à part).
  - `hsvaToHex(c: Hsva): string` — `#RRGGBB` si `a===1`, sinon `#RRGGBBAA` ; toujours minuscule, 8 bits par canal.
  - `hexToHsva(hex: string): Hsva | null` — alias pratique = `parseColor` restreint au hex (renvoie `null` sur non-hex).
  - `withAlpha(c: Hsva, a: number): Hsva` — clampe `a` à [0,1].
  - `formatHex(input: string): string | null` — normalise une saisie hex en `#rrggbb`/`#rrggbbaa` minuscule, ou `null` si invalide.

- [ ] **Step 1 : Écrire les tests qui échouent** (`tests/studio-color.test.ts`)

```ts
import { describe, expect, it } from "bun:test";
import { parseColor, hsvaToHex, hexToHsva, withAlpha, formatHex } from "@/lib/studio/color";

describe("parseColor", () => {
  it("lit #RRGGBB en HSVA opaque", () => {
    const c = parseColor("#ff0000")!;
    expect(c.h).toBeCloseTo(0, 5);
    expect(c.s).toBeCloseTo(1, 5);
    expect(c.v).toBeCloseTo(1, 5);
    expect(c.a).toBe(1);
  });
  it("lit #RGB (3 chiffres) comme sa forme longue", () => {
    expect(parseColor("#f00")).toEqual(parseColor("#ff0000"));
  });
  it("lit l'alpha #RRGGBBAA", () => {
    expect(parseColor("#ff000080")!.a).toBeCloseTo(0x80 / 255, 5);
  });
  it("transparent = alpha 0", () => { expect(parseColor("transparent")!.a).toBe(0); });
  it("renvoie null pour un jeton ou une saisie invalide", () => {
    expect(parseColor("{{brand.primary}}")).toBeNull();
    expect(parseColor("rouge")).toBeNull();
    expect(parseColor("#zzz")).toBeNull();
  });
});

describe("aller-retour hex↔hsva (la mutation est le juge)", () => {
  // BALAYAGE : un échantillon dense de hex doit revenir à lui-même via hsva à ±1/255.
  const samples = ["#000000", "#ffffff", "#3b82f6", "#e11d48", "#10b981", "#f59e0b", "#7c3aed", "#00000080"];
  for (const hex of samples) {
    it(`${hex} survit à l'aller-retour`, () => {
      expect(hsvaToHex(hexToHsva(hex)!)).toBe(hex.length === 7 ? hex : hex.toLowerCase());
    });
  }
  it("hsvaToHex omet l'alpha quand a===1", () => {
    expect(hsvaToHex({ h: 210, s: 0.5, v: 1, a: 1 })).toMatch(/^#[0-9a-f]{6}$/);
  });
  it("hsvaToHex inclut l'alpha quand a<1", () => {
    expect(hsvaToHex({ h: 210, s: 0.5, v: 1, a: 0.5 })).toMatch(/^#[0-9a-f]{8}$/);
  });
});

describe("withAlpha / formatHex", () => {
  it("withAlpha clampe à [0,1]", () => {
    expect(withAlpha({ h: 0, s: 0, v: 0, a: 1 }, 2).a).toBe(1);
    expect(withAlpha({ h: 0, s: 0, v: 0, a: 1 }, -1).a).toBe(0);
  });
  it("formatHex normalise la casse et la forme courte", () => {
    expect(formatHex("#F00")).toBe("#ff0000");
    expect(formatHex("#ABC123")).toBe("#abc123");
    expect(formatHex("pas une couleur")).toBeNull();
  });
});
```

- [ ] **Step 2 : Lancer → échec.** `bun test tests/studio-color.test.ts` — échoue (« parseColor is not defined »).

- [ ] **Step 3 : Implémenter `lib/studio/color.ts`.** Fonctions pures, aucun import. Convertir hex→rgb (gérer 3/6/8 chiffres), rgb→hsv (algorithme standard), hsv→rgb→hex. `parseColor` gère `transparent` et renvoie `null` hors hex. Ne PAS importer de `scene.ts` (feuille). Exemple de squelette :

```ts
// lib/studio/color.ts — maths de couleur PURES. Aucune dépendance (client-safe, sans base, sans React).
export type Hsva = { h: number; s: number; v: number; a: number };

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function hexToRgba(hex: string): { r: number; g: number; b: number; a: number } | null {
  if (!HEX_RE.test(hex)) return null;
  let h = hex.slice(1);
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a };
}

export function parseColor(input: string): Hsva | null {
  if (input === "transparent") return { h: 0, s: 0, v: 0, a: 0 };
  const rgba = hexToRgba(input);
  if (!rgba) return null;
  const { r, g, b, a } = rgba;
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max, a };
}

export const hexToHsva = (hex: string): Hsva | null => (HEX_RE.test(hex) ? parseColor(hex) : null);

export function hsvaToHex({ h, s, v, a }: Hsva): string {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  const seg = Math.floor(h / 60) % 6;
  [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][seg].forEach((val, i) => {
    const n = Math.round((val + m) * 255);
    if (i === 0) r = n; else if (i === 1) g = n; else b = n;
  });
  const hx = (n: number) => n.toString(16).padStart(2, "0");
  const base = `#${hx(r)}${hx(g)}${hx(b)}`;
  return a >= 1 ? base : `${base}${hx(Math.round(a * 255))}`;
}

export const withAlpha = (c: Hsva, a: number): Hsva => ({ ...c, a: Math.min(1, Math.max(0, a)) });

export function formatHex(input: string): string | null {
  const hsva = hexToHsva(input.trim());
  return hsva ? hsvaToHex(hsva) : null;
}
```

- [ ] **Step 4 : Lancer → succès.** `bun test tests/studio-color.test.ts` — vert. Puis `bunx tsc --noEmit` (seule l'erreur d'artefact `.next/dev/types` préexistante est tolérée).

- [ ] **Step 5 : Commit.**
```bash
git add lib/studio/color.ts tests/studio-color.test.ts
git commit -m "feat(studio): maths de couleur pures — hex/hsva/rgb, parse, alpha (chantier C T1)"
```

---

## Task 2 : Maths de balayage & de curseur pures (`lib/studio/field-scrub.ts`)

**Files:**
- Create: `lib/studio/field-scrub.ts`
- Test: `tests/studio-field-scrub.test.ts`

**Interfaces:**
- Produces:
  - `type ScrubModifier = "none" | "shift" | "alt"`.
  - `scrubValue(start: number, dxPx: number, opts: { step?: number; min?: number; max?: number; modifier?: ScrubModifier; pxPerStep?: number }): number` — `dxPx` pixels depuis le début du glisser → nouvelle valeur. Sensibilité de base : `pxPerStep` pixels par `step` (défaut `pxPerStep=4`, `step=1`). `modifier`: `"shift"` ×10, `"alt"` ×0.1. Arrondit au multiple de l'incrément effectif, clampe `[min,max]`.
  - `valueToFraction(value: number, min: number, max: number): number` — ∈ [0,1], clampé.
  - `sliderValue(fraction: number, opts: { min: number; max: number; step?: number }): number` — inverse, arrondi au step, clampé.
  - `opacityToPercent(opacity: number): number` — `0..1` → `0..100` entier arrondi.
  - `percentToOpacity(percent: number): number` — `0..100` → `0..1`, clampé.

- [ ] **Step 1 : Tests qui échouent** (`tests/studio-field-scrub.test.ts`)

```ts
import { describe, expect, it } from "bun:test";
import { scrubValue, valueToFraction, sliderValue, opacityToPercent, percentToOpacity } from "@/lib/studio/field-scrub";

describe("scrubValue (fonction de choix — balayer)", () => {
  it("dx=0 laisse la valeur inchangée (point-zéro)", () => {
    expect(scrubValue(50, 0, { step: 1 })).toBe(50);
  });
  it("continuité : un petit dx donne un petit delta, monotone", () => {
    const a = scrubValue(0, 4, { step: 1 });   // 1 pas
    const b = scrubValue(0, 8, { step: 1 });   // 2 pas
    expect(a).toBe(1); expect(b).toBe(2);
  });
  it("Maj multiplie par 10, Alt par 0.1", () => {
    expect(scrubValue(0, 40, { step: 1, modifier: "shift" })).toBe(100); // 10 pas × 10
    expect(scrubValue(0, 40, { step: 1, modifier: "alt" })).toBe(1);     // 10 pas × 0.1
  });
  it("clampe à [min,max]", () => {
    expect(scrubValue(0, -400, { step: 1, min: 0 })).toBe(0);
    expect(scrubValue(0, 4000, { step: 1, max: 100 })).toBe(100);
  });
  it("respecte le step (arrondi au multiple)", () => {
    expect(scrubValue(0, 6, { step: 0.5, pxPerStep: 4 })).toBeCloseTo(0.5 * (6 / 4), 5);
  });
});

describe("curseur ↔ fraction (aller-retour)", () => {
  it("valueToFraction et sliderValue sont inverses au step près", () => {
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      const v = sliderValue(f, { min: 0, max: 200, step: 1 });
      expect(valueToFraction(v, 0, 200)).toBeCloseTo(f, 2);
    }
  });
  it("valueToFraction clampe hors bornes", () => {
    expect(valueToFraction(-10, 0, 100)).toBe(0);
    expect(valueToFraction(999, 0, 100)).toBe(1);
  });
});

describe("opacité", () => {
  it("0..1 ↔ 0..100 aller-retour aux valeurs rondes", () => {
    expect(opacityToPercent(0.5)).toBe(50);
    expect(percentToOpacity(50)).toBeCloseTo(0.5, 5);
    expect(opacityToPercent(1)).toBe(100);
    expect(opacityToPercent(0)).toBe(0);
  });
  it("percentToOpacity clampe", () => {
    expect(percentToOpacity(150)).toBe(1);
    expect(percentToOpacity(-5)).toBe(0);
  });
});
```

- [ ] **Step 2 : Lancer → échec.** `bun test tests/studio-field-scrub.test.ts`.

- [ ] **Step 3 : Implémenter `lib/studio/field-scrub.ts`** (pur, aucun import) :

```ts
// lib/studio/field-scrub.ts — maths PURES de balayage/curseur. Aucune dépendance.
export type ScrubModifier = "none" | "shift" | "alt";

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const roundToStep = (v: number, step: number) => Math.round(v / step) * step;

export function scrubValue(
  start: number,
  dxPx: number,
  opts: { step?: number; min?: number; max?: number; modifier?: ScrubModifier; pxPerStep?: number } = {},
): number {
  const step = opts.step ?? 1;
  const pxPerStep = opts.pxPerStep ?? 4;
  const factor = opts.modifier === "shift" ? 10 : opts.modifier === "alt" ? 0.1 : 1;
  const steps = (dxPx / pxPerStep) * factor;
  const raw = start + steps * step;
  const stepped = roundToStep(raw, step * (opts.modifier === "alt" ? 0.1 : 1));
  return clamp(stepped, opts.min ?? -Infinity, opts.max ?? Infinity);
}

export const valueToFraction = (value: number, min: number, max: number): number =>
  max === min ? 0 : clamp((value - min) / (max - min), 0, 1);

export function sliderValue(fraction: number, opts: { min: number; max: number; step?: number }): number {
  const step = opts.step ?? 1;
  const raw = opts.min + clamp(fraction, 0, 1) * (opts.max - opts.min);
  return clamp(roundToStep(raw, step), opts.min, opts.max);
}

export const opacityToPercent = (opacity: number): number => Math.round(clamp(opacity, 0, 1) * 100);
export const percentToOpacity = (percent: number): number => clamp(percent, 0, 100) / 100;
```

- [ ] **Step 4 : Lancer → succès + `bunx tsc --noEmit`.**

- [ ] **Step 5 : Commit.**
```bash
git add lib/studio/field-scrub.ts tests/studio-field-scrub.test.ts
git commit -m "feat(studio): maths pures de balayage & de curseur — scrubValue/sliderValue/opacité (chantier C T2)"
```

---

## Task 3 : `NumberField` scrubby (glisser sur l'étiquette)

**Files:**
- Modify: `components/studio/property-fields.tsx` (la fonction `NumberField`, lignes ~51-91)
- Test: `tests/studio-scrub-field.test.ts` (DOM, harnais U0)

**Interfaces:**
- Consumes: `scrubValue`, `type ScrubModifier` (Tâche 2). `NumberField` garde EXACTEMENT sa signature actuelle (`label`, `value`, `onCommit`, `step?`, `min?`, `max?`, `action?`, `dataField?`, `disabled?`) — aucun appelant (`property-panel.tsx`, `geometry-strip.tsx`) n'est modifié.
- Produces: le même `NumberField`, dont l'ÉTIQUETTE est désormais une poignée de balayage.

**Comportement (à énoncer et tester) :** `pointerdown` sur l'étiquette → `setPointerCapture`, curseur `ew-resize`, mémorise `startValue = value` et `startX`. `pointermove` : calcule `dxPx = e.clientX - startX`, `modifier` depuis `e.shiftKey`/`e.altKey`, met à jour l'affichage LOCAL (`setLocal(String(scrubValue(startValue, dxPx, { step, min, max, modifier })))`) SANS appeler `onCommit`. `pointerup` : calcule la valeur finale et appelle `onCommit(finale)` UNE fois (si ≠ `value`), relâche la capture, restaure le curseur. `Escape` pendant le glisser : annule (revient à `startValue`, pas de commit). Un `pointerdown`+`pointerup` SANS mouvement (dx < seuil de 3 px) ne commit rien ET laisse le focus tomber dans l'`<input>` (clic-pour-taper préservé). Les flèches clavier de l'`<input>` restent inchangées.

- [ ] **Step 1 : Test DOM qui échoue** (`tests/studio-scrub-field.test.ts`). Monter `NumberField` via le harnais U0 (`tests/dom-harness.ts`), simuler un glisser sur l'étiquette, vérifier que `onCommit` est appelé UNE fois avec la valeur balayée, et PAS pendant le move.

```ts
import { describe, expect, it, mock } from "bun:test";
import { mountDom } from "./dom-harness"; // harnais U0 (voir tests existants studio-interactions)
import { NumberField } from "@/components/studio/property-fields";
import { createElement as h } from "react";

// NOTE À L'IMPLÉMENTEUR : calquer le montage exact sur un test DOM existant de tests/studio-*.test.ts
// (par ex. studio-interactions) — `mountDom` ci-dessus est indicatif. Le point testé, lui, est ferme :
describe("NumberField scrubby", () => {
  it("un glisser sur l'étiquette commit UNE fois la valeur balayée, pas par move", async () => {
    const onCommit = mock((_v: number) => {});
    const { container, fireLabelDrag } = mountNumberField({ label: "X", value: 10, step: 1, onCommit });
    // glisser de +40px sans modificateur → +10 pas (pxPerStep=4) → 20
    await fireLabelDrag({ fromX: 100, toXs: [110, 130], upX: 140 }); // moves puis up à +40
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toBe(20);
  });

  it("un clic sans mouvement ne commit pas et focalise l'input (clic-pour-taper)", async () => {
    const onCommit = mock((_v: number) => {});
    const { input, fireLabelClick } = mountNumberField({ label: "X", value: 10, onCommit });
    await fireLabelClick({ x: 100 }); // down puis up au même x
    expect(onCommit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
  });

  it("Escape pendant le glisser annule (pas de commit)", async () => {
    const onCommit = mock((_v: number) => {});
    const { fireLabelDragThenEscape } = mountNumberField({ label: "X", value: 10, step: 1, onCommit });
    await fireLabelDragThenEscape({ fromX: 100, toX: 130 });
    expect(onCommit).not.toHaveBeenCalled();
  });
});
```

> L'implémenteur écrit `mountNumberField` (un petit assembleur local montant `NumberField` dans le harnais U0 et exposant `fireLabelDrag`/`fireLabelClick`/`fireLabelDragThenEscape` via `PointerEvent`/`KeyboardEvent`), en calquant sur un test DOM existant. Les ASSERTIONS ci-dessus sont fermes.

- [ ] **Step 2 : Lancer → échec** (l'étiquette n'a pas de gestionnaire de pointeur ; `onCommit` non appelé par le glisser).

- [ ] **Step 3 : Implémenter le balayage dans `NumberField`.** Envelopper le `<Label>` (dans `FieldRow`) d'un gestionnaire, OU passer à `FieldRow` un `onLabelPointerDown`. Le plus simple : dans `NumberField`, rendre l'étiquette via un élément portant les gestionnaires plutôt que le `<Label>` nu — ajouter `className="cursor-ew-resize select-none"` et `data-scrub` pour le test. Utiliser un `useRef` pour `{ startX, startValue }` et un état `scrubbing`. Pendant le glisser, `setLocal` (le tampon existant) ; au `pointerup`, `onCommit`. Réutiliser `useCommitBuffer` déjà en place. Garder l'`<input>` et son `onKeyDown`/`onBlur` INCHANGÉS.

```tsx
// esquisse — dans NumberField, au-dessus du return :
const scrub = useRef<{ startX: number; startValue: number } | null>(null);
const [scrubbing, setScrubbing] = useState(false);
function onLabelPointerDown(e: React.PointerEvent) {
  if (disabled) return;
  (e.target as HTMLElement).setPointerCapture(e.pointerId);
  scrub.current = { startX: e.clientX, startValue: value };
  setScrubbing(true);
}
function onLabelPointerMove(e: React.PointerEvent) {
  if (!scrub.current) return;
  const modifier = e.shiftKey ? "shift" : e.altKey ? "alt" : "none";
  const v = scrubValue(scrub.current.startValue, e.clientX - scrub.current.startX, { step, min, max, modifier });
  setEditing(true); setLocal(String(v));
}
function onLabelPointerUp(e: React.PointerEvent) {
  if (!scrub.current) return;
  const moved = Math.abs(e.clientX - scrub.current.startX) >= 3;
  const modifier = e.shiftKey ? "shift" : e.altKey ? "alt" : "none";
  const v = scrubValue(scrub.current.startValue, e.clientX - scrub.current.startX, { step, min, max, modifier });
  scrub.current = null; setScrubbing(false); setEditing(false);
  if (moved) { if (v !== value) onCommit(v); else setLocal(strValue); }
  else { inputRef.current?.focus(); } // clic sans mouvement → focus l'input
}
function onLabelKeyDown(e: React.KeyboardEvent) {
  if (e.key === "Escape" && scrub.current) { setLocal(strValue); setEditing(false); scrub.current = null; setScrubbing(false); }
}
```

Fournir `FieldRow` un moyen de porter ces gestionnaires sur son `<Label>` (ajouter des props optionnelles `labelProps?: React.HTMLAttributes<HTMLElement>` à `FieldRow`, sans casser ses autres appelants). Passer aussi un `inputRef`.

- [ ] **Step 4 : Lancer → succès.** `bun test tests/studio-scrub-field.test.ts`, puis `bun test tests/studio-*.test.ts` (le flake préexistant `studio-autosave` ordre-dépendant est le SEUL échec toléré), puis `bunx tsc --noEmit`. **Mutation :** supprimer le clamp/`onCommit`-unique → un test rougit.

- [ ] **Step 5 : Commit.**
```bash
git add components/studio/property-fields.tsx tests/studio-scrub-field.test.ts
git commit -m "feat(studio): champs numériques scrubby — glisser l'étiquette, Maj ×10/Alt ×0.1, une entrée d'historique (chantier C T3)"
```

---

## Task 4 : Le sélecteur de couleur (`color-picker.tsx`)

**Files:**
- Create: `components/studio/color-picker.tsx`
- Modify: `components/studio/property-panel.tsx` (la fonction `ColorField`, lignes ~139-188 : remplacer l'`<input>` hex par le déclencheur du sélecteur)
- Test: `tests/studio-color-picker.test.ts` (DOM)

**Interfaces:**
- Consumes: `parseColor`, `hsvaToHex`, `withAlpha`, `formatHex`, `type Hsva` (Tâche 1) ; `scrubValue` (Tâche 2, pour le glisser du carré SV/curseurs) ; `pickerRowsFor(context, "color")` + `TokenPicker`/`onPick` (existant, `components/studio/token-picker.tsx`) pour l'onglet jeton ; `Popover`/`Tabs` (`components/ui/`).
- Produces: `ColorPicker({ value, context, onCommit, dataField })` — `value: string` (hex, `transparent`, ou `{{jeton}}`), `onCommit: (v: string) => void`. Un module-niveau `recentColors: string[]` (session) + `pushRecent(hex)`.

**Comportement :** le déclencheur = la pastille d'aperçu + la valeur (le rendu actuel de `ColorField`). Cliquer ouvre un Popover à deux onglets (`Tabs`) : **« Couleur »** (carré SV glissable + curseur teinte + curseur alpha + entrée hex/RGB + bouton pipette si `window.EyeDropper` existe + grille de nuancier de marque + rangée « Récents ») et **« Jeton »** (les `pickerRowsFor(context, "color")`, choisir → `onCommit("{{id}}")`). Chaque changement de couleur littérale appelle `onCommit(hsvaToHex(...))` — au RELÂCHEMENT d'un glisser (carré/curseur) = une entrée d'historique ; une saisie hex valide commit au blur/Entrée ; un clic de nuancier/récent/pipette commit immédiatement (geste unique). `pushRecent` à chaque commit littéral. `data-field` sur le déclencheur ; `data-testid` sur les sous-contrôles (`color-sv`, `color-hue`, `color-alpha`, `color-hex`, `color-eyedropper`, `color-swatch`, `color-token-tab`).

**Le nuancier de marque** : constante `BRAND_SWATCHES: string[]` dans `color-picker.tsx`, SOURCÉE des jetons de thème de l'app — l'implémenteur lit `app/globals.css` / la config de thème pour les valeurs éditoriales (terracotta + neutres) et les recopie en hex littéraux (commenter la source). Ne PAS deviner : si aucune palette n'est trouvable, utiliser les couleurs de marque déjà présentes dans `lib/studio` (par ex. les valeurs par défaut de `categoryColors`/thème) et le noter.

**Type `EyeDropper`** : TS peut ne pas le connaître. Ajouter en tête de fichier une déclaration minimale :
```ts
declare global {
  interface Window { EyeDropper?: { new (): { open: () => Promise<{ sRGBHex: string }> } }; }
}
```

- [ ] **Step 1 : Test DOM qui échoue** (`tests/studio-color-picker.test.ts`) — monter `ColorField` (via `PropertyPanel` ou un montage local), ouvrir le sélecteur, vérifier : (a) un clic de nuancier commit ce hex ; (b) l'onglet Jeton commit `{{id}}` ; (c) taper un hex valide + blur commit le hex normalisé ; (d) §0 : une valeur `{{jeton}}` initiale affiche l'état lié (damier) et l'onglet Jeton.

```ts
import { describe, expect, it, mock } from "bun:test";
import { ColorPicker } from "@/components/studio/color-picker";
// Monter via le harnais U0 comme les tests studio-property-panel existants.
describe("ColorPicker", () => {
  it("cliquer une pastille de nuancier commit son hex", async () => {
    const onCommit = mock((_v: string) => {});
    const { openAndClickSwatch } = mountColorPicker({ value: "#000000", context: "article_image", onCommit });
    await openAndClickSwatch(0); // première pastille de BRAND_SWATCHES
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toMatch(/^#[0-9a-f]{6}$/);
  });
  it("l'onglet Jeton commit {{id}} (liaison U4 préservée)", async () => {
    const onCommit = mock((_v: string) => {});
    const { openTokenTabAndPickFirst } = mountColorPicker({ value: "#000000", context: "article_image", onCommit });
    await openTokenTabAndPickFirst();
    expect(onCommit.mock.calls[0][0]).toMatch(/^\{\{.+\}\}$/);
  });
  it("taper un hex court le normalise au commit", async () => {
    const onCommit = mock((_v: string) => {});
    const { openTypeHexBlur } = mountColorPicker({ value: "#000000", context: "article_image", onCommit });
    await openTypeHexBlur("#f00");
    expect(onCommit).toHaveBeenCalledWith("#ff0000");
  });
});
```

- [ ] **Step 2 : Lancer → échec.**

- [ ] **Step 3 : Implémenter `color-picker.tsx`** (carré SV en pointer-drag réutilisant `scrubValue` OU un simple ratio position→(s,v) ; curseurs teinte/alpha idem ; hex via `formatHex`/`hsvaToHex` ; pipette `await new window.EyeDropper().open()` → `onCommit(formatHex(sRGBHex))` ; nuancier `BRAND_SWATCHES.map` ; récents `recentColors`). Puis **modifier `ColorField`** dans `property-panel.tsx` : remplacer le `<div className="flex …"><span swatch/><Input/></div>` par `<ColorPicker value={local} context={context} onCommit={(v) => { setLocal(v); onCommit(v); }} dataField={dataField} />`, en gardant l'état « lié » (damier) pour un jeton. `ColorField` conserve son `action` (le `TokenPicker` peut disparaître de l'action puisque l'onglet Jeton le remplace — le noter et garder le comportement de liaison identique).

- [ ] **Step 4 : Lancer → succès.** `bun test tests/studio-color-picker.test.ts`, `bun test tests/studio-*.test.ts` (flake autosave toléré), `bunx tsc --noEmit`. **Mutation :** faire commit au sélecteur une couleur FIXE quel que soit le clic → le test « cliquer une pastille » rougit.

- [ ] **Step 5 : Commit.**
```bash
git add components/studio/color-picker.tsx components/studio/property-panel.tsx tests/studio-color-picker.test.ts
git commit -m "feat(studio): vrai sélecteur de couleur — carré SV/teinte/alpha/hex/pipette/nuancier/récents + onglet jeton (chantier C T4)"
```

---

## Task 5 : `SliderField` + opacité + combos bornés

**Files:**
- Create: `components/ui/slider.tsx` (enveloppe du `Slider` Base UI)
- Modify: `components/studio/property-fields.tsx` (ajouter `SliderField`)
- Modify: `components/studio/property-panel.tsx` (EXPOSER `layer.opacity` + combos flou/interligne)
- Test: `tests/studio-slider-field.test.ts` (DOM)

**Interfaces:**
- Consumes: `sliderValue`, `valueToFraction`, `opacityToPercent`, `percentToOpacity` (Tâche 2) ; `Slider` (nouveau `components/ui/slider.tsx`).
- Produces: `SliderField({ label, value, min, max, step?, onCommit, format?, dataField? })` — curseur + `<input>` numérique synchronisé ; `onCommit: (v: number) => void` UNE fois par glisser ; `format?: (v:number)=>string` pour l'affichage (par ex. « % »).

- [ ] **Step 1 : `components/ui/slider.tsx`** — enveloppe shadcn du `@base-ui/react/slider` (calquer sur `components/ui/switch.tsx`/`popover.tsx` pour le style et les `data-slot`). Pas de test propre (primitive de présentation ; couverte par `SliderField`).

- [ ] **Step 2 : Test DOM qui échoue** (`tests/studio-slider-field.test.ts`) — monter `SliderField`, bouger le curseur, vérifier `onCommit` appelé UNE fois par geste avec la valeur `sliderValue` ; taper dans le numérique synchronisé commit aussi ; l'aller-retour opacité (0.5 ↔ 50 %).

```ts
import { describe, expect, it, mock } from "bun:test";
import { SliderField } from "@/components/studio/property-fields";
describe("SliderField", () => {
  it("un glisser du curseur commit une fois la valeur bornée", async () => {
    const onCommit = mock((_v: number) => {});
    const { dragTo } = mountSliderField({ label: "Opacité", value: 100, min: 0, max: 100, step: 1, onCommit });
    await dragTo(0.5); // fraction 0.5 → 50
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toBe(50);
  });
  it("le numérique synchronisé reflète et commit", async () => {
    const onCommit = mock((_v: number) => {});
    const { typeNumber } = mountSliderField({ label: "Flou", value: 4, min: 0, max: 200, step: 1, onCommit });
    await typeNumber(20);
    expect(onCommit).toHaveBeenCalledWith(20);
  });
});
```

- [ ] **Step 3 : Implémenter `SliderField`** dans `property-fields.tsx` (curseur Base UI + `NumberField`-like synchronisé, tampon `useCommitBuffer`, commit au `onValueCommitted` du Slider — Base UI expose un événement de fin de glisser). Puis **exposer l'opacité** dans `property-panel.tsx` : dans la section « Apparence » de CHAQUE type de calque (texte/image/forme/qr), ajouter
```tsx
<SliderField
  label="Opacité" dataField="opacity"
  value={opacityToPercent(layer.opacity ?? 1)} min={0} max={100} step={1}
  format={(v) => `${v} %`}
  onCommit={(pct) => patch({ opacity: pct >= 100 ? undefined : percentToOpacity(pct) })}
/>
```
(écrire `undefined` à 100 % garde le §0 : un calque pleinement opaque reste SANS clé `opacity`, identique à aujourd'hui). Convertir le champ « Flou » d'ombre et « Interligne » en combos `SliderField` (garder leurs bornes `min` existantes ; l'interligne `min 0.1`, le flou `min 0`).

- [ ] **Step 4 : Lancer → succès.** `bun test tests/studio-slider-field.test.ts`, `bun test tests/studio-*.test.ts` (flake autosave toléré), `bunx tsc --noEmit`. **§0 :** un test vérifie qu'un calque opacité 100 % ne porte PAS de clé `opacity` après un aller-retour. **Mutation :** ignorer la fraction du curseur (commit fixe) → le test de glisser rougit.

- [ ] **Step 5 : Commit.**
```bash
git add components/ui/slider.tsx components/studio/property-fields.tsx components/studio/property-panel.tsx tests/studio-slider-field.test.ts
git commit -m "feat(studio): SliderField + opacité exposée + combos bornés (flou/interligne) (chantier C T5)"
```

---

## Task 6 : Intégration, passe §0, et vérification visuelle

**Files:**
- Modify: (au besoin) `components/studio/property-panel.tsx`, `components/studio/geometry-strip.tsx` — cohérence finale.
- Test: `tests/studio-property-panel.test.ts` (§0 non-régression), plus la vérification Playwright du contrôleur.

**Interfaces:** aucune nouvelle — cette tâche relie et vérifie.

- [ ] **Step 1 : Test §0 de non-régression** — un test qui monte `PropertyPanel` sur un calque texte, forme, image et qr, et vérifie que : taper dans un champ numérique commit toujours à l'identique ; un `ColorField` avec une valeur `{{jeton}}` initiale affiche l'état lié ; un gabarit sans `opacity`/couleur alpha se sérialise identiquement (`parseScene(scene)` aller-retour deep-equal). Réutiliser les assertions des tests `studio-property-panel` existants.

- [ ] **Step 2 : Lancer → tout vert** (`bun test tests/studio-*.test.ts` sauf le flake autosave ; `bun run test:pure` ; `bunx tsc --noEmit`).

- [ ] **Step 3 : Vérification VISUELLE (contrôleur, Playwright).** Serveur de dev + login (README : `admin@afrotiative.com`). Sur un gabarit, vérifier à l'écran : le glisser-balayage change une valeur ; le sélecteur s'ouvre, le carré SV/curseurs/pipette/nuancier fonctionnent, l'onglet Jeton lie ; le curseur d'opacité change l'opacité rendue. (Les IMPLÉMENTEURS NE lancent PAS Playwright — ils calent au `bun test`/`tsc` ; le contrôleur fait cette passe.)

- [ ] **Step 4 : Commit** (s'il y a des correctifs d'intégration ; sinon rien).
```bash
git add -A && git commit -m "chore(studio): passe d'intégration §0 des champs de l'inspecteur (chantier C T6)"
```

---

## Self-Review (auteur du plan)

**1. Couverture de la spec :** §1 scrubby → T2 (maths) + T3 (champ) ; §2 sélecteur → T1 (maths) + T4 (composant) ; §3 curseurs → T2 (maths) + T5 (`SliderField`/opacité/combos) ; §4 cohérence/§0 → discipline « une entrée par geste » dans T3/T4/T5 + T6 ; qualité/tests → tests purs balayés (T1/T2) + DOM (T3/T4/T5) + Playwright (T6). Toutes les sections couvertes.

**2. Placeholders :** aucun TBD ; chaque fonction pure a son test concret ; les tests DOM énoncent des assertions fermes et confient à l'implémenteur uniquement l'ASSEMBLAGE du montage (calqué sur un test existant), pas la logique.

**3. Cohérence des types :** `Hsva`, `parseColor`/`hsvaToHex`/`withAlpha`/`formatHex` (T1) consommés par T4 ; `scrubValue`/`ScrubModifier` (T2) par T3 et T4 ; `sliderValue`/`valueToFraction`/`opacityToPercent`/`percentToOpacity` (T2) par T5 ; `SliderField`/`ColorPicker` signatures stables. `NumberField` garde sa signature (aucun appelant cassé). `onCommit` inchangé partout.

**Note d'exécution :** brancher sur `feat/studio-pro-c-inspecteur` (déjà créée, off main). C est indépendant du chantier B (en revue) ; si B fusionne d'abord, une fusion/rebase règle les rares recouvrements dans `property-panel.tsx` (C ne réorganise pas l'inspecteur, surface minimale).
