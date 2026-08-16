# Renvoyer à l'IA — exécution asynchrone et modes de choix d'image

**Date** : 2026-08-16
**Statut** : conçu, prêt pour plan d'implémentation

## Problème

Deux défauts signalés sur « Renvoyer à l'IA », en unitaire comme en lot.

### 1. L'action semble ne jamais démarrer

Rien ne revient à l'utilisateur avant la fin complète du traitement. Par article, séquentiellement :

- `requireUser()` + RBAC (`lib/actions/article-actions.ts:70`) ;
- `await import("@/lib/pipeline/regenerate-core")` — en dev, compile tout le graphe jsdom/extraction/IA au premier clic ;
- ré-extraction de **chaque source, une à une**, sur le réseau (`lib/pipeline/regenerate-core.ts:37-44`). Chaque source parcourt la chaîne jina → firecrawl → crawl4ai, et un contenu « faible » ne stoppe pas la chaîne : elle continue vers le fournisseur suivant (`lib/extract/index.ts:110`). S'ajoute un crawl de backfill d'images (`lib/extract/index.ts:60`). Trois sources = facilement 6 à 10 allers-retours distants avant le moindre appel IA ;
- **aucun timeout**. Le chemin d'ingestion enveloppe l'extraction dans `withTimeout(..., perOperationTimeoutMs)` (`lib/pipeline/run.ts:448`) ; le chemin de régénération, non. Une source lente bloque tout ;
- puis l'appel LLM, qui fait lui-même tourner le pool de jetons OpenRouter — jusqu'à 2 × N jetons d'appels séquentiels sur erreur de quota ou brouillon trop court (`lib/ai/with-token-pool.ts`).

En lot, ce coût est multiplié par N et strictement sériel (`components/queue/bulk-action-bar.tsx:65-74`). Le compteur `X/N` ne s'incrémente qu'après un article complet : le premier tic est à un article entier de distance.

### 2. Cocher uniquement « Image à la une » ne fonctionne pas

Deux causes cumulées.

**a) La régénération utilise l'extracteur restreint SSRF sur ses propres sources de confiance.** `lib/pipeline/regenerate-core.ts:39` appelle `extractExternal(s.url)`, soit `externalOnly: true`. Ce mode désactive explicitement le backfill d'images par fetch direct et ne laisse que Crawl4AI comme source d'images (`lib/extract/index.ts:173-178`). L'ingestion, elle, appelle `extract(item.url)` (`lib/pipeline/stages.ts:457`) et bénéficie du backfill. Un article qui avait une image à l'ingestion peut donc revenir avec `candidateImages: []` à la régénération.

Cette restriction n'est pas justifiée ici : ce sont les mêmes URLs de flux déjà crawlées à l'ingestion — le raisonnement est déjà écrit à `lib/pipeline/stages.ts:192`.

**b) Une liste de candidats vide n'épargne pas l'image existante, elle l'efface.** Sans candidat, le prompt impose `featuredImageUrl=null` (`lib/ai/generate-article.ts:29`), `sanitizeDraft` force à null tout ce qui n'est pas dans la liste (`lib/ai/generate-article.ts:42`), puis :

```ts
columns.featuredImageUrl = draft.featuredImageUrl ?? null;
```

(`lib/pipeline/regenerate.ts:27`) écrit `null` par-dessus l'image existante, ainsi que crédit et URL source. Résultat : une minute d'attente pour une génération d'article complète dont le seul effet retenu est l'effacement de l'image, avec `imageMissing: true` et retour au statut `pending`.

Note connexe : même en image seule, une génération d'article **complète** est lancée (titre, corps, tags…) pour n'en garder que trois colonnes.

## Décisions prises

| Question | Décision |
|---|---|
| Douleur principale | L'absence de retour, pas la durée brute → exécution asynchrone avec progression |
| Réutiliser le texte des sources capté à l'ingestion | Non — on re-crawle toujours, la fraîcheur est conservée |
| Image seule | Appel LLM dédié bon marché par défaut, **plus** un mode manuel où l'éditeur choisit parmi les candidats |
| Zéro candidat | Conserver l'image et échouer explicitement |
| Où se règle auto / manuel | Défaut global dans Réglages **et** surcharge par exécution dans les dialogues |
| Autres champs pendant qu'une image attend | Appliqués immédiatement ; seule l'image attend |
| Cueillette manuelle en lot | Bac différé sur /queue + assistant de choix pas-à-pas |
| Persistance du travail asynchrone | Nouvelles tables `regen_jobs` / `regen_job_items` |

Écarté : la mise en cache du texte extrait sur `article_sources` (gain de vitesse le plus important, mais fraîcheur sacrifiée — refusé).

## Architecture

### Modèle de données

Deux tables calquées sur `pipeline_runs` / `pipeline_steps`, délibérément **séparées** de celles-ci pour que l'index unique partiel « un seul run de pipeline actif » reste valable et qu'une régénération puisse tourner pendant une ingestion.

