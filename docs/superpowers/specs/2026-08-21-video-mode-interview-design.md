# Mode interview (sous-projet 5) — design

Ouvre les trois surfaces réservées par SP1 pour les vidéos d'interview : gérer les
**intervenants**, **assigner un locuteur** à chaque beat et **rattacher une réponse à sa
question**, et **suivre le consentement** avec un verrou dur avant la mise en montage. Tout
en application (le contrat d'import n'est pas touché). SP1 avait réservé la table
`interview_speakers`, `script_beats.speakerId` (FK) et `answersBeatId` (auto-référence
logique), et les kinds `question`/`reponse` ; rien n'a été écrit depuis.

## Objectif et périmètre

- **But** : sur un projet d'interview, l'équipe crée les intervenants (nom, rôle, consentement),
  assigne un locuteur par beat, lie chaque beat `reponse` à un beat `question` de la même
  variante, et ne peut pas passer en montage tant qu'un intervenant n'a pas consenti.
- **Hors périmètre** : **extension du contrat JSON / import / MCP** (les intervenants et le
  mapping Q/R se font en app ; le contrat continue de ne porter que `type: question|reponse`) ;
  **rôle en liste fermée** (rôle = texte libre) ; toute IA ; intégration du locuteur au
  tournage (SP4 inchangé — le conducteur SP2 affiche déjà `speakerName`).

## Décisions verrouillées (ne pas rouvrir)

1. **Verrou de consentement dur** sur la transition `tourne → en_montage` : refus si un
   intervenant du projet a `consentGiven = false`. Les autres transitions ne sont pas
   affectées ; un projet sans intervenant n'est jamais bloqué.
2. **Tout en application** : pas de modification du contrat/import/MCP.
3. **Rôle = texte libre** (colonne `role` inchangée).
4. **Mapping Q/R strict** : `answersBeatId` n'est posable que sur un beat `reponse`, et cible
   un beat `question` de la **même variante** (validé dans le cœur, sinon `RefusalError`).
5. **Suppression d'intervenant = null-then-delete** : dénoue automatiquement les beats qui le
   référencent (`speakerId → null`) puis supprime, dans une transaction verrouillant d'abord
   les variantes du projet (par id) pour respecter l'ordre de verrou.
6. **Un seul spec/plan.** **Aucune migration** (toutes les colonnes existent).

## 1. Intervenants — nouveau `lib/video/speakers-core.ts`

Module sans `"use server"`, importe `@/db`, réutilise `RefusalError` de `@/lib/video/persist`.
Les intervenants sont **par projet** (pas sous une variante) ; leur CRUD ne touche pas les
beats, SAUF la suppression.

- `createSpeakerCore(input: { projectId: string; name: string; role: string | null }): Promise<{ id: string }>` — insère (`consentGiven` défaut false via la colonne).
- `updateSpeakerCore(input: { speakerId: string; name?: string; role?: string | null; consentGiven?: boolean; consentNote?: string | null }): Promise<void>` — patch partiel (absent = no-op ; null = vider `role`/`consentNote`). Refus si intervenant introuvable.
- `deleteSpeakerCore(input: { speakerId: string }): Promise<void>` — dans une transaction : charge le `projectId` de l'intervenant ; verrouille les variantes du projet `FOR UPDATE` par ordre d'`id` ; met `script_beats.speakerId = null` là où il pointe cet intervenant ; supprime la ligne. (La FK `speakerId` est `ON DELETE no action` : sans dénouement, la suppression échouerait.)
- `listSpeakersCore(projectId: string): Promise<SpeakerRow[]>` où `SpeakerRow = { id, name, role, consentGiven, consentNote, createdAt }`, ordonné par `createdAt`.

## 2. Assignation locuteur + mapping Q/R — extension de `updateBeatCore`

Étendre `updateBeatSchema` (`lib/validation.ts`) et `updateBeatCore` (`lib/video/persist.ts`)
avec deux champs optionnels : `speakerId?: string | null` (uuid ou null), `answersBeatId?:
string | null` (uuid ou null). Conserver l'ordre de verrou **variante puis beat**, et le patch
partiel (absent = no-op, null = dénouer).

Validation dans le cœur (après verrou de la variante, re-lecture du beat) :
- `speakerId` non nul : l'intervenant doit appartenir au **projet du beat** (jointure
  beat → variant → project ; `interview_speakers.projectId === project`), sinon `RefusalError`.
- `answersBeatId` non nul : le beat édité doit être `kind = reponse` ; le beat cible doit
  exister, être `kind = question` et de la **même variante** que le beat édité, sinon
  `RefusalError`. (Auto-référence : `answersBeatId` ne peut pas pointer le beat lui-même.)

L'action `updateBeat` existante passe déjà `parsed.data` élargi au cœur — pas d'action
nouvelle pour l'assignation.

## 3. Verrou de consentement — dans `setProjectStatusCore`

`setProjectStatusCore` (`lib/video/persist.ts`, SP4) gagne une garde : quand `to ===
"en_montage"`, si le projet a au moins un `interview_speakers` avec `consentGiven = false`,
lever `RefusalError("Consentement manquant : un intervenant n'a pas donné son consentement.")`.
La vérification se fait dans la même transaction (après le verrou de la ligne projet), avant
l'écriture du statut. Les transitions `→ pret_a_tourner`/`→ tourne` ne sont pas affectées.

