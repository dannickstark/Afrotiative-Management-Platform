# Studio Pro — Chantier E : Craft visuel & marque — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Appliquer la marque éditoriale au STUDIO (que l'audit go-live avait exclu) — fond d'atelier tokenisé, palette de surcouches centralisée et cohérée, états vides de marque, mouvement plus riche, icônes cohérentes — sans toucher au moteur de rendu.

**Architecture :** CHROME d'éditeur uniquement. Jetons CSS (`globals.css`), un module PUR `lib/studio/overlay-theme.ts` comme source unique des couleurs de surcouches, réutilisation de la primitive de marque `components/shell/empty-state.tsx`, jetons de mouvement + `prefers-reduced-motion`, convention de taille d'icône partagée. Chaque livrable a un ARTEFACT testable ; le SUBJECTIF est jugé par une passe Playwright du contrôleur.

**Tech Stack :** Next.js 16.3, Tailwind v4 (`@theme`), CSS custom properties (oklch), lucide-react, Base UI, `bun test` (jsdom), Playwright (contrôleur).

## Global Constraints

- **Portée moteur : AUCUNE.** `lib/studio/scene.ts` et le chemin de rendu Satori (`render.ts`/`resolve.ts`/`element.ts`) sont INCHANGÉS. La sortie de rendu est bit à bit identique. E est de la chrome (CSS/couleurs/composants/mouvement/icônes).
- **Aucune bibliothèque nouvelle** — transitions CSS tokenisées (pas de framer-motion) ; icônes lucide AFFINÉES (aucun nouveau dessin).
- **§0 :** les surcouches gardent leur GÉOMÉTRIE et leurs `data-testid` (`snap-guide`, `binding-outline`, `binding-label`, poignées) ; seule la COULEUR bouge. Les `data-testid` verrouillés par des tests existants (`property-panel-empty`, `property-panel-empty-hint`) sont PRÉSERVÉS.
- **Mouvement toujours coupé par `@media (prefers-reduced-motion: reduce)`** — non négociable (accessibilité).
- **Surcouches : cohérer à la marque MAIS garder chaque rôle DISTINCT** (sélection ≠ guide ≠ liaison ≠ zone sûre).
- **`lib/studio/*` reste client-safe / sans base / sans React.** Copie en français. `data-testid`/`data-field` sur les contrôles, rôles Base UI (pas de sous-chaîne).

---

## File Structure

- **Modify `app/globals.css`** — ajoute `--canvas-backdrop` (`:root` ~L66 + `.dark` ~L101) et les jetons de mouvement (`--ease-spring`, `--motion-fast`, `--motion-base`) + la coupe `prefers-reduced-motion` (E1, E4).
- **Modify `components/studio/editor-shell.tsx`** — consomme `--canvas-backdrop` (L978) ; `TooSmallState` (L1125) via `EmptyState` (E1, E3) ; classes de mouvement sur les tiroirs/panneaux (E4).
- **Create `lib/studio/overlay-theme.ts`** — module PUR, source unique des couleurs de surcouches (E2).
- **Modify `components/studio/canvas.tsx`** — consomme `overlay-theme` (remplace `#2563eb`/`GUIDE_COLOR`/`BINDING_COLOR`/`#fff`) (E2) ; classe de transition du contour de sélection (E4).
- **Modify `components/studio/canvas-chrome.tsx`** — consomme `overlay-theme` (remplace `SAFE_TINT`/`SAFE_LINE`) (E2).
- **Modify `components/studio/property-panel.tsx`** — l'état vide (`property-panel-empty`) via `EmptyState` (E3).
- **Modify `components/studio/floating-toolbar.tsx`, `canvas-context-menu.tsx`** — classes de mouvement (E4).
- **Create `lib/studio/studio-icons.ts`** — convention de taille/trait d'icône partagée (E5).
- **Modify** rail/inspector/toolbars pour consommer la convention d'icône + finition accent/titre (E5).
- **Tests :** `tests/studio-overlay-theme.test.ts` (pur), `tests/studio-craft.test.ts` (DOM : états vides, mouvement, icônes, §0).

