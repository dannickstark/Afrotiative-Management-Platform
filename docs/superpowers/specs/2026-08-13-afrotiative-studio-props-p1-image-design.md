# Afrotiative — Studio Properties Pro · P1 : Propriétés d'image avancées — Spécification

**Date :** 2026-08-13
**Programme :** « Studio Properties Pro » — enrichir les contrôles de propriétés des calques (image, texte, forme, QR). **P1 = image**, le premier et le plus impactant.
**Statut :** Conception validée en atelier — prête pour le plan
**Portée moteur : OUI.** Contrairement aux chantiers Studio Pro A–E (chrome uniquement), P1 TOUCHE le moteur de rendu (Satori) et le schéma. Le §0 devient : les gabarits image EXISTANTS (cover/contain) rendent VISUELLEMENT à l'identique (équivalence mesurée au pixel via `renderScene`), et l'absence des nouveaux champs = comportement actuel exact (migration no-op).
**Base :** `main` (studio complet).

---

## Le problème

Un calque image n'expose aujourd'hui que : `source`, `fit: "cover" | "contain"`, `radius?`, `blur?`, `overlay?` (`lib/studio/scene.ts`). Un designer ne peut ni **répéter/mosaïquer** le contenu (background-repeat), ni **régler la taille** au-delà de cover/contain (background-size : étirer, taille personnalisée), ni **choisir quelle partie** est visible (point focal / background-position), ni **fondre** l'image (blend-mode). Décisions d'atelier : jeu COMPLET + avancé (cover/contain/étirer/mosaïque/taille perso + décalages de position + répétition par axe repeat-x/repeat-y/space/round + fondu), un **point focal DÉPLAÇABLE**, et une **échelle + axe de mosaïque réglables**.

---

## Le CRUX : WYSIWYG (le moteur ET l'aperçu doivent COÏNCIDER)

Le canevas « Montage » rend les images en **CSS navigateur** ; l'export final les rend en **Satori**. Cette fonctionnalité n'existe QUE si le modèle CSS `background-*` rend PAREIL des deux côtés. Le geste architectural central : rendre un calque image comme un **`<div>` de fond** (`backgroundImage` + `backgroundSize` + `backgroundRepeat` + `backgroundPosition` + `backgroundBlendMode`) au lieu de l'`<img objectFit>` actuel pré-recadré par sharp — DANS LES DEUX chemins (`element.ts` moteur ET `layer-view.tsx` aperçu).

## 1 · Le spike (stop-and-report) — AVANT tout le reste

Satori 0.29 RÉFÉRENCE `backgroundRepeat`/`repeat-x`/`repeat-y`, mais il faut PROUVER qu'il REND — en coïncidant avec le navigateur — pour chaque mode voulu : `background-size` (cover/contain/longueur/%), `background-repeat` (repeat/repeat-x/repeat-y/no-repeat/**space**/**round**), `background-position`, et `background-blend-mode`. Le spike rend une image témoin chaque manière et COMPARE AU PIXEL Satori contre navigateur, mode par mode. **Il rend compte et s'ARRÊTE** : pour chaque mode, « rend / coïncide » ou non. **Si un mode diverge** (ex. Satori ignore `space`/`round`, ou les blend-modes), le repli — compositing côté sharp pour ce mode, ou le retirer du périmètre — est la **décision de l'humain au gate du spike**. Ce spike dé-risque toute la fonctionnalité, exactement comme le spike de routage du chantier A et le spike de relayout du chantier D.

## 2 · Schéma (`scene.ts` imageLayer) — ADDITIF, migration no-op

