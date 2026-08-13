# Afrotiative — Studio Pro · Chantier C : Refonte des champs de l'inspecteur — Spécification

**Date :** 2026-08-13
**Programme :** « Studio Pro » (chantiers A→E). **Chantier C**, après A et B.
**Statut :** Conception validée en atelier — prête pour le plan
**Portée moteur :** aucune. Le rendu Satori est inchangé ; le schéma n'ajoute AUCUN champ (`opacity` existe déjà sur `layerBase`, `0..1`, seulement pas encore EXPOSÉ). Tout est primitive de champ cliente + réducteur existant.
**Base :** stacké sur `main` (indépendant du chantier B en revue). C touche l'inspecteur (`property-panel.tsx`, `property-fields.tsx`, `geometry-strip.tsx`) SANS le réorganiser — surface de conflit minimale si B fusionne d'abord.

---

## Le problème (audit du 2026-08-13)

L'inspecteur fonctionne mais ses champs sont ceux d'un formulaire, pas d'un outil de design :
- **Aucun champ « scrubby »** — chaque `NumberField` (`property-fields.tsx`) est un `<input type="number">` : pour changer une taille ou une position, il faut cliquer, sélectionner, taper. Un pro attend de POUVOIR GLISSER sur l'étiquette (Figma / After Effects) pour balayer la valeur.
- **Aucun vrai sélecteur de couleur** — `ColorField` (`property-panel.tsx`) est une pastille d'aperçu + un `<input type="text">` hex + le `TokenPicker` (liaison U4). Pas de carré Teinte/Saturation/Valeur, pas de curseur de teinte, pas d'alpha, pas de pipette, pas de nuancier de marque, pas de récents. Choisir une couleur = connaître son hex.
- **Aucun curseur (slider)** — les valeurs BORNÉES (opacité `0..1`, flou d'ombre `≥0`, interligne) n'ont qu'un champ numérique. `layer.opacity` existe au schéma mais N'EST MÊME PAS AFFICHÉE.

Décisions d'atelier : **sélecteur de couleur complet façon Figma** (carré SV + teinte + alpha + hex/RGB + pipette native + nuancier de marque + récents + onglet jeton) ; **curseurs pour l'opacité ET les autres bornées** (flou, interligne) ; **champs scrubby sur TOUS les champs numériques** (glisser uniforme, Maj ×10 / Alt ×0.1). Aucune bibliothèque nouvelle : construit sur Base UI + maths de couleur PURES.

---

## Principe directeur (même colonne vertébrale que A/B/D)

- **Le pur d'abord + fonctions de choix :** les maths de couleur (`hexToHsv`/`hsvToHex`/`parseColor`/`withAlpha`), le balayage (`scrubValue`) et les curseurs (`sliderValue`, conversions d'opacité) sont des fonctions PURES, testées sans DOM, BALAYÉES (continuité, point-fixe, bornes) — la leçon U2.
- **Le tampon de commit préservé :** les primitives gardent le patron `useCommitBuffer` (tampon local, résolution au blur/Entrée, Échap annule).
- **Une entrée d'historique par GESTE :** un balayage complet, un glisser dans le carré SV, un glisser de curseur = UN seul commit à la libération (comme le glisser de calque de B), pas une entrée par pixel.
- **§0 non-régression :** le moteur de rendu et `scene.ts` sont INCHANGÉS. Une couleur reste un `hexColor` (littéral ou `{{jeton}}`) ; l'opacité reste le champ `0..1` déjà au schéma. Taper dans un champ commit à l'identique. Un jeton lié rend et se lie exactement comme aujourd'hui.

---

## 1 · Champs numériques « scrubby »