---

## Task 1 : Jeton `--canvas-backdrop`

**Files:**
- Modify: `app/globals.css` (`:root` ~L66, `.dark` ~L101)
- Modify: `components/studio/editor-shell.tsx:978`
- Test: `tests/studio-craft.test.ts`

**Interfaces:**
- Produces: la variable CSS `--canvas-backdrop` (clair + sombre) ; le `canvas-backdrop` div la consomme.

- [ ] **Step 1 : Test qui échoue** (`tests/studio-craft.test.ts`) — lire le SOURCE de `globals.css` et `editor-shell.tsx` (pas de rendu) et vérifier le jeton + sa consommation, l'absence du fond en dur :

```ts
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const ROOT = join(import.meta.dir, "..");
const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");
const shell = readFileSync(join(ROOT, "components/studio/editor-shell.tsx"), "utf8");

describe("chantier E · --canvas-backdrop", () => {
  it("le jeton est défini en clair ET en sombre", () => {
    // défini au moins deux fois (bloc :root clair + bloc .dark)
    const hits = css.match(/--canvas-backdrop\s*:/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });
  it("le canvas-backdrop consomme le jeton, plus de fond neutre EN DUR", () => {
    // le div data-testid="canvas-backdrop" utilise var(--canvas-backdrop)
    expect(shell).toContain("var(--canvas-backdrop)");
    // le couple neutral-100 / dark:bg-neutral-900 en dur a disparu de ce fichier
    expect(shell).not.toContain("bg-neutral-100");
    expect(shell).not.toContain("dark:bg-neutral-900");
  });
});
```

- [ ] **Step 2 : Lancer → échec.** `bun test tests/studio-craft.test.ts`.

- [ ] **Step 3 : Implémenter.** Dans `globals.css`, ajouter au bloc `:root` (~L66, clair) un neutre éditorial CHAUD et au bloc `.dark` (~L101) son pendant sombre :
```css
/* :root (clair) */  --canvas-backdrop: oklch(0.965 0.008 75);   /* gris chaud éditorial, ~neutral mais tiède */
/* .dark */          --canvas-backdrop: oklch(0.205 0.006 75);   /* fond d'atelier sombre chaud */
```
Dans `editor-shell.tsx:978`, remplacer `bg-neutral-100 p-4 dark:bg-neutral-900` par `p-4` + un style/classe consommant le jeton — le plus simple, une classe utilitaire arbitraire Tailwind : `bg-[var(--canvas-backdrop)]`. (Garder le reste de la className : `flex min-w-0 flex-1 items-center justify-center overflow-auto rounded-lg border … p-4`.) Mettre à jour le commentaire voisin (L961-964) qui décrit l'ancien fond en dur.

- [ ] **Step 4 : Lancer → succès + `bun test tests/studio-editor-shell.test.ts` (le canvas-backdrop reste monté) + `bunx tsc --noEmit`** (seule l'erreur d'artefact `.next/dev/types` préexistante tolérée).

- [ ] **Step 5 : Commit.**
```bash
git add app/globals.css components/studio/editor-shell.tsx tests/studio-craft.test.ts
git commit -m "feat(studio): jeton --canvas-backdrop (neutre éditorial chaud) remplace le fond en dur (chantier E T1)"
```

---

## Task 2 : `lib/studio/overlay-theme.ts` — palette de surcouches centralisée

**Files:**
- Create: `lib/studio/overlay-theme.ts`
- Modify: `components/studio/canvas.tsx` (L120 `GUIDE_COLOR`, L127 `BINDING_COLOR`, L453/474 `#2563eb`/`#fff`, L561/581-582)
- Modify: `components/studio/canvas-chrome.tsx` (L86-87 `SAFE_TINT`/`SAFE_LINE`)
- Test: `tests/studio-overlay-theme.test.ts`

