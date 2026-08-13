# Afrotiative — Studio Pro · Chantier E : Craft visuel & marque — Spécification

**Date :** 2026-08-13
**Programme :** « Studio Pro » (chantiers A→E). **Chantier E**, le DERNIER — après A (coque), B (interactions), C (champs), D (contraintes).
**Statut :** Conception validée en atelier — prête pour le plan
**Portée moteur :** AUCUNE. Le rendu Satori et `lib/studio/scene.ts` sont INCHANGÉS. C'est de la CHROME d'éditeur : jetons CSS, couleurs de surcouches, composants d'état vide, mouvement, icônes. La sortie de rendu est bit à bit identique.
**Base :** stacké sur `main` (qui porte A+B+C+D). E thème ce que A/B/C/D ont construit.

---

## Le problème (audit du 2026-08-13)

La marque éditoriale (terracotta `--accent-brand`, titres éditoriaux/Lora, monogramme « A ») a été appliquée à l'app d'administration lors de l'audit go-live — mais **le studio en a été EXPLICITEMENT exclu** (« un process Claude séparé possède l'éditeur visuel »). Résultat, le studio est fonctionnel mais générique :
- **Fond d'atelier en dur** — `components/studio/editor-shell.tsx:978` code `bg-neutral-100 dark:bg-neutral-900` en dur (chantier A a « tué le vide blanc » mais avec un gris plat, pas un neutre éditorial chaud). Aucun jeton `--canvas-backdrop`.
- **Couleurs de surcouches éparpillées en hexes bruts** — sélection `#2563eb`, guides d'accrochage `GUIDE_COLOR="#e11d48"`, liaisons `BINDING_COLOR="#7c3aed"` (canvas.tsx) ; zones sûres `rgba(245,158,11,…)` (canvas-chrome.tsx). Délibérément distinctes pour l'usage, mais AUCUNE cohérence de marque et AUCUNE source unique.
- **États vides génériques** — l'inspecteur « Sélectionnez un calque… » et l'état « trop petit » n'utilisent pas la primitive de marque `components/shell/empty-state.tsx`.
- **Peu de mouvement** — panneaux/tiroirs/barre flottante/menu apparaissent sans micro-interactions travaillées.
- **Icônes lucide génériques** — tailles/graisses de trait incohérentes selon le rail/l'inspecteur/les barres.

Décisions d'atelier : icônes = **lucide affinées** (aucun nouveau dessin, tailles/traits unifiés) ; surcouches = **centraliser + cohérer à la marque** en gardant chaque rôle DISTINCT ; mouvement = **plus riche** (ressort/échelle marqués) MAIS toujours coupé par `prefers-reduced-motion`.

---

## Principe directeur

Le craft est SUBJECTIF → chaque livrable a un ARTEFACT TESTABLE (un jeton défini ET consommé, un composant qui rend, des classes de mouvement + la coupe `reduced-motion`, un invariant de distinction des surcouches), PLUS une passe VISUELLE Playwright (contrôleur) pour le ressenti. **§0 :** aucun changement du moteur/`scene.ts` ; le comportement (sélection, guides, liaisons) est identique, seulement re-coloré/animé.

---

## 1 · Jeton `--canvas-backdrop`

Ajouter `--canvas-backdrop` (clair + sombre) à `app/globals.css` — un NEUTRE ÉDITORIAL CHAUD (pas le `neutral-100/900` plat), cohérent avec la rampe warm-grey du thème (`oklch(… 0.005 106.5)` etc.). Le consommer dans `editor-shell.tsx:978` (remplacer `bg-neutral-100 dark:bg-neutral-900` par `bg-[var(--canvas-backdrop)]` ou une utilité `canvas-backdrop`). **Testable :** le jeton est défini (clair+sombre) ; aucun `bg-neutral-100`/`dark:bg-neutral-900` en dur ne subsiste sur le `canvas-backdrop` (grep).

## 2 · `lib/studio/overlay-theme.ts` — palette de surcouches centralisée