L'étiquette d'un `NumberField` devient une POIGNÉE de glissement :
- `pointerdown` sur l'étiquette → curseur `ew-resize`, `setPointerCapture` ; `pointermove` balaye la valeur ; `pointerup` commit UNE entrée d'historique. Un CLIC simple (sans glisser, seuil de quelques px) laisse le focus tomber dans l'`<input>` pour taper — le comportement d'aujourd'hui est préservé. `Escape` pendant le glisser annule (revient à la valeur de départ).
- **Fonction PURE `scrubValue(start, dxPx, opts): number`** où `opts = { step, min, max, modifier }` : `dxPx` pixels → delta de valeur ; `modifier` : `"shift"` ×10, `"alt"` ×0.1, sinon ×1 ; arrondit au `step`, clampe à `[min, max]`. Fonction de choix — balayer la continuité (petit `dxPx` → petit delta), le point-zéro (`dxPx=0` → valeur inchangée), les bornes, les modificateurs.
- S'applique à TOUS les champs numériques UNIFORMÉMENT parce qu'ils partagent cette seule primitive : `GeometryStrip` (x/y/l/h/rotation), taille de police, interligne, espacement des lettres, ombre x/y/flou, épaisseur de bordure.
- Accessibilité : les flèches clavier de l'`<input type="number">` restent l'équivalent clavier du balayage ; l'étiquette-poignée porte `role`/`aria` appropriés et ne piège pas le focus.

## 2 · Vrai sélecteur de couleur (façon Figma)

