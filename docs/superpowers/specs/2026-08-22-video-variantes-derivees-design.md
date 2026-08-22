# Variantes dérivées & cadrages 16:9 / 9:16 (sous-projet 6) — design

Dernier sous-projet du module Vidéo. Permet de **dériver une variante** d'un script (ex. un
Short 9:16 à partir du YouTube long 16:9) par **copie profonde indépendante**, de gérer les
variantes (dériver / supprimer une dérivée), et d'afficher un **guide de zone sûre** selon le
ratio. SP1 avait réservé `script_variants.derivedFromId` (uuid nu), `aspectRatio` (16:9 /
9:16 / 1:1) et `framing` (jsonb, non utilisé ici) ; tous les lecteurs (conducteur, tournage,
exports) sont déjà scopés par variante et la page bascule déjà sur `activeVariant`.

## Objectif et périmètre

- **But** : dériver une variante (plateforme + ratio + durée cible) en copiant les beats et
  inserts de la source, la gérer (basculer, supprimer une dérivée), et lire un repère visuel
  de cadrage selon le ratio.
- **Hors périmètre** : recadrage réel / données de cadrage par beat (`framing` reste non
  utilisé — guide visuel seulement) ; copie de l'état de tournage (prises) ou de montage ;
  synchronisation live entre source et dérivée (la dérivée est indépendante) ; IA.

## Décisions verrouillées (ne pas rouvrir)

1. **Dériver = copie profonde indépendante** : nouveaux beats/inserts (nouveaux ids) ; éditer
   la dérivée n'affecte pas la source.
2. **Copié** : beats (colonnes de contenu + `externalId`, `framing`, `sources`, `speakerId`),
   liens Q/R (`answersBeatId` **remappé** vers les beats copiés), et les `beat_inserts`.
   **Exclu** : `beat_takes`, `selectedTakeId`, `montageCheckedAt`, `importedSnapshot`,
   `locallyEditedAt`, journal.
3. **`externalId` conservé** à la copie (clé de fusion d'import ; l'unicité est par variante).
4. **Cadrage = guide visuel** piloté par `aspectRatio` (16:9 / 9:16 / 1:1). Pas de données par
   beat ; `framing` inchangé.
5. **Suppression = variantes dérivées uniquement** : la variante d'origine (`derivedFromId`
   nul) est protégée ; un projet garde toujours ≥1 variante.
6. **`derivedFromId` reste un uuid logique** (pas de FK) ; supprimer une variante dont une
   autre dérive laisse une référence pendouillante inoffensive (les lectures tolèrent).
7. **Aucune migration** ; un seul spec/plan.

## 1. Cœur de dérivation — nouveau `lib/video/variants-persist.ts`

Module sans `"use server"`, importe `@/db`, réutilise `RefusalError` de `@/lib/video/persist`.
`deriveVariantCore(input: { sourceVariantId: string; platform: string; aspectRatio: string; targetDurationSec: number | null }): Promise<{ variantId: string }>` — une transaction, **ordre de verrou** `script_variants` d'abord :

1. Verrouiller la source `FOR UPDATE` ; lire `projectId`. Refus si introuvable.
2. Position : `max(position) + 1` parmi les variantes du projet (motif `prepareImportCore`).
3. Insérer la nouvelle variante `{ projectId, platform, aspectRatio, targetDurationSec, position, derivedFromId: sourceVariantId }`.
4. Charger les beats de la source (ordonnés par `position`) + leurs `beat_inserts`.
5. Insérer les beats copiés (nouveaux ids), en construisant une **map old→new**. Copier :
   `externalId, position, kind, spokenText, directionNote, screenText, transitionIn,
   transitionOut, estimatedDurationSec, durationOverrideSec, framing, speakerId, sources`.
   Laisser `answersBeatId` nul à ce stade ; NE PAS copier `selectedTakeId`, `montageCheckedAt`,
   `importedSnapshot`, `locallyEditedAt`.
6. Deuxième passe : pour chaque beat source ayant `answersBeatId`, poser sur le beat copié
   `answersBeatId = map[source.answersBeatId]` (les liens Q/R pointent les beats copiés).
7. Pour chaque beat copié, insérer ses `beat_inserts` depuis les inserts de la source
   (nouveaux ids) : `kind, url, r2Key, tcIn, tcOut, displayDurationSec, credit, rightsNote,
   linkStatus, linkCheckedAt, position`.
8. Renvoyer `{ variantId }`.

La source n'est pas mutée (la dérivation lit) ; son `updatedAt` ne change pas.

## 2. Suppression d'une variante dérivée — `deleteVariantCore`

`deleteVariantCore(input: { variantId: string }): Promise<void>` :
- Charger la variante ; si `derivedFromId` est nul → `RefusalError("La variante d'origine ne
  peut pas être supprimée.")`.
- Sinon verrouiller `FOR UPDATE` puis supprimer (cascade → beats/inserts/takes). Une
  `derivedFromId` d'une autre variante pointant celle-ci devient pendouillante (uuid logique,
  toléré).