## 4. UI

### Onglet Intervenants (6ᵉ)
Nouvel onglet `?tab=intervenants` sur `app/(app)/video/[id]/page.tsx`. Composant
`components/video/speakers-manager.tsx` (`"use client"`), motif de `category-manager.tsx` :
- Liste des intervenants (nom, rôle, badge de consentement, note).
- Formulaire d'ajout (nom + rôle) → `createSpeaker`.
- Par intervenant : éditer nom/rôle, **basculer le consentement** (`updateSpeaker` avec
  `consentGiven`), éditer la note de consentement, supprimer (`ConfirmDialog` destructif).
- **Avertissement** : si des intervenants n'ont pas consenti, un bandeau visible « N
  intervenant(s) sans consentement — la mise en montage sera bloquée. » (en plus du verrou
  dur au tournage).

### beat-inspector
`components/video/beat-inspector.tsx` gagne :
- un `<select>` **Locuteur** (les intervenants du projet + « Aucun ») → `updateBeat({ beatId,
  speakerId })`.
- pour un beat `kind = reponse`, un `<select>` **Répond à** listant les beats `question` de la
  variante (numéro/position + extrait) + « Aucune » → `updateBeat({ beatId, answersBeatId })`.

La page charge `listSpeakersCore(project.id)` (pour l'onglet et le select locuteur) et fournit
à l'inspecteur les beats `question` de la variante active (déjà disponibles dans `beats`).

## 5. Actions & câblage

Server actions dans `lib/actions/video-actions.ts` (garde `video:manage`, `refusable`,
`revalidateVideo`) : `createSpeaker`, `updateSpeaker`, `deleteSpeaker`. L'assignation
locuteur/Q-R passe par `updateBeat` (élargi). Le verrou de consentement est déjà porté par
`finishShooting` → `setProjectStatusCore` (SP4), qui renvoie le refus ; le bouton « Tournage
terminé » affiche le toast.

Nouveaux schémas Zod dans `lib/validation.ts` : `createSpeakerSchema`, `updateSpeakerSchema` ;
extension d'`updateBeatSchema` (speakerId uuid nullable optionnel, answersBeatId uuid nullable
optionnel).

## Modèle de données

**Aucune migration.** Colonnes déjà présentes : `interview_speakers` (name, role,
consentGiven, consentNote), `scriptBeats.speakerId` (FK), `scriptBeats.answersBeatId` (uuid
logique). Aucune valeur d'enum ajoutée.

## Sécurité & gestion des erreurs

- Toutes les actions débutent par `requireUser()` + `requirePermission(role, "video", "manage")`.
- `updateBeatCore` refuse un `speakerId` d'un autre projet et un `answersBeatId` qui n'est pas
  `reponse → question` de la même variante (ou l'auto-référence).
- `setProjectStatusCore` refuse `→ en_montage` sans consentement complet.
- Ordre de verrou respecté ; `deleteSpeakerCore` verrouille les variantes du projet (par id)
  avant de dénouer les beats.
- `answersBeatId` reste une référence logique (pas de FK) ; la cohérence (cible existante,
  bon kind, même variante) est assurée par le cœur au moment de l'écriture. Un beat
  `question` supprimé peut laisser un `answersBeatId` pendouillant — la lecture (conducteur,
  inspecteur) doit tolérer une cible absente (afficher « question supprimée » ou rien).

## Tests

- **DB** : speakers CRUD (create/update/delete-dénoue-les-beats/list) ; `updateBeatCore` avec
  `speakerId` (refuse un intervenant d'un autre projet) et `answersBeatId` (refuse source
  non-`reponse`, cible non-`question`, cross-variante, auto-référence ; accepte le cas
  valide) ; `setProjectStatusCore` → `en_montage` bloqué avec un intervenant non consenti,
  autorisé une fois consenti / sans intervenant.
- **UI (purs)** : `speakers-manager` (liste, badge consentement, bandeau d'avertissement,
  bouton supprimer) ; beat-inspector rend le select locuteur et, pour un `reponse`, le select
  « Répond à ».
- Nouveaux tests purs inscrits dans `PURE_FILES`. Tests DB : voie lente, UUID valides,
  nettoyage.

## Contraintes héritées

- `lib/video/speakers-core.ts` importe `@/db` (exception documentée, pas de `"use server"`) ;
  réutilise `RefusalError`.
- Ordre de verrou `script_variants → script_beats` pour toute écriture de beat ; suppression
  d'intervenant verrouille les variantes du projet d'abord.
- Copie UI en français ; shadcn/ui + Tailwind v4 ; réutiliser `guard()`/`refusable()`/
  `revalidateVideo`, le motif `category-manager.tsx`, et les libellés de beat.
- Le conducteur (SP2) affiche déjà `speakerName` ; il se peuplera une fois les locuteurs
  assignés — aucune modif SP2.

Voir [[video-module-roadmap]] et [[execution-mode-subagent-driven]]. Amont : `interview_speakers`
et §10 (« intervenants, mapping question/réponse, consentement (SP5) ») de
`2026-08-16-video-script-contrat-import-design.md` (SP1).