`ColorField` remplace son `<input>` hex nu par un déclencheur (la pastille d'aperçu + la valeur) qui ouvre un **Popover Base UI** contenant le sélecteur (`components/studio/color-picker.tsx`) :
- **Carré Saturation/Valeur** (glissable, réutilise l'interaction de balayage) + **curseur de teinte** + **curseur d'alpha**. L'alpha ici est celui de la COULEUR elle-même, encodé `#RRGGBBAA` — le schéma `hexColor` accepte DÉJÀ 8 chiffres (`scene.ts`, la regex et le message le disent), donc AUCUN changement de schéma. À distinguer de `layer.opacity` (§3, opacité de tout le calque, `0..1`) : deux notions distinctes, toutes deux légales.
- **Entrée hex / RGB** (le champ texte d'aujourd'hui, enrichi) — accepte `#RGB`, `#RRGGBB`, `#RRGGBBAA`, `transparent`.
- **Pipette native** (`EyeDropper` API) — détectée par fonctionnalité, le bouton est MASQUÉ là où l'API n'existe pas (Firefox/Safari) plutôt que d'échouer.
- **Nuancier de marque** — grille de pastilles DÉRIVÉE des jetons de thème de l'app (la marque éditoriale : terracotta + neutres — sourcée du thème CSS existant, PAS des valeurs devinées).
- **Récents** — une liste au niveau MODULE (session, pas OS/localStorage) des dernières couleurs LITTÉRALES choisies, comme le presse-papiers de session de B.
- **Onglet « Jeton »** — préserve la liaison U4 À L'IDENTIQUE : choisir un `{{jeton}}` REMPLACE tout le champ par le jeton (le contenu couleur est TOUJOURS une valeur unique, jamais un mélange — voir la note de `ColorField`), affiché avec l'état « lié » (pastille en damier + libellé de jeton) exactement comme aujourd'hui.
- **Maths PURES `lib/studio/color.ts`** : `hexToHsv`, `hsvToHex`, `parseColor(str): {h,s,v,a} | null`, `withAlpha`, `formatHex`. Toutes pures, balayées : aller-retour hex↔hsv à une tolérance (arrondi 8 bits), cas limites (`transparent`, hex 3 chiffres, alpha, entrées invalides → `null` sans écraser).
- **§0 :** le champ commit TOUJOURS un `hexColor` (littéral ou `{{jeton}}`) via le MÊME `onCommit` — schéma, chemin de rendu et liaison U4 intacts. Le carré SV et les curseurs partagent la discipline « une entrée d'historique par glisser ».

## 3 · Curseurs (sliders)

Une primitive **`SliderField`** (curseur Base UI + `<input>` numérique synchronisé) pour les valeurs bornées :
- **Opacité** — EXPOSE `layer.opacity` (au schéma `0..1`, non affiché aujourd'hui) dans la section « Apparence » comme un curseur 0–100 % + un numérique synchronisé. Fonctions pures `opacityToPercent` / `percentToOpacity`.
- **Autres bornées** — flou d'ombre (`≥0`), interligne, reçoivent un combo curseur + numérique là où une plage bornée est naturelle. Le numérique reste l'entrée PRÉCISE ; le curseur est le contrôle grossier/visuel.
- **Fonction PURE `sliderValue(fraction, opts): number`** et son inverse `valueToFraction` — testées (fraction ↔ valeur, arrondi au step, bornes). UNE entrée d'historique par glisser.

## 4 · Cohérence & non-régression

Les trois gestes (balayage, glisser dans le carré SV, glisser de curseur) tamponnent pendant le geste et commit UNE FOIS — même discipline que le glisser de calque de B. Les champs RESTENT dans leurs sections actuelles (Cadre / Police / Apparence / Ombre / Contour / Source / Remplissage / Forme / Bordure / QR) : **aucune réorganisation de l'inspecteur** (hors périmètre). Taper commit à l'identique (§0). Les cibles `scrollIntoView` de la barre flottante de B (`data-section`) restent résolubles si B fusionne.

---

## Qualité — comment on teste une refonte de champs

- **Le pur d'abord :** `scrubValue`, `hexToHsv`/`hsvToHex`/`parseColor`, `sliderValue`/`opacityToPercent` — toutes pures, balayées (continuité/point-fixe/bornes/aller-retour), la mutation est le juge (retirer le clamp, casser l'aller-retour → un test rougit).
- **La composition là où est le risque (leçon U1) :** harnais DOM (U0) pour — un balayage change la valeur ET produit UNE entrée d'historique ; le sélecteur commit un hex ET un jeton ; le curseur d'opacité fait l'aller-retour ; §0 (taper commit à l'identique, un jeton lié rend/lie encore).
- **Anti-vacuité, pas de piège de sous-chaîne** (les `aria-*` de Base UI, pas les libellés dans tout le HTML). `data-field` sur chaque contrôle.
- **Vérification VISUELLE réelle :** captures Playwright (contrôleur) du sélecteur réel, du carré SV, de la pipette, et du « feel » du balayage — c'est un chantier visuel.
- **§0 / non-régression :** aucune action ne mute la scène hors du réducteur ; un gabarit rend à l'identique ; `parseScene` fait l'aller-retour bit à bit (aucun changement de schéma).

---

## Découpage en tâches (SDD, dans cet ordre)

1. **Maths de couleur pures** — `lib/studio/color.ts` : `hexToHsv`/`hsvToHex`/`parseColor`/`withAlpha`/`formatHex`, balayées. Le socle du sélecteur, aucune UI.
2. **Maths de balayage & de curseur pures** — `lib/studio/field-scrub.ts` : `scrubValue(start, dxPx, opts)`, `sliderValue`/`valueToFraction`, `opacityToPercent`/`percentToOpacity`, balayées.
3. **`NumberField` scrubby** — glisser sur l'étiquette (curseur, capture de pointeur, modificateurs), UNE entrée d'historique, clic-pour-taper préservé, Échap annule. Câble la Tâche 2 ; s'applique à tous les champs numériques.
4. **Le sélecteur de couleur** — `components/studio/color-picker.tsx` (carré SV, teinte, alpha, hex/RGB, pipette, nuancier de marque, récents, onglet jeton) dans un Popover, remplaçant l'`<input>` de `ColorField`. Câble la Tâche 1, préserve la liaison U4 + le contrat `onCommit`.
5. **`SliderField` + opacité + combos bornés** — la primitive curseur+numérique, expose `layer.opacity` (nouveau champ), et les combos flou/interligne. Câble la Tâche 2.
6. **Intégration + passe §0 + Playwright** — vérification visuelle réelle, non-régression de bout en bout, cohérence des trois gestes.

---

## Hors périmètre (chantier C)

- Dégradés / couleurs multi-arrêts (une couleur reste un `hexColor` unique).
- Historique de couleurs PERSISTANT (les récents sont en session seulement).
- Réorganisation de la MISE EN PAGE de l'inspecteur (sections, ordre) — hors sujet.
- Des widgets par champ au-delà du scrubby / curseur / sélecteur.