```
regen_jobs
  id                uuid pk
  actor_id          text → user.id
  fields            jsonb          -- RegenerateFieldsInput
  image_mode        text           -- 'auto' | 'manual'
  total             int
  done              int
  status            text           -- 'running' | 'done' | 'failed' | 'cancelled'
  cancel_requested  boolean default false
  started_at        timestamp
  finished_at       timestamp      -- null tant que le job tourne

regen_job_items
  id           uuid pk
  job_id       uuid → regen_jobs (on delete cascade)
  article_id   uuid → articles   (on delete cascade)
  title        text              -- instantané, pour un rapport d'échec lisible
  stage        text              -- 'queued' | 'extracting' | 'generating' | 'writing'
  status       text              -- 'pending' | 'ok' | 'failed' | 'awaiting_image'
  message      text
  started_at   timestamp
  finished_at  timestamp
```

Plus **une colonne sur `articles`** :

```
pending_image_candidates  jsonb   -- null, ou [{ url, sourceUrl, mediaName }]
```

Elle vit sur l'article et non sur le job : le choix est par article et doit survivre à la suppression du job. Cette unique colonne alimente le bac, le badge et le filtre.

**Garde d'unicité** : index unique partiel sur `regen_job_items(article_id) WHERE finished_at IS NULL` — un article est dans au plus un job en vol. Pas de verrou global : deux éditeurs peuvent travailler en parallèle.

`awaiting_image` est un état **terminal** pour l'item : `finished_at` est renseigné, le job peut se clore et l'article redevient éligible à une nouvelle régénération. L'attente d'un choix vit désormais dans `articles.pending_image_candidates`, pas dans le job. Un job dont tous les items sont `ok` ou `awaiting_image` a le statut `done` ; `failed` est réservé aux jobs dont **tous** les items ont échoué, sinon `done` avec un rapport d'échecs partiels (même convention que les lots existants).

### Exécution asynchrone

`startRegenJob(articleIds[], fields, imageMode)` insère le job et ses items, lance `void runRegenJob(jobId)` en promesse détachée, et retourne `jobId` immédiatement — exactement le motif de `lib/actions/pipeline-actions.ts:104`. `getRegenJobAction(jobId)` est sondé toutes les 1,5 s, en miroir de `getActiveRunAction` (`lib/actions/pipeline-actions.ts:109`).

**L'unitaire est un job de un.** Même chemin de code, et la page article gagne une bande de progression (« Extraction 2/3 → Génération IA → Écriture ») au lieu d'un spinner opaque — ce qui répond précisément à la plainte.

Dans le runner, par article :

- les sources sont extraites **en parallèle** (`Promise.all`), chacune enveloppée dans `withTimeout(..., perOperationTimeoutMs)` ;
- les articles restent **sériels** au sein d'un lot, délibérément : le pool OpenRouter est partagé et tourne jusqu'à 2 × N jetons par appel ; des appels LLM parallèles multiplieraient les périodes de refroidissement pour dépassement de quota. Le sériel est acceptable dès lors que la progression est visible ;
- `cancel_requested` est sondé entre deux articles, comme `executeRun`.

La dérivation de progression pure va dans `lib/pipeline/regen-live.ts` (sans DB, voie `test:pure`), en miroir de `lib/pipeline/live.ts`.

Le plafond de 10 articles côté UI est conservé, mais devient une garde de confort plutôt qu'une protection contre une boucle bloquante.

### Choix de l'image

**Mode** — nouveau réglage pipeline `regenerateImageMode` (`auto` | `manual`, défaut `auto`), surchargeable par exécution via un radio à côté de la case « Image à la une » dans les deux dialogues.

**Les candidats portent leur provenance.** La collecte étiquette chaque image avec la source dont elle vient : `{ url, sourceUrl, mediaName }`. Un choix manuel renseigne alors `imageCredit` depuis `mediaName` et `imageSourceUrl` depuis `sourceUrl` — provenance plus fiable que le crédit deviné par le LLM aujourd'hui.

**Quatre cas, décidés par un module pur `lib/pipeline/regen-plan.ts` :**

| Champs cochés | Mode | Ce qui s'exécute |
|---|---|---|
| image seule | auto | extraction + appel **`pickFeaturedImage` bon marché** — aucune génération d'article |
| image seule | manuel | extraction seule, **aucun LLM** ; candidats garés, item → `awaiting_image` |
| image + autres | auto | un `generateArticle` comme aujourd'hui ; son `featuredImageUrl` est déjà contraint à la liste de candidats, donc pas de second appel |
| image + autres | manuel | `generateArticle` pour les autres champs, son choix d'image écarté, candidats garés |

`lib/ai/pick-image.ts` est un petit appel structuré (titre + corps + candidats → `{ url, credit }`) à travers le même pool de jetons, avec la même garde que `sanitizeDraft` (`lib/ai/generate-article.ts:42`) : une URL absente de la liste de candidats est rejetée.

**Zéro candidat — ne jamais détruire.**

