# Tournage & journal de prises (sous-projet 4) — design

Donne à l'équipe une **vue de tournage** sur mobile/tablette : un prompteur pour lire les
lignes et un **journal de prises** par beat (bonne / mauvaise / à revoir), avec une prise
retenue par beat et les transitions de statut du projet (prêt à tourner → tourné → en
montage). SP1 avait réservé la table `beat_takes` et l'enum `take_status` ; le statut du
projet est aujourd'hui une colonne morte, jamais transitionnée. SP4 ouvre les deux.

## Objectif et périmètre

- **But** : sur le plateau, l'équipe démarre le tournage, lit les beats en grand
  (prompteur), enregistre des prises d'un tap (bonne/mauvaise/à revoir), désigne LA prise
  retenue par beat, et marque le tournage terminé.
- **Hors périmètre** : **prompteur auto-défilant** (on livre un grand texte navigable, pas
  de téléprompteur motorisé) ; **hors-ligne / file locale** (en ligne uniquement, aucune
  infra offline n'existe) ; **intégration au conducteur** de la prise retenue (SP2 reste
  inchangé — reporté) ; upload de rushes/footage (les prises ne portent pas de média en
  SP4). Toute IA.

## Décisions verrouillées (ne pas rouvrir)

1. **Prise retenue = `selectedTakeId` sur le beat** (exactement une par beat). Colonne
   `uuid` **sans contrainte FK** (une FK beat→prise alors que prise→beat cascade formerait
   une FK circulaire — connue pour compliquer les migrations) ; référence logique appliquée
   côté code.
2. **Prises sur n'importe quel beat** (pas seulement les beats parlés).
3. **En ligne uniquement**, responsive, grandes cibles tactiles.
4. **Transitions de statut** wirées : `en_ecriture → pret_a_tourner`, `pret_a_tourner →
   tourne`, `tourne → en_montage`. Pas de machine à états complète.
5. **Un seul spec/plan** (comme SP2/SP3).
6. **Pas d'intégration conducteur** de la prise retenue en SP4 (stockée, non lue par SP2).

## 1. Schéma (une migration)

`beat_takes` existe déjà : `{ id, beatId → script_beats (cascade), number int notNull,
status take_status notNull, startedAt timestamp, note text, createdAt, unique(beatId,
number) }`. `take_status` = `bonne | mauvaise | a_revoir`.

Ajout : **`selectedTakeId`** sur `script_beats` — `uuid("selected_take_id")` nullable,
**sans `.references()`** (référence logique). Enforcement applicatif :
- `selectTakeCore` vérifie que la prise appartient au beat avant d'écrire.
- `deleteTakeCore` efface `selectedTakeId` si la prise supprimée était retenue.

Une migration additive `ALTER TABLE "script_beats" ADD COLUMN "selected_take_id" uuid;`.
Aucune valeur d'enum ajoutée.

## 2. Cœurs de prises — nouveau `lib/video/takes-core.ts`

Module sans `"use server"`, importe `@/db` (exception documentée comme `persist.ts`),
réutilise `RefusalError` de `@/lib/video/persist`. **Ordre de verrou** étendu :
`script_variants` (FOR UPDATE) → `script_beats` → **`beat_takes` en dernier**. Découverte de
la variante via `beatId → variantId` (ou `takeId → beatId → variantId`) par selects nus, puis
`FOR UPDATE` sur la variante.

- Pur `nextTakeNumber(existing: number[]): number` — `max(existing) + 1`, `1` si vide
  (extrait pour test unitaire).
- `addTakeCore(input: { beatId: string; status?: TakeStatus }): Promise<{ id: string; number: number }>` — numérote via `nextTakeNumber`, insère `startedAt = new Date()`, `status` défaut `"a_revoir"`. Respecte `unique(beatId, number)`.
- `updateTakeCore(input: { takeId: string; status?: TakeStatus; note?: string | null }): Promise<void>` — patch partiel (absent = no-op, null = vider `note`).
- `deleteTakeCore(input: { takeId: string }): Promise<void>` — supprime ; si la prise était `selectedTakeId` du beat, remet `selectedTakeId` à null (même transaction).
- `selectTakeCore(input: { beatId: string; takeId: string | null }): Promise<void>` — `takeId` non nul : vérifier `take.beatId === beatId` (sinon `RefusalError`) puis `script_beats.selectedTakeId = takeId` ; `null` : effacer.
- `readTournageCore(variantId: string): Promise<{ variantId: string; projectId: string; status: string; beats: TournageBeat[] } | null>` où `TournageBeat = { id, position, kind, kindLabel, spokenText, directionNote, selectedTakeId, takes: TakeRow[] }` et `TakeRow = { id, number, status, note, startedAt }`. Beats ordonnés par `position`, prises par `number`.

`TakeStatus = "bonne" | "mauvaise" | "a_revoir"` (union exportée, ou `INSERT`… non ;
exporter `TAKE_STATUSES`/`TakeStatus` depuis `lib/video/schema.ts` sur le modèle
`INSERT_KINDS`).

