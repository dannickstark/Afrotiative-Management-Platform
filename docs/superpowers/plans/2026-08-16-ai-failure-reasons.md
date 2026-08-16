# Plan — Raisons d'échec IA explicites (fin du « Aucun fournisseur IA configuré » trompeur)

## Contexte / Problème constaté

Lors d'un « Renvoyer à l'IA » en lot depuis `/queue`, plusieurs articles ont été rapportés en échec
avec le message **« Aucun fournisseur IA configuré — régénération impossible. »** alors que des
jetons OpenRouter sont bien configurés, et le titre affichait un préfixe `MOCK`.

Cause racine établie (debug systématique) :

1. `generateArticle()` (`lib/ai/generate-article.ts:111`) retourne `via: "mock"` pour **deux
   situations totalement différentes** : (a) aucun fournisseur configuré, (b) tous les
   fournisseurs / jetons ont été essayés et ont **échoué**. `lib/pipeline/regenerate-core.ts:46`
   traduit les deux par « Aucun fournisseur IA configuré ». Message faux dans le cas (b).
2. `runWithOpenRouterPool` (`lib/ai/with-token-pool.ts`) retourne un `{ ok: false }` **nu** : la
   raison réelle (429 / 401 / erreur transport / brouillon trop court) est perdue.
3. Le `catch` de `with-token-pool.ts:41` **n'écrit aucun log** — contrairement à
   `generate-article.ts:106` pour les autres fournisseurs. Aucune trace côté serveur.
4. La branche OpenRouter n'a **aucun réessai par jeton**, alors que la branche non-OpenRouter
   (`generate-article.ts:94`) réessaie 2 fois. Un seul brouillon « flaky » (< `openrouterMinContentChars`,
   400 par défaut) suffit à consommer le jeton et, si le pool n'a qu'un membre, à tomber en mock.

Le lot amplifie : un 429 pose un cooldown de 60 min sur le jeton concerné, qui disparaît donc du
pool pour tous les articles suivants du même lot.

## Spec (autorité)

Pas de spec séparée : **ce document fait autorité**. Les décisions engageantes sont dans
« Contraintes globales » ci-dessous ; en cas de conflit, ce document tranche.

## Objectif

Que l'utilisateur voie **pourquoi** ça a échoué, article par article, et que le pool soit un peu
plus résilient. On ne change PAS la politique de cooldown, ni le seuil `openrouterMinContentChars`,
ni le comportement « on n'écrase jamais un article avec du mock ».

## Contraintes globales

- **Français** pour tous les messages destinés à l'utilisateur et les commentaires de code (le
  codebase est intégralement commenté en français) ; identifiants de code en anglais.
- **Aucun secret dans un message, un log ou une exception.** Jamais de jeton, jamais de fragment de
  jeton. Les logs identifient un jeton par son `label` uniquement.
