# Studio Properties Pro — P1 : Propriétés d'image avancées — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Donner au calque image le modèle CSS `background-*` complet (taille : cover/contain/étirer/mosaïque/perso ; répétition par axe ; point focal déplaçable ; fondu), rendu à l'identique par Satori (export) ET par l'aperçu navigateur (Montage), sans régresser les gabarits existants.

**Architecture :** Rendre un calque image comme un `<div>` de FOND (`backgroundImage`+`backgroundSize`+`backgroundRepeat`+`backgroundPosition`+`backgroundBlendMode`) au lieu de l'`<img objectFit>` pré-recadré par sharp — dans le moteur (`element.ts`) ET l'aperçu (`layer-view.tsx`). Un **spike stop-and-report** prouve d'abord ce que Satori 0.29 rend correctement ; une **soupape §0** garde l'ancien chemin `<img>` pour cover/contain si le pixel diverge.

**Tech Stack :** Next.js 16.3, Zod v4, Satori 0.29 + resvg, sharp, `bun test` (jsdom + rasterisation pixel), Playwright (contrôleur).

## Adjudication post-spike (Tâche 1 faite — le contrôleur a tranché ; ceci PRIME sur toute mention contraire ci-dessous)

Le spike (commit `2c7f297`, rapport `spike-satori-background-report.md`) a mesuré Satori 0.29. Décision utilisateur : **livrer le périmètre natif-Satori, différer le reste.**
- **DANS P1 :** `sizing` = `cover | contain | stretch | tile | custom` ; `tile.axis` = **`both | x | y` UNIQUEMENT** ; `focal` (point focal déplaçable) ; `customSize`. **CHEMIN DE RENDU UNIQUE** (pas de soupape `<img>` permanente).
- **RETIRÉ de P1 (Satori ne les rend pas) :** `background-blend-mode` (pas de champ `blend` du tout) ET `background-repeat: space`/`round` (pas dans l'enum `axis`). Différés à un futur chantier « effets raster » (repli sharp).
- **LE POINT CLÉ du spike — `background-position` :** Satori a un BOGUE de pourcentage (`cadre × pct` au lieu de `(cadre − image_effective) × pct`, et `100%` boucle). Donc :
  - **APERÇU navigateur (`layer-view.tsx`, Tâche 4) :** émettre `background-position` en **POURCENTAGE** (`"x% y%"` depuis `focalToPosition`) — le CSS navigateur le calcule CORRECTEMENT.
  - **MOTEUR Satori (`element.ts`, Tâche 3) :** émettre `background-position` en **PIXELS CALCULÉS** = `(dimCadre − dimImageEffective) × focal`, JAMAIS un pourcentage brut. La dimension effective dépend du mode (cover/contain/stretch/custom/tile) et de la taille INTRINSÈQUE de l'image — que `element.ts` obtient via les métadonnées passées par `prepareImage`/`render.ts` (métadonnées sharp). C'est le cœur technique de la Tâche 3.

## Global Constraints

- **§0 (mesuré, pas affirmé) :** les gabarits image cover/contain EXISTANTS rendent VISUELLEMENT à l'identique — comparaison AU PIXEL via `renderScene`. Soupape : si cover/contain via CSS `background-size` diverge de l'ancien `objectFit` (sharp pré-recadré) au-delà d'une tolérance stricte, GARDER l'ancien chemin `<img objectFit>` pour cover/contain (`sizing` absent inclus) et n'utiliser le `<div>` de fond QUE pour les modes NOUVEAUX. La Tâche 3 tranche selon ce que le pixel dit.
- **Migration no-op :** les nouveaux champs de schéma sont OPTIONNELS ; un gabarit sans eux = comportement d'aujourd'hui exact ; `parseScene` fait l'aller-retour deep-equal.
- **`lib/studio/*` client-safe / sans base / sans React** pour les modules purs (`image-css.ts`). `images.ts` (sharp) est déjà server-only.
- **Aucune bibliothèque nouvelle.** Copie en français. `data-field`/`data-testid` sur les contrôles.
- **Le spike (Tâche 1) est stop-and-report** : il rend compte, s'arrête, et l'humain arbitre les modes divergents AVANT les Tâches 2+.

---

## File Structure

- **Create `lib/studio/image-css.ts`** — mappage PUR `imageCss(layer)`/`focalToPosition`/`tileToRepeat` (sizing/focal/tile/custom/blend → styles CSS `background-*`). Feuille, aucun import React/DOM/base.
- **Modify `lib/studio/scene.ts`** — champs optionnels sur `imageLayer` (`sizing`/`focal`/`tile`/`customSize`/`blend`), migration no-op.
- **Modify `lib/studio/element.ts`** — `imageNode` rend le `<div>` de fond (moteur Satori).
- **Modify `lib/studio/images.ts`** — `prepareImage` : plus de recadrage forcé pour les nouveaux modes (préparation à la taille adéquate).
- **Modify `components/studio/layer-view.tsx`** — `ImageContent` rend le même CSS de fond (parité aperçu).
- **Modify `components/studio/property-panel.tsx`** — `ImageFields` : menu Ajustement + contrôles mosaïque/perso/position/fondu.
- **Create `components/studio/focal-point-field.tsx`** — le sélecteur 2D (vignette + glisser) écrivant `focal`.
- **Tests :** `tests/studio-props-spike.test.ts` (spike), `tests/studio-image-css.test.ts` (pur), `tests/studio-image-render.test.ts` (§0 pixel + nouveaux modes), `tests/studio-image-fields.test.ts` (inspecteur DOM).

---

## Task 1 : Spike — le modèle de fond de Satori (STOP-AND-REPORT)

**Files:**
- Create: `tests/studio-props-spike.test.ts` (le harnais de mesure ; peut rester dans l'arbre comme documentation de capacité)
- Report: `.superpowers/sdd/<workspace>/spike-satori-background-report.md`

**But :** prouver AU PIXEL ce que Satori 0.29 (via `renderScene`/resvg, le VRAI chemin) rend pour `background-size`, `background-repeat`, `background-position`, `background-blend-mode`, en comparant à une attente ANALYTIQUE (pas besoin de navigateur — le contrôleur fera la parité navigateur en Tâche 7).

**Méthode :** construire une scène minimale à UN calque image dont la source est une **image témoin SYNTHÉTIQUE** aux pixels connus (ex. une PNG 2×2 : coin haut-gauche rouge pur `#ff0000`, les 3 autres blancs — encodée en data URI dans le test), posée dans un cadre connu (ex. 200×200), et la rendre via `renderScene` en variant UNIQUEMENT le style de fond. Pour chaque mode, rasteriser le PNG (sharp raw, comme `tests/studio-shape-render.test.ts:53`) et vérifier la COULEUR de pixels-sondes contre l'attente analytique :
- `background-size: cover` / `contain` / `100px 100px` / `50% 50%` — le carré rouge occupe la fraction attendue.
- `background-repeat: repeat` (une image 100×100 dans un cadre 200×200 ⇒ le motif rouge apparaît en 4 quadrants), `repeat-x`, `repeat-y`, `no-repeat`, **`space`**, **`round`** — sondes aux positions attendues.
- `background-position: 0% 0%` / `50% 50%` / `100% 100%` — le carré rouge se déplace comme prévu.
- `background-blend-mode: multiply` / `screen` / `overlay` / `normal` — avec un `background-color`/overlay connu, la couleur mélangée attendue.

> NOTE : ce test est un SPIKE — son but est de MESURER, pas de figer une API. Écrire ~une sonde par mode ; là où Satori rend correctement, le test PASSE ; là où il diverge, marquer le mode `it.skip` avec un commentaire « Satori 0.29 ne rend pas X » ET le consigner dans le rapport. Modéliser la rasterisation/sonde exactement sur `tests/studio-shape-render.test.ts` (même `sharp(...).raw().toBuffer({resolveWithObject:true})` + comparaison de couleur à tolérance).

- [ ] **Step 1 : Écrire le harnais** — la scène témoin + la fonction de sonde de pixel (réutiliser le helper de `studio-shape-render.test.ts`), et UNE sonde pour `background-size: cover` (le cas le plus simple, doit passer).
- [ ] **Step 2 : Lancer** `bun test tests/studio-props-spike.test.ts` — le cas cover passe (preuve que le harnais mesure le vrai rendu).
- [ ] **Step 3 : Étendre** aux autres modes (une sonde chacun) ; pour chaque : PASSE si Satori rend correctement, `it.skip("Satori 0.29: <mode> non rendu — voir rapport")` sinon.
- [ ] **Step 4 : LA SOUPAPE §0** — rendre la MÊME image témoin en cover DEUX façons : (a) l'ancien chemin `<img objectFit:cover>` (le code actuel de `element.ts`), (b) le nouveau `<div background-size:cover>` — et comparer leurs pixels. Consigner : « cover via CSS ÉGALE-t-il cover via objectFit dans une tolérance stricte ? » — c'est ce qui décide chemin-unique vs soupape en Tâche 3.
- [ ] **Step 5 : Rédiger le rapport** (`spike-satori-background-report.md`) : un TABLEAU mode → { rend ?, coïncide avec l'attente ? } + le verdict soupape. **S'ARRÊTER** et rendre compte au contrôleur : quels modes sont dans le périmètre, comment traiter les divergents (repli sharp / retrait), chemin-unique ou soupape. Commit du harnais :
```bash
git add tests/studio-props-spike.test.ts
git commit -m "spike(studio): modèle de fond Satori 0.29 — ce qui rend au pixel (Properties Pro P1 T1)"
```

**⚠️ Le contrôleur relit le rapport et arbitre AVANT de dispatcher la Tâche 2.** Les Tâches 2–7 ci-dessous supposent le cas nominal (Satori rend size/repeat/position ; blend et space/round selon le spike) ; le contrôleur ajuste leur portée selon le rapport.

---

## Task 2 : Schéma + mappage pur `image-css.ts`

**Files:**
- Modify: `lib/studio/scene.ts` (l'objet `imageLayer`, ~L87-94)
- Create: `lib/studio/image-css.ts`
- Test: `tests/studio-scene.test.ts` (migration no-op), `tests/studio-image-css.test.ts` (pur)

**Interfaces:**
- Produces (schéma) : `imageLayer` gagne `sizing?: enum(cover,contain,stretch,tile,custom)`, `focal?: {x,y}` (0–1), `tile?: {scale: number.positive, axis: enum("both","x","y")}`, `customSize?: {w,h}` (OPTIONNELS). **PAS de champ `blend`** (retiré, cf. adjudication). `tile.axis` n'a QUE both/x/y (pas space/round).
- Produces (`image-css.ts`, PUR — le CSS de l'APERÇU, position en POURCENTAGE) :
  - `type ImageCss = { backgroundSize: string; backgroundRepeat: string; backgroundPosition: string }` (pas de `backgroundBlendMode`).
  - `imageCss(layer: ImageLayer): ImageCss` — mappage complet, `backgroundPosition` en `%` (correct dans le navigateur).
  - `focalToPosition(focal?: {x:number;y:number}): string` — `{0.5,0.5}`/absent → `"50% 50%"` ; `{0,1}` → `"0% 100%"`.
  - `tileToRepeat(tile?: {scale:number; axis:"both"|"x"|"y"}): { backgroundRepeat: string }` — `"x"` → `"repeat-x"`, `"y"` → `"repeat-y"`, `"both"` → `"repeat"`. (space/round n'existent pas.)
  - `focalToPositionPx(layer, effImg:{w:number;h:number}): string` — la variante PIXELS pour le MOTEUR Satori (Tâche 3) : `((frame.w − effImg.w) × focal.x)px ((frame.h − effImg.h) × focal.y)px`. PURE, testée sur la formule CSS.

- [ ] **Step 1 : Tests qui échouent.** Migration no-op dans `tests/studio-scene.test.ts` :

```ts
it("imageLayer : les nouveaux champs sont OPTIONNELS (migration no-op)", () => {
  const scene = fixtureSceneWithImage(); // un calque image SANS sizing/focal/tile/custom/blend
  const parsed = parseScene(scene);
  expect(parsed.layers[0]).not.toHaveProperty("sizing");
  expect(JSON.parse(JSON.stringify(parsed))).toEqual(scene); // aller-retour deep-equal
});
it("imageLayer : sizing accepte les cinq modes, refuse l'inconnu", () => {
  for (const s of ["cover","contain","stretch","tile","custom"]) expect(() => parseScene(withSizing(s))).not.toThrow();
  expect(() => parseScene(withSizing("bogus"))).toThrow();
});
```

Et le pur dans `tests/studio-image-css.test.ts` :

```ts
import { imageCss, focalToPosition, tileToRepeat } from "@/lib/studio/image-css";
it("focalToPosition : centre par défaut, coins exacts", () => {
  expect(focalToPosition()).toBe("50% 50%");
  expect(focalToPosition({ x: 0, y: 1 })).toBe("0% 100%");
  expect(focalToPosition({ x: 1, y: 0 })).toBe("100% 0%");
});
it("imageCss : cover/contain/stretch/tile mappent les bons background-*", () => {
  expect(imageCss(img({ sizing: "cover" })).backgroundSize).toBe("cover");
  expect(imageCss(img({ sizing: "contain" })).backgroundSize).toBe("contain");
  expect(imageCss(img({ sizing: "stretch" })).backgroundSize).toBe("100% 100%");
  const t = imageCss(img({ sizing: "tile", tile: { scale: 0.5, axis: "x" } }));
  expect(t.backgroundRepeat).toBe("repeat-x");
});
it("imageCss : absent/legacy (fit seul) => cover|contain, pas de blend", () => {
  expect(imageCss(img({ fit: "cover" })).backgroundSize).toBe("cover"); // dérivé de fit
});
```

- [ ] **Step 2 : Lancer → échec.**
- [ ] **Step 3 : Implémenter** le schéma (champs optionnels, MÊME style que `constraints`/`opacity` optionnels ; `.register()` NON concerné — pas un nœud couleur, sauf `blend` qui n'est pas une couleur non plus) + `image-css.ts` (pur ; `imageCss` lit `sizing ?? (fit === "cover" ? "cover" : "contain")` pour le cas legacy). Balayer chaque mode.
- [ ] **Step 4 : Lancer → succès** + `bun run test:pure` + `bunx tsc --noEmit`.
- [ ] **Step 5 : Commit.**
```bash
git add lib/studio/scene.ts lib/studio/image-css.ts tests/studio-scene.test.ts tests/studio-image-css.test.ts
git commit -m "feat(studio): schéma image avancé (sizing/focal/tile/custom/blend, no-op) + mappage CSS pur (Properties Pro P1 T2)"
```

---

## Task 3 : Chemin de rendu (`element.ts` + `prepareImage`) + §0 pixel

**Files:**
- Modify: `lib/studio/element.ts` (`imageNode`, L133-161)
- Modify: `lib/studio/images.ts` (`prepareImage`, PrepareImageOptions)
- Test: `tests/studio-image-render.test.ts`

**Interfaces:**
- Consumes: `imageCss` (T2). `PrepareImageOptions` gagne les infos de mode nécessaires (ou reçoit le layer).

- [ ] **Step 1 : Test §0 pixel qui échoue** (`tests/studio-image-render.test.ts`) — modelé sur `tests/studio-shape-render.test.ts` : rendre un gabarit à UN calque image `sizing:"cover"` (ou legacy `fit:"cover"`) via `renderScene`, et vérifier des pixels-sondes attendus (le carré rouge de l'image témoin occupe la zone cover attendue). AJOUTER une sonde pour un mode NOUVEAU rendu par le spike (ex. `tile`). Le test PROUVE au pixel que le nouveau chemin rend cover comme avant ET rend la mosaïque.

- [ ] **Step 2 : Lancer → échec.**
- [ ] **Step 3 : Implémenter (CHEMIN UNIQUE — verdict du spike).** `imageNode` (pour `layer.type==="image"` UNIQUEMENT ; le QR garde son `<img>`) rend `{ type:"div", props:{ style:{ ...frameStyle, overflow:"hidden", ...radius, backgroundImage:`url(${uri})`, ...imageCss(layer), backgroundPosition: focalToPositionPx(layer, effImg) } } }` — noter que `backgroundPosition` d'`imageCss` (en `%`) est ÉCRASÉ par la version PIXELS `focalToPositionPx(layer, effImg)` (le bogue de `%` de Satori l'exige). `effImg` = la taille EFFECTIVE de l'image après `background-size` (dérivée du mode + la taille INTRINSÈQUE, obtenue via les métadonnées sharp de `prepareImage`). `prepareImage` prépare l'image SANS recadrage forcé au cadre (les nouveaux modes en ont besoin à leur taille naturelle/tuile) et RENVOIE aussi la taille intrinsèque (métadonnées) pour que `element.ts` calcule `effImg`. Le flou/overlay restent dans `prepareImage`.
- [ ] **Step 4 : Lancer → succès** ; puis `bun test tests/studio-*.test.ts` (les tests de rendu image existants — `studio-render`, `studio-preview` — DOIVENT rester verts, c'est le §0 ; seul le flake autosave toléré) ; `bun run test:pure` ; `bunx tsc --noEmit`. **§0 : si un test de rendu image existant rougit, le nouveau chemin a changé le rendu — c'est un échec, pas à contourner.**
- [ ] **Step 5 : Commit.**
```bash
git add lib/studio/element.ts lib/studio/images.ts tests/studio-image-render.test.ts
git commit -m "feat(studio): rendu image en <div> de fond (background-size/repeat/position/blend), §0 pixel des gabarits existants (Properties Pro P1 T3)"
```

---

## Task 4 : Parité de l'aperçu (`layer-view.tsx`)

**Files:**
- Modify: `components/studio/layer-view.tsx` (`ImageContent`, L85-106)
- Test: `tests/studio-image-fields.test.ts` (ou un test DOM dédié)

**Interfaces:** Consumes `imageCss` (T2).

- [ ] **Step 1 : Test DOM qui échoue** — monter `ImageContent` (via le harnais U0) pour un calque `sizing:"tile"` et vérifier que le nœud rendu porte `background-image` + `background-repeat: repeat` (pas un `<img objectFit>`), et pour `sizing:"cover"` le CSS cover — MÊME mapping que le moteur (`imageCss`).

```ts
it("l'aperçu rend le MÊME CSS de fond que le moteur (parité)", () => {
  const html = renderImageContent(img({ sizing: "tile", tile: { scale: 1, axis: "both" } }), "data:image/png;base64,AAAA");
  expect(html).toContain("background-repeat: repeat");
  expect(html).toContain("background-image");
});
```

- [ ] **Step 2 : Lancer → échec.**
- [ ] **Step 3 : Implémenter** — `ImageContent` rend un `<div style={{ backgroundImage: `url(${src})`, ...imageCss(layer), borderRadius: layer.radius, filter: layer.blur ? `blur(${layer.blur}px)` : undefined }}>` au lieu de `<img objectFit>` (aligné sur le verdict soupape de la Tâche 3 : chemin unique ou double). Garder le `Placeholder` pour une source absente. GARDER le rendu du flou/rayon.
- [ ] **Step 4 : Lancer → succès** + `bun test tests/studio-*.test.ts` (les tests d'aperçu existants verts) + `tsc`.
- [ ] **Step 5 : Commit.**
```bash
git add components/studio/layer-view.tsx tests/studio-image-fields.test.ts
git commit -m "feat(studio): aperçu Montage en <div> de fond — parité pixel avec l'export (Properties Pro P1 T4)"
```

---

## Task 5 : Inspecteur — Ajustement + mosaïque/perso/position/fondu

**Files:**
- Modify: `components/studio/property-panel.tsx` (`ImageFields`)
- Test: `tests/studio-image-fields.test.ts`

**Interfaces:** Consumes le `SelectField`/`NumberField` (scrubby)/`SliderField` du chantier C, `patch` (dispatch `setLayerProp`).

- [ ] **Step 1 : Test DOM qui échoue** — le menu « Ajustement » change `sizing` ; les contrôles mosaïque (échelle+axe) n'apparaissent QUE quand `sizing==="tile"` ; les champs perso QUE quand `sizing==="custom"` ; le fondu sous le repli avancé.

```ts
it("le menu Ajustement écrit sizing ; les contrôles mosaïque n'apparaissent qu'en mode mosaïque", () => {
  const { html, chooseSizing } = mountImageFields(img({ sizing: "cover" }));
  expect(html()).not.toContain('data-field="tile-scale"');
  chooseSizing("tile");
  expect(html()).toContain('data-field="tile-scale"');
  expect(html()).toContain('data-field="tile-axis"');
});
```

- [ ] **Step 2 : Lancer → échec.**
- [ ] **Step 3 : Implémenter** dans `ImageFields` : remplacer le `SelectField` cover/contain par un « Ajustement » à 5 options (Remplir/Ajuster/Étirer/Mosaïque/Taille perso) écrivant `sizing` (et gardant `fit` cohérent pour la rétrocompat : `sizing==="cover"|"contain"` met à jour `fit`) ; afficher conditionnellement : mosaïque → `SliderField` « Échelle » (`tile.scale`) + `SelectField` « Répétition » (`tile.axis`, options **Les deux / Horizontale / Verticale** = both/x/y) ; perso → deux `NumberField` (`customSize.w/h`). PAS de contrôle « Fondu » (blend retiré du périmètre). Le positionnement est couvert par le point focal (Tâche 6), pas un champ de décalage séparé. `data-field` sur chacun.
- [ ] **Step 4 : Lancer → succès** + suite studio + `tsc`.
- [ ] **Step 5 : Commit.**
```bash
git add components/studio/property-panel.tsx tests/studio-image-fields.test.ts
git commit -m "feat(studio): inspecteur image — Ajustement (5 modes) + mosaïque/perso/fondu (Properties Pro P1 T5)"
```

---

## Task 6 : Le point focal déplaçable (`focal-point-field.tsx`)

**Files:**
- Create: `components/studio/focal-point-field.tsx`
- Modify: `components/studio/property-panel.tsx` (le monter dans `ImageFields`)
- Test: `tests/studio-image-fields.test.ts`

**Interfaces:**
- Produces: `FocalPointField({ value, imageSrc, onCommit })` — `value: {x,y}` (0–1), `onCommit: (v:{x,y})=>void`. Une vignette de l'image avec un point déplaçable ; glisser → x/y ∈ [0,1] (clampé), UNE entrée d'historique au relâchement.

- [ ] **Step 1 : Test DOM qui échoue** — glisser le point sur la vignette écrit `focal` (x,y clampés à [0,1]), une seule fois au `pointerup` (pas par move). Modeler le glisser-2D sur le carré SV du `color-picker.tsx` (chantier C, même patron pointer→ratio).

```ts
it("glisser le point focal écrit focal x/y clampé, une fois au relâchement", () => {
  const onCommit = mock();
  const { dragTo } = mountFocalField({ value: { x: 0.5, y: 0.5 }, onCommit });
  dragTo({ fx: 1.2, fy: -0.3 }); // hors bornes → clampé
  expect(onCommit).toHaveBeenCalledTimes(1);
  expect(onCommit.mock.calls[0][0]).toEqual({ x: 1, y: 0 });
});
```

- [ ] **Step 2 : Lancer → échec.**
- [ ] **Step 3 : Implémenter** `FocalPointField` (réutiliser le patron pointer→ratio du carré SV de `color-picker.tsx` : `pointerdown`+`setPointerCapture`, `pointermove` met à jour l'affichage local, `pointerup` → `onCommit({x,y})` clampé [0,1], UNE fois). Le monter dans `ImageFields` (visible pour cover/tile où le focal compte), câblé sur `patch({ focal })`. La vignette = l'image source (ou un placeholder si absente).
- [ ] **Step 4 : Lancer → succès** + suite studio + `tsc`.
- [ ] **Step 5 : Commit.**
```bash
git add components/studio/focal-point-field.tsx components/studio/property-panel.tsx tests/studio-image-fields.test.ts
git commit -m "feat(studio): point focal déplaçable — origine de recadrage/mosaïque (Properties Pro P1 T6)"
```

---

## Task 7 : Intégration, §0, et parité WYSIWYG (Playwright)

**Files:**
- Test: `tests/studio-image-render.test.ts` (assertions §0 finales)
- Vérification Playwright du contrôleur.

- [ ] **Step 1 : Test §0 de bout en bout** — un gabarit image legacy (`fit` seul) rendu via `renderScene` fait l'aller-retour pixel à l'identique d'avant P1 ; `parseScene` deep-equal (aucune dérive de sérialisation) ; un gabarit avec chaque nouveau mode rend sans erreur.
- [ ] **Step 2 : Lancer → tout vert** (`bun test tests/studio-*.test.ts` sauf le flake autosave ; `bun run test:pure` ; `bunx tsc --noEmit`).
- [ ] **Step 3 : Parité WYSIWYG (contrôleur, Playwright).** Serveur de dev + login. Pour chaque mode (cover/contain/étirer/mosaïque/perso, point focal, fondu) : comparer le canevas « Montage » (navigateur) au « Rendu réel » (Satori) — ils doivent COÏNCIDER. Glisser le point focal et vérifier que le recadrage suit dans les DEUX. (Les implémenteurs NE lancent PAS Playwright.)
- [ ] **Step 4 : Commit** (correctifs d'intégration éventuels).
```bash
git add -A && git commit -m "chore(studio): passe d'intégration §0 + WYSIWYG des propriétés d'image (Properties Pro P1 T7)"
```

---

## Self-Review (auteur du plan)

**1. Couverture de la spec :** §1 spike → T1 ; §2 schéma → T2 ; §3 rendu+prepareImage+soupape → T3 ; §4 parité aperçu → T4 ; §5 inspecteur → T5 + T6 (point focal) ; §6 tests → répartis (pur T2, §0 pixel T3/T7, DOM T4/T5/T6, Playwright T7). Toutes les sections couvertes.

**2. Placeholders :** le seul « à déterminer » légitime est l'ensemble des modes `blend`/`space`/`round` réellement rendus — DÉCIDÉ par le spike (T1), c'est le rôle du spike, pas un trou de plan. Les Tâches 2–7 disent explicitement « selon le verdict du spike ».

**3. Cohérence des types :** `imageCss`/`focalToPosition`/`tileToRepeat`/`ImageCss` (T2) consommés par T3 (moteur), T4 (aperçu) ; `sizing`/`focal`/`tile`/`customSize`/`blend` (schéma T2) lus partout ; `FocalPointField({value,imageSrc,onCommit})` (T6). `PrepareImageOptions` étendu en T3. Noms cohérents.

**Note d'exécution :** brancher sur `feat/studio-props-p1-image` (déjà créée, off main). LE SPIKE (T1) EST STOP-AND-REPORT : le contrôleur relit le rapport et arbitre les modes divergents + chemin-unique-vs-soupape AVANT de dispatcher T2. §0 : les gabarits image existants rendent au pixel à l'identique (mesuré, T3/T7).