**Interfaces:**
- Produces: `OVERLAY` — un objet gelé aux clés au moins `selection`, `handleFill`, `snapGuide`, `binding`, `bindingLabelFg`, `safeTint`, `safeLine` (toutes des chaînes CSS). Plus `SELECTION`/`SNAP_GUIDE`/`BINDING`/`SAFE_TINT`/`SAFE_LINE` en exports nommés pour les consommateurs.

- [ ] **Step 1 : Test PUR qui échoue** (`tests/studio-overlay-theme.test.ts`) — la source unique + la DISTINCTION des rôles :

```ts
import { describe, expect, it } from "bun:test";
import { OVERLAY } from "@/lib/studio/overlay-theme";

describe("overlay-theme (palette de surcouches)", () => {
  it("les quatre RÔLES restent visuellement distincts (anti-régression d'usage)", () => {
    const roles = [OVERLAY.selection, OVERLAY.snapGuide, OVERLAY.binding, OVERLAY.safeTint];
    // aucune paire identique — un designer doit pouvoir les différencier
    expect(new Set(roles).size).toBe(roles.length);
  });
  it("les valeurs sont des chaînes CSS non vides", () => {
    for (const v of Object.values(OVERLAY)) { expect(typeof v).toBe("string"); expect(v.length).toBeGreaterThan(0); }
  });
});
```

- [ ] **Step 2 : Lancer → échec.**

- [ ] **Step 3 : Implémenter `lib/studio/overlay-theme.ts`** (PUR, aucun import ; nudge éditorial en gardant 4 hues distincts — la sélection reste FROIDE pour se démarquer du chaud de la marque ; le guide se rapproche de la terracotta ; la liaison reste violette ; la zone sûre reste ambre) :

```ts
// lib/studio/overlay-theme.ts — SOURCE UNIQUE des couleurs de surcouches du canevas (chrome, pas moteur).
// Cohérées à la marque éditoriale MAIS chaque rôle reste VISUELLEMENT DISTINCT (leçon d'usage U2/U4 :
// une sélection n'est pas un guide n'est pas une liaison n'est pas une zone sûre). Module pur, sans import.
export const OVERLAY = Object.freeze({
  selection: "#2f5fe0",        // bleu encre — reste FROID, distinct du chaud de la marque
  handleFill: "#ffffff",       // poignées : pastille blanche bordée `selection`
  snapGuide: "#d1472f",        // terracotta — rapproché de --accent-brand (guide = repère de marque)
  binding: "#7c3aed",          // violet — distinct des trois autres
  bindingLabelFg: "#ffffff",
  safeTint: "rgba(245,158,11,0.14)", // ambre translucide (zone sûre)
  safeLine: "1px dashed rgba(245,158,11,0.85)",
});

export const SELECTION = OVERLAY.selection;
export const HANDLE_FILL = OVERLAY.handleFill;
export const SNAP_GUIDE = OVERLAY.snapGuide;
export const BINDING = OVERLAY.binding;
export const SAFE_TINT = OVERLAY.safeTint;
export const SAFE_LINE = OVERLAY.safeLine;
```

Puis migrer les consommateurs : dans `canvas.tsx`, `const GUIDE_COLOR = SNAP_GUIDE;` `const BINDING_COLOR = BINDING;` et remplacer les `#2563eb`/`#fff` littéraux des poignées (L453, L474) par `HANDLE_FILL`/`SELECTION` (`background: HANDLE_FILL, border: \`1px solid ${SELECTION}\``), le contour de liaison (L561) par `${BINDING}`, l'étiquette (L581-582) par `background: BINDING, color: OVERLAY.bindingLabelFg`. Dans `canvas-chrome.tsx`, remplacer les constantes locales `SAFE_TINT`/`SAFE_LINE` (L86-87) par l'import depuis `overlay-theme`. GARDER toute la géométrie et les `data-testid` inchangés.

