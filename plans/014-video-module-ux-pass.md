# Plan 014 — Passe UX du module Vidéo

Issu du canevas de design « Console vidéo Afrotiative » (page « Proposition »). Cinq corrections
ciblées : aucun nouveau vocabulaire visuel, aucune donnée nouvelle en base — tout ce qui est affiché
existe déjà (statut, inserts + `linkStatus`, prises, consentements, durées).

Contraintes globales, valables pour CHAQUE tâche :

- Respecter `DESIGN.md` : pastille de statut = fond `/15` de la couleur de statut + texte à 100 %,
  hairline plutôt qu'ombre, terracotta réservé aux actions primaires, Lora pour les titres, Inter
  pour le chrome, contrôles 32 px.
- Réutiliser les composants existants (`Badge`, `Button`, `Table`, `Card`, `EmptyState`) — ne pas
  créer de second vocabulaire.
- Français partout dans l'UI ; libellés pris dans `lib/video/labels.ts`, jamais réécrits sur place.
- `bun run typecheck` et `bun run test:pure` doivent passer. La suite complète (`bun test`) tape une
  DB distante partagée : lente et bruyante, ne pas s'en servir comme boucle de travail.
- Ne PAS pousser, ne pas ouvrir de PR, ne pas fusionner. Commits locaux uniquement.

---

## Task 1 — Couche données : ce qui réclame un humain, par projet

`lib/queries/video.ts#listVideoProjects` renvoie déjà `unreviewedCount`. Ajouter à
`VideoProjectListRow` :

