# Pipeline — étape « Vérification & complétion »

**Date :** 2026-08-08
**Sous-projet :** D (indépendant ; **prérequis du sous-projet B**)
**Statut :** validé

## Problème

Des articles atteignent la file de revue avec des informations manquantes que personne ne détecte
avant le clic sur « Approuver rapidement ». Le cas le plus fréquent : **aucune information sur
l'image à utiliser** — ni URL, ni crédit, ni source. L'échec ne se manifeste qu'au moment de la
publication, où `lib/wp/publish.ts:260-264` refuse avec « Choisissez une catégorie avant de
publier » ou « Le crédit de l'image est obligatoire ». Le manque est donc découvert au plus mauvais
moment, article par article, sans piste de correction.

## Principe

Une **sixième étape par article** qui, juste après la génération : tente de **réparer** ce qui peut
l'être automatiquement, puis **consigne** ce qui reste manquant sur l'article. Ce qui reste
bloquant empêche l'approbation, avec un message précis et un point de correction.

## Placement dans la chaîne

L'étape s'insère **immédiatement après `Génération IA`**, sur le `draft` encore en mémoire :

```
Extraction du contenu → Génération IA → Vérification & complétion
  → Calcul de l'embedding → Regroupement (clustering) → Dépôt en revue
```

Ce placement est délibéré : `computeArticleScore` (`lib/pipeline/stages.ts:179`) lit `hasImage`, et
il tourne après le clustering. Réparer avant l'embedding garantit donc que le score reflète
l'article **réparé** — une image récupérée améliore réellement le score, au lieu d'être pénalisée
par un `imageMissing` déjà figé.

`lib/pipeline/live.ts:10` (`ITEM_STAGES`) et `STAGE_LABEL` sont mis à jour dans le même ordre :
`deriveStepperNodes` rend et gèle strictement de gauche à droite, la position dans le tableau doit
égaler l'ordre de déclenchement réel.

## Module — `lib/pipeline/completeness.ts`

Deux unités, l'une purement testable, l'autre effectuant les entrées/sorties.

### `checkCompleteness(draft, sources): string[]` — pur

Retourne les clés manquantes, dans un ordre stable. Aucune I/O, aucune dépendance DB.

### `repairDraft(draft, sources, deps): Promise<RepairResult>`

`deps = { extract }` — injecté pour que les tests n'aient jamais besoin du réseau.
Retourne `{ draft, repaired: string[], missing: string[] }`. **Ne lève jamais** : chaque
réparation est tentée dans son propre `try/catch`, un échec laisse simplement la clé dans
`missing`.

| Clé | Bloquant | Réparation automatique |
|---|---|---|
| `featuredImageUrl` | oui | reprend `candidateImages` ; si vide, relance `extract()` sur chaque URL source pour récupérer `images[]` — c'est le cas « ni lien, ni source » |
| `imageCredit` | oui (si image présente) | `mediaName` de la source dont le domaine correspond à l'hôte de l'image, sinon celui de la première source |
| `imageSourceUrl` | oui (si image présente) | URL de cette même source |
| `categoryId` | oui | **aucune** — choisir une catégorie est une décision éditoriale, jamais devinée |
| `sources` (aucune) | oui | irréparable par construction |
| `excerpt` | non | 200 premiers caractères du texte du corps, coupés sur un mot |
| `tags` | non | aucune — purement indicatif |

`BLOCKING_FIELDS` est exporté comme constante depuis ce module : `lib/wp/publish.ts` et
l'interface la consomment, il n'existe donc qu'une seule définition de « bloquant ».

Une image ne peut être retenue que si elle passe `isSafePublicHttpUrl` (`lib/url-guard.ts`, déjà
utilisé par la publication) — la réparation ne doit pas introduire une URL que la publication
refusera ensuite.

## Câblage dans `stageSources`

```ts
const repair = await timedStep(steps, hooks, "Vérification & complétion", ms,
  () => repairDraft(draft, uniqueSources, { extract }));
```

**Sémantique d'échec — différente des cinq autres étapes.** Les autres étapes avortent l'article
(`articleId: null`) en cas d'échec. Celle-ci ne le doit pas : perdre une réparation ne doit jamais
coûter un article. L'appel est donc enveloppé de sorte qu'un rejet enregistre l'étape en `failed`
puis **poursuive** avec le `draft` non réparé et `missing` calculé par `checkCompleteness` seul.
C'est la seule étape de `stageSources` avec ce comportement ; le commentaire du code doit le dire
explicitement.

`persistArticle` reçoit `missingFields` et l'écrit dans la même transaction que le reste.

### Le cas particulier de la catégorie

`checkCompleteness` travaille sur le `draft`, où la catégorie est un **nom** ; sa résolution en
`categoryId` n'a lieu que dans `persistArticle`, via `resolveCategoryId`, qui peut renvoyer `null`
alors que le nom paraissait valide. La clé `categoryId` se détermine donc en deux temps :

