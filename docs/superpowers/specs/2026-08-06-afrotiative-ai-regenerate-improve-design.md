# Afrotiative Media — Régénération IA d'un article (« Renvoyer à l'IA » + « Améliorer avec IA »)

**Date :** 2026-08-06
**Statut :** Design validé — prêt pour le plan d'implémentation
**Branche :** `feat/ai-regenerate` (sur `main`)
**Portée :** Remplacer le **stub** `regenerate()` par une vraie régénération IA **sélective** d'un article (choix des champs), et activer le bouton **« Améliorer avec IA »** (réécriture du corps). Deux actions serveur, deux petites boîtes de dialogue.

Documents sources : pipeline de génération (`lib/pipeline/stages.ts` `persistArticle`, `lib/ai/generate-article.ts`), extraction (`lib/extract`), scoring (`lib/pipeline/score.ts`), clustering (`lib/pipeline/cluster.ts`).

---

## 1. Objectif

Aujourd'hui, dans l'éditeur d'article, « Renvoyer à l'IA » appelle `regenerate()` — un **stub** qui repasse l'article en `pending` et journalise « renvoyé à l'IA (simulé) » **sans aucun appel IA** ; et « Améliorer avec IA » est un bouton **désactivé** (« Bientôt (SP3) »). Le pipeline de génération existe pourtant en entier. Objectif : câbler ces deux actions sur les vrais blocs du pipeline.

---

## 2. Décisions validées (brainstorming)

