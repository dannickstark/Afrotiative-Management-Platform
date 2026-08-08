# Réglages — planification sans syntaxe cron

**Date :** 2026-08-08
**Sous-projet :** C (indépendant — aucun prérequis)
**Statut :** validé

## Problème

`components/settings/pipeline-settings-form.tsx:196-205` expose un champ texte brut attendant une
expression cron, avec `0 */2 * * *` en simple espace réservé. Planifier le pipeline suppose donc de
connaître la syntaxe cron. En prime, l'expression est interprétée dans le fuseau du serveur —
UTC sur Railway — si bien que « 8 h » n'est pas 8 h à Paris.

## Principe

Un sélecteur de mode qui **génère** le cron, une expression brute conservée derrière un mode
avancé, et un aperçu des prochaines exécutions toujours visible.

```
Planification
─────────────────────────────────
( ) Désactivée
(●) Toutes les  [ 2 ▾] heures
( ) Chaque jour à        [08:00]
( ) Les jours choisis à  [08:00]
    [x]L [x]M [x]M [x]J [x]V [ ]S [ ]D

Prochaines : aujourd'hui 14:00, 16:00, 18:00
▸ Mode avancé (cron)
```

## Module — `lib/pipeline/schedule-expr.ts`

Pur, sans DB ni DOM. `croner` y est utilisé uniquement comme analyseur (`paused: true`), exactement
comme `isValidCron` dans `lib/validation.ts:66`.

```ts
export type ScheduleSpec =
  | { mode: "off" }
  | { mode: "everyNHours"; hours: number; minute: number }
  | { mode: "daily"; time: string }              // "HH:MM"
  | { mode: "weekdays"; days: number[]; time: string }; // days: 0=dimanche … 6=samedi
```

- `toCron(spec): string` — `""` pour `off`, `"M */N * * *"`, `"M H * * *"`, `"M H * * 1,2,3"`.
- `fromCron(cron): ScheduleSpec | null` — reconnaissance des trois formes ci-dessus.
- `nextRuns(cron, count, tz = SCHEDULE_TZ): Date[]` — via croner.
- `describeSpec(spec): string` — phrase française pour le résumé.
- `SCHEDULE_TZ = "Europe/Paris"` — **déclaré ici**, dans le module pur, et importé par
  `scheduler.ts`. Le sens inverse créerait une dépendance du module pur vers un module à effets
  (croner actif, imports dynamiques de `./run` et `./overlap`), non chargeable en test unitaire.

**Règle d'aller-retour, structurante :** `fromCron` renvoyant `null`, le formulaire s'ouvre en mode
avancé avec la chaîne brute intacte. Une expression écrite à la main n'est **jamais** réécrite
silencieusement en un mode approchant. `toCron(fromCron(c)) === c` doit tenir pour toute expression
que `fromCron` reconnaît — c'est la propriété que les tests vérifient.

## Fuseau horaire

`scheduler.ts` importe `SCHEDULE_TZ` depuis `schedule-expr.ts` et le passe à
`new Cron(scheduleCron, { timezone: SCHEDULE_TZ, protect: true, catch: true })` (l. 62). Le journal
`[scheduler] planification active:` mentionne le fuseau.

⚠️ **Changement de comportement sur les planifications existantes.** Un `0 8 * * *` déjà enregistré
se déclenche aujourd'hui à 08:00 UTC, soit 09:00 ou 10:00 à Paris selon la saison ; après ce
sous-projet il se déclenchera à 08:00 à Paris. Le décalage est intentionnel et prend effet au
prochain `reloadSchedule()` — c'est-à-dire au redémarrage ou à la première sauvegarde des réglages.
Le libellé du champ indique « heure de Paris » pour que ce ne soit jamais une surprise.

Les garanties existantes de `reloadSchedule` sont préservées : la fonction ne lève jamais (elle est
atteinte depuis `instrumentation.register()`, où un rejet ferait sortir le processus), et un cron
invalide dégrade vers « aucune planification ».

## Composant — `components/settings/schedule-field.tsx`

Client component autonome, contrôlé par `value: string` / `onChange(cron: string)`. Il ne connaît
que le cron : `PipelineSettingsForm` conserve `scheduleCron` comme unique champ d'état et
`updatePipelineSettings` est inchangé. Aucune migration : la forme stockée reste une expression
cron.

À l'ouverture, `fromCron(value)` détermine le mode affiché. Le mode avancé est un `Collapsible`
contenant le champ texte actuel ; il s'ouvre d'office quand `fromCron` a renvoyé `null`.

L'aperçu appelle `nextRuns(toCron(spec), 3)` et rend les dates via `formatDate` (`lib/format.ts`).
Si le calcul échoue — expression invalide en cours de frappe dans le mode avancé — l'aperçu affiche
le message d'erreur de validation plutôt qu'une liste vide.

`croner` est une dépendance de production déjà installée et utilisable dans le navigateur ; le
calcul de l'aperçu se fait donc côté client, sans aller-retour serveur.

## Validation

`pipelineSettingsSchema.scheduleCron` (`lib/validation.ts:100`) est déjà adossé à croner : toute
valeur produite par `toCron` passe par construction, et le mode avancé reste couvert. Aucun
changement de schéma.

## Fichiers

| Fichier | Action |
|---|---|
| `lib/pipeline/schedule-expr.ts` | nouveau |
| `components/settings/schedule-field.tsx` | nouveau |
| `components/settings/pipeline-settings-form.tsx` | la carte « Planification » utilise `ScheduleField` |
| `lib/pipeline/scheduler.ts` | `SCHEDULE_TZ`, option `timezone`, journal enrichi |

## Tests

`tests/schedule-expr.test.ts` — pur :

- `toCron` pour les quatre modes, dont la liste de jours (`"0 8 * * 1,2,3,4,5"`) ;
- `fromCron` reconnaît chaque forme produite par `toCron` ;
- **aller-retour** : pour un échantillon de specs, `fromCron(toCron(spec))` est équivalent à
  `spec` ; pour tout cron reconnu, `toCron(fromCron(c)) === c` ;
- `fromCron` renvoie `null` sur une expression non représentable (`"0 8 1 * *"`, `"*/7 * * * *"`)
  et sur une chaîne invalide, sans lever ;
- `nextRuns` produit des instants strictement croissants ; un `0 8 * * *` tombe à 08:00 heure de
  Paris en heure d'hiver **comme** en heure d'été (le test fixe la date de référence) ;
- toute sortie de `toCron` non vide satisfait `pipelineSettingsSchema`.

`tests/pipeline-scheduler.test.ts` (étendu) — `reloadSchedule` construit le job avec
`timezone: "Europe/Paris"` ; un cron invalide laisse le job vide sans lever ; une planification vide
désactive.

## Hors périmètre

Plusieurs créneaux fixes par jour (écarté au profit du mode « Toutes les N heures »), fuseau
configurable par l'utilisateur, planification distincte pour `publishDueArticles`.
