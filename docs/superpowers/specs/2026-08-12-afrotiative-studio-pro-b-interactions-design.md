# Afrotiative — Studio Pro · Chantier B : Interactions pros — Spécification

**Date :** 2026-08-12
**Programme :** « Studio Pro » (chantiers A→E). **Chantier B**, après A.
**Statut :** Conception validée en atelier — prête pour le plan
**Portée moteur :** aucune (rendu Satori inchangé). Le schéma gagne un champ `groupId?` optionnel ; tout le reste est interaction cliente + réducteur.
**Base :** stacké sur le chantier A (`feat/studio-pro-a-coque`) — B consomme la coque plein écran, la barre d'éditeur et son **emplacement de zoom** (`data-testid="zoom-slot"`, inerte, posé par A Tâche 2).

---

## Le problème (audit du 2026-08-12)

BLOCKERS pour un pro, relevés dans le code :
- **Aucun vrai zoom** — `computeCanvasScale` (editor-shell) plafonne à 1 (ajustement seul) ; `EditorPrefs.zoom` existe mais n'est **pas consommé** en édition ; le canevas est un `transform: scale(k)` dans un conteneur `overflow-auto`. **Aucun pan.**
- **Aucun raccourci clavier d'édition** : seuls `Delete`, les flèches (nudge) et `⌘/` existent. **Pas de `⌘Z`/redo, copier/coller/dupliquer, tout-sélectionner, Échap.** (Le réducteur a pourtant déjà `undo`/`redo`.)
- **Aucune barre contextuelle flottante, aucun menu clic-droit** (`canvas.tsx` documente « aucun gestionnaire contextmenu »).
- **Aucun groupe** — `layers` est un tableau plat, pas de notion de parent/enfant.

Décisions d'atelier : barre contextuelle flottante **ET** menu clic-droit ; **inclure** groupe/dégroupe (modèle `groupId` PLAT, pas un schéma récursif) ; presse-papiers **en session** (mémoire, pas OS).

---

## 1 · Vrai zoom + pan

