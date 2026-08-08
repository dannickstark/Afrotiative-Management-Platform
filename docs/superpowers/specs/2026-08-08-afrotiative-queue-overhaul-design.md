# `/queue` — refonte des actions, filtres persistés, périmètre « en attente »

**Date :** 2026-08-08
**Sous-projet :** B (**dépend du sous-projet D** pour `missingFields`)
**Statut :** validé

## Trois demandes, une refonte

1. approfondir les actions de la file ;
2. mémoriser les filtres dans le navigateur ;
3. n'afficher par défaut que les articles en attente, les autres statuts restant accessibles.

Elles touchent les mêmes fichiers et se conditionnent mutuellement : la sélection multiple n'a de
sens qu'avec un périmètre cadré, et le périmètre n'est tenable que si les filtres survivent à la
navigation.

## État actuel

`lib/queries/queue.ts:11` n'a **aucun `where`** : la page charge tous les articles de tous les
statuts et filtre côté client via TanStack. `quickApprove` (`lib/actions/queue-actions.ts:17`)
appelle `publishArticle` — le bouton « Approuver rapidement » **publie immédiatement sur
WordPress**, ce que son libellé ne dit pas.

## Décision d'architecture — filtres côté serveur

Les filtres passent en **paramètres d'URL traités côté serveur**, sur le modèle exact de
`/published` (`lib/queries/published.ts`) : `parseQueueSearchParams` pure, `getQueue(filters)`
retournant `{ rows, total, page, pageCount }`, `escapeLike` sur la recherche, page bornée dans
l'intervalle valide.

TanStack React Table **reste** — pour les définitions de colonnes, le rendu et la sélection de
lignes — mais perd le filtrage, le tri et la pagination. Motif : un seul modèle de filtrage dans
la base de code, et le périmètre « en attente » doit être appliqué en SQL, pas après avoir chargé
l'intégralité de la table.

Paramètres : `status` (défaut `pending`), `q`, `cat`, `src`, `sort`, `page`.
`status=all` lève le filtre — les autres statuts restent donc atteignables, conformément à la
décision de périmètre.

## Persistance des filtres

`hooks/use-persisted-filters.ts` — générique, paramétré par une clé.

- à chaque changement, écrit la chaîne `searchParams` courante dans
  `localStorage["afrotiative.queue.filters.v1"]` ;
- sur une visite **nue** de `/queue` (aucun paramètre de recherche), remplace l'URL par la valeur
  mémorisée via `router.replace` — pas d'entrée d'historique parasite.

Conséquence voulue : le lien « File de revue » de la barre latérale restitue la dernière vue, alors
qu'une URL partagée ou mise en favori l'emporte toujours. Le suffixe `v1` de la clé permet
d'invalider proprement si la forme des filtres change.

Le hook est écrit pour être réutilisable tel quel sur `/published` par la suite ; ce branchement
n'est pas dans ce périmètre.

Garde-fou : lecture de `localStorage` enveloppée (navigation privée, quota), un échec dégrade
silencieusement vers « pas de restauration ».

## Actions

### Sélection multiple

Colonne de cases à cocher + case d'en-tête « tout sélectionner » (portée : la page courante). La
sélection est un état client pur et **se vide à tout changement de filtre ou de page** — approuver
en lot une sélection dont on ne voit plus les lignes serait dangereux.

`components/queue/bulk-action-bar.tsx` — barre flottante apparaissant dès une ligne sélectionnée :
« N sélectionné(s) » · Approuver et publier · Rejeter · Effacer la sélection.

**Le dialogue de confirmation énonce explicitement que l'approbation publie immédiatement sur
WordPress.** C'est déjà la sémantique de `quickApprove` ; l'action en lot la rend simplement
visible plutôt que de la découvrir article par article.

