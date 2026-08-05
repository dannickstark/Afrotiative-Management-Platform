# Afrotiative Media — Paramètres de déclenchement d'une exécution

**Date :** 2026-08-06
**Statut :** Design validé — prêt pour le plan d'implémentation
**Branche :** `feat/run-trigger-parameters` (sur `main`, post-pipeline-v2)
**Portée :** Enrichir le **déclenchement** d'une exécution du pipeline avec des paramètres saisis au lancement, dont les **valeurs par défaut sont configurables dans les réglages**.

Documents sources : spec du panneau d'exécution en direct (`2026-08-05-afrotiative-live-run-panel-design.md`), feuille de route pipeline (`2026-08-05-afrotiative-pipeline-program-roadmap.md`).

---

## 1. Objectif

Aujourd'hui, lancer une exécution manuelle depuis `/runs` est un **bouton à un clic sans aucun paramètre** : `startPipelineRun()` ouvre une exécution puis détache `executeRun` sur **tous les flux actifs**, avec le plafond `maxItemsPerRun` global et **aucun filtre de date**. Un rédacteur ne peut ni cibler quelques flux, ni éviter de retraiter des articles trop anciens, ni limiter le volume d'une exécution ponctuelle.

Objectif : permettre à l'utilisateur de **régler quelques paramètres avant de lancer une exécution**, chaque paramètre ayant une **valeur par défaut configurable dans `/settings/pipeline`**. Les exécutions planifiées (cron) héritent simplement de ces défauts.

**Principe préservé :** la barrière de revue humaine reste intacte — une exécution ne fait que déposer des articles `pending`. Aucun des paramètres retenus ne touche à cette barrière.

---

## 2. Décisions validées (brainstorming)

| Décision | Choix retenu |
|---|---|
| **Paramètres retenus** | (1) **Coupure de récence** (ne pas traiter les articles trop anciens), (2) **sélection des flux/sources**, (3) **nombre max de nouveaux éléments** pour cette exécution. |
| **Paramètres écartés** (YAGNI) | Bascule « recherche web » par exécution ; override « publication automatique » par exécution ; mode **prévisualisation** (dry-run). Non retenus pour cette itération. |
| **Forme de la coupure de récence** | **Les deux** : une valeur **relative** (« derniers N h ») sert de **défaut dans les réglages** ; au déclenchement, l'utilisateur peut choisir une valeur relative **ou** une date/heure **absolue** (« depuis le … »). |
| **Éléments sans date de publication fiable** | **Inclus** par la coupure. Beaucoup de flux RSS omettent/malforment `pubDate` ; la coupure n'exclut que les éléments qu'on peut **prouver** trop anciens. Favorise le rappel (ne pas rater une vraie actualité). |
| **Application du plafond `maxItems`** | **Après tout le filtrage** (récence + déjà-traités), jamais pendant la collecte. S'il reste plus de `maxItems` candidats, on **narrow** en gardant les **plus récents** (top-X). Les éléments **sans date** rangent comme **les plus anciens** (écartés en premier lors du narrowing). Corrige le plafond « compteur courant » actuel, qui écarte selon l'ordre de lecture des flux plutôt que par récence. |
| **Persistance des paramètres** | Résolus au déclenchement puis **stockés en `jsonb` sur la ligne `pipeline_runs`** ; `executeRun` les **lit depuis la ligne**. Source unique de vérité, survit à pause/reprise, visible dans l'historique. |
| **Exécutions planifiées** | Héritent des **défauts des réglages** (tous les flux actifs, max par défaut, récence par défaut). ⚠️ Conséquence assumée : une fois un défaut de récence défini, **les exécutions planifiées filtrent aussi** les éléments trop anciens. |
| **Défaut de récence à la livraison** | **`NULL` = aucune limite** (opt-in). Rétrocompatible : le comportement actuel (aucun filtre de date) est préservé tant qu'un admin ne définit pas de valeur. |
| **UX de déclenchement** | Le bouton unique devient une **boîte de dialogue « Configurer l'exécution »** pré-remplie avec les défauts. Pas de bouton « lancement rapide » séparé. |

---

## 3. Périmètre