- Ne jamais persister un résultat mock : le refus actuel (`via === "mock"` → `{ ok: false }`) reste.
- `markTokenResult` doit être appelé **au plus une fois par jeton et par passage dans le pool**,
  avec le statut final de ce jeton (les valeurs de statut existantes restent : `ok`, `flaky`,
  `rate_limited`, `auth_failed`, `error` — l'UI des réglages les affiche).
- Les cooldowns existants ne changent pas : `RATE_LIMIT_COOLDOWN_MS`, `AUTH_COOLDOWN_MS`.
- `bun run typecheck` doit passer. Tests : `bun run test:pure` (le suite complète tape une base
  distante partagée, lente et instable — ne pas s'en servir comme gate).
- Ne pas élargir : pas de refonte de l'UI `/queue` (elle affiche déjà `failed[].message` par
  article — c'est justement ce message qu'on rend exact), pas de changement sur `embed()`.

---

## Task 1 — `runWithOpenRouterPool` : raison d'échec, logs, réessai par jeton

**Fichier :** `lib/ai/with-token-pool.ts` (+ `tests/with-token-pool.test.ts`)

### 1a. Type de retour porteur d'une raison

Remplacer `PoolResult<T>` par :

```ts
export type PoolFailureReason = "empty_pool" | "rate_limited" | "auth_failed" | "flaky" | "error";
export type PoolResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: PoolFailureReason; detail?: string };
```

- `empty_pool` : `loadPool()` a renvoyé un tableau vide (aucun jeton actif hors cooldown, et pas de
  clé d'environnement).
- Sinon, la raison est **agrégée** sur tous les jetons essayés, par ordre de priorité décroissante :
  `rate_limited` > `auth_failed` > `error` > `flaky`. (Justification : c'est l'ordre de ce que
  l'utilisateur peut faire — attendre / corriger une clé / regarder les logs / relancer.)
- `detail` : message d'erreur de la **dernière** exception classée, tronqué à 200 caractères, ou
  `undefined` s'il n'y a eu aucune exception (cas tout-flaky). Jamais de jeton dedans.

### 1b. Réessai par jeton

Chaque jeton a droit à **2 tentatives** (`ATTEMPTS_PER_TOKEN = 2`, constante nommée exportée), mais
uniquement pour les échecs qui peuvent passer au 2e essai :

- résultat `isFlaky` → réessayer le même jeton une fois ; si le 2e essai est encore flaky →
  `mark(id, "flaky")` puis jeton suivant ;
- exception classée `error` → réessayer le même jeton une fois ; si le 2e essai échoue encore →
  `mark(id, <classe du 2e échec>)` puis jeton suivant ;
- exception classée `rate_limited` ou `auth_failed` → **aucun réessai** sur ce jeton (inutile) :
  `mark` avec le cooldown correspondant, jeton suivant immédiatement ;
- succès non-flaky → `mark(id, "ok")` et retour `{ ok: true, value }`.

Un seul appel `mark` par jeton, portant l'issue **finale** de ce jeton.

### 1c. Logs

Aucun échec ne doit plus être silencieux. Sur chaque issue non-`ok`, écrire un `console.warn`
préfixé `[openrouter]`, mentionnant le `label` du jeton, la classe d'échec, le n° de tentative et,
pour une exception, son message. Exemple de forme (le libellé exact est libre, le contenu ne l'est
pas) :

```
[openrouter] jeton « environnement » — rate_limited (tentative 1/2) : 429 Too Many Requests
[openrouter] jeton « compte-2 » — brouillon inexploitable (flaky), tentative 2/2
```

Et une ligne de synthèse quand le pool est épuisé, indiquant le nombre de jetons essayés et la
raison agrégée retenue.

### Tests (`tests/with-token-pool.test.ts`)

Étendre le fichier existant (garder ses cas actuels en les adaptant au nouveau type de retour) :

- pool vide → `{ ok: false, reason: "empty_pool" }`, `op` jamais appelé ;
- 1 jeton, 1er essai flaky, 2e essai bon → `{ ok: true }`, `op` appelé 2 fois, `mark` appelé une
  seule fois avec `"ok"` ;
- 1 jeton, 2 essais flaky → `{ ok: false, reason: "flaky" }`, un seul `mark(t1, "flaky")` ;
- 1 jeton, 1er essai jette une erreur générique, 2e essai bon → `{ ok: true }`, un seul `mark(t1, "ok")` ;
- 1 jeton qui jette 429 → `op` appelé **une seule fois** (pas de réessai), `mark(t1, "rate_limited",
  RATE_LIMIT_COOLDOWN_MS)`, `{ ok: false, reason: "rate_limited" }` ;
- 1 jeton qui jette 401 → `op` appelé une seule fois, `mark(t1, "auth_failed", AUTH_COOLDOWN_MS)`,
  `reason: "auth_failed"` ;
- 2 jetons : t1 tout-flaky, t2 429 → `reason: "rate_limited"` (priorité), et `detail` porte le
  message du 429 ;
- 2 jetons : t1 429, t2 ok → inchangé par rapport à aujourd'hui (`{ ok: true }`, cooldown posé sur t1) ;
- `detail` est tronqué à 200 caractères sur un message d'erreur très long.

---

## Task 2 — Propager la raison hors de `generateArticle` / `improveArticleBody`

**Fichiers :** `lib/ai/failure-message.ts` (nouveau), `lib/ai/generate-article.ts`,
`lib/ai/improve-article.ts` (+ tests)

**Dépend de Task 1** (`PoolFailureReason`).

### 2a. `lib/ai/failure-message.ts` (nouveau, module pur — pas de `"use server"`, pas d'accès DB)

```ts
export type AiFailureReason = "unconfigured" | "empty_pool" | "rate_limited" | "auth_failed" | "flaky" | "error";
export function aiFailureMessage(reason: AiFailureReason, action: "régénération" | "amélioration", detail?: string): string
```

Messages (à la lettre, `${action}` interpolé) :

- `unconfigured` → `Aucun fournisseur IA configuré — ${action} impossible.`
- `empty_pool` → `Tous les jetons OpenRouter sont inactifs ou en période de récupération — ${action} impossible pour le moment.`
- `rate_limited` → `Quota ou limite de débit atteint sur tous les jetons OpenRouter — réessayez plus tard.`
- `auth_failed` → `Jetons OpenRouter refusés par le fournisseur (clé invalide ou révoquée) — vérifiez les jetons dans Réglages.`
- `flaky` → `L'IA a renvoyé un contenu inexploitable sur tous les jetons — réessayez.`
- `error` → `Appel à l'IA en échec sur tous les jetons.` puis, si `detail` est non vide, ` Dernière erreur : ${detail}` (le `detail` reçu est déjà tronqué par Task 1 ; ne pas re-tronquer, ne pas ré-interpréter).

Module purement fonctionnel, testable sans DB ni réseau.

### 2b. `generateArticle`

Nouvelle signature de retour : `Promise<{ draft: ArticleDraft; via: string; failure?: AiFailureReason; failureDetail?: string }>`.

- Chemin nominal inchangé : `{ draft, via: "openrouter" | <nom> }`, **sans** `failure`.
- Suivre la raison la plus récente au fil de la boucle `llmOrder` dans une variable locale :
  - branche openrouter non configurée (`!cfg.openrouter`) → ne rien enregistrer (ce n'est pas un
    échec, juste un fournisseur absent) ;
  - `runWithOpenRouterPool` renvoie `{ ok: false, reason, detail }` → mémoriser `reason`/`detail` ;
  - branche non-openrouter : `buildModel` nul → ne rien enregistrer ; `generateObject` qui jette aux
    2 tentatives → mémoriser `"error"` + message de la dernière exception tronqué à 200 caractères ;
- retour final mock : `{ draft: <mock>, via: "mock", failure: <raison mémorisée ?? "unconfigured">, failureDetail }`.
  Autrement dit `unconfigured` **uniquement** quand aucun fournisseur n'a été réellement tenté.
- La priorité d'agrégation entre plusieurs fournisseurs échoués n'est pas requise : la **dernière**
  raison mémorisée gagne (la boucle est courte et ordonnée par préférence).

### 2c. `improveArticleBody`

Même traitement, retour `Promise<{ bodyHtml: string; via: string; failure?: AiFailureReason; failureDetail?: string }>`.
Le corps reste **inchangé** (`input.bodyHtml`) dans le cas mock, comme aujourd'hui. La sortie vide
(`text.trim().length === 0`) de la branche non-openrouter mémorise `"flaky"`.

### Tests

- `tests/ai-fallback.test.ts` : adapter aux nouveaux champs et **ajouter** — pool en échec
  `rate_limited` → `generateArticle` renvoie `via: "mock"` ET `failure: "rate_limited"` ; aucun
  fournisseur configuré (`llmOrder` sans provider configuré) → `failure: "unconfigured"`.
- Nouveau `tests/ai-failure-message.test.ts` : une assertion par raison (chaîne exacte), plus le cas
  `error` avec et sans `detail`, et `action` = `"amélioration"`.
- Vérifier que `tests/openrouter-flaky-wiring.test.ts` passe toujours (l'adapter si le type le force).

---

## Task 3 — Câbler les messages aux appelants

**Fichiers :** `lib/pipeline/regenerate-core.ts`, `lib/actions/article-actions.ts`,
`lib/pipeline/stages.ts` (+ tests)

**Dépend de Task 2.**

### 3a. `lib/pipeline/regenerate-core.ts:46`

```ts
if (via === "mock") return { ok: false, message: aiFailureMessage(failure ?? "unconfigured", "régénération", failureDetail), title: article.title };
```

Import statique de `@/lib/ai/failure-message` autorisé : le module est pur (aucune dépendance
lourde), il ne casse pas la discipline d'imports dynamiques du fichier — le commentaire d'en-tête du
fichier explique la règle, ajouter une phrase qui justifie l'exception.

### 3b. `lib/actions/article-actions.ts:97` (`improveWithAi`)

Idem avec `action: "amélioration"`.

### 3c. `lib/pipeline/stages.ts:226-228`

Comportement inchangé (`aiDegraded` / `clusterUncertain` posés comme aujourd'hui). Enrichir
uniquement le `console.warn` existant de la ligne 229 avec la raison quand `gen.failure` existe,
pour qu'un run de pipeline dégradé dise pourquoi.

### Tests

- `tests/regenerate-core.test.ts` : ajouter un cas où `generateArticle` renvoie
  `{ via: "mock", failure: "rate_limited" }` → le message retourné est celui de `rate_limited`, et
  un cas `failure: undefined` → message `unconfigured` (compatibilité ascendante).
- `tests/queue-actions.test.ts` doit continuer à passer (le message remonte tel quel dans
  `failed[].message` de la barre d'actions `/queue` — aucun changement d'UI requis).

---

## Vérification finale

- `bun run typecheck`
- `bun run test:pure`
- Vérifier à la main qu'aucun message ne contient de fragment de jeton.