## 3. Actions & schémas

`lib/validation.ts` : `deriveVariantSchema` (`sourceVariantId` uuid, `platform` z.enum(PLATFORMS
inlined), `aspectRatio` z.enum(["16:9","9:16","1:1"]), `targetDurationSec` int min 5 max 14400
nullable) ; `variantIdSchema` (`variantId` uuid).

`lib/actions/video-actions.ts` (garde `video:manage`, `refusable`, `revalidateVideo`) :
- `deriveVariant(input): Promise<{ ok: true; variantId: string } | { ok: false; message }>`.
- `deleteVariant(input): Promise<{ ok: true } | { ok: false; message }>`.

## 4. UI de gestion des variantes

`components/video/variant-manager.tsx` (`"use client"`), monté dans l'onglet Écriture à la
place du bloc de badges `variants.length > 1` actuel :
- Liste des variantes en badges : `PLATFORM_LABEL` + ratio, marqueur « dérivée » si
  `derivedFromId` non nul, la variante active mise en avant, lien `?tab=ecriture&variant=<id>`.
- Bouton **« Dériver une variante »** → dialog (select plateforme, select ratio
  16:9/9:16/1:1, durée cible) → `deriveVariant({ sourceVariantId: activeVariant.id, … })` →
  naviguer vers `?variant=<nouveau>` (via `router.push`) + toast.
- Sur chaque variante **dérivée** : bouton **Supprimer** (`ConfirmDialog` destructif) →
  `deleteVariant`. Pas de bouton sur l'origine.

La page fournit `project.variants` (déjà toutes chargées par `getVideoProject`) et
`activeVariant`. Aucun autre onglet ne change (tout est déjà scopé `activeVariant`).

## 5. Guide de zone sûre (cadrage)

`components/video/aspect-ratio-guide.tsx` (pur) : un petit schéma SVG du cadre selon le ratio
(`16:9` paysage / `9:16` portrait / `1:1` carré) avec la **zone sûre** esquissée, + une note
courte (ex. « Gardez l'action dans la zone centrale pour le 9:16 »). Piloté par une prop
`ratio`. Purement informatif — pas de données, pas d'outil de recadrage.
- Affiché près de l'en-tête de variante dans l'onglet Écriture, et dans le prompteur
  (`tournage-view.tsx` reçoit déjà le ratio via… la page — lui passer `aspectRatio` de la
  variante active si absent).

## Sécurité & gestion des erreurs

- Toutes les actions débutent par `requireUser()` + `requirePermission(role, "video", "manage")`.
- `deriveVariantCore` : refus si source introuvable ; toute la copie en une transaction
  (atomique — pas de variante à moitié copiée).
- `deleteVariantCore` : refus de supprimer l'origine ; cascade DB pour les enfants.
- Ordre de verrou `script_variants` d'abord respecté dans les deux cœurs.
- `derivedFromId`/`answersBeatId` références logiques ; cohérence assurée par le cœur à la
  copie ; pendouillage toléré en lecture.

## Tests

- **DB** : `deriveVariantCore` — beats + inserts copiés avec de nouveaux ids ; `answersBeatId`
  remappé vers le beat copié (pas vers la source) ; `speakerId` préservé ; `beat_takes` /
  `montageCheckedAt` / `selectedTakeId` NON copiés ; `derivedFromId` = source ; position =
  suivante ; source inchangée. `deleteVariantCore` — refuse l'origine (`derivedFromId` nul),
  supprime une dérivée + cascade.
- **UI (purs)** : `variant-manager` (badges, marqueur dérivée, bouton Dériver, Supprimer
  seulement sur une dérivée) ; `aspect-ratio-guide` (rend le bon cadre pour 16:9 / 9:16 / 1:1).
- Nouveaux tests purs inscrits dans `PURE_FILES`. Tests DB : voie lente, UUID valides,
  nettoyage.

## Contraintes héritées

- `lib/video/variants-persist.ts` importe `@/db` (exception documentée, pas de `"use server"`).
- Ordre de verrou `script_variants → script_beats → beat_inserts` respecté.
- Copie profonde : nouveaux ids partout, `answersBeatId` remappé ; NE PAS copier l'état de
  tournage/montage.
- Copie UI en français ; shadcn/ui + Tailwind v4 ; réutiliser `guard()`/`refusable()`/
  `revalidateVideo`, les motifs `speakers-manager`/`category-manager` (CRUD), `PLATFORM_LABEL`.
- Toutes les server actions sont des `export async function` (leçon SP4 : pas de const
  fléchée dans un module `"use server"`).

Voir [[video-module-roadmap]] et [[execution-mode-subagent-driven]]. Amont : `derivedFromId` /
`framing` réservés par `2026-08-16-video-script-contrat-import-design.md` (SP1). **Dernier des
8 sous-projets du module Vidéo.**
