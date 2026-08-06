# Afrotiative Media — Page « Articles publiés » (`/published`)

**Date :** 2026-08-06
**Statut :** Design validé — prêt pour le plan d'implémentation
**Branche :** `feat/published-articles-page` (sur `main`)
**Portée :** Remplacer le **stub** `/published` (aujourd'hui une seule ligne « disponible dans une prochaine version ») par une vraie **liste des articles actuellement publiés**, filtrable et paginée.

Documents sources : pattern de la file de revue (`lib/queries/queue.ts`, `components/queue/queue-table.tsx`), pipeline de publication WordPress (`lib/wp/publish.ts`).

---

## 1. Objectif

`/published` est **déjà dans la navigation** (`components/shell/nav-items.ts` — « Articles publiés », visible par tous les rôles authentifiés) mais rend un simple placeholder. Les données existent pourtant : chaque article publié a `status='published'`, un `publishedAt`, et une ligne `distributions` (canal `wordpress`) portant l'id du post WP. Objectif : une page **liste des articles actuellement en ligne**, en lecture seule, avec **recherche + filtres + pagination**, chaque ligne renvoyant à l'article et au post WordPress.

---

## 2. Décisions validées (brainstorming)

| Décision | Choix retenu |
|---|---|
| **Contenu de la liste** | **Uniquement les articles actuellement publiés** : `status='published'`, triés `published_at DESC`. Un article dépublié (repassé `approved`) **sort** de la liste. |
| **Actions par ligne** | **Lecture seule + liens** : la ligne ouvre la page article (`/article/[id]`, où Modifier/Dépublier/Republier existent déjà) + un lien externe **« Voir sur WordPress »**. Aucune nouvelle action à câbler. |
| **Filtrage (v1)** | **Riche** : recherche par titre + filtre catégorie + plage de dates + filtre auteur (IA/Humain) + **pagination**. |
| **Architecture** | **Côté serveur, piloté par l'URL** : filtres/pagination dans les search params ; un server component les lit et lance **une** requête paginée. Résultats partageables/bookmarkables, payload borné. (Le pattern « tout charger puis filtrer côté client » de la file de revue ne passe pas à l'échelle sur un ensemble non borné.) |
| **Accès** | **Authentifié, lecture seule** — aucun rôle requis (l'entrée nav n'a pas de `roles`), aucune permission `article:read` n'existe dans `lib/rbac.ts`. |
| **Lien WordPress** | L'URL publique live **n'est pas stockée** (seul `distributions.externalId` = l'id du post). Reconstruire `<wp-base>/?p=<postId>` — fiable quelle que soit la config de permaliens. |

---

## 3. Périmètre

**Inclus :**
- Requête serveur paginée + filtrée `getPublishedArticles(filters)` (`lib/queries/published.ts`).
- Parsing pur des search params → filtres (`parsePublishedSearchParams`), + helper pur `wpPostUrl`.
- Page serveur `app/(app)/published/page.tsx` (remplace le stub).
- Composants : barre de filtres, tableau, pagination (`components/published/`).
- Tests unitaires purs (parsing, wpPostUrl) + un test d'intégration DB (requête).

**Exclus :**
- Toute action de mutation depuis la liste (Dépublier/Republier restent dans l'éditeur — décision « lecture seule »).
- Vue « historique/audit » des articles jamais/anciennement publiés (décision « actuellement publiés uniquement »).
- Colonnes score / nombre de sources (vue publiée volontairement épurée).
- Persistance de l'URL WP live (reconstruite via `?p=`).
- La page `/calendar` (stub distinct, hors scope).

---

## 4. Requête de données — `lib/queries/published.ts`

```ts
export type PublishedFilters = {
  search?: string; categoryId?: string; from?: Date; to?: Date;
  author?: "ai" | "human"; page: number; pageSize: number;
};
export type PublishedRow = {
  id: string; title: string; categoryName: string | null;
  publishedAt: Date; imageUrl: string | null; aiAuthor: boolean;
  wpUrl: string | null;   // lien live déjà calculé côté serveur (voir wpPostUrl) — l'UI ne fait qu'afficher
};
export type PublishedPage = { rows: PublishedRow[]; total: number; page: number; pageCount: number };

export async function getPublishedArticles(f: PublishedFilters): Promise<PublishedPage>;
```

Une requête sur `articles` avec `status='published'` + prédicats de filtre construits conditionnellement :
- `search` → `title ILIKE '%'||q||'%'` (Drizzle `ilike`).
- `categoryId` → `articles.category_id = ?`.
- `from` → `published_at >= from` ; `to` → `published_at < to + 1 jour` (**borne haute fin de journée** : un `<input type="date">` donne minuit, donc un `<= to` exclurait les articles publiés le jour choisi). Bornes présentes indépendamment.
- `author` → `ai_author = true` (ia) / `false` (human).

`leftJoin wpCategories` (nom de catégorie) ; `leftJoin distributions` sur `(article_id, channel='wordpress')` pour `externalId` ; `ORDER BY published_at DESC` ; `LIMIT pageSize OFFSET (page-1)*pageSize`. `total` via un `db.$count(articles, <même WHERE>)`. `pageCount = max(1, ceil(total/pageSize))`.

`wpUrl` est **calculé côté serveur dans `getPublishedArticles`** (via `wpPostUrl(getWpConfig()?.baseUrl, externalId)`) et posé sur chaque `PublishedRow`. Ainsi l'UI n'importe jamais le helper ni `@/db` — elle ne fait qu'afficher `row.wpUrl` (sécurité bundle client, cf. la leçon `runs-filter.ts`).

Helper **pur** (testable, sans DB) — placé dans un module DB-free `lib/wp/post-url.ts` :
```ts
// L'URL live n'est pas stockée : reconstruire le permalien ?p= (fiable sur toute config WP).
// Retourne null si baseUrl ou postId manque (lien alors masqué dans l'UI).
export function wpPostUrl(baseUrl: string | null | undefined, postId: string | null): string | null {
  if (!baseUrl || !postId) return null;
  return `${baseUrl.replace(/\/$/, "")}/?p=${encodeURIComponent(postId)}`;
}
```

> Note : `status='published'` ⇒ il existe une distribution `wordpress` (WordPress est le seul canal de publication réel aujourd'hui), donc `wpUrl` est en pratique toujours présent ; le `null` reste géré défensivement (WP non configuré, ou distribution absente).

---

## 5. Parsing des paramètres — pur & testable

```ts
// Dans lib/queries/published.ts (ou un module pur voisin) — aucun accès DB/DOM.
export const PUBLISHED_PAGE_SIZE = 25;
export function parsePublishedSearchParams(
  sp: Record<string, string | string[] | undefined>,
): PublishedFilters;
```
Lit `q, cat, from, to, author, page`. Règles : `page = max(1, parseInt)` (défaut 1) ; `pageSize = PUBLISHED_PAGE_SIZE` ; `search`/`categoryId` : chaîne non vide sinon absent ; `from`/`to` : `Date` valide (via `Date.parse`) sinon absent ; `author` : `"ai"|"human"` sinon absent. Pur (mêmes conventions que `filterRuns`/`resolveRunParams`).

---

## 6. Page — `app/(app)/published/page.tsx` (server component)

```
requireUser()                           // auth seule (aucun rôle requis)
filters = parsePublishedSearchParams(await searchParams)
[page, { categories }] = await Promise.all([
  getPublishedArticles(filters),
  getTaxonomy(),        // lib/queries/settings.ts — `categories` = lignes wpCategories (id, name) pour le <Select>
])
return <PublishedView page={page} filters={filters} categories={categories} />
```
(Next 16 : `searchParams` est asynchrone — `await` avant lecture, selon `node_modules/next/dist/docs/`.)

---

## 7. UI — `components/published/`

- **`published-filters.tsx`** (`"use client"`) : recherche titre (débouncée), `Select` catégorie, deux `<input type="date">` (from/to), `Select` auteur (`Tous` / `IA` / `Humain`). Chaque changement `router.push` les search params mis à jour et **remet `page=1`**. Valeurs contrôlées depuis les props (rendues serveur) → partageables. Aucune primitive UI nouvelle (réutilise `Select`/`Input`/`Label` existants).
- **`published-table.tsx`** : lignes = vignette (featuredImageUrl) · titre (lien `/article/[id]`) · catégorie · date de publication (`formatDate`) · badge auteur (IA/Humain) · lien externe **« Voir sur WordPress »** (`row.wpUrl`, `target="_blank" rel="noopener noreferrer"`, remplacé par un tiret cadratin `—` si `null`). États vides : « Aucun article publié. » (aucun filtre actif) vs « Aucun résultat pour ces filtres. » (filtres actifs).
- **`published-pagination.tsx`** (`"use client"`) : `Précédent` / `Suivant` (désactivés aux bornes) + « Page X / N » ; met à jour le param `page`. `PublishedView` compose filtres + tableau + pagination.

---

## 8. Tests

- **Purs** (`bun test`, sans DB) : `parsePublishedSearchParams` (défauts, clamp `page`, dates invalides ignorées, `author` inconnu ignoré, recherche/catégorie vides ignorées) ; `wpPostUrl` (base normalisée, `null` si base/id manquant, encodage de l'id).
- **Intégration DB** (Neon réel, comme `tests/dashboard-queries.test.ts`/`queue`) : semer des articles `published` (dont un IA et un humain, catégories/dates distinctes, un avec distribution `wordpress`), un `approved` (jamais publié) et un anciennement publié puis dépublié (`approved` + distribution) → asserter que `getPublishedArticles` ne renvoie **que** les `published`, tri `published_at DESC`, chaque filtre (catégorie, recherche, plage de dates, auteur) restreint correctement, la pagination découpe (`total` + tranche), et `wpUrl` est bien dérivé de l'`externalId` de la distribution WordPress (l'id apparaît dans l'URL `?p=`). Inclure un cas **plage de dates fin-de-journée** : un article publié le jour du `to` est inclus. Nettoyage FK-safe.

---

## 9. Fichiers touchés (indicatif)

- `lib/queries/published.ts` — nouveau : `getPublishedArticles`, `parsePublishedSearchParams`, types (`PublishedFilters`/`PublishedRow`/`PublishedPage`).
- `lib/wp/post-url.ts` — nouveau : `wpPostUrl` pur, DB-free (importé par `getPublishedArticles`).
- `app/(app)/published/page.tsx` — remplace le stub par le server component.
- `components/published/published-filters.tsx` · `published-table.tsx` · `published-pagination.tsx` · `published-view.tsx` — nouveaux.
- `tests/published.test.ts` (purs) + `tests/published-queries.test.ts` (intégration DB).
- Aucune migration (aucun nouveau champ).