- `targetSec: number | null` — somme des `targetDurationSec` des variantes du projet (`null` si
  aucune variante n'en porte).
- `deadLinkCount: number` — inserts du projet dont `linkStatus` ∈ {`mort`, `interdit`}.
- `missingConsentCount: number` — intervenants du projet avec `consentGiven = false`.

Impératif : agrégations **en lot** (une requête par dimension sur `inArray(projectIds)`), jamais un
appel par ligne — le commentaire existant sur le N+1 de `unreviewedByProject` explique pourquoi.

Extraire la mise en forme en fonctions **pures** testables si cela clarifie, et ajouter les tests
correspondants dans `tests/` (fichier existant si un fichier pur couvre déjà la liste).

## Task 2 — Écran de liste : statut en pastille + colonne « À traiter »

`components/video/project-list.tsx` :

- Statut rendu comme pastille de statut (même correspondance visuelle que le reste du produit :
  `brouillon` → draft, `en_ecriture` → pending, `pret_a_tourner`/`tourne`/`en_montage` → in-review,
  `publie` → approved, `archive` → draft). Libellés via `VIDEO_STATUS_LABEL`. Supprimer le
  `replace(/_/g, " ")` + `capitalize` devenus inutiles.
- Colonne « Durée » → « Durée / cible » : `9:40 / 10:00`, cible en `muted-foreground`, `—` si absente.
- Nouvelle colonne « À traiter » regroupant les badges : `N non relue(s)` (déplacé depuis la colonne
  Titre), `N lien(s) mort(s)` en destructive, `N consentement(s)` en destructive. `—` si rien.
- Barre de filtres au-dessus de la table : champ de recherche (titre) + select statut + select
  plateforme, filtrage **client**, plus un compte « N projets · M demandent une action ». La table
  devient donc un composant client ; garder `ProjectList` comme composant de rendu et isoler l'état
  de filtrage — ne pas transformer la page serveur.
- État vide conservé (`EmptyState`), plus un état « aucun résultat » distinct quand un filtre est actif.

## Task 3 — Bandeau de projet commun aux six onglets

Nouveau `components/video/project-header.tsx`, rendu par `app/(app)/video/[id]/page.tsx` au-dessus
des `Tabs` (il remplace le `PageHeader` actuel de cette page) :

- Ligne 1 : titre (Lora), pastille de statut, et **la** prochaine action — le bouton d'avancement
  aujourd'hui enfermé dans `TournageView#StatusHeader` (`markReadyToShoot` / `startShooting` /
  `finishShooting`, mêmes server actions, même garde RBAC : n'afficher que si `video:manage`).
- Ligne 2 : les six étapes du pipeline en texte 12 px, l'étape courante en `font-semibold`, les
  autres en `muted-foreground`. Décoratif : pas de lien, pas de terracotta.
- Ligne 3 : sélecteur de variante (liens `?variant=`, la variante active en `active`), cumul de durée
  face à la cible de la variante active, nombre de beats, nombre d'inserts, puis les badges d'alerte
  (liens morts, écritures non relues, consentements manquants) — mêmes libellés que T2.
- Quand un consentement manque ET que le projet est `tourne`, afficher sous le bandeau l'alerte
  destructive « … n'a pas donné son consentement — la mise en montage est bloquée. » avec un lien
  vers `?tab=intervenants`. Le blocage lui-même reste côté serveur ; le bandeau ne fait que
  l'annoncer.

Retirer `StatusHeader` de `components/video/tournage-view.tsx` (le bandeau le porte désormais) et
ajuster les tests qui l'attendaient. `VariantManager` reste dans l'onglet Écriture pour dériver et
supprimer, mais son bloc de badges de variantes devient redondant : le réduire à sa carte d'actions.

## Task 4 — Onglet Écriture : médias et sources visibles depuis la table

`components/video/beat-list.tsx` :

- Deux colonnes : « Médias » (nombre d'inserts par nature, ex. `1 graphique`, + une pastille ronde
  6 px donnant le pire `linkStatus` du beat : vert `ok`, ambre `non_verifie`, rouge `mort`/`interdit`)
  et « Sources » (nombre, badge destructive `0` quand le beat est de type `narration`/`reponse` et
  n'a aucune source — application de la règle « jamais pré-vérifié »).
  composant `duration-meter.tsx` (aucun autre appelant à casser) et mettre à jour les tests de
  `BeatList` qui l'attendaient.
- Légende sous la table expliquant les trois pastilles.

## Task 5 — Onglet Montage : exports en boutons, avancement visible

`app/(app)/video/[id]/page.tsx` + `components/video/conducteur-view.tsx` :

- Les trois exports (`csv`, `json`, `manifest`) deviennent des `Button variant="outline" size="sm"`
  avec icône, rendus dans une barre d'actions, plus un bouton « Accès monteur » qui ouvre le panneau
  `MontageSharePanel` (dialogue ou repli) au lieu de l'étaler en permanence au-dessus du conducteur.
  Ce sont des téléchargements : rester des `<a href>` habillés en bouton, pas des `onClick`.
- Bandeau de totaux du conducteur enrichi d'un avancement « N / M beats montés » (compter
  `beat.checked`) avec une barre de progression fine.
- Un beat coché passe en retrait (fond `muted/40`, texte du beat en `muted-foreground`) plutôt que
  de rester identique à un beat non monté.

## Task 6 — Onglet Tournage : avancement des prises

`components/video/tournage-view.tsx` :

- En tête du mode Journal : « Prises retenues : N / M beats » avec barre de progression, nombre total
  de prises, badge `N beats sans prise`.
- Filtres (état client) : « Tous les beats » / « Sans prise » / « À revoir » (beats dont aucune prise
  n'est `bonne`).
- Le premier beat sans prise retenue reste en carte pleine (texte en Lora, boutons Bonne / Mauvaise /
  À revoir conservés à **44 px minimum** — usage plateau) ; les autres passent en lignes compactes
  avec leur compteur de prises et un bouton pour les déplier.
- Mode prompteur inchangé.

---

## Ordre

Task 1 → Task 2, puis Task 3 → (Task 4, Task 5, Task 6). Les tâches 4, 5 et 6 sont indépendantes entre elles une fois la 3 posée.
