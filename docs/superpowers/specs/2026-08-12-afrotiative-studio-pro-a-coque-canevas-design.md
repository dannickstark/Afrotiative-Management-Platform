# Afrotiative — Studio Pro · Chantier A : Coque « canevas d'abord » & IA responsive — Spécification

**Date :** 2026-08-12
**Programme :** « Studio Pro » (chantiers A→E ; voir `2026-08-12-afrotiative-studio-pro-d-contraintes-multiformat-design.md` pour le cadrage). **Chantier A**, choisi comme premier chantier VISIBLE après D.
**Statut :** Conception validée en atelier — prête pour le plan
**Portée moteur :** aucune. C'est de la structure d'interface, du routage, et du responsive — pas le moteur de rendu.

---

## Le problème (audit + captures Playwright du 2026-08-12)

L'éditeur `/studio/[id]` est **imbriqué dans la coque back-office** : la barre latérale de l'app
(Rédaction/Supervision/Studio/Réglages, ~250 px) et un en-tête restent affichés, en concurrence avec
un SECOND rail d'icônes. Le plan de travail n'est jamais la vedette : inspecteur vide béant à droite,
plan de travail flottant petit (« 59 % » d'ajustement) au milieu d'un vide blanc, rail exigu.
**Rien dans l'éditeur n'est responsive** (0 media-query dans `editor-shell/canvas/panels/property-panel`) ;
à 1024 px la pastille format **chevauche** les icônes de la barre du canevas. La galerie de gabarits est
un **tableau texte** sans vignette. Décisions d'atelier : **éditeur plein écran** (hors coque admin),
**galerie en vignettes rendues**, **desktop-first avec tiroirs sous ~1024**. La marque/le mouvement/le
craft fin sont le **chantier E** ; A livre la STRUCTURE et le RESPONSIVE.

---

## 1 · L'éditeur passe en plein écran (hors coque admin)

`/studio/[id]` (et l'éditeur en général) cesse d'hériter de la barre latérale + en-tête de
`app/(app)/layout.tsx`. Il reçoit sa propre **barre supérieure d'éditeur, mince** :
- **Gauche :** `← Gabarits` (retour à la liste) · nom du gabarit · indicateur d'enregistrement.
- **Centre :** le commutateur `Montage ⇄ Rendu réel`.
- **Droite :** un emplacement de zoom (le mécanisme réel de zoom/pan est le chantier B ; A pose le
  contrôle et le conteneur) · Historique · Publier.

**L'authentification NE change PAS** — seule la chrome VISUELLE disparaît. La liste des gabarits
(`/studio`) et la bibliothèque (`/studio/assets`) gardent la coque admin normale.

> **Réserve à lever (Tâche 1, spike stop-and-report) :** ce dépôt tourne sur un Next.js « pas celui
> que vous connaissez » (16.3, Turbopack ; voir AGENTS.md — lire `node_modules/next/dist/docs/` avant
> de router). L'approche envisagée — sortir l'éditeur du groupe de routes `(app)` vers un nouveau
> groupe `(studio-editor)` avec une **layout plein écran** propre, SANS changer l'URL `/studio/[id]`,
> tout en refaisant la garde `requireUser` dans la nouvelle layout — doit être **prouvée dans CE
> Next** avant tout le reste. Si les groupes de routes ne permettent pas d'échapper à la layout parente
> comme attendu (ou si `/studio` liste et `/studio/[id]` éditeur entrent en collision entre groupes),
> le repli (une layout conditionnelle, ou un `usePathname` qui masque la coque pour l'éditeur) est la
> décision de l'humain. Le spike rend compte et s'arrête.

---

## 2 · Corps « canevas d'abord » à trois zones

- **Gauche :** le rail d'icônes mince (six catégories, toujours visible) + le **panneau accosté** par
  catégorie, qui coulisse (chevron + raccourci `⌘/`, déjà présent).
- **Centre :** le **canevas dominant, sur un fond NEUTRE** (pas un vide blanc), le plan de travail
  centré avec une ombre douce. Tue l'effet « inachevé ». (A garde le fit actuel ; le vrai zoom/pan est
  le chantier B — mais A pose l'emplacement du contrôle de zoom et le fond neutre.)
- **Droite :** l'**inspecteur repliable**, avec un **état vide COMPACT** au lieu du grand panneau blanc
  actuel (« Sélectionnez un calque… » dans une petite carte, pas un vide de 300 px).
- **Bordures redimensionnables** rail↔panneau et canevas↔inspecteur (poignées de glissement), largeurs
  **persistées** dans `editor-prefs.ts` (à côté de `openPanel`, etc.).

---

## 3 · Responsive (desktop-first)

Une fonction PURE `editorLayoutMode(width): "full" | "inspector-drawer" | "all-drawers" | "too-small"`
(testable sans DOM), consommée par la coque :
- **≥ 1280 :** trois zones pleines.
- **1024–1280 :** l'inspecteur devient un **tiroir** à droite (ouvert à la sélection) ; le rail reste.
- **< 1024 :** rail + panneaux + inspecteur en **tiroirs/superpositions** ; le canevas ne rétrécit
  JAMAIS sous un minimum utilisable — corrige le chevauchement pastille/icônes de 1024 px vu en capture.
- **< ~768 (téléphones) :** un état gracieux **« Écran trop petit pour l'édition — aperçu seulement »**
  avec un aperçu en lecture seule (réutilise le rendu du mode « Rendu réel »).

Les tiroirs réutilisent `Sheet`/`Drawer` de la bibliothèque UI ; la détection de largeur réutilise
`hooks/use-mobile.ts` (présent, jamais importé par le studio) ou un `useMediaQuery` équivalent.

---

## 4 · Galerie de gabarits en vignettes (`/studio`, dans la coque admin)

Une **grille de cartes**, chacune montrant une **vignette RENDUE** du gabarit (via le pipeline de rendu
satori, en action serveur **mise en cache** — réutiliser le cache de rendu par hash d'entrée ; chargée
paresseusement par `IntersectionObserver`, comme la bande de vignettes du mode Rendu réel). Carte =
vignette + nom + pastille de format + état + actions. Groupée par contexte (Image à la une / Publication
sociale) comme aujourd'hui. Un **bascule grille ⇄ tableau** préserve le tableau actuel (l'état mémorisé).

---

## 5 · Craft (léger ici ; le gros est le chantier E)

A pose le **fond neutre du canevas**, l'ombre du plan de travail, la chrome légère et repliable, les
**états vides compacts**, et un nettoyage de jetons/espacement là où A touche. La marque éditoriale
appliquée partout, le mouvement/micro-interactions, l'iconographie sur mesure sont le **chantier E** —
A ne les régresse pas mais ne les précharge pas.

---

## Qualité — comment on teste une refonte de mise en page

- **Le pur d'abord :** `editorLayoutMode(width)` et le choix de largeurs persistées sont des fonctions
  pures, testées sur la matrice de largeurs (bornes exactes 768/1024/1280) — fonction de choix, balayer
  continuité/déterminisme.
- **La composition là où est le risque (leçon U1) :** le harnais DOM (U0) pour monter la coque et
  vérifier qu'à une largeur donnée l'inspecteur est un tiroir et non une colonne, que le canevas reste
  au-dessus de sa largeur minimale, que la barre d'éditeur ne réaffiche pas la barre latérale de l'app.
- **Vérification VISUELLE réelle :** captures Playwright de l'éditeur à 1440 / 1280 / 1024 / 768, avant
  et après, comparées aux captures d'audit — c'est un chantier visuel, la preuve est à l'écran (serveur
  de dev + Playwright déjà en place).
- **Le spike routage (Tâche 1) est stop-and-report** : plein écran prouvé + `requireUser` toujours
  actif + retour navigation, avant d'y poser quoi que ce soit.
- **Non-régression :** la liste des gabarits et la bibliothèque gardent la coque admin ; l'auth de
  l'éditeur est inchangée ; aucune route ne casse.

---

## Découpage en tâches (SDD, dans cet ordre)

1. **Spike routage plein écran (stop-and-report) :** prouver dans CE Next que l'éditeur `/studio/[id]`
   rend dans une layout plein écran sans la barre latérale de l'app, `requireUser` toujours appliqué,
   URL inchangée, retour vers `/studio` fonctionnel. Rendre compte du mécanisme (groupe de routes vs
   repli) avant la suite.
2. **Barre supérieure d'éditeur** (retour · nom · save · mode · zoom-slot · Historique · Publier) dans
   la coque plein écran, remplaçant l'en-tête admin pour l'éditeur.
3. **Corps trois zones + fond neutre + états vides compacts + bordures redimensionnables** (largeurs
   persistées dans `editor-prefs`).
4. **Responsive : `editorLayoutMode` pur + les tiroirs** (inspecteur→tiroir 1024–1280 ; tout en tiroirs
   <1024 ; état « trop petit » <768). Tests purs + DOM + captures Playwright aux quatre largeurs.
5. **Galerie en vignettes** : action serveur de vignette rendue+cache, grille de cartes paresseuse,
   bascule grille ⇄ tableau, groupée par contexte.

---

## Hors périmètre (chantier A)

- Le vrai zoom/pan, la barre contextuelle flottante, le menu clic-droit, copier/coller, ⌘Z clavier — **chantier B**.
- La refonte des champs de l'inspecteur (scrubby, sélecteur de couleur) — **chantier C**.
- La marque appliquée, le mouvement, l'iconographie sur mesure — **chantier E**.
- Une vraie édition tactile/tablette (décision d'atelier : desktop-first + tiroirs ; les téléphones
  reçoivent l'état « aperçu seulement », pas une édition tactile).
