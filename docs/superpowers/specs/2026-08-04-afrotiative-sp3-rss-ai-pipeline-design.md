# Afrotiative Media — SP3 : Pipeline d'ingestion RSS → IA (provider-agnostic)

**Date :** 2026-08-04
**Statut :** Design validé — prêt pour le plan d'implémentation
**Branche :** `feat/sp3-rss-ai-pipeline` (empilée sur SP0+SP1, Tasks 1–13 + suivi ActionBar)
**Portée :** Sous-projet SP3 du programme. SP0+SP1 Tasks 14–15 restent en pause (reprise après SP3).

Documents sources : `compass_artifact_…_text_markdown.md` (architecture), `afrotiative-uiux-brief.md`, spec SP0+SP1.

---

## 1. Objectif

Remplacer l'automatisation externe (n8n) par un pipeline interne : lire les flux RSS, dédupliquer, extraire le texte intégral, **réécrire par IA** dans la voix française d'Afrotiative, et **déposer l'article en file de revue (`pending`)** avec ses sources et ses indicateurs de confiance — **sans jamais publier automatiquement**. La publication WordPress reste SP5.

**Principe directeur : l'IA propose, l'humain dispose.** Le pipeline s'arrête à la barrière de revue humaine (les articles produits atterrissent dans la File de revue construite en SP1).

**Thème architectural central : des fournisseurs enfichables, chaînés en repli (fallback), configurés par variables d'environnement, qui se dégradent gracieusement** — le pipeline tourne aujourd'hui même sans certaines clés, et se renforce dès qu'une clé est ajoutée. Inspiré du fonctionnement d'OmniRoute (routage + repli).

---

## 2. Périmètre