## 3. Transitions de statut — cœur dans `persist.ts` + actions

Premier chemin d'écriture du statut. `setProjectStatusCore(input: { projectId: string; to: VideoProjectStatus }): Promise<void>` — vérifie que `(from → to)` est dans la table de
transitions autorisées, sinon `RefusalError("Transition de statut non autorisée.")`.
Transitions : `en_ecriture → pret_a_tourner`, `pret_a_tourner → tourne`, `tourne →
en_montage`. Pure `estTransitionAutorisee(from, to): boolean` (extraite pour test).

Actions (`lib/actions/video-actions.ts`, garde `video:manage`) :
- `markReadyToShoot(projectId)` → `pret_a_tourner`.
- `startShooting(projectId)` → `tourne`.
- `finishShooting(projectId)` → `en_montage`.

## 4. Onglet Tournage — `components/video/tournage-view.tsx`

5ᵉ onglet `?tab=tournage` sur `app/(app)/video/[id]/page.tsx`. Client, responsive, grandes
cibles tactiles, en ligne. Consomme `readTournageCore(activeVariant.id)`.

- **En-tête de statut** : le statut courant + le bon bouton de transition — « Marquer prêt à
  tourner » (si `en_ecriture`), « Démarrer le tournage » (si `pret_a_tourner`), « Tournage
  terminé » (si `tourne`). Un seul bouton pertinent à la fois.
- **Mode Journal** (défaut) : beats ordonnés ; par beat — le texte parlé, la note de
  réalisation en repère, la liste des prises (numéro, badge de statut, ★ si retenue, note),
  et **trois gros boutons** Bonne / Mauvaise / À revoir (chacun ajoute une prise avec ce
  statut en un tap) ; par prise — désigner retenue (★, `selectTake`), éditer la note,
  supprimer.
- **Mode Prompteur** (bascule) : grand texte parlé lisible, un beat à la fois avec
  navigation précédent/suivant, boutons de log rapides toujours accessibles (quelqu'un
  logue pendant que le présentateur lit). **Pas d'auto-défilement** (reporté).

Libellés de statut de prise : `bonne → « Bonne »`, `mauvaise → « Mauvaise »`, `a_revoir →
« À revoir »` (nouvelle map `TAKE_STATUS_LABEL` dans `lib/video/labels.ts`).

## 5. Actions & câblage de lecture

Server actions de prises dans `lib/actions/video-actions.ts` (ou un nouveau
`lib/actions/takes-actions.ts`) : `addTake`, `updateTake`, `deleteTake`, `selectTake` —
toutes `guard()` (`video:manage`) + `refusable()` + `revalidateVideo()`. Les transitions
`markReadyToShoot`/`startShooting`/`finishShooting` idem.

La page charge `readTournageCore(activeVariant.id)` pour l'onglet Tournage.
`selectedTakeId` est **stocké mais non lu** par le conducteur SP2 (reporté).

## Sécurité & gestion des erreurs

- Toutes les actions débutent par `requireUser()` + `requirePermission(role, "video",
  "manage")`.
- `selectTakeCore` refuse une prise d'un autre beat (`RefusalError`).
- `setProjectStatusCore` refuse une transition non autorisée (`RefusalError`).
- Ordre de verrou `script_variants → script_beats → beat_takes` respecté ; ne pas rouvrir le
  cycle ABBA.
- `selectedTakeId` sans FK : la cohérence (prise retenue existante et appartenant au beat)
  est garantie par les cœurs, pas par la base.

## Tests

- **Purs** : `nextTakeNumber` (vide→1, gaps, max+1) ; `estTransitionAutorisee` (les trois
  autorisées vrai, le reste faux, ex. `tourne → publie` faux).
- **DB** : `addTakeCore` (numérotation auto + `unique`), `updateTakeCore` (patch),
  `deleteTakeCore` (efface `selectedTakeId` si retenue), `selectTakeCore` (refuse une prise
  d'un autre beat ; null efface), `setProjectStatusCore` (autorise/refuse), `readTournageCore`
  (beats+prises ordonnés).
- **UI** : `tournage-view` (rend beats, prises, trois boutons de log, bascule prompteur, le
  bon bouton de statut selon l'état).
- Nouveaux tests purs inscrits dans `PURE_FILES`. Tests DB : voie lente, UUID valides,
  nettoyage.

## Contraintes héritées

- `lib/video/takes-core.ts` importe `@/db` (exception documentée, pas de `"use server"`) ;
  le pur `nextTakeNumber`/`estTransitionAutorisee` reste sans `@/db`.
- Ordre de verrou étendu à `beat_takes` en dernier.
- Copie UI en français ; shadcn/ui + Tailwind v4 ; réutiliser `guard()`/`refusable()`/
  `RefusalError`/`revalidateVideo` et les libellés de beat.
- `selectedTakeId` référence logique (pas de FK), cohérence assurée par les cœurs.

Voir [[video-module-roadmap]] et [[execution-mode-subagent-driven]]. Amont : la table
`beat_takes` réservée par `2026-08-16-video-script-contrat-import-design.md` (SP1).
