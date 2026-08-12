# Planification conviviale — pipeline RSS + diffusion sociale

**Date :** 2026-08-12
**Statut :** validé
**Remplace :** `2026-08-08-afrotiative-schedule-builder-design.md` (jamais implémenté)

## Contexte

Le champ de planification du pipeline (`components/settings/pipeline-settings-form.tsx:196-205`)
attend toujours une expression cron brute (`0 */2 * * *` en espace réservé). Un administrateur non
technique ne peut donc pas dire simplement « toutes les 2 heures » ou « chaque jour à 08:00 ». Un
spec validé le 2026-08-08 décrivait déjà ce composant mais n'a jamais été implémenté ; ce document
le reprend, corrige le fuseau et étend le périmètre à la diffusion sociale.

Le déclenchement et l'exécution en arrière-plan **existent déjà** et restent inchangés :
`instrumentation.ts` → `initScheduler()` → `reloadSchedule()` crée un job `croner` à partir de
`scheduleCron`, qui appelle `runPipeline({ triggeredBy: "scheduled" })` en processus, avec garde
anti-chevauchement (`lib/pipeline/overlap.ts` + index partiel « un seul run actif »). La partie 4
(vérification) confirme que cette chaîne se déclenche réellement de bout en bout avant la mise en
production cette semaine.

## Décisions (validées 2026-08-12)

1. **Presets + échappatoire cron avancé** — sélecteur de mode qui génère le cron, plus un mode
   « avancé » conservant la saisie brute.
2. **Fuseau : UTC (heure serveur).** Choix explicite. Les heures saisies (« 08:00 ») s'interprètent
   en UTC. Le libellé du champ affiche « UTC » de façon non ambiguë. *Cela diffère du spec
   2026-08-08 qui proposait `Europe/Paris` — la décision UTC d'aujourd'hui prime.*
3. **Vérification : live end-to-end + tests automatisés.**
4. **Périmètre : pipeline RSS + diffusion sociale.**

## Partie 1 — Module pur `lib/pipeline/schedule-expr.ts`

Pur, sans DB ni DOM. `croner` y sert uniquement d'analyseur (`{ paused: true }`), comme `isValidCron`
dans `lib/validation.ts:66`. Testable via `bun run test:pure` (aucune base requise).

```ts
export type ScheduleSpec =
  | { mode: "off" }
  | { mode: "everyNMinutes"; minutes: number }            // 15 | 30
  | { mode: "everyNHours"; hours: number }                // 1,2,3,4,6,8,12 ; déclenche à la minute 0
  | { mode: "daily"; time: string }                       // "HH:MM"
  | { mode: "weekdays"; days: number[]; time: string };   // days: 0=dimanche … 6=samedi

export const SCHEDULE_TZ = "UTC"; // déclaré ici, importé par scheduler.ts
```

Fonctions :
- `toCron(spec): string` — `""` pour `off` ; `"*/N * * * *"` ; `"0 */N * * *"` ; `"M H * * *"` ;
  `"M H * * 1,2,3"`.
- `fromCron(cron): ScheduleSpec | null` — reconnaît les formes ci-dessus ; `null` sinon.
- `nextRuns(cron, count, tz = SCHEDULE_TZ): Date[]` — via croner, instants strictement croissants.
- `describeSpec(spec): string` — résumé français (« Toutes les 2 heures », « Chaque jour à 08:00
  UTC », « Lun, Mer, Ven à 08:00 UTC »).

**Règle d'aller-retour (structurante) :** si `fromCron` renvoie `null`, le formulaire s'ouvre en
mode avancé avec la chaîne brute **intacte** — jamais réécrite silencieusement. Invariant testé :
`toCron(fromCron(c)) === c` pour tout `c` reconnu.

## Partie 2 — Composant `components/settings/schedule-field.tsx`

Client component autonome, contrôlé `value: string` / `onChange(cron: string)`. Il ne connaît que le
cron ; `PipelineSettingsForm` garde `scheduleCron` comme unique champ d'état et
`updatePipelineSettings` (`lib/actions/pipeline-settings-actions.ts:19`) est inchangé. **Aucune
migration** : la valeur stockée reste une expression cron `text`.

- À l'ouverture, `fromCron(value)` détermine le mode affiché ; le mode avancé (un `Collapsible`
  contenant le champ texte actuel) s'ouvre d'office quand `fromCron` a renvoyé `null`.
- Maquette du sélecteur :

  ```
  Planification (UTC)
  ─────────────────────────────────
  ( ) Désactivée
  ( ) Toutes les [ 15 ▾] minutes
  (●) Toutes les [ 2 ▾] heures
  ( ) Chaque jour à       [08:00]
  ( ) Les jours choisis à [08:00]
      [x]L [x]M [x]M [x]J [x]V [ ]S [ ]D
  Prochaines : aujourd'hui 14:00, 16:00, 18:00 (UTC)
  ▸ Mode avancé (cron)
  ```

- Aperçu : `nextRuns(toCron(spec), 3)` rendu via `formatDate` (`lib/format.ts`). En cas d'échec
  (expression invalide en cours de frappe côté avancé), l'aperçu affiche le message de validation,
  pas une liste vide. `croner` est une dépendance de prod déjà installée, utilisable en navigateur :
  l'aperçu se calcule côté client, sans aller-retour serveur.