**Inclus :**
- Couches fournisseurs enfichables : **LLM**, **extraction**, **embeddings** — chacune une interface + chaîne d'adaptateurs ordonnée avec repli + adaptateur *mock*.
- Parsing RSS (`rss-parser`) sur les flux **actifs** (table `feeds` déjà seedée).
- Déduplication exacte (guid + URL normalisée + hash) **et** regroupement sémantique (embeddings + pgvector, table `article_embeddings` déjà présente).
- Génération IA structurée (Zod + auto-réparation) : titre, corps HTML, catégorie (contrainte à `wp_categories`), tags, extrait, image à la une (parmi les candidates), indicateurs de confiance.
- Orchestration **in-app** : route handler `POST /api/pipeline/run` + action serveur « Lancer une exécution maintenant » ; écriture de `pipeline_runs` / `pipeline_steps` (observabilité), erreurs reformulées en **français clair**.
- Surface minimale « Exécutions » : bouton *Lancer maintenant* + liste des dernières exécutions (l'écran Runs complet reste SP4).
- Sécurité du déclencheur (secret partagé), garde anti-chevauchement.

**Hors périmètre :** publication WordPress (SP5), écran Runs complet/traces détaillées (SP4), SP0+SP1 Tasks 14–15 (en pause), Trigger.dev (durabilité — ajout ultérieur possible ; l'orchestration in-app suffit pour cette version).

---

## 3. Découverte live des fournisseurs (2026-08-04)

Sondage réel des endpoints (clés dans `.env.local`) — informe les défauts :

- **OpenRouter** (`https://openrouter.ai/api/v1`) : OpenAI-compatible propre, sortie structurée fiable (`openai/gpt-4o-mini` → réponse nette). → **LLM primaire.**
- **OmniRoute** (`https://omniroute-production-4027.up.railway.app/v1`) : passerelle de routage, **561 modèles** (alias sémantiques `auto/chat`, `auto/best-chat`, `auto/fast`, `auto/cheap`, `auto/claude-sonnet`, `auto/gemini`…). ⚠️ **Renvoie du SSE (streaming) par défaut** et `auto/chat` peut router vers un modèle de *raisonnement* (`reasoning_content`). → **LLM de repli** ; l'adaptateur doit **forcer le non-streaming** (ou agréger le SSE) et choisir un alias de chat simple (ex. `auto/fast` / un modèle `ddgw/*`). Pas de provider d'embeddings configuré (`/embeddings` → « No credentials for embedding provider »).
- **Jina** : `r.jina.ai` (Reader, extraction) **et** `api.jina.ai/v1/embeddings` (`jina-embeddings-v3`, multilingue, **1024-dim confirmés**, clé partagée). → **embeddings réels** + extraction primaire.
- **Firecrawl** (`fc-…`) : extraction de repli (API standard `/v1/scrape`).

**Conséquence :** clustering sémantique **réel** dès le départ (Jina embeddings). LLM fiable dès le départ (OpenRouter primaire, OmniRoute repli).

---

## 4. Couches fournisseurs (le cœur)

Chaque couche : une interface, des adaptateurs, un **sélecteur d'ordre** lu depuis l'env, un repli sur erreur/quota, un **mock** terminal.

### 4.1 LLM — `lib/ai/`
- Fondation : **Vercel AI SDK** (`ai`) + providers `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai-compatible` (OpenRouter, OmniRoute).
- Interface : `generateArticle(input, schema): Promise<ArticleDraft>` via `generateObject` (validation Zod + réparation).
- Ordre : `LLM_ORDER="openrouter,omniroute"` ; repli sur quota/erreur/JSON invalide ; si tout échoue → **MockLLM** (texte français déterministe) pour que la run se termine.
- Adaptateur OmniRoute : **non-streaming forcé** + alias de chat simple.
- Modèles par provider via env (`OPENROUTER_MODEL="openai/gpt-4o-mini"`, `OMNIROUTE_MODEL="auto/chat"`), surchargeable.

### 4.2 Extraction — `lib/extract/`
- Interface : `extract(url): Promise<{ title, textOrHtml, markdown, images: string[], via: string }>`.
- Chaîne `EXTRACT_ORDER="jina,firecrawl,readability"` :
  1. **Jina Reader** (`https://r.jina.ai/<url>`, clé) → markdown propre.
  2. **Firecrawl** (`/v1/scrape`, clé) si Jina épuisé/en erreur.
  3. **Readability + jsdom + DOMPurify** (auto-hébergé, sans clé) — **termine toujours** la chaîne ; sélecteurs de repli (`article`, `main`, `[role=main]`) si < 100 caractères.
- Capture des **images candidates** (og:image, `<img>` de taille raisonnable) pour l'étape image à la une.
- Chaque repli journalise **pourquoi** (quota vs erreur) en français dans `pipeline_steps`. Extraction pauvre tolérée : l'IA écrit à partir du peu obtenu.

### 4.3 Embeddings — `lib/embeddings/`
- Interface : `embed(text): Promise<number[]>` (longueur **1024**, = colonne `article_embeddings.embedding vector(1024)`).
- Adaptateur **Jina** (`api.jina.ai/v1/embeddings`, `jina-embeddings-v3`, `dimensions:1024`) par défaut ; **MockEmbedder** déterministe (hash → vecteur) en repli si pas de clé/erreur. L'adaptateur normalise à 1024 dims si un futur provateur diffère.

---

## 5. Étapes du pipeline (une exécution)

`POST /api/pipeline/run` (ou le bouton) ouvre une ligne `pipeline_runs` (`triggered_by`, `status='running'`), puis **par flux actif** :

1. **fetchFeed** — `rss-parser` ; try/catch par flux (un flux cassé n'interrompt jamais la run) ; enregistre `raw_items` (guid, url, content_hash normalisé).
2. **dedup** — ignore si guid / URL normalisée / hash déjà vus (`raw_items`). *(exact/near-exact)*
3. **extract** — chaîne Jina→Firecrawl→Readability ; capture images candidates.
4. **embed + cluster** — calcule l'embedding (titre+corps) **en mémoire** ; recherche pgvector du plus proche voisin parmi les `article_embeddings` **existants** (jointure `articles`, fenêtre `articles.generated_at ≥ now−72 h`) au-dessus d'un seuil cosinus (config `CLUSTER_THRESHOLD`, défaut ~0.83) → décide `cluster_id` (rattachement à un cluster existant même-sujet, ou nouveau). Le vecteur est **persisté à l'étape 6** (la table `article_embeddings` est clé-étrangère `article_id`, l'article n'existe pas encore ici).
5. **aiGenerate** — passe **tous les textes sources du cluster** + la liste `wp_categories` autorisée à `generateArticle` → `{title, bodyHtml, category (enum), tags[], excerpt, featuredImageUrl (parmi candidates), confidenceFlags}`. Catégorie contrainte à l'enum ; `confidenceFlags` posés quand l'IA hésite (catégorie/image/regroupement).
6. **stageForReview** — insère un `articles` `status='pending'`, `ai_author=true`, `generated_at=now`, + `article_sources` (média + lien), `article_tags` (avec `is_new` selon présence dans `wp_tags`), `confidence_flags`, `cluster_id`, **et la ligne `article_embeddings` (article_id + vecteur calculé à l'étape 4)**.

Chaque étape écrit une ligne `pipeline_steps` (nom, statut, durée, `error_message` clair + `error_technical`). La run finit `success` / `partial` / `failed` ; compteurs `feeds_read`, `new_items`, `published`(=0 ici, revue humaine).

---

## 6. Configuration & fonctionnement sans clé

Toutes les clés optionnelles dans `.env.local` (déjà renseignées : `JINA_API_KEY`, `FIRECRAWL_API_KEY`, `OMNIROUTE_*`, `OPENROUTER_API_KEY`, `EMBED_*=Jina`, `LLM_ORDER`, `EXTRACT_ORDER`, `PIPELINE_TRIGGER_SECRET`). `.env.example` documente les noms sans secrets.
- Sans **aucune** clé : Readability + MockLLM + MockEmbedder → run complète, articles `pending` de substitution.
- Avec les clés actuelles : Jina/Firecrawl/Readability + OpenRouter(/OmniRoute) + Jina-embeddings → **articles réels + clustering réel** dès aujourd'hui.
- Chargement env : `process.loadEnvFile('.env.local')` (déjà le motif du repo) ; Bun auto-charge pour `bun run`/`bun test`.

---

## 7. Déclenchement, sécurité, observabilité

- **Manuel** : action serveur « Lancer une exécution maintenant », **RBAC** (`pipeline`:`configure` = Admin ; `read` = Éditeur ; jamais Journaliste) — bouton visible Admin/Éditeur.
- **Cron externe** : `POST /api/pipeline/run` protégé par en-tête `Authorization: Bearer $PIPELINE_TRIGGER_SECRET` (toutes les 15–20 min).
- **Garde anti-chevauchement** : refuse une nouvelle run si une run `running` existe (ou dépasse un TTL de sécurité).
- **Observabilité** : `pipeline_runs`/`pipeline_steps` ; erreurs en langage clair + repli technique. Surface minimale ici (bouton + dernières runs) ; écran complet SP4.
- **Coûts/limites** : cap configurable d'articles par run (`MAX_ITEMS_PER_RUN`, défaut ~20) ; journalise ce qui est tronqué (pas de troncature silencieuse).

---

## 8. Modèle de données

Aucune nouvelle table : le schéma SP0 les a toutes (`feeds`, `raw_items`, `articles`, `article_sources`, `article_tags`, `article_embeddings` (HNSW cosinus), `clusters`, `pipeline_runs`, `pipeline_steps`). La fenêtre temporelle du clustering utilise `articles.generated_at` (jointure), donc **pas besoin** d'un timestamp sur `article_embeddings`. Si un champ manque vraiment à la marge (ex. `raw_items.normalized_url` si l'on préfère le matérialiser plutôt que le calculer), l'ajouter via une migration Drizzle **additive** (jamais destructive).

---

## 9. Gestion des erreurs

- Un flux/une source en échec → l'étape est `failed` avec message clair, la run continue (`partial`).
- Provider LLM/extraction en échec/quota → repli automatique au suivant ; si le mock est atteint, l'article est marqué faible confiance.
- JSON IA invalide → boucle de réparation `generateObject` (N essais) ; échec final → étape `failed`, pas d'article partiel inséré.
- Jamais de stack trace en première lecture ; détail technique en repli.

---

## 10. Tests & vérification

- **Unitaires (sans réseau)** : clé de dedup (guid/url/hash), logique de seuil de cluster, schéma Zod `ArticleDraft` + réparation, ordre de sélection/repli des providers, déterminisme Mock LLM/Embedder, extraction des images candidates, normalisation d'URL.
- **Intégration (réseau réel, opt-in via env présentes)** : une run end-to-end sur un flux seedé → ≥1 article `pending` réel + `pipeline_runs`/`steps` peuplés ; nettoyage/reseed après.
- **Vérification applicative** : lancer une run, puis piloter l'app — le nouvel article apparaît dans la File de revue et s'ouvre dans l'éditeur (parcours SP1 intact).

---

## 11. Structure de fichiers

```
lib/ai/{index.ts, providers.ts, generate-article.ts, schema.ts, mock.ts}
lib/extract/{index.ts, jina.ts, firecrawl.ts, readability.ts, images.ts}
lib/embeddings/{index.ts, jina.ts, mock.ts}
lib/rss/parse-feed.ts
lib/pipeline/{run.ts, dedup.ts, cluster.ts, stages.ts, overlap.ts}
lib/config/pipeline-config.ts        # ordre + clés + défauts sûrs
app/api/pipeline/run/route.ts        # POST, secret bearer
lib/actions/pipeline-actions.ts      # « Lancer maintenant » (RBAC)
components/pipeline/run-now.tsx      # bouton + dernières runs (surface minimale)
app/(app)/runs/page.tsx              # remplace le placeholder par la surface minimale
db/migrations/…                      # migrations additives si nécessaire
tests/{dedup,cluster,ai-schema,providers,extract-images,pipeline-run}.test.ts
```

---

## 12. Décisions & alternatives écartées

- **Vercel AI SDK** (retenu) plutôt que le SDK `openai` brut : abstraction multi-provider native (OpenAI/Anthropic/Google/OpenRouter/OmniRoute) + `generateObject` — colle à l'exigence « flexible, peut être OpenRouter/OmniRoute/Claude/OpenAI/Gemini ».
- **OpenRouter primaire, OmniRoute repli** (retenu) : sondage live → OpenRouter fiable en sortie structurée ; OmniRoute streame/route vers du raisonnement (adaptateur plus délicat).
- **Embeddings Jina** (retenu) plutôt que Mock-only : clé déjà disponible, 1024-dim réels → clustering sémantique réel immédiat ; Mock en repli.
- **Orchestration in-app** (retenu) plutôt que Trigger.dev : chemin le plus court vers un pipeline complet et observable, sans infra ; Trigger.dev possible plus tard.
- **Dedup exact + clustering sémantique** (retenu, per user) : les deux couches, du moins cher au plus riche.