- Image seule : l'item échoue avec « Aucune image candidate trouvée — image inchangée. »
- Image accompagnée d'autres champs : ces autres champs sont appliqués, l'item réussit avec ce message en avertissement.

Les colonnes d'image ne sont jamais écrites à null. C'est le correctif direct du problème 2.

**Le bac.** `pending_image_candidates IS NOT NULL` alimente : un badge dans la colonne `image` existante de la file, un nouveau filtre `img=pending` dans `components/queue/queue-filters.tsx` (nouveau paramètre d'URL dans `parseQueueSearchParams`, nouvelle condition dans `getQueue`), et un bouton « Choisir les images (N) ».

L'assistant (`components/queue/image-pick-wizard.tsx`, réutilisant la grille de vignettes de `components/studio/asset-library.tsx`) les parcourt un par un : image actuelle à gauche, grille de candidats, boutons `Choisir` / `Passer` / `Aucune image`, compteur « 3/7 ». Le fermer ne perd rien — le bac est l'état.

`pickRegeneratedImage(articleId, choice)` écrit les trois colonnes d'image, vide la colonne d'attente et enregistre une courte révision, sous la permission `article:regenerate`.

### Correctifs du problème 2 proprement dits

1. `extractExternal` → `extract` dans `regenerateArticle` (`lib/pipeline/regenerate-core.ts:39`).
2. `selectRegenerationColumns` n'émet jamais une image nulle par-dessus une image existante (`lib/pipeline/regenerate.ts:26-30`).

## Fichiers touchés

**Nouveaux**

- `lib/pipeline/regen-plan.ts` — pur : champs + mode + candidats → décision
- `lib/pipeline/regen-live.ts` — pur : dérivation de la progression
- `lib/pipeline/regen-job.ts` — le runner (`runRegenJob`)
- `lib/actions/regen-actions.ts` — `startRegenJob`, `getRegenJobAction`, `cancelRegenJob`, `pickRegeneratedImage`
- `lib/queries/regen-jobs.ts` — lectures
- `lib/ai/pick-image.ts` — l'appel de choix d'image
- `components/queue/image-pick-wizard.tsx` — l'assistant
- `components/queue/regen-progress.tsx` — la bande de progression sondée

**Modifiés**

- `db/schema.ts` + migration générée (`bun run db:generate`)
- `lib/pipeline/regenerate-core.ts` — extraction parallèle, timeouts, `extract`, branchement du plan
- `lib/pipeline/regenerate.ts` — invariant « ne jamais effacer l'image »
- `lib/validation.ts` — `pipelineSettingsSchema` (+ `regenerateImageMode` avec `.default()`), schémas des nouvelles actions
- `lib/pipeline/settings-write.ts` — **le champ doit y être ajouté**, oubli historique qui rend une section silencieusement inopérante
- `components/settings/pipeline-settings-form.tsx` — `FormState`, `toFormState`, `payload`, rendu
- `components/article/regenerate-dialog.tsx` et `components/queue/bulk-regenerate-dialog.tsx` — radio auto/manuel, bascule vers le job
- `components/queue/bulk-action-bar.tsx` — la boucle client cède la place au sondage du job
- `lib/queries/queue.ts` (`parseQueueSearchParams`, `getQueue`), `components/queue/queue-filters.tsx`, `components/queue/columns.tsx` — filtre et badge du bac
- `scripts/test-fast.ts` — liste blanche `PURE_FILES`

## Tests

Voie pure (`test:pure`) :

- `regen-plan.ts` — le tableau des quatre cas et les règles de candidat vide, en table de fixtures
- `regen-live.ts` — dérivation de la progression
- `selectRegenerationColumns` — invariant « ne jamais effacer », en extension des tests existants
- la garde de liste de candidats de `pickFeaturedImage`, sans invoquer le LLM (même forme que `tests/ai-prompt.test.ts`)

Voie DB : transitions d'état du runner, index unique « un job en vol par article », et `pickRegeneratedImage`.

**Test de régression écrit en premier** : une régénération image seule avec zéro candidat doit laisser `featuredImageUrl` intact et signaler l'échec.

## Découpage

Un plan, trois phases livrables indépendamment :

1. **Correctifs et vitesse** — `extract` au lieu de `extractExternal`, invariant « ne jamais effacer », extraction parallèle avec timeouts. Corrige le problème 2 et réduit déjà la durée, sans nouvelle table.
2. **Job asynchrone et progression** — tables, runner, actions, sondage, bandes de progression en unitaire et en lot. Répond au problème 1.
3. **Modes d'image, bac et assistant** — réglage, radio, `pickFeaturedImage`, colonne d'attente, filtre, badge, assistant de choix.

## Hors périmètre

- Mise en cache du texte des sources sur `article_sources` (explicitement refusée : la fraîcheur prime).
- Exécution parallèle des articles au sein d'un lot (le pool de jetons partagé l'interdit en pratique).
- Toute modification du chemin d'ingestion au-delà de l'étiquetage de provenance des images candidates.
- Sources d'images hors scraping — la politique « scraping et Crawl4AI uniquement » reste inchangée.