- `scale` devient `fitScale × zoomFactor`. `zoomFactor` est persisté dans `EditorPrefs.zoom` (aujourd'hui `number | "fit"`, jamais lu en édition — enfin consommé). `"fit"` recalcule à l'ajustement ; un nombre est un facteur multiplicatif.
- **L'emplacement de zoom de A** (`zoom-slot`) devient le contrôle vivant : % courant + boutons −/+ + un menu (Ajuster `⇧1` / 100% `⇧0` / Zoom sur la sélection `⇧2` / 50 %–200 %).
- `⌘/Ctrl + molette` = **zoom centré sur le CURSEUR** (jamais sur le milieu du canevas) ; `Espace`-glisser = **pan** (défilement du conteneur `overflow-auto`) ; pincement trackpad = zoom.
- **Fonction pure `zoomModel`** : clamp (min/max), et le calcul « zoom-to-cursor » (ajuste le défilement pour garder le point sous le curseur fixe) — c'est une **fonction de choix**, testée sur continuité + le point-fixe exact.
- Réconcilie les DEUX affichages de zoom de A (le slot de la barre + la pastille `zoom-chip` de `CanvasChrome`) — une seule source (`scale`/`zoomFactor`), les deux la lisent.

## 2 · Raccourcis clavier — un keymap central

Une fonction PURE `resolveShortcut(event, ctx): EditorCommand | null` (ctx = y a-t-il une sélection, l'historique est-il non vide…), **gardée** pour ne PAS se déclencher quand le focus est dans un champ (input/textarea/contenteditable). Mappe : `⌘Z` undo · `⌘⇧Z` redo · `⌘C` copier · `⌘V` coller · `⌘D` dupliquer · `⌘A` tout-sélectionner · `Échap` désélectionner · `⌘G` grouper · `⌘⇧G` dégrouper. (`Delete` + flèches existent déjà — les migrer dans le keymap sans changer le comportement.) `undo`/`redo` câblent les actions **déjà présentes** du réducteur.

## 3 · Presse-papiers en session

Un presse-papiers au niveau module (mémoire) tenant un instantané (clone profond) des calques copiés. `copier` = instantané de la sélection ; `coller` = ajoute les calques avec des **ids neufs** et un **décalage** ; `⌘D dupliquer` = copier+coller-sur-place-décalé en **UNE entrée d'historique**. Marche d'un gabarit à l'autre DANS la session. Nouvelle action réducteur `addLayers` (lot, une entrée d'historique) + génération d'ids uniques. Un calque groupé collé reçoit un `groupId` neuf partagé (le groupe est dupliqué, pas fusionné).

## 4 · Barre contextuelle flottante

Une petite barre ancrée AU-DESSUS de la sélection, rendue dans le conteneur mis à l'échelle (comme la surcouche de liaisons de U4, coords gabarit, taille écran constante via `1/scale`). Actions rapides PAR TYPE : texte → police/taille/couleur/gras ; forme → remplissage/bordure ; image → remplacer/ajuster ; qr → slot ; **commun** → dupliquer/supprimer/verrouiller/ordre/grouper. Fonction PURE `toolbarActionsFor(selection): Action[]`. **Complète** l'inspecteur (ne le remplace pas) — les 4-6 actions les plus fréquentes près de l'objet, le jeu complet reste à droite. Masquée pendant un glisser/redimensionnement.

## 5 · Menu clic-droit

Un menu contextuel (primitive `context-menu` shadcn — à ajouter à `components/ui/` si absente) sur le corps d'un calque et sur le canevas : copier/coller/dupliquer, supprimer, **avancer/reculer** (réordonner — `reorderLayer` existe), verrouiller/masquer (`toggleLocked`/`toggleVisible` existent), grouper/dégrouper. Le clic-droit sélectionne d'abord la cible (comme les outils de référence). Garde-fou U3 : un clic-droit sur un calque VERROUILLÉ (pointer-events:none) tombe sur le canevas — comportement à énoncer, testé.

## 6 · Groupe / dégroupe — modèle `groupId` PLAT (décision d'atelier)

Chaque calque gagne `groupId?: string` (optionnel, au `layerBase` du schéma). **Grouper** N calques sélectionnés = leur assigner un `groupId` neuf partagé (une action réducteur `setGroup`, une entrée d'historique). **Sélectionner** un membre sélectionne TOUT le groupe (résolution pure `expandSelectionToGroups(ids, scene)`). **Glisser** un membre déplace tous les membres — réutilise le glisser-de-groupe multi-sélection **déjà** en place. **Dégrouper** = effacer le `groupId` des membres. Le **panneau de calques** montre un nœud de groupe (repliable) regroupant les membres. Le **cadre de groupe** (pour la barre flottante et les poignées) = boîte englobante des membres (fonction pure `groupBounds`).

**Ce que le modèle plat NE fait PAS, énoncé :** pas de groupes IMBRIQUÉS ; la **contiguïté d'ordre de peinture** d'un groupe est au mieux (les membres restent dans le tableau plat ; grouper les rend contigus au moment du groupe, mais un calque inséré entre eux ensuite peut casser la contiguïté — c'est acceptable pour un éditeur de gabarits). Le modèle récursif (un type de calque `group` avec `children`) est un chantier bien plus lourd (récursion dans les deux chemins de rendu, le relayout/contraintes de D, l'ordre-z, la sélection) — délibérément écarté ici. `groupId` optionnel absent = comportement actuel exact (migration no-op).

**Interaction avec le chantier D (contraintes) :** un groupe n'est PAS un cadre parent ; les contraintes restent **par calque** relatives au canevas (inchangé). Grouper ne change pas les contraintes. À énoncer, pas à découvrir.

---

## Qualité — les leçons du programme

- **Le pur d'abord + fonctions de choix :** `zoomModel` (clamp + point-fixe curseur), `resolveShortcut`, `toolbarActionsFor`, `expandSelectionToGroups`, `groupBounds`, le décalage de collage — tous purs, testés ; balayer chaque fonction de choix (le zoom-to-cursor et la résolution de raccourci en particulier — la leçon U2).
- **La garde du focus est load-bearing :** un test prouve que `⌘A`/`Delete`/etc. ne se déclenchent PAS quand le focus est dans un champ de l'inspecteur (sinon éditer un nombre supprimerait le calque). Mutation : retirer la garde → le test rougit.
- **Harnais DOM (U0)** pour zoom/pan/raccourcis/barre/menu ; captures **Playwright** (contrôleur) pour le zoom/pan et la barre flottante réels.
- **Une entrée d'historique par geste** (dupliquer, grouper, coller) — pinée, undo restaure exactement.
- **Anti-vacuité, mutation seule juge, pas de piège de sous-chaîne** (Base UI `aria-*`).
- **§0 / non-régression :** aucune action ne mute la scène hors du réducteur ; les gabarits sans `groupId` rendent identiquement.

---

## Découpage en tâches (SDD, dans cet ordre)

1. **Keymap central + `resolveShortcut` pur** (garde du focus) ; câble undo/redo (`⌘Z`/`⌘⇧Z`), tout-sélectionner (`⌘A`), Échap ; migre Delete/flèches dans le keymap. Le socle.
2. **Presse-papiers en session** : `addLayers` réducteur + ids neufs + décalage ; copier/coller/dupliquer (`⌘C/V/D`), une entrée d'historique.
3. **Vrai zoom** : `zoomModel` pur (clamp + zoom-to-cursor) ; `scale = fitScale × zoomFactor` ; contrôles dans le `zoom-slot` (%, −/+, menu Fit/100%/sélection) ; raccourcis `⇧0/1/2` ; réconcilie les deux affichages.
4. **Pan + molette** : `Espace`-glisser (défilement) ; `⌘/Ctrl + molette` zoom-au-curseur ; pincement.
5. **Groupe/dégroupe** : `groupId?` au schéma (no-op) ; `setGroup` réducteur ; `expandSelectionToGroups`/`groupBounds` purs ; sélection/glisser de groupe ; nœud de groupe dans le panneau de calques ; `⌘G`/`⌘⇧G`.
6. **Barre contextuelle flottante** : `toolbarActionsFor` pur + le rendu ancré sur la sélection (coords mises à l'échelle) ; actions par type + communes.
7. **Menu clic-droit** : primitive `context-menu` + le menu sur calque/canevas (copier/coller/dupliquer/supprimer/ordre/verrou/masquer/grouper), sélection-à-la-cible.

---

## Hors périmètre (chantier B)

- Groupes IMBRIQUÉS / un type de calque `group` récursif (le modèle plat est délibéré).
- Opérations booléennes (union/soustraction), presse-papiers OS/inter-onglets.
- La refonte des CHAMPS de l'inspecteur (scrubby, sélecteur de couleur) — **chantier C**.
- Le craft marque/mouvement, l'iconographie — **chantier E**.