- à l'étape, elle est signalée si `draft.category` est absent de `categoryNames` ou si
  `confidence.categoryUncertain` est vrai ;
- dans `persistArticle`, après `resolveCategoryId`, elle est **ajoutée** à la liste si `catId`
  vaut `null` et n'y figure pas déjà.

C'est la seule clé réconciliée après coup ; les six autres sont entièrement déterminées à
l'étape. La liste écrite en base est donc toujours celle qui fait foi pour l'application du
blocage.

## Base de données

Migration `0012_*` :

```sql
ALTER TABLE articles
  ADD COLUMN missing_fields jsonb NOT NULL DEFAULT '[]'::jsonb;
```

Drizzle (`db/schema.ts`) : `missingFields: jsonb("missing_fields").$type<string[]>().notNull().default([])`.

Colonne distincte de `confidenceFlags` à dessein : `confidenceFlags` exprime un doute sur la
qualité, `missingFields` est une **liste de travail** — interrogeable, affichable, et vidée au fur
et à mesure des corrections. Les mélanger rendrait impossible de distinguer « l'IA n'était pas sûre
de la catégorie » de « il n'y a pas de catégorie ».

## Application du blocage

Le point d'application ne change pas : `publishArticle` reste le seul endroit qui refuse une
publication. Ses deux gardes existantes (`lib/wp/publish.ts:260-264`) sont généralisées en une
seule lecture de `missingFields ∩ BLOCKING_FIELDS`, avec un message français énumérant les manques.
Les gardes actuelles restent couvertes : `categoryId` et `imageCredit` sont dans l'ensemble
bloquant.

`shouldAutoPublish` (`lib/pipeline/auto-publish.ts`) gagne une condition : aucun champ bloquant
manquant. Un article incomplet ne peut donc jamais franchir l'exception SP6.

Les champs non bloquants (`excerpt`, `tags`) n'empêchent jamais rien — ils s'affichent comme
indications.

## Effet connu sur les exécutions passées

Ajouter une entrée à `ITEM_STAGES` fait rendre ce nœud en `pending` **à perpétuité** pour les
exécutions antérieures, dont les lignes `pipeline_steps` sont écrites avant l'existence de
l'étape. C'est un artefact d'affichage assumé : versionner la liste des étapes par date
d'exécution coûterait plus que le désagrément. À mentionner dans le plan d'implémentation pour
éviter qu'il soit signalé comme régression.

## Fichiers

| Fichier | Action |
|---|---|
| `lib/pipeline/completeness.ts` | nouveau — `checkCompleteness`, `repairDraft`, `BLOCKING_FIELDS`, `MISSING_LABEL` |
| `lib/pipeline/stages.ts` | étape insérée ; `missingFields` transmis à `persistArticle` |
| `lib/pipeline/live.ts` | `ITEM_STAGES` + `STAGE_LABEL` |
| `lib/pipeline/auto-publish.ts` | condition « aucun champ bloquant manquant » |
| `lib/wp/publish.ts` | garde généralisée sur `missingFields ∩ BLOCKING_FIELDS` |
| `db/schema.ts`, `db/migrations/0012_*.sql` | colonne `missing_fields` |
| `lib/queries/queue.ts` | expose `missingFields` (consommé par le sous-projet B) |

`MISSING_LABEL: Record<string, string>` traduit chaque clé en français pour l'interface
(`featuredImageUrl` → « Image à la une », `imageCredit` → « Crédit image », …). Défini avec les
clés, jamais dupliqué côté composant.

## Tests

`tests/completeness.test.ts` — sans réseau, `extract` injecté :

- `checkCompleteness` : détecte chacune des sept clés, et n'en détecte aucune sur un brouillon
  complet ;
- `imageCredit`/`imageSourceUrl` ne sont pas signalés quand il n'y a pas d'image (rien à créditer) ;
- réparation image depuis `candidateImages` ;
- réparation image via ré-extraction quand `candidateImages` est vide — le cas signalé ;
- une URL d'image refusée par `isSafePublicHttpUrl` n'est pas retenue et la clé reste manquante ;
- crédit dérivé par correspondance de domaine, puis par repli sur la première source ;
- `categoryId` manquant n'est jamais réparé ;
- un `extract` qui rejette laisse `repairDraft` résolu, sans lever ;
- `excerpt` dérivé du corps, coupé sur un mot.

`tests/auto-publish.test.ts` — un champ bloquant manquant interdit l'auto-publication même quand
score et sources satisfont le seuil.

`tests/wp-publish.test.ts` — la garde généralisée refuse avec le message énumérant les manques, et
les deux cas historiques (catégorie absente, crédit absent) restent refusés.

`tests/live-panel.test.ts` — `deriveStepperNodes` sur six nœuds ; une exécution ancienne
(cinq étapes) rend le sixième nœud `pending` sans casser le gel gauche-droite.