| Décision | Choix retenu |
|---|---|
| **Régénération sélective** | Boîte de dialogue avec **6 cases** (Titre / Corps / Extrait / Catégorie / Tags / Image à la une), **toutes cochées par défaut** ; seuls les champs cochés sont écrasés. |
| **Version précédente** | **Snapshot** : le `{titre, bodyHtml}` d'avant est enregistré dans `article_revisions.detail` avant l'écrasement (récupérable manuellement). |
| **Exécution** | **Synchrone** (spinner via le `useTransition` existant de l'action-bar) — comme `reprocessRawItem`. |
| **Portée** | **Les deux maintenant** : `regenerate()` réel **et** « Améliorer avec IA ». |
| **« Améliorer avec IA »** | Boîte de dialogue avec **instruction facultative** (ex. « raccourcir », « ton plus formel ») ; vide = amélioration générale. Le LLM réécrit le **corps** en gardant les faits. |
| **Sources** | `article_sources` ne stocke que `mediaName + url` (pas le texte) → régénérer **ré-extrait** les URLs sources (via `extractExternal`, SSRF-safe). |
| **Mode dégradé (mock)** | Si aucun fournisseur IA n'est configuré (`generateArticle`/`improve` retombe sur le mock) → **refuser** l'action (message clair), pour ne JAMAIS écraser le contenu réel par du `[MOCK]`. |
| **Statut** | Régénérer/Améliorer repasse l'article en **`pending`** (re-revue). Actions offertes là où l'action-bar l'est déjà (pas pour publié/rejeté). RBAC `article:regenerate` (admin/éditeur) — inchangé. |

---

## 3. Périmètre

**Inclus :**
- Action `regenerate(articleId, fields)` réelle (ré-extraction + génération + application sélective + snapshot + re-scoring).
- Action `improveWithAi(articleId, instruction?)` (réécriture du corps).
- Nouveau `lib/ai/improve-article.ts` (prompt de réécriture + chaîne de fournisseurs).
- Cœur partagé `lib/pipeline/regenerate.ts` (snapshot + application + rafraîchissement embedding/cluster/score).
- Boîtes de dialogue : sélection des champs (régénérer) ; instruction facultative (améliorer).
- Activation du bouton « Améliorer avec IA » (`editor-shell.tsx`).
- Tests unitaires (application sélective, prompt d'amélioration, garde anti-mock) + intégration DB.

**Exclus :**
- Restauration en un clic d'une version snapshotée (le snapshot est consultable dans les révisions, pas de bouton « restaurer » — v1).
- Re-clustering forcé quand seuls des champs hors-corps changent (embedding/cluster inchangés si le corps ne change pas).
- Édition en streaming / aperçu avant application (l'action applique directement, statut `pending` pour re-revue).
- File d'attente / exécution en arrière-plan (synchrone assumé).

---

## 4. Blocs réutilisés (ne rien réinventer)

| Bloc | Rôle dans la régénération |
|---|---|
| `extractExternal(url)` (`lib/extract`) | Ré-extraction SSRF-safe du texte + images des URLs sources. |
| `generateArticle({ sources, candidateImages, categories })` (`lib/ai/generate-article.ts`) | Produit le `ArticleDraft` (title/bodyHtml/excerpt/category/tags/image/confidence) + `via`. |
| `sanitizeArticleHtml(html)` (`lib/sanitize.ts`) | Assainit le `bodyHtml` généré/réécrit avant persistance. |
| `resolveCategoryId(name, names)` / `insertTags(tx, id, tags)` (`lib/pipeline/stages.ts`) | Mapping catégorie (nom→id) et remplacement des tags. **À exporter** si nécessaire. |
| `embed(text)` (`lib/embeddings`) + `decideCluster(vector)` (`lib/pipeline/cluster.ts`) | Rafraîchit `article_embeddings` + `clusterId` quand le corps change. |
| `computeArticleScore(input)` (`lib/pipeline/score.ts`) | Recalcule `articles.score` (pur). |

**Important :** on **n'appelle pas** `persistArticle` (qui fait un `INSERT` d'un NOUVEL article). Le cœur `applyRegeneration(...)` (`lib/pipeline/regenerate.ts`) fait un **`UPDATE`** de l'article existant (id/distributions/cluster préservés) sur les seuls champs cochés. Il reçoit le `draft` **en paramètre** (l'action fait l'extraction + `generateArticle` + garde anti-mock autour de lui) — ainsi la logique risquée (application sélective + snapshot + re-score) est testable en intégration DB avec un `draft` synthétique, sans LLM.

---

## 5. Action `regenerate(articleId, fields)`

`fields: { title: boolean; body: boolean; excerpt: boolean; category: boolean; tags: boolean; image: boolean }`.

1. RBAC `article:regenerate`. Valider `fields` (au moins un `true`).
2. Charger l'article + `article_sources`. **Aucune source → `{ ok:false, message:"Aucune source à régénérer." }`.**
3. **Ré-extraire** chaque URL source (`extractExternal`, best-effort ; ignorer les mortes ; agréger `candidateImages`). **Aucune extraction exploitable → `{ ok:false, message:"Impossible d'extraire les sources." }`.**
4. `generateArticle({ sources, candidateImages, categories })` → `{ draft, via }`. **`via === "mock"` → `{ ok:false, message:"Aucun fournisseur IA configuré — régénération impossible." }`** (ne pas écraser avec du mock).
5. **Transaction (tout ou rien)** — le cœur `applyRegeneration(...)` reçoit le `draft` déjà généré + `fields` + `sources` (paramètre, pas d'appel LLM interne — voir §8 pour la testabilité) :
   - **Une seule révision** (snapshot **et** traçabilité) : `article_revisions` `action:"régénéré par IA"`, `detail:` titre + `bodyHtml` d'avant **et** la liste des champs cochés (« champs : titre, corps, … »).
   - Écraser **uniquement** les champs cochés : `title`→`draft.title` ; `body`→`sanitizeArticleHtml(draft.bodyHtml)` ; `excerpt`→`draft.excerpt` ; `category`→`resolveCategoryId(draft.category, categoryNames)` ; `tags`→remplacer `article_tags` (`insertTags`) ; `image`→`featuredImageUrl`/`imageCredit`/`imageSourceUrl`.
   - Toujours : `status='pending'`, `updatedAt=now`, `confidenceFlags` depuis `draft.confidence`, `aiAuthor=true`.
   - **Cohérence embedding/cluster/score — uniquement si `body` est coché** : `embed(titre+corps)` → maj `article_embeddings` ; `decideCluster(vector)` → maj `clusterId` **et** fournit le `bestScore` ; `computeArticleScore(...)` → maj `articles.score`. **Si le corps n'est PAS régénéré, embedding/cluster/score restent inchangés** (le `computeArticleScore` a besoin du `bestScore` de cohésion que seul `decideCluster` fournit ; et l'article repasse de toute façon en revue humaine — un score non rafraîchi sur une régénération catégorie/image seule est acceptable en v1).
6. `revalidatePath('/article/'+id)` + `/queue`. Retour `{ ok:true, message:"Article régénéré — déposé en revue." }`.

---

## 6. Action `improveWithAi(articleId, instruction?)`

1. RBAC `article:regenerate`. `instruction` : chaîne facultative, bornée (ex. ≤ 500 car.).
2. Charger l'article (`title`, `bodyHtml`).
3. `improveArticleBody({ title, bodyHtml, instruction })` (nouveau, `lib/ai/improve-article.ts`) → `{ bodyHtml, via }` : prompt « réécris pour la clarté/le style, **conserve tous les faits**, n'ajoute pas de sources ni de section Sources » (+ instruction si fournie), sur la même chaîne `llmOrder`/`buildModel`. **`via === "mock"` → refuser** (message clair), ne pas toucher au corps.
4. **Snapshot** prior body → révision.
5. Transaction : `bodyHtml = sanitizeArticleHtml(nouveau)`, `status='pending'`, re-embed + re-cluster + re-score (le corps change) ; révision `action:"amélioré par IA"`.
6. `revalidatePath`. Retour `{ ok:true, message:"Corps amélioré — déposé en revue." }`.

---

## 7. UI

Les deux actions restent derrière le `RoleGate allow={["admin","editor"]}` existant, synchrones (spinner via le `useTransition` de l'action-bar).

- **« Renvoyer à l'IA »** (`components/article/action-bar.tsx`) : le bouton n'appelle plus directement `regenerate` — il ouvre une **boîte de dialogue de sélection** (`RegenerateDialog`) : 6 cases à cocher (Titre / Corps / Extrait / Catégorie / Tags / Image à la une), toutes cochées, bouton **« Régénérer »** (désactivé si zéro coché). Sur confirmation → `regenerate(articleId, fields)`. (Cases natives `<input type="checkbox">` — pas de primitive `checkbox` dans `components/ui`.)
- **« Améliorer avec IA »** (`components/article/editor-shell.tsx`) : retirer `disabled` + le tooltip « Bientôt (SP3) » ; le bouton ouvre une **boîte de dialogue** (`ImproveDialog`) avec un `Textarea` d'instruction **facultative** (placeholder « ex : raccourcir, ton plus formel… »), bouton **« Améliorer »** → `improveWithAi(articleId, instruction || undefined)`.
- Toasts : succès (message de l'action) / erreur (message serveur, ex. mode dégradé, aucune source).

---

## 8. Tests

- **Purs / unitaires** (`bun test`, sans DB) :
  - `buildImprovePrompt(input)` : contient l'instruction fournie + la consigne « conserver les faits » (exporté comme `buildArticlePrompt` l'est déjà).
  - Helper pur d'**application sélective** (`draft` + `fields` → l'ensemble des colonnes/valeurs à écrire) : seuls les champs cochés apparaissent ; garde « au moins un champ ».
- **Intégration DB** (Neon réel — la logique risquée testée **sans LLM** en injectant un `draft` synthétique) :
  - `applyRegeneration` avec un **`draft` synthétique** : semer un article `pending` (titre/corps/catégorie/tags/image connus), appeler `applyRegeneration` avec un sous-ensemble de `fields` → asserter que **seuls** ces champs ont changé, que la révision existe (snapshot titre+corps d'avant **+** liste des champs), `status='pending'` ; cas **corps coché** → embedding/score rafraîchis, cas **hors-corps** → embedding/score **inchangés**.
  - **Gardes au niveau action** (sans clé fournisseur → chemin mock) : `regenerate` sur un article **sans source** → `ok:false`, contenu **inchangé** ; garde **anti-mock** (aucune clé LLM → `generateArticle` `via:"mock"` → `regenerate` refuse, contenu **inchangé**).
  - `improveWithAi` : garde anti-mock ; et le cœur d'application (corps synthétique amélioré) → corps remplacé + snapshot + `status='pending'`.

---

## 9. Fichiers touchés (indicatif)

- `lib/actions/article-actions.ts` — `regenerate(articleId, fields)` réel ; nouvelle `improveWithAi(articleId, instruction?)`.
- `lib/pipeline/regenerate.ts` — nouveau : cœur partagé (snapshot + application sélective + re-embed/cluster/score via UPDATE).
- `lib/ai/improve-article.ts` — nouveau : `buildImprovePrompt` + `improveArticleBody`.
- `lib/pipeline/stages.ts` — exporter `resolveCategoryId` / `insertTags` si nécessaire (sinon répliquer le mapping).
- `lib/validation.ts` — schémas `regenerateFieldsSchema` (≥ 1 champ) + `improveInputSchema` (instruction bornée).
- `components/article/action-bar.tsx` — `RegenerateDialog` + branchement.
- `components/article/editor-shell.tsx` — activer « Améliorer avec IA » + `ImproveDialog`.
- Tests : `tests/regenerate.test.ts` (pur + intégration), `tests/ai-improve.test.ts` (prompt).
- Aucune migration (aucun nouveau champ).