- [ ] **Step 4 : Test §0 de migration** (dans `tests/studio-craft.test.ts`) — grep source : aucun hexe de surcouche BRUT ne subsiste dans les deux composants :
```ts
it("aucune couleur de surcouche EN DUR ne subsiste dans canvas/canvas-chrome (source unique)", () => {
  const canvas = readFileSync(join(ROOT, "components/studio/canvas.tsx"), "utf8");
  const chrome = readFileSync(join(ROOT, "components/studio/canvas-chrome.tsx"), "utf8");
  // les hexes historiques ne doivent plus apparaître comme LITTÉRAUX de code (les commentaires citant
  // l'historique sont tolérés : on vérifie l'absence dans un contexte de valeur CSS "…: '#…'" ou `${…}`).
  for (const hex of ["#2563eb", "#e11d48", "#7c3aed"]) {
    expect(canvas.includes(`"${hex}"`) || canvas.includes(`'${hex}'`)).toBe(false);
  }
  expect(chrome.includes("rgba(245,158,11")).toBe(false); // migré vers overlay-theme
});
```
(Si un commentaire historique gêne le grep, l'implémenteur reformule le commentaire — la RÈGLE « source unique » prime.) Lancer `bun test tests/studio-overlay-theme.test.ts tests/studio-craft.test.ts`, puis `bun test tests/studio-*.test.ts` (le flake `studio-autosave` ordre-dépendant est le seul échec toléré ; les tests de guides/liaisons/poignées doivent rester VERTS — la couleur a changé, pas la géométrie ni les testid), puis `bun run test:pure`, `bunx tsc --noEmit`.

- [ ] **Step 5 : Commit.**
```bash
git add lib/studio/overlay-theme.ts components/studio/canvas.tsx components/studio/canvas-chrome.tsx tests/studio-overlay-theme.test.ts tests/studio-craft.test.ts
git commit -m "feat(studio): overlay-theme — source unique des couleurs de surcouches, cohérée à la marque, rôles distincts (chantier E T2)"
```

---

## Task 3 : États vides du studio via `EmptyState`

**Files:**
- Modify: `components/studio/property-panel.tsx` (L986-996, `property-panel-empty`)
- Modify: `components/studio/editor-shell.tsx` (`TooSmallState`, L1125-1147)
- Test: `tests/studio-craft.test.ts` (+ garder `tests/studio-editor-shell.test.ts`/`studio-property-panel.test.ts` verts)

**Interfaces:**
- Consumes: `EmptyState` de `components/shell/empty-state.tsx` — `EmptyState({ icon?, title, hint?, action? })`.

- [ ] **Step 1 : Test DOM qui échoue** — l'inspecteur vide et l'état trop-petit rendent la primitive `EmptyState` (structure `border-dashed grid place-items-center`), en PRÉSERVANT les testid verrouillés :

```ts
// dans tests/studio-craft.test.ts — monter PropertyPanel sans sélection et TooSmallState via le harnais
it("l'inspecteur vide utilise EmptyState et garde ses data-testid verrouillés", () => {
  const html = renderPropertyPanelEmpty(); // helper local calqué sur studio-property-panel.test.ts
  expect(html).toContain('data-testid="property-panel-empty"');      // testid préservé (verrou de test)
  expect(html).toContain('data-testid="property-panel-empty-hint"');
  expect(html).toContain("border-dashed");                            // la primitive EmptyState partagée
});
```
(L'implémenteur écrit le helper de montage en calquant sur `tests/studio-property-panel.test.ts` ; l'ASSERTION est ferme.)

- [ ] **Step 2 : Lancer → échec.**

- [ ] **Step 3 : Implémenter.** Dans `property-panel.tsx`, remplacer le `<div data-testid="property-panel-empty">…</div>` par un usage de `EmptyState` — mais GARDER les `data-testid` : envelopper ou passer les testid. Le plus simple : rendre `<div data-testid="property-panel-empty"><EmptyState icon={<MousePointerSquareDashed …/>} title="Aucun calque sélectionné" hint="Sélectionnez un calque pour modifier ses propriétés." /></div>` en posant `data-testid="property-panel-empty-hint"` sur le `hint` (si `EmptyState` ne le permet pas, garder le hint comme aujourd'hui avec son testid À CÔTÉ, ou ajouter une prop testid minimale à `EmptyState` sans casser ses autres appelants). Dans `TooSmallState`, remplacer la carte par `<EmptyState icon={<Smartphone …/>} title="Écran trop petit pour l'édition" hint="Aperçu seulement — élargissez la fenêtre pour éditer." />` (garder l'aperçu en lecture seule en dessous).

- [ ] **Step 4 : Lancer → succès.** `bun test tests/studio-craft.test.ts tests/studio-property-panel.test.ts tests/studio-editor-shell.test.ts`, puis `bun test tests/studio-*.test.ts` (flake autosave toléré), `bun run test:pure`, `bunx tsc --noEmit`. Vérifier que les testid verrouillés passent TOUJOURS.

- [ ] **Step 5 : Commit.**
```bash
git add components/studio/property-panel.tsx components/studio/editor-shell.tsx tests/studio-craft.test.ts
git commit -m "feat(studio): états vides de marque — inspecteur & « trop petit » via EmptyState partagé (chantier E T3)"
```

---

## Task 4 : Jetons de mouvement + micro-interactions plus riches

**Files:**
- Modify: `app/globals.css` (jetons `--ease-spring`/`--motion-fast`/`--motion-base` + bloc `@media (prefers-reduced-motion: reduce)`)
- Modify: `components/studio/floating-toolbar.tsx`, `components/studio/canvas-context-menu.tsx`, `components/studio/editor-shell.tsx` (tiroirs/panneaux), `components/studio/canvas.tsx` (transition du contour)
- Test: `tests/studio-craft.test.ts`

**Interfaces:**
- Produces: les jetons CSS de mouvement + une (ou des) classe(s) utilitaire(s) (ex. `.studio-motion-pop`, `.studio-motion-slide`) définies dans `globals.css`, appliquées par les composants.

- [ ] **Step 1 : Test qui échoue** — les jetons + la classe existent, la coupe `reduced-motion` neutralise, et un composant les porte :

```ts
it("les jetons de mouvement + la classe existent et sont coupés par prefers-reduced-motion", () => {
  expect(css).toMatch(/--ease-spring\s*:/);
  expect(css).toContain("prefers-reduced-motion: reduce");
  // au moins une classe de mouvement studio est définie ET neutralisée sous reduced-motion
  expect(css).toMatch(/\.studio-motion-pop/);
});
it("la barre flottante porte la classe de mouvement (apparition pop)", () => {
  const tb = readFileSync(join(ROOT, "components/studio/floating-toolbar.tsx"), "utf8");
  expect(tb).toContain("studio-motion-pop");
});
```

- [ ] **Step 2 : Lancer → échec.**

- [ ] **Step 3 : Implémenter.** Dans `globals.css`, ajouter :
```css
:root {
  --motion-fast: 120ms;
  --motion-base: 200ms;
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1); /* léger dépassement (ressort) */
}
.studio-motion-pop { animation: studio-pop var(--motion-base) var(--ease-spring); }
@keyframes studio-pop { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: none; } }
.studio-motion-slide { transition: transform var(--motion-base) var(--ease-spring), opacity var(--motion-fast) ease; }
@media (prefers-reduced-motion: reduce) {
  .studio-motion-pop { animation: none; }
  .studio-motion-slide { transition: none; }
}
```
Appliquer `studio-motion-pop` à la barre flottante (`floating-toolbar.tsx`) et au menu clic-droit (`canvas-context-menu.tsx`, le popup) ; `studio-motion-slide` sur le panneau accosté / les Sheet drawers (`editor-shell.tsx`) ; une transition de couleur/opacité douce sur le contour de sélection (`canvas.tsx`, via une classe). Enrichir les états survol/focus des contrôles là où c'est bon marché (les boutons partagés héritent déjà de transitions Tailwind — ne pas régresser).

- [ ] **Step 4 : Lancer → succès.** `bun test tests/studio-craft.test.ts`, `bun test tests/studio-*.test.ts` (flake autosave toléré), `bun run test:pure`, `bunx tsc --noEmit`. **Contrôleur : la richesse/fluidité RÉELLE et le respect de reduced-motion se vérifient en Playwright (passe T6).**

- [ ] **Step 5 : Commit.**
```bash
git add app/globals.css components/studio/floating-toolbar.tsx components/studio/canvas-context-menu.tsx components/studio/editor-shell.tsx components/studio/canvas.tsx tests/studio-craft.test.ts
git commit -m "feat(studio): jetons de mouvement + micro-interactions (pop/slide, ressort), coupés par reduced-motion (chantier E T4)"
```

---

## Task 5 : Cohérence des icônes + finition de marque

**Files:**
- Create: `lib/studio/studio-icons.ts` (convention de taille/trait)
- Modify: `components/studio/rail.tsx`, `components/studio/property-panel.tsx`, `components/studio/floating-toolbar.tsx`, `components/studio/canvas-context-menu.tsx` (consommer la convention) ; en-têtes de panneaux (police éditoriale) ; affordances d'action (accent)
- Test: `tests/studio-craft.test.ts`

**Interfaces:**
- Produces: `STUDIO_ICON` (ex. `"size-4"` par défaut, `STUDIO_ICON_STROKE = 1.75`) — la convention partagée ; consommée par les composants d'icônes du studio.

- [ ] **Step 1 : Test qui échoue** — la convention existe et est consommée uniformément ; l'accent/le titre éditorial sont appliqués :

```ts
import { STUDIO_ICON, STUDIO_ICON_STROKE } from "@/lib/studio/studio-icons";
it("la convention d'icône partagée existe", () => {
  expect(typeof STUDIO_ICON).toBe("string");
  expect(typeof STUDIO_ICON_STROKE).toBe("number");
});
it("le rail et la barre flottante consomment la convention (pas de taille ad-hoc)", () => {
  const rail = readFileSync(join(ROOT, "components/studio/rail.tsx"), "utf8");
  expect(rail).toContain("STUDIO_ICON");
});
```

- [ ] **Step 2 : Lancer → échec.**

- [ ] **Step 3 : Implémenter.** `lib/studio/studio-icons.ts` :
```ts
// Convention d'icône du studio : une taille et une graisse de trait UNIQUES, pour que le rail,
// l'inspecteur, les barres et le menu se ressemblent. lucide affinées — aucun nouveau dessin.
export const STUDIO_ICON = "size-4";          // 16px, taille de base des icônes d'action du studio
export const STUDIO_ICON_STROKE = 1.75;       // graisse de trait cohérente (lucide défaut = 2)
```
Faire consommer par `rail.tsx` (`<Icon className={STUDIO_ICON} strokeWidth={STUDIO_ICON_STROKE} …/>` au lieu de `size-4` en dur), la barre flottante, le menu clic-droit, l'inspecteur — unifier les tailles dépareillées. **Finition de marque :** appliquer `--accent-brand` aux affordances d'action génériques (bouton primaire « Publier », état ACTIF du rail/mode, anneaux de focus) via les classes de token existantes (`bg-[var(--accent-brand)]`/`text-…`/`ring-…`) là où c'est aujourd'hui neutre ; appliquer la police de titre éditoriale (`font-heading`) aux TITRES de panneaux/sections et aux titres d'`EmptyState` du studio. NE PAS régresser le contraste/accessibilité.

- [ ] **Step 4 : Lancer → succès.** `bun test tests/studio-craft.test.ts`, `bun test tests/studio-*.test.ts` (flake autosave toléré), `bun run test:pure`, `bunx tsc --noEmit`. **Contrôleur : la cohérence visuelle RÉELLE des icônes + l'accent se jugent en Playwright (T6).**

- [ ] **Step 5 : Commit.**
```bash
git add lib/studio/studio-icons.ts components/studio/rail.tsx components/studio/property-panel.tsx components/studio/floating-toolbar.tsx components/studio/canvas-context-menu.tsx tests/studio-craft.test.ts
git commit -m "feat(studio): convention d'icône partagée + finition accent/titre éditorial (chantier E T5)"
```

---

## Task 6 : Intégration, passe §0, et vérification visuelle

**Files:**
- Test: `tests/studio-craft.test.ts` (assertions §0 finales)
- Vérification Playwright du contrôleur.

**Interfaces:** aucune nouvelle — relie et vérifie.

- [ ] **Step 1 : Test §0 de non-régression** — le moteur/`scene.ts` intacts, les surcouches gardent géométrie + testid :
```ts
it("§0 : ni scene.ts ni le chemin de rendu ne sont touchés par le chantier E", () => {
  // ce test est un GARDE-FOU documentaire — la revue de branche vérifie le diff ; ici on épingle que
  // les surcouches gardent leurs data-testid (géométrie inchangée) en montant le canevas.
  const html = renderCanvasWithSelectionAndGuides(); // helper calqué sur studio-interactions
  expect(html).toContain('data-testid="snap-guide"');
  expect(html).toContain('data-testid="binding-outline"'); // si showBindings
});
```
(L'implémenteur écrit les helpers en calquant sur les tests DOM existants ; les assertions sont fermes.)

- [ ] **Step 2 : Lancer → tout vert.** `bun test tests/studio-*.test.ts` (flake autosave toléré) ; `bun run test:pure` ; `bunx tsc --noEmit`.

- [ ] **Step 3 : Vérification VISUELLE (contrôleur, Playwright).** Serveur de dev + login (README). Captures AVANT/APRÈS : fond d'atelier chaud ; surcouches cohérentes mais distinctes (sélection/guide/liaison/zone sûre) ; états vides de marque (inspecteur, trop-petit) ; mouvement (barre flottante pop, tiroirs slide) + un passage `prefers-reduced-motion` qui neutralise ; cohérence des icônes + accent terracotta. (Les IMPLÉMENTEURS NE lancent PAS Playwright.)

- [ ] **Step 4 : Commit** (correctifs d'intégration éventuels).
```bash
git add -A && git commit -m "chore(studio): passe d'intégration §0 du craft visuel (chantier E T6)"
```

---

## Self-Review (auteur du plan)

**1. Couverture de la spec :** §1 fond → T1 ; §2 surcouches → T2 ; §3 états vides → T3 ; §4 mouvement → T4 ; §5 icônes+finition → T5 ; §6 intégration+§0+Playwright → T6. Toutes les sections couvertes.

**2. Placeholders :** aucun TBD ; chaque tâche a un test concret ; les helpers de montage DOM sont délégués à l'implémenteur (calqués sur des tests existants) mais les ASSERTIONS sont fermes ; les valeurs oklch/hex sont des points de départ que le contrôleur ajuste visuellement (craft).

**3. Cohérence des types :** `OVERLAY`/`SELECTION`/`SNAP_GUIDE`/`BINDING`/`SAFE_TINT`/`SAFE_LINE` (T2) consommés par canvas/canvas-chrome ; `EmptyState` (existant) par T3 ; les jetons/classes de mouvement (T4) par les composants ; `STUDIO_ICON`/`STUDIO_ICON_STROKE` (T5) par le rail/les barres. `--canvas-backdrop` (T1) consommé par editor-shell. Noms cohérents.

**Note d'exécution :** brancher sur `feat/studio-pro-e-craft` (déjà créée, off main = A+B+C+D). Craft = artefacts testables + passe Playwright du contrôleur pour le subjectif. §0 : moteur/`scene.ts` JAMAIS touchés.