GARDER `fit` opérant ; AJOUTER des champs OPTIONNELS pour qu'un gabarit existant soit INCHANGÉ quand ils sont absents :
- `sizing?: z.enum(["cover","contain","stretch","tile","custom"])` — mode de taille. Absent ⇒ dérivé de `fit` (cover/contain), comportement d'aujourd'hui.
- `focal?: { x: z.number().min(0).max(1), y: z.number().min(0).max(1) }` — le point focal / origine de recadrage (cover) et de mosaïque (tile), → `background-position`. Défaut centre (0.5, 0.5).
- `tile?: { scale: z.number().positive(), axis: z.enum(["both","x","y","space","round"]) }` — mode mosaïque : `scale` = taille d'une tuile (fraction de la taille naturelle), `axis` = mode de répétition.
- `customSize?: { w: z.number().positive(), h: z.number().positive() }` — mode taille perso (px).
- `blend?: z.enum([...blend-modes rendus par le spike...])` — `background-blend-mode` (avec l'overlay).
Un calque sans `sizing` rend EXACTEMENT comme aujourd'hui. La discrimination `type: "image"` du schéma est préservée ; le registre de couleurs et les jetons intacts.

## 3 · Rendu + préparation (`element.ts` + `images.ts`)

`element.ts` rend le calque image comme le `<div>` de fond (mappage pur `imageCss(layer)` → styles CSS). `images.ts#prepareImage` cesse de RECADRER de force au cadre (`sharp.resize(w,h,{fit})`) : il PRÉPARE l'image (le flou et la teinte overlay restent) à une taille qui laisse le CSS faire la taille/répétition (taille naturelle bornée, ou la taille de tuile pour le mode mosaïque). **§0 :** les gabarits cover/contain existants doivent rendre VISUELLEMENT à l'identique — vérifié en MESURANT au pixel à travers `renderScene` (l'approche U3), pas seulement affirmé.

**LA SOUPAPE §0 (décidée par le spike/Tâche 3, non par avance) :** `background-size: cover` (Satori/CSS) doit égaler l'ancien `objectFit: cover` (sharp pré-recadré). Si l'équivalence au pixel TIENT dans une tolérance stricte, tous les modes passent par le `<div>` de fond (chemin unique, plus propre). SINON — si cover/contain via CSS diverge du chemin sharp historique — on GARDE l'ancien chemin `<img objectFit>` pour cover/contain (et `sizing` absent), et on n'utilise le `<div>` de fond QUE pour les modes NOUVEAUX (mosaïque/étirer/taille perso). Ce repli préserve un §0 BIT À BIT pour les gabarits existants au prix de deux chemins de rendu. Le spike (Tâche 1) mesure l'écart ; la Tâche 3 choisit le chemin unique OU la soupape selon ce que le pixel dit — c'est le point de décision, pas une supposition.

## 4 · Parité de l'aperçu (`layer-view.tsx`)

L'aperçu « Montage » rend le MÊME `<div>` de fond CSS, pour que le designer voie EXACTEMENT ce qui s'exporte. Cette parité EST le but de la fonctionnalité ; elle a sa propre passe Playwright (Satori contre navigateur).

## 5 · Inspecteur (`ImageFields`)

- Un menu **« Ajustement »** (Remplir/Ajuster/Étirer/Mosaïque/Taille perso) — remplace le sélecteur cover/contain actuel, rétrocompatible.
- Un **sélecteur de point focal** : glisser un point sur une vignette de l'image → `focal` x/y, réutilisé comme origine de recadrage (cover) ET de mosaïque (tile). Construit sur les primitives du chantier C (le carré SV du sélecteur de couleur est le patron du glisser-2D).
- Les contrôles **mosaïque** (curseur d'échelle + choix d'axe) affichés SEULEMENT en mode mosaïque.
- Les champs **taille perso** (W×H) en mode taille perso.
- Sous un repli « avancé » : le **décalage de position** (nudge scrubby) et le **fondu** (`blend`). Construit sur `NumberField` scrubby / `SliderField` / `SelectField` du chantier C.

## 6 · Qualité — comment on teste

- **Le pur d'abord :** `imageCss(layer)` (mappage sizing/focal/tile/custom/blend → `{backgroundSize, backgroundRepeat, backgroundPosition, backgroundBlendMode}`), `focalToPosition`, `tileToRepeat` — fonctions de choix PURES, balayées (chaque mode, bornes 0/1 du focal, axes).
- **§0 mesuré, pas affirmé :** un gabarit image cover et un contain rendus AVANT/APRÈS via `renderScene`, comparés au pixel (tolérance stricte). C'est le garde-fou du changement de moteur.
- **La composition là où est le risque :** harnais DOM pour l'inspecteur (le menu Ajustement change `sizing` ; le glisser du point focal écrit `focal` ; les contrôles mosaïque n'apparaissent qu'en mode mosaïque) ; une entrée d'historique par geste.
- **Playwright (contrôleur) :** la VRAIE parité Satori-contre-navigateur sur chaque mode (cover/contain/étirer/mosaïque/taille perso, focal, fondu) — c'est le cœur WYSIWYG, jugé à l'écran.
- **Anti-vacuité, pas de piège de sous-chaîne.** Le registre de jetons/couleurs intact.

---

## Découpage en tâches (SDD, dans cet ordre ; le spike GATE le reste)

1. **Spike modèle de fond Satori (stop-and-report) :** prouver quels `background-size`/`repeat`/`position`/`blend` Satori 0.29 rend ET fait coïncider avec le navigateur ; rendre compte mode par mode ; l'humain arbitre les modes divergents AVANT la suite.
2. **Schéma + mappage pur :** champs optionnels (`sizing`/`focal`/`tile`/`customSize`/`blend`), migration no-op ; `imageCss`/`focalToPosition`/`tileToRepeat` purs, balayés.
3. **Chemin de rendu :** `element.ts` en `<div>` de fond + `prepareImage` (plus de recadrage forcé) ; §0 équivalence au pixel des gabarits cover/contain via `renderScene`.
4. **Parité aperçu :** `layer-view.tsx` rend le même CSS de fond.
5. **Inspecteur :** menu Ajustement + contrôles mosaïque/taille perso/position/fondu.
6. **Point focal déplaçable :** le sélecteur 2D (vignette + glisser) écrivant `focal`, réutilisé cover + tile.
7. **Intégration + §0 + Playwright :** non-régression de bout en bout + la passe WYSIWYG du contrôleur.

---

## Hors périmètre (P1)

- Le recadrage/masquage de l'image à une forme NON rectangulaire (c'est le système de clip de forme, U3).
- Plusieurs images par calque ; fonds animés/vidéo ; point focal par coin.
- Les autres types de calque (texte/forme/QR) — chantiers P2+ du programme Properties Pro.
- Tout mode que le spike déclare non rendu par Satori sans repli acceptable (décision humaine au gate).