Un module PUR (client-safe, sans base, sans React) de couleurs NOMMÉES : `SELECTION`, `HANDLE_FILL`, `HANDLE_BORDER`, `SNAP_GUIDE`, `BINDING`, `SAFE_TINT`, `SAFE_LINE` (au moins). Y migrer les hexes épars : `canvas.tsx` (`#2563eb`, `GUIDE_COLOR`, `BINDING_COLOR`, les poignées `#fff`/`#2563eb`) et `canvas-chrome.tsx` (`SAFE_TINT`/`SAFE_LINE`). Nudger vers une palette éditoriale cohérente **tout en gardant chaque rôle VISUELLEMENT DISTINCT** — la distinction que les couleurs actuelles fournissent (une sélection n'est pas un guide n'est pas une liaison n'est pas une zone sûre) est un acquis d'usage à préserver. **Testable :** source unique (grep prouve qu'aucun hexe de surcouche brut ne subsiste dans canvas.tsx/canvas-chrome.tsx) ; un test PUR épingle que les quatre rôles restent des valeurs DISTINCTES (anti-régression de distinction) ; §0 — la géométrie/les data-testid des surcouches sont inchangés, seule la couleur bouge.

## 3 · États vides du studio

Réutiliser `components/shell/empty-state.tsx` (`EmptyState({ icon?, title, hint?, action? })` — marque : icône, type éditorial, `hint`) pour les surfaces vides du studio :
- L'inspecteur « Sélectionnez un calque… » (aujourd'hui une carte nue).
- L'état « trop petit / aperçu seulement » (`TooSmallState`, editor-shell) — un `EmptyState` avec le monogramme + une aide claire.
- Un panneau vide (ex. calques vides) si présent.
Utiliser un `icon` cohérent et une copie éditoriale française. **Testable :** ces surfaces rendent le composant `EmptyState` partagé (avec ses éléments de marque), pas une carte ad-hoc.

## 4 · Jetons de mouvement + micro-interactions plus riches

Un petit jeu de jetons durée/easing (dont un easing À RESSORT) dans `app/globals.css` (ou `lib/studio/motion.ts` + utilités), appliqués à : le glissement d'ouverture/fermeture du panneau accosté et des tiroirs (Sheet), l'apparition en fondu+échelle de la barre flottante (B Tâche 6), le menu clic-droit (B Tâche 7), les états survol/focus des contrôles, la transition du contour de sélection et des lignes du panneau de calques. « Plus riche » = ressort/échelle perceptibles à l'apparition. **IMPÉRATIF :** chaque animation est enveloppée par `@media (prefers-reduced-motion: reduce)` qui la DÉSACTIVE (transitions à 0 / pas de transform). **Testable :** les jetons sont définis ; la requête `reduced-motion` est présente et neutralise les transitions ; les classes/`data-attr` appliquées sont vérifiables en test DOM.

## 5 · Cohérence des icônes + finition de marque

- **Icônes lucide affinées :** unifier la TAILLE et la GRAISSE DE TRAIT des icônes selon le contexte (une convention partagée, ex. `size-4`/`size-[18px]`/`size-5` + `strokeWidth` constant) à travers le rail, l'inspecteur, les barres (flottante, en-tête), le menu clic-droit, les panneaux ; remplacer les icônes dépareillées par un jeu cohérent. Aucun NOUVEAU dessin.
- **Finition de marque :** appliquer `--accent-brand` (terracotta) de façon COHÉRENTE aux affordances d'action du studio (boutons primaires, états actifs, anneaux de focus) là où elles sont génériques ; appliquer la police de titre éditoriale (`--font-heading`) aux TITRES du studio (titres de panneaux, titres d'états vides). **Testable :** la constante de taille d'icône partagée est utilisée uniformément (pas de tailles ad-hoc) ; l'accent/le titre éditorial sont appliqués aux endroits spécifiés (grep/DOM).

## 6 · Intégration + passe §0 + Playwright

Passe de non-régression (sélection/guides/liaisons se comportent à l'identique, seulement re-colorés/animés ; moteur intact) + la passe VISUELLE du contrôleur (chaleur du fond, cohérence des surcouches, états vides, ressenti du mouvement, cohérence des icônes — captures avant/après).

---

## Qualité — comment on teste du CRAFT

- **Le pur d'abord :** `overlay-theme.ts` est un module pur ; test = source unique + distinction des rôles épinglée.
- **La composition là où est le risque :** harnais DOM pour — les surfaces vides rendent `EmptyState` ; les classes de mouvement sont présentes ET la coupe `reduced-motion` neutralise ; les consommateurs de surcouches lisent le module (aucun hexe brut) ; la taille d'icône partagée est utilisée.
- **Le SUBJECTIF est pour Playwright (contrôleur), pas pour un test unitaire** — chaleur du fond, cohérence des couleurs, ressenti du mouvement, finesse des icônes se JUGENT à l'écran (captures avant/après).
- **Anti-vacuité, pas de piège de sous-chaîne.** §0 : moteur/`scene.ts` intacts ; les surcouches gardent géométrie et `data-testid` ; un gabarit rend à l'identique.

---

## Découpage en tâches (SDD, dans cet ordre)

1. **Jeton `--canvas-backdrop`** — le définir (clair+sombre) dans `globals.css`, le consommer dans `editor-shell`, retirer le fond en dur.
2. **`lib/studio/overlay-theme.ts`** — centraliser + cohérer la palette de surcouches ; migrer `canvas.tsx` et `canvas-chrome.tsx` ; test pur de distinction.
3. **États vides** — les surfaces vides du studio (inspecteur, trop-petit, panneau) via `EmptyState` partagé.
4. **Mouvement** — jetons durée/easing (dont ressort) + micro-interactions (panneau/tiroir/barre/menu/survol/sélection), coupe `reduced-motion`.
5. **Icônes + finition de marque** — convention de taille/trait d'icône partagée ; accent terracotta cohérent + titre éditorial sur les titres du studio.
6. **Intégration + §0 + Playwright** — non-régression de bout en bout + passe visuelle du contrôleur.

---

## Hors périmètre (chantier E)

- Le DESSIN de nouvelles icônes (lucide affinées uniquement).
- Toute bibliothèque d'animation (transitions CSS tokenisées, pas de framer-motion).
- Tout changement du moteur de rendu / du schéma / de la sérialisation.
- La refonte de l'app d'ADMINISTRATION (le studio uniquement — la marque admin existe déjà).