**Inclus :**
- Nouvelle colonne de réglage `default_max_item_age_hours` (défaut de récence relatif, nullable).
- Nouvelle colonne `params` (`jsonb`) sur `pipeline_runs` enregistrant les paramètres réellement utilisés.
- Boîte de dialogue « Configurer l'exécution » (récence, flux, nombre max) pré-remplie depuis les réglages.
- Filtre de récence en phase 1 de `executeRun`, avec étape d'observabilité « éléments ignorés (trop anciens) ».
- Câblage de la sélection des flux (déjà supporté par `executeRun`) et du nombre max par exécution dans le déclencheur manuel.
- Schémas de validation (`runParamsSchema`, extension de `pipelineSettingsSchema`), extension du formulaire de réglages.
- Tests unitaires des helpers purs (filtre de récence, résolution des défauts, validation).

**Exclus :**
- Bascule recherche web / override publication auto par exécution.
- Mode prévisualisation (dry-run).
- Toute UI de paramètres pour les exécutions planifiées (elles utilisent les défauts, sans écran).
- Persistance de la date de publication (`isoDate`) dans `raw_items` : le filtre s'applique en mémoire sur le candidat en phase 1 (voir §6). Non requis pour cette itération.

---

## 4. Modèle de données

### 4.1 Réglages (`pipeline_settings`, singleton)

Une nouvelle colonne :

```
default_max_item_age_hours  integer  NULL   -- défaut de récence relatif (heures). NULL = aucune coupure.
```

- `max_items_per_run` (existant) reste le **défaut du champ « nombre max »** du déclencheur.
- La sélection des flux n'a **pas** de colonne : son défaut est « tous les flux actifs » (comportement actuel).

### 4.2 Exécutions (`pipeline_runs`)