- Un libellé « Les heures sont en UTC » accompagne le champ.

## Partie 3 — Fuseau explicite dans le scheduler

`lib/pipeline/scheduler.ts` importe `SCHEDULE_TZ` depuis `schedule-expr.ts` et le passe à
`new Cron(scheduleCron, { timezone: SCHEDULE_TZ, protect: true, catch: true }, …)`. Passer
`timezone: "UTC"` explicitement rend le déclenchement déterministe quel que soit le fuseau du
serveur (Railway est en UTC, mais l'explicite évite toute dérive). Le journal
`[scheduler] planification active:` mentionne le fuseau.

Garanties de `reloadSchedule` préservées : la fonction ne lève jamais (atteinte depuis
`instrumentation.register()`), et un cron invalide dégrade vers « aucune planification ».

## Partie 4 — Diffusion sociale : `IntervalPicker`

Le champ `autoIntervalHours` (`components/settings/social-channel-form.tsx:458-462`) est aujourd'hui
un `<Input>` numérique brut. On le remplace par un petit sélecteur `components/settings/interval-picker.tsx` :

- `value: number` / `onChange(hours: number)`.
- Options courantes : 1, 2, 3, 6, 12, 24 heures, plus « Personnalisé… » révélant un champ numérique
  (borne > 0, comme la validation actuelle `autoIntervalHours <= 0` l. 158).
- **Stockage inchangé** : entier `auto_interval_hours` ; la logique de diffusion
  (`lib/diffusion/scheduler.ts`, `isDue` sur `lastAutoSendAt + autoIntervalHours`) n'est pas touchée.

Les fenêtres `autoWindowStartHour`/`autoWindowEndHour` restent des champs numériques (hors périmètre
de cet allègement).

## Partie 5 — Vérification (live + automatisée)

**Tests automatisés (purs, `bun run test:pure`, sans base) — `tests/schedule-expr.test.ts` :**
- `toCron` pour les cinq modes, dont la liste de jours (`"0 8 * * 1,2,3,4,5"`) et les minutes
  (`"*/15 * * * *"`) ;
- `fromCron` reconnaît chaque forme produite par `toCron` ;
- aller-retour : `toCron(fromCron(c)) === c` pour tout cron reconnu ; `fromCron(toCron(spec))`
  équivalent à `spec` sur un échantillon ;
- `fromCron` renvoie `null` (sans lever) sur non représentable (`"0 8 1 * *"`, `"*/7 * * * *"`) et
  sur chaîne invalide ;
- `nextRuns` strictement croissant ; un `"0 8 * * *"` tombe à 08:00 UTC (date de référence fixée) ;
- toute sortie non vide de `toCron` satisfait `pipelineSettingsSchema` (`lib/validation.ts:100`).

**Tests scheduler (étendus) — `tests/pipeline-scheduler.test.ts` :** `reloadSchedule` construit le
job avec `timezone: "UTC"` ; un cron invalide laisse le job vide sans lever ; une planification vide
désactive.

**Live end-to-end (manuel, avant go-live) :**
1. `next dev` — confirmer dans les logs que `instrumentation.ts` boot le scheduler
   (`[scheduler] …`).
2. Enregistrer une planification courte (ex. « toutes les 15 minutes », ou un cron d'une minute via
   le mode avancé) avec au moins un `feed` `active = true` de test.
3. Confirmer qu'un `pipelineRun` avec `triggeredBy = "scheduled"` se crée, que `parseFeed` récupère
   des articles, et que le run se termine en arrière-plan (statut `success`/`partial`).
4. Modifier la planification et confirmer que `reloadSchedule()` reconstruit le job **sans
   redémarrage** (le champ de settings recharge le job en direct).
5. Vérifier la garde anti-chevauchement : un second déclenchement pendant qu'un run tourne est
   ignoré (log « run déjà actif »).

## Fichiers

| Fichier | Action |
|---|---|
| `lib/pipeline/schedule-expr.ts` | nouveau (module pur) |
| `components/settings/schedule-field.tsx` | nouveau (client component) |
| `components/settings/pipeline-settings-form.tsx` | la carte « Planification » utilise `ScheduleField` |
| `lib/pipeline/scheduler.ts` | importe `SCHEDULE_TZ`, passe `timezone`, journal enrichi |
| `components/settings/interval-picker.tsx` | nouveau (diffusion sociale) |
| `components/settings/social-channel-form.tsx` | `autoIntervalHours` utilise `IntervalPicker` |
| `tests/schedule-expr.test.ts` | nouveau (pur) |
| `tests/pipeline-scheduler.test.ts` | étendu |

## Hors périmètre

- Fuseau configurable par l'utilisateur (décision : UTC fixe).
- Plusieurs créneaux fixes par jour (couvert par « Toutes les N heures/minutes »).
- Planification distincte pour `publishDueArticles` (endpoint `/api/publish/due` inchangé).
- Refonte des fenêtres horaires de diffusion (`autoWindowStart/EndHour`).
