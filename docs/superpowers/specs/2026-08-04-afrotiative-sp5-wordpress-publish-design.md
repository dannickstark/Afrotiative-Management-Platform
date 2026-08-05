# Afrotiative Media — SP5 : Publication WordPress (fermeture de la boucle)

**Date :** 2026-08-04
**Statut :** Design validé — prêt pour le plan d'implémentation
**Branche :** `feat/sp5-wordpress-publish` (empilée sur SP4 → SP3 → SP0+SP1)
**Portée :** Sous-projet SP5. SP0+SP1 Tasks 14–15 restent en pause.

Documents sources : `compass_artifact_…` §6 (WordPress REST), `afrotiative-uiux-brief.md` §6.4/6.7, spec SP0+SP1.

---

## 1. Objectif

Fermer la boucle **RSS → IA → revue humaine → publication**. Aujourd'hui « Approuver & publier » est simulé (écrit `distributions` `status:'stubbed'`). SP5 le branche sur une **vraie publication WordPress** via l'API REST : télécharge l'image à la une, l'uploade, crée/met à jour l'article WP avec catégorie/tags/image/crédit, stocke l'id du post (idempotence), et passe l'article en `published`. Plus : **dépublier** / **republier** depuis l'éditeur, et **publication planifiée automatique** (les articles approuvés + planifiés partent à l'heure dite).

**Barrière de revue humaine préservée (non négociable) :** rien ne se publie sans qu'un humain ait approuvé. La publication planifiée ne publie que des articles déjà `approved` (donc déjà validés par un humain).

> **Mise à jour SP6 (auto-publication contrôlée) :** un article peut désormais aussi atteindre `approved` sans clic humain, via une **exception explicitement configurée, désactivée par défaut, et auditée** (`shouldAutoPublish` — score ≥ seuil, ≥ N sources, image présente, aucun drapeau de faible confiance ; voir `lib/pipeline/auto-publish.ts` et `article_revisions` pour l'entrée « publié automatiquement »). `publishDueArticles` et `publishArticle` décrits ci-dessous restent **inchangés** : ils ne publient toujours que du `status='approved'`, quelle que soit la façon dont l'article y est arrivé. Voir README.md pour la politique complète.

**Thème :** un **adaptateur de canal enfichable** (`PublishChannel`) — WordPress aujourd'hui, WhatsApp/réseaux sociaux plus tard — s'appuyant sur la table `distributions` déjà prévue à cet effet.

---

## 2. Périmètre

**Inclus :**
- **`WordPressClient`** typé (raw `fetch`, Basic Auth via Application Password) : catégories/tags (resolve-or-create), upload média en deux temps, create/update post, changement de statut (publish/draft/trash), test de connexion.
- **`PublishChannel`** (interface) + **`WordPressChannel`** ; `publishArticle` / `unpublishArticle` / `republishArticle` opérant sur `distributions` (canal + statut + `externalId` = id du post WP).
- **Branchement des actions existantes** : `approveAndPublish` (éditeur) + `quickApprove` (file) → vraie publication ; **Dépublier** / **Republier** depuis l'éditeur (article publié en lecture seule).
- **Publication planifiée** : `publishDueArticles()` + `POST /api/publish/due` (bearer `PUBLISH_TRIGGER_SECRET`) pour un cron externe.
- **Mapping** catégorie (`wp_categories.wpId`) + tags (resolve-or-create côté WP, reflété dans le miroir `wp_tags` + `article_tags.is_new`) ; **image à la une** (téléchargement → upload → `featured_media`) ; **pied de sources + crédit image obligatoire** ajoutés au corps.
- **RBAC** : publier/dépublier/republier = `article:publish` (Éditeur + Admin) ; cron = secret bearer.
- Erreurs **en français clair** ; en cas d'échec l'article reste `approved`, `distribution:'failed'`, **rejouable — jamais perdu**.

**Hors périmètre :** écran Réglages → Intégrations (statut de connexion UI) = SP2/P2 (SP5 configure par env + un helper `testWordPressConnection()`) ; canaux WhatsApp/sociaux = SP6 ; SP0+SP1 Tasks 14–15.

---

## 3. Configuration

Env (gitignoré, déjà dans `.env.local`) : `WP_BASE_URL` (ex. `https://afrotiative.com`), `WP_USER` (utilisateur bot rôle **Editor**), `WP_APP_PASSWORD` (Application Password ; WordPress **retire les espaces** côté serveur — le client fait de même), `PUBLISH_TRIGGER_SECRET`. En-tête : `Authorization: Basic base64(user:app_password_sans_espaces)`. Pré-requis WP : 5.6+ (Application Passwords), permaliens jolis, `/wp-json` accessible.

**Fonctionnement sans `WP_BASE_URL`/creds :** toute tentative de publication renvoie une erreur claire « WordPress non configuré » (l'article reste `approved`) — jamais un faux succès. La vérification réelle (Task finale) exige les creds.

---

## 4. `WordPressClient` (raw fetch)

Base : `${WP_BASE_URL}/wp-json/wp/v2`. Méthodes :
- `getCategories()` / `getTags()` — GET, pagination gérée.
- `resolveOrCreateTag(name)` — GET `/tags?search=` ; si absent, POST `/tags` → id.
- `uploadMedia(bytes, filename, mime)` — POST `/media` binaire (`Content-Disposition: attachment; filename=...`, `Content-Type: <mime>`, corps = octets bruts) → `{id, source_url}`. (Le média distant est **téléchargé côté serveur** dans un buffer d'abord.)
- `createPost(payload)` / `updatePost(id, payload)` — POST/PUT `/posts` avec `{title, content, excerpt, status, categories:[ids], tags:[ids], featured_media}` → `{id, link}`.
- `setPostStatus(id, 'publish'|'draft'|'trash')` — PUT `/posts/{id}` (`status`) ou DELETE (`trash`).
- `testConnection()` — GET `/users/me?context=edit` → 200 = creds valides + droits.
- Tout non-2xx → `WordPressError` avec message français + code/corps techniques.

Client typé, sans dépendance (fetch natif). Pas de jsdom → pas d'import dynamique nécessaire (l'action reste standard ; Next tourne sur Node depuis SP4).

---

## 5. Canal & `publishArticle`

- Interface `PublishChannel { publish(article): Promise<{externalId}>; update(article, externalId): Promise<void>; unpublish(externalId): Promise<void> }`.
- `WordPressChannel` implémente via `WordPressClient`.
- **`publishArticle(articleId)`** :
  1. Charge l'article + `wp_categories.wpId` (via `categoryId`), `article_tags`, `article_sources`, image (`featuredImageUrl`, `imageCredit`, `imageSourceUrl`).
  2. Valide : catégorie requise + crédit image requis si image (mêmes règles que `approveAndPublish`).
  3. Construit le corps : `bodyHtml` + **pied « Sources »** (média + lien, tel qu'à l'écran) + **crédit image**.
  4. Résout la catégorie (wpId) ; resolve-or-create les tags → ids (met à jour le miroir `wp_tags` + `article_tags.is_new=false`).
  5. Si image : télécharge → `uploadMedia` → `featured_media`.
  6. **Idempotent** : si `distributions` a déjà un `externalId` pour (`article`, `wordpress`) → `updatePost` ; sinon `createPost` (`status:'publish'`).
  7. Écrit `distributions` (`channel:'wordpress'`, `status:'sent'`, `externalId:<postId>`, `at:now`) ; passe l'article `published`, `publishedAt:now`.
  - Échec à toute étape → `distributions` `status:'failed'`, article **reste `approved`**, remonte l'erreur française ; rejouable.
- **`unpublishArticle(articleId)`** : `setPostStatus(externalId,'draft')` (ou trash selon choix) ; article → `approved` ; `distributions` mis à jour.
- **`republishArticle(articleId)`** : `updatePost(externalId, ...)` avec le contenu corrigé ; article reste `published`, `publishedAt` inchangé.

---

## 6. Branchement des actions

- **`approveAndPublish(id)`** (`lib/actions/article-actions.ts`) et **`quickApprove(id)`** (`lib/actions/queue-actions.ts`) : remplacer le stub `distributions:'stubbed'` par `await publishArticle(id)`. `requirePermission(role,"article","publish")` (déjà en place). Sur succès : article `published` + toast « Publié sur WordPress ». Sur échec : toast erreur française, article `approved`.
- **Éditeur (article publié, lecture seule)** : boutons **Dépublier** (`unpublishArticle`) et **Republier** (`republishArticle`) sous `RoleGate allow={["admin","editor"]}` — câble les placeholders SP1.
- **`schedule({id, at})`** inchangé (pose `scheduledAt` + `approved`) ; c'est le cron qui publiera.

---

## 7. Publication planifiée

- **`publishDueArticles()`** : sélectionne les articles `status='approved' AND scheduledAt IS NOT NULL AND scheduledAt <= now`, publie chacun via `publishArticle` (try/catch par article — un échec n'arrête pas les autres), renvoie un compte `{published, failed}`.
- **`POST /api/publish/due`** : garde `Authorization: Bearer $PUBLISH_TRIGGER_SECRET` (401 si absent/faux — jamais ouvert), appelle `publishDueArticles()`, renvoie le compte. `maxDuration` élevé. Un cron externe l'appelle toutes les ~5 min.
- **Barrière préservée** : ne publie que du `approved` (déjà validé par un humain).

---

## 8. Modèle de données

Aucune nouvelle table : `distributions` (SP0) porte `articleId, channel, status, externalId, at`. `status` enum `distributionStatus` = `stubbed|pending|sent|failed` (déjà présent ; on utilise `sent`/`failed`). `wp_categories.wpId` / `wp_tags.wpId` existent. Si un champ manque vraiment (peu probable), migration **additive** uniquement.

---

## 9. Gestion des erreurs

- WordPress non configuré (pas de `WP_BASE_URL`/creds) → « WordPress non configuré » ; article reste `approved`.
- Échec réseau/HTTP WP → message français (« La publication sur WordPress a échoué : … ») + détail technique loggé ; `distributions:'failed'` ; rejouable.
- Image en échec (téléchargement/upload) → **fail-soft** : publier le post **sans** `featured_media` et journaliser l'échec image dans `distributions` (ou une révision), plutôt que de bloquer toute la publication pour une image manquante. L'éditeur pourra ajouter une image ensuite via republier. Jamais un post à moitié cassé.
- Jamais laisser l'article dans un état incohérent (transaction/ordre : ne passer `published` qu'après un post WP réussi).

---

## 10. Tests & vérification

- **Unitaires (sans réseau)** : construction du payload (catégorie/tags/`featured_media`/corps+pied sources+crédit) ; décision idempotente create-vs-update (selon `externalId` existant) ; sélection des articles « dus » (`publishDueArticles` query) ; resolve-or-create tag ; gardes RBAC des actions ; garde bearer du cron. Le `WordPressClient` HTTP testé via un serveur `Bun.serve` factice simulant les endpoints WP.
- **Vérification réelle (exige `WP_BASE_URL` + creds)** : `testConnection()` OK ; publier UN article approuvé seedé → **post réel visible** sur le WP avec bon titre/catégorie/tags/image/crédit + pied de sources ; `updatePost` (republier) reflète une correction ; `unpublish` met le post en brouillon/corbeille ; nettoyer le post de test. Piloter l'app : « Approuver & publier » depuis la file → post en ligne + article `published` ; dépublier/republier depuis l'éditeur.

---

## 11. Structure de fichiers

```
lib/wp/{client.ts, channel.ts, publish.ts, config.ts}   # WordPressClient, WordPressChannel, publishArticle/unpublish/republish, env
lib/actions/publish-actions.ts        # dépublier/republier server actions (ou étendre article-actions)
lib/actions/article-actions.ts        # approveAndPublish → publishArticle (remplace le stub)
lib/actions/queue-actions.ts          # quickApprove → publishArticle
app/api/publish/due/route.ts          # POST bearer — publie les articles planifiés dus
components/article/publish-controls.tsx  # Dépublier / Republier (article publié)
tests/{wp-client,wp-publish,publish-due}.test.ts
```

---

## 12. Décisions & alternatives écartées

- **Client `fetch` typé** (retenu) plutôt qu'une lib WP : `node-wpapi` non maintenue ; contrôle total du flux média deux-temps (compass §6).
- **Publication synchrone dans l'action** (retenu) plutôt qu'une file : un seul article, l'éditeur attend quelques secondes ; simple et observable. (Une file/Trigger.dev reste possible plus tard.)
- **Idempotence via `distributions.externalId`** (retenu) : republier met à jour le post existant plutôt que d'en créer un doublon.
- **Cron `POST /api/publish/due` secret** (retenu) pour la planification, cohérent avec le déclencheur pipeline SP3.
- **Adaptateur de canal enfichable** (retenu) : WordPress d'abord, WhatsApp/sociaux en réutilisant `distributions` (SP6).
- **Barrière de revue** : la publication planifiée ne touche que du `approved` — aucun contournement de la validation humaine.