Une nouvelle colonne `params jsonb` (nullable — `NULL` pour les exécutions historiques d'avant cette story) capturant ce que l'exécution a **réellement** utilisé :

```ts
// db/schema.ts — typage du jsonb (comme RunCheckpoint)
export type RunParams = {
  recency:
    | { kind: "age"; hours: number; cutoffAt: string }  // « derniers N h » → instant résolu à l'ouverture
    | { kind: "since"; cutoffAt: string }               // date/heure absolue (ISO)
    | { kind: "none" };                                  // aucune coupure
  feedIds: string[] | null;   // null = tous les flux actifs
  maxItems: number;           // résolu (override du déclencheur, sinon défaut réglages)
};
```

Enregistrer `cutoffAt` (l'**instant résolu**) rend le filtrage et l'affichage historique non ambigus : pour une récence relative, `cutoffAt = now − hours` calculé **à l'ouverture** de l'exécution (qui démarre immédiatement ensuite), donc chaque exécution planifiée calcule sa propre fenêtre.

---

## 5. UX de déclenchement

Le bouton « Lancer une exécution maintenant » (dans `IdleView`, `components/pipeline/live-run-panel.tsx`) devient **« Configurer l'exécution… »** et ouvre une **boîte de dialogue** (shadcn `Dialog`) **pré-remplie depuis les défauts des réglages** — « lancer avec les défauts » reste donc à ~deux clics.

Contenu de la dialogue (admins uniquement, `RoleGate` inchangé) :

- **Récence** — groupe radio :
  - `( ) Aucune limite`
  - `(•) Derniers [ 48 h ▾ ]` — sélecteur `6 h · 12 h · 24 h · 48 h · 72 h · 7 j`, pré-positionné sur le défaut réglages.
  - `( ) Depuis [ date ] [ heure ]` — saisie absolue.
  - (Le radio par défaut suit `default_max_item_age_hours` : « Aucune limite » si `NULL`, sinon « Derniers N h ».)
- **Flux** — liste à cocher des flux actifs, **tous cochés par défaut**, avec une bascule « Tous ».
- **Nombre max de nouveaux éléments** — champ numérique pré-rempli avec `max_items_per_run`.
- Action principale : **« Lancer l'exécution »**.

L'état « en cours » / « en pause » (`RunningView`) est inchangé.

---

## 6. Flux serveur

### 6.1 Action de déclenchement

`startPipelineRun` prend désormais un argument :

```ts
startPipelineRun(input: RunParamsInput): Promise<{ ok: true; runId: string } | { ok: false; message: string }>
```

1. RBAC (`pipeline`, `configure`) — inchangé.
2. **Valider** `input` via `runParamsSchema` (voir §8). Message français propre en cas d'échec.
3. **Résoudre les défauts** manquants depuis `getPipelineSettings()` (récence, nombre max).
4. Résoudre `cutoffAt` : `kind:"age"` → `now − hours` ; `kind:"since"` → l'instant saisi ; `kind:"none"` → pas de coupure.
5. Déterminer les **flux cibles** (sélection, ou tous les actifs) et `feedsTotal`.
6. `openRun({ triggeredBy:"manual", feedsTotal, params })` — **persiste `params`** sur la ligne.
7. `executeRun(runId)` détaché (inchangé pour le reste).

### 6.2 `openRun` / `executeRun`

- `openRun` gagne un paramètre `params?: RunParams` écrit dans l'`insert`.
- `executeRun` **lit `run.params` depuis la ligne** (comme il lit déjà la ligne pour la reprise) plutôt que via de nouveaux `opts`. Il en dérive : flux cibles, `cutoffAt` (la chaîne ISO de `params.recency.cutoffAt` est convertie en `Date` avant d'appeler `isWithinRecency`), `maxItems`. La reprise fonctionne sans effort (les params sont déjà sur la ligne ; la phase 1 est de toute façon sautée en reprise).
- **Rétrocompat `opts.feedIds`** : le paramètre `opts.feedIds` existant (utilisé par `runPipeline`) reste supporté. `run.params.feedIds`, quand présent, prime ; sinon on retombe sur `opts.feedIds`, sinon tous les flux actifs.

### 6.3 Exécutions planifiées

`runPipeline({ triggeredBy:"scheduled" })` résout les params **entièrement depuis les réglages** (tous les flux actifs, `maxItems` = défaut, récence = défaut) et les persiste via `openRun`. Conséquence assumée (§2) : la récence par défaut, une fois définie, s'applique aussi aux exécutions planifiées.

---

## 7. Câblage du pipeline (phase 1) — **filtrer d'abord, plafonner ensuite**

Principe (précisé au brainstorming) : le plafond `maxItems` s'applique **après** tout le filtrage, **jamais pendant** la collecte. On retire d'abord le maximum d'éléments (trop anciens + déjà traités), puis, s'il en reste plus que `maxItems`, on **narrow** en gardant les **plus récents**. Aujourd'hui le plafond est un **compteur courant appliqué dans l'ordre de lecture des flux** : une fois le compteur plein, les éléments des flux lus plus tard sont écartés **même s'ils sont plus récents** que des éléments déjà retenus de flux antérieurs — c'est précisément ce que ce changement corrige.

**Séquence dans `executeRun` (`lib/pipeline/run.ts`) :**

1. **Collecte (boucle par flux)** — pour chaque `item`, **sans aucun plafond** :
   - **Récence (coupure)** : si `cutoffAt` défini **et** `item.isoDate` présent **et** `Date(item.isoDate) < cutoffAt` → **ignorer** (trop ancien), incrémenter `tooOld`. `isoDate` **null/illisible** → **inclure** (politique retenue).
   - **Dédup intra-lot** (`seenHashes`) puis **déjà-traité** (`isSeen` — élément enregistré par une exécution précédente dans `raw_items`) → **écarter**. *(Ce filtre existe déjà et se produit avant tout plafond ; le changement ne touche que l'étape de narrowing ci-dessous.)*
   - Sinon → **candidat** (accumulé sur tous les flux, sans limite).
2. **Narrowing (après la boucle, avant le regroupement/embedding)** — si `candidats.length > maxItems`, trier par date **du plus récent au plus ancien** et garder les `maxItems` premiers. Les éléments **sans date** rangent comme **les plus anciens** (donc écartés en premier quand on doit plafonner ; ils sont traités dès qu'il reste de la place sous le plafond). Le reste est **écarté** (compté `overCap`). Le narrowing **avant** l'embedding garantit qu'on n'embed jamais plus de `maxItems` éléments.
3. **Ciblage des flux** : déjà géré en amont par les flux cibles (`feedIds`).

Deux helpers **purs et testables** (`lib/pipeline/recency.ts`, sans DB/DOM, comme `filterRuns`/`summarizeRunsWindow`) :

```ts
// Coupure de récence : true = garder l'élément.
export function isWithinRecency(isoDate: string | null, cutoffAt: Date | null): boolean {
  if (!cutoffAt) return true;            // aucune coupure
  if (!isoDate) return true;             // sans date → inclus (politique retenue)
  const t = Date.parse(isoDate);
  if (Number.isNaN(t)) return true;      // date illisible → traitée comme « sans date » → inclus
  return t >= cutoffAt.getTime();
}

// Narrowing par récence : garde les `maxItems` plus récents (sans date = plus anciens → écartés en
// premier). Tri stable : à date égale, l'ordre d'entrée est préservé. Retourne gardés + écartés.
export function narrowByRecency<T>(
  items: readonly T[], isoDateOf: (t: T) => string | null, maxItems: number,
): { kept: T[]; dropped: T[] } {
  if (items.length <= maxItems) return { kept: [...items], dropped: [] };
  const key = (t: T) => { const d = Date.parse(isoDateOf(t) ?? ""); return Number.isNaN(d) ? -Infinity : d; };
  const sorted = [...items].sort((a, b) => key(b) - key(a));   // plus récent d'abord
  return { kept: sorted.slice(0, maxItems), dropped: sorted.slice(maxItems) };
}
```

**Pas de troncature silencieuse** (comme l'étape « Limite d'éléments atteinte » existante) : `tooOld > 0` et `overCap > 0` produisent chacun une étape `pipeline_steps` visible (`partial`). Les éléments ignorés (récence **ou** narrowing) ne sont **pas** enregistrés (`recordRawItem`) ni marqués vus : ils **réapparaissent** comme candidats à une prochaine exécution (un élément plafonné aujourd'hui parce que trop d'actualités plus récentes sont arrivées sera reconsidéré ensuite).

---

## 8. Validation, réglages, tests

- **`runParamsSchema`** (zod, `lib/validation.ts`) :
  - `recency` : union discriminée `age` (`hours` entier positif, borné à **720 h = 30 jours**) / `since` (datetime ISO, **pas dans le futur**) / `none`.
  - `feedIds` : tableau d'UUID valides, ou absent/null = tous les actifs.
  - `maxItems` : entier positif, borné par un plafond de sûreté.
- **Réglages** : étendre `pipelineSettingsSchema` avec `defaultMaxItemAgeHours` (entier positif **nullable** ; option « aucune limite » dans le formulaire), puis `PipelineSettingsForm`, `persistPipelineSettings` et `getPipelineSettings` (mapping de la colonne).
- **Tests unitaires** (style existant, sans DB) :
  - `isWithinRecency` : élément récent (inclus), trop ancien (exclu), sans date (inclus), date illisible (inclus), bornes (`==` cutoff), absence de coupure.
  - Résolution/défaut des params (override vs défaut réglages ; calcul de `cutoffAt` pour `age`/`since`/`none`).
  - `runParamsSchema` : cas valides/invalides (UUID malformé, `hours` négatif, `since` futur, `maxItems` hors bornes).

---

## 9. Migration & rétrocompatibilité

- Migration additive : `ALTER TABLE pipeline_settings ADD COLUMN default_max_item_age_hours integer` (NULL) ; `ALTER TABLE pipeline_runs ADD COLUMN params jsonb` (NULL).
- **Aucun changement de comportement à la livraison** : `default_max_item_age_hours` = `NULL` ⇒ aucune coupure ⇒ pipeline identique à aujourd'hui jusqu'à ce qu'un admin règle une valeur.
- Les exécutions historiques (`params = NULL`) s'affichent normalement ; l'historique n'affiche les paramètres que lorsqu'ils existent.

---

## 10. Fichiers touchés (indicatif)

- `db/schema.ts` — 2 colonnes + type `RunParams`.
- `drizzle/…` — migration additive.
- `lib/validation.ts` — `runParamsSchema` + extension `pipelineSettingsSchema`.
- `lib/pipeline/recency.ts` — helper pur (nouveau) + tests.
- `lib/pipeline/run.ts` — `openRun(params)`, lecture `run.params` dans `executeRun`, filtre récence + `maxItems` + étape « ignorés ».
- `lib/actions/pipeline-actions.ts` — signature `startPipelineRun(input)`, résolution des défauts.
- `lib/queries/settings.ts` — mapping `defaultMaxItemAgeHours`.
- `lib/pipeline/settings-write.ts` — persistance du nouveau réglage.
- `components/pipeline/live-run-panel.tsx` + nouvelle dialogue de configuration.
- `components/settings/pipeline-settings-form.tsx` — champ défaut de récence.
- `app/api/pipeline/run/route.ts` — inchangé (résolution des défauts côté `runPipeline`).
- Tests : `tests/recency.test.ts`, extension des tests de validation/params.
```