`bulkApprove(ids)` et `bulkReject({ ids, reason })` dans `lib/actions/queue-actions.ts` :
mêmes gardes RBAC que les actions unitaires (`article:publish`, `article:reject`), exécution
**séquentielle** (la publication WordPress est un appel réseau ; le parallélisme exposerait au
throttling et rendrait le rapport d'erreur illisible), retour
`{ ok: string[], failed: { id, title, message }[] }`.

Le retour partiel est le point important : une publication en lot échoue rarement en bloc. Le toast
annonce « 12 publiés, 3 échecs » et la liste des échecs reste affichée avec, pour chacun, le motif
français renvoyé par `publishArticle` — typiquement un champ bloquant issu du sous-projet D, qui se
corrige alors sur place.

Un article déjà bloquant est écarté **avant** l'appel réseau, avec son motif, plutôt que de partir
vers WordPress pour en revenir refusé.

### Aperçu rapide

`components/queue/preview-sheet.tsx` — un `Sheet` : image, titre, chapô, corps assaini, liste des
sources, liste des informations manquantes, et les mêmes actions qu'en ligne. Alimenté par
`getQueuePreview(id)` (`lib/queries/queue.ts`), qui ne charge le corps que pour l'article demandé.
Le corps est déjà assaini en base (`sanitizeArticleHtml` à la génération) ; il est rendu tel quel,
sans second assainissement.

### Correction en ligne

`components/queue/fix-popover.tsx`, accroché au badge « informations manquantes » : catégorie
(Select sur `wpCategories`), URL d'image, crédit, URL source. N'affiche que les champs réellement
manquants.

`fixArticleFields({ id, categoryId?, featuredImageUrl?, imageCredit?, imageSourceUrl? })` dans
`lib/actions/article-actions.ts` : garde `article:edit`, validation Zod dans `lib/validation.ts`,
URL passées par `isSafePublicHttpUrl`, recalcul de `missingFields` via `checkCompleteness` après
écriture, entrée `article_revisions` (« informations complétées ») comme toute autre mutation.

C'est ce qui referme la boucle avec le sous-projet D : le pipeline signale ce qu'il n'a pas su
réparer, la file le corrige sans quitter la page.

## Colonnes

Ajoutées à `components/queue/columns.tsx` : la case à cocher (en tête de ligne) et un badge
« informations manquantes » listant les libellés de `MISSING_LABEL` en infobulle. Le filtre
« Statut » reste, avec `En attente` comme valeur par défaut au lieu de `Tous les statuts`.

## Fichiers

| Fichier | Action |
|---|---|
| `components/ui/checkbox.tsx` | ajouté par le CLI shadcn (`npx shadcn@latest add checkbox`) |
| `lib/queries/queue.ts` | `QueueFilters`, `parseQueueSearchParams`, `getQueue(filters)`, `getQueueFacets()`, `getQueuePreview(id)` |
| `hooks/use-persisted-filters.ts` | nouveau |
| `app/(app)/queue/page.tsx` | `searchParams: Promise<…>` **awaité** puis `parseQueueSearchParams`, comme `app/(app)/published/page.tsx` |
| `components/queue/queue-view.tsx` | nouveau — calque de `published-view.tsx` |
| `components/queue/queue-filters.tsx` | réécrit en barre pilotée par l'URL |
| `components/queue/queue-table.tsx` | sélection de lignes, plus de filtrage client |
| `components/queue/queue-pagination.tsx` | nouveau — calque de `published-pagination.tsx` |
| `components/queue/bulk-action-bar.tsx` | nouveau |
| `components/queue/preview-sheet.tsx` | nouveau |
| `components/queue/fix-popover.tsx` | nouveau |
| `components/queue/columns.tsx` | case à cocher + badge manques |
| `lib/actions/queue-actions.ts` | `bulkApprove`, `bulkReject` |
| `lib/actions/article-actions.ts` | `fixArticleFields` |

## Tests

`tests/queue-queries.test.ts` — `parseQueueSearchParams` pure : défaut `pending`, `status=all`
lève le filtre, statut inconnu retombe sur `pending`, page bornée, chaînes vides ignorées,
métacaractères `%`/`_` échappés.

`tests/queue-actions.test.ts` (étendu) — `bulkApprove` : succès partiel renvoyant `ok` et `failed`
peuplés ; un article à champ bloquant manquant est écarté sans appel réseau ; RBAC refuse un
`journalist` sur les deux actions en lot ; `bulkReject` exige un motif comme l'action unitaire.

`tests/article-actions.test.ts` (étendu) — `fixArticleFields` recalcule `missingFields`, écrit la
révision, refuse une URL non sûre, refuse un rôle sans `article:edit`.

`tests/use-persisted-filters.test.ts` — logique pure extraite du hook (`shouldRestore(params)`,
`serialize`/`deserialize`) : restaure sur URL nue, ne restaure pas quand un paramètre est présent,
tolère un `localStorage` indisponible.

## Hors périmètre

Séparer « Approuver » de « Publier maintenant » (écarté explicitement), raccourcis clavier, annuler
(undo), attribution d'un article à un relecteur.
