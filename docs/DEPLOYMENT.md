# Afrotiative Media — Runbook de déploiement & exploitation

Back-office de la rédaction : **RSS → réécriture IA (français) → revue humaine → publication WordPress**.
Ce document est le guide pour mettre la plateforme en production et l'exploiter au quotidien.

> **Barrière de revue humaine (non négociable) :** aucun article n'est publié sans qu'un humain l'ait approuvé.
> La publication planifiée ne touche que des articles déjà `approved`. Rien dans ce runbook ne contourne cette règle.

---

## 1. Prérequis

| Composant | Exigence |
|---|---|
| **Runtime** | Node 20+ (l'app tourne sur Node ; Bun sert de gestionnaire de paquets / test runner / lanceur de scripts). Bun 1.x installé. |
| **Base de données** | PostgreSQL avec l'extension **pgvector** (Neon recommandé — pgvector préinstallé). Deux URLs : pooled (app) + direct (migrations). |
| **WordPress** *(pour publier)* | WP 5.6+ (Application Passwords), **permaliens jolis** activés, `/wp-json` accessible publiquement, un utilisateur bot de rôle **Editor** minimum. |
| **Hébergement** | N'importe quel hôte Node/Next (Vercel, Railway, Fly, VPS). `maxDuration` des routes cron = 300 s : sur Vercel, plan qui autorise 300 s de fonction. |
| **Ordonnanceur** | Un cron externe capable de faire deux `POST` HTTP authentifiés (Vercel Cron, GitHub Actions, cron-job.org, crontab système…). |

---

## 2. Variables d'environnement

Toutes les valeurs vivent dans `.env.local` (gitignoré — **jamais commité, jamais imprimé**). Le fichier `.env.example` (à la racine) est la liste de référence à jour, avec des commentaires par variable. En production, injectez ces variables via le gestionnaire de secrets de l'hôte, pas via un fichier.

**Obligatoires :**

| Variable | Rôle |
|---|---|
| `DATABASE_URL` | Postgres pooled (utilisé par l'app). |
| `DIRECT_URL` | Postgres direct (utilisé par les migrations drizzle-kit). |
| `BETTER_AUTH_SECRET` | Secret de session. Générer : `openssl rand -base64 32`. |
| `BETTER_AUTH_URL` | URL publique de l'app (ex. `https://admin.afrotiative.com`). |

**Pipeline (SP3) — tout optionnel** ; sans clés, le pipeline tourne en **mode dégradé** (extraction Readability locale + génération/embeddings *mock*), il ne plante jamais mais produit des brouillons marqués dégradés :

`LLM_ORDER`, `OPENROUTER_API_KEY`, `OMNIROUTE_BASE_URL`/`OMNIROUTE_API_KEY`, `EXTRACT_ORDER`, `JINA_API_KEY`, `FIRECRAWL_API_KEY`, `EMBED_*`, `CLUSTER_THRESHOLD`, `MAX_ITEMS_PER_RUN`, `CLUSTER_WINDOW_HOURS`. Voir `.env.example` pour les défauts.

- **`PIPELINE_TRIGGER_SECRET`** — **requis** pour autoriser le cron `POST /api/pipeline/run`. Sans lui, l'endpoint répond toujours 401 (jamais ouvert). Générer : `openssl rand -hex 32`.

**WordPress (SP5) — laisser les 4 vides désactive proprement la publication** (`getWpConfig()` renvoie `null`, la publication no-op avec un message clair) :

| Variable | Rôle |
|---|---|
| `WP_BASE_URL` | ex. `https://afrotiative.com` (sans slash final). |
| `WP_USER` | utilisateur WordPress lié à l'Application Password. |
| `WP_APP_PASSWORD` | Application Password WP (les espaces sont retirés automatiquement). |
| `PUBLISH_TRIGGER_SECRET` | **requis** pour autoriser le cron `POST /api/publish/due` (401 sinon). Générer : `openssl rand -hex 32`. |

> Les deux `*_TRIGGER_SECRET` doivent être **distincts** l'un de l'autre et de tout autre secret.

---

## 3. Mise en place de la base de données

### 3.1 Deux branches Neon : `dev` et `production`

La sélection de la branche est **entièrement pilotée par l'environnement** — aucun code à changer. Le runtime lit `DATABASE_URL` (pooled) ; les migrations lisent `DIRECT_URL` (direct). Il suffit que chaque environnement charge la bonne connexion :

| Environnement | Charge | Pointe vers |
|---|---|---|
| **Local** (`bun run dev`) | `.env.local` (gitignoré, jamais déployé) | branche **`dev`** |
| **Live** (hôte déployé) | variables d'env du gestionnaire de secrets de l'hôte | branche **`production`** |

Règles :
- Les identifiants de **`production`** ne vivent **que** dans le gestionnaire de secrets de l'hôte — **jamais** dans un fichier commité **ni dans `.env.local`** (sinon une commande destructive locale viserait la production).
- `.env.local` contient **uniquement** la branche `dev`. Comme il est gitignoré, il n'est jamais déployé ; sur l'hôte, les vraies variables d'env priment.
- Posez `PRODUCTION_DB_HOST` (le hostname de l'endpoint `production`, ex. `ep-xxx.neon.tech`) dans l'env de l'hôte : le script de seed refusera alors de viser cette base (garde-fou anti-écrasement).

### 3.2 Migrations & extension

```bash
bun install
bun run db:migrate        # applique les migrations drizzle (utilise DIRECT_URL)
```

- **pgvector** : sur chaque branche Neon, activez l'extension une fois (`CREATE EXTENSION IF NOT EXISTS vector;`) — les migrations posent l'index HNSW sur `article_embeddings`.
- **Migrer la `production`** : exécutez `bun run db:migrate` **dans l'environnement de déploiement** (l'hôte fournit alors `DIRECT_URL` = branche `production`), typiquement comme étape de build/release — pas depuis votre poste avec des creds de prod dans `.env.local`.

### 3.3 Seed — développement uniquement (destructif)

`bun run db:seed` **efface toutes les tables applicatives** puis recrée des données de démo (comptes à mot de passe partagé). Réservé au développement, jamais à la production. Garde-fous intégrés :
- refus sous `NODE_ENV=production` ;
- refus si la cible correspond à `PRODUCTION_DB_HOST` ;
- sinon, exige une confirmation explicite et affiche toujours le hostname cible :

```bash
CONFIRM_SEED=1 bun run db:seed    # affiche « db:seed → cible : ep-…neon.tech » avant d'effacer
```

---

## 4. Créer le premier administrateur (production)

Sans email transactionnel, l'onboarding se fait par mot de passe temporaire depuis **Réglages → Équipe**. Mais il faut d'abord **un** admin pour se connecter. Créez-le sans seeder de données de démo :

```bash
ADMIN_EMAIL="vous@afrotiative.com" \
ADMIN_NAME="Votre Nom" \
ADMIN_PASSWORD='choisir-un-mot-de-passe-fort-12+' \
bun run db:create-admin
```

Le script refuse si l'email existe déjà et n'imprime jamais le mot de passe. Connectez-vous ensuite et créez le reste de l'équipe depuis **Réglages → Équipe** (chaque membre reçoit un mot de passe temporaire affiché une seule fois).

---

## 5. Build & démarrage

```bash
bun run build
bun run start            # sert la build de production sur le port 3000
```

Vérification rapide : `bun test` (135 tests, sans réseau ni clés), `bun run typecheck`.

---

## 6. Les deux tâches cron (le cœur de l'automatisation)

L'automatisation repose sur **deux endpoints POST protégés par bearer**, appelés par un ordonnanceur externe. Chacun renvoie 401 si le secret manque ou ne correspond pas — ils ne sont **jamais** ouverts.

### 6.1 Ingestion du pipeline — `POST /api/pipeline/run`

Récupère les flux RSS actifs, extrait/réécrit/embed/cluster, crée des brouillons `pending` pour la file de revue.

```bash
curl -fsS -X POST https://VOTRE-APP/api/pipeline/run \
  -H "Authorization: Bearer $PIPELINE_TRIGGER_SECRET"
```

- **Cadence recommandée : toutes les 15–20 min.**
- **Anti-chevauchement intégré** : si un run est déjà en cours → `409 {"error":"already running"}` (sûr à réappeler, aucun double traitement).
- Réponses : `200` avec le récap du run ; `401` (secret) ; `409` (déjà en cours).
- `maxDuration = 300 s`.

### 6.2 Publication planifiée — `POST /api/publish/due`

Publie sur WordPress les articles **déjà `approved`** dont `scheduledAt <= maintenant`. Un échec sur un article n'arrête pas les autres (article laissé `approved`, distribution `failed`, **rejouable**).

```bash
curl -fsS -X POST https://VOTRE-APP/api/publish/due \
  -H "Authorization: Bearer $PUBLISH_TRIGGER_SECRET"
```

- **Cadence recommandée : toutes les ~5 min.**
- Ne publie **que** du `approved` planifié → la barrière de revue humaine est préservée.
- Réponses : `200 {"published":n,"failed":m}` ; `401` (secret).
- `maxDuration = 300 s`.

### 6.3 Exemple — Vercel Cron (`vercel.json`)

> Vercel Cron n'envoie pas d'en-tête `Authorization`. Deux options : (a) déclencher via un service externe qui envoie le bearer (recommandé), ou (b) adapter les routes pour accepter aussi le header `x-vercel-cron` / un secret en query. L'exemple ci-dessous illustre la **cadence** ; le bearer reste requis par le code actuel.

```json
{
  "crons": [
    { "path": "/api/pipeline/run", "schedule": "*/20 * * * *" },
    { "path": "/api/publish/due",  "schedule": "*/5 * * * *" }
  ]
}
```

### 6.4 Exemple — crontab système / cron-job.org

```cron
*/20 * * * *  curl -fsS -X POST https://VOTRE-APP/api/pipeline/run -H "Authorization: Bearer $PIPELINE_TRIGGER_SECRET"
*/5  * * * *  curl -fsS -X POST https://VOTRE-APP/api/publish/due  -H "Authorization: Bearer $PUBLISH_TRIGGER_SECRET"
```

---

## 7. Checklist de première mise en route

1. [ ] Variables d'env posées (§2) ; `DATABASE_URL`/`DIRECT_URL` valides ; les deux `*_TRIGGER_SECRET` générés et distincts.
2. [ ] `bun install && bun run db:migrate` ; extension pgvector active.
3. [ ] `bun run db:create-admin` → premier admin créé (§4).
4. [ ] `bun run build && bun run start` (ou déploiement hôte) ; l'app répond sur `/login`.
5. [ ] Connexion admin → **Réglages → Sources RSS** : ajouter les vrais flux, **« Vérifier ce flux »** avant d'activer.
6. [ ] **Réglages → Intégrations** : « Tester » WordPress (doit être *configuré* + connexion OK) et les fournisseurs IA.
7. [ ] **Réglages → Catégories & Tags** : « Synchroniser depuis WordPress » → la vraie taxonomie remplace les placeholders (l'IA choisit une catégorie dans ce miroir).
8. [ ] **Réglages → Équipe** : créer les comptes éditeurs/journalistes (mot de passe temporaire communiqué à chacun).
9. [ ] Déclencher **une** fois le pipeline manuellement (curl §6.1) → vérifier des brouillons dans **/queue**.
10. [ ] Revue humaine : ouvrir un article dans l'éditeur, corriger, **« Approuver & publier »** → post WordPress en ligne (vérifier titre/catégorie/tags/image/crédit + pied de sources).
11. [ ] Seulement ensuite : **activer les deux crons** (§6). L'automatisation tourne.

---

## 8. Notes d'exploitation

- **Observabilité** : `/runs` liste chaque exécution du pipeline (statut, étapes, items, erreurs) ; le tiroir de détail permet de **retraiter** un item ou **relancer** un run.
- **Mode dégradé** : sans clés IA, les brouillons sont produits mais marqués dégradés (`confidenceFlags.aiDegraded`) — visibles en revue, jamais publiés automatiquement.
- **WordPress non configuré** : toute tentative de publication renvoie « WordPress non configuré » et laisse l'article `approved` (jamais de faux succès).
- **Image fail-soft** : si l'image à la une échoue, le post part **sans** image (jamais de post à moitié cassé) ; l'éditeur peut l'ajouter puis **Republier**.
- **Idempotence** : republier met à jour le post WP existant (via `distributions.externalId`), jamais de doublon.
- **Dépublier / Republier** : depuis l'éditeur d'un article publié (rôles Éditeur/Admin).
- **Sécurité** : secrets uniquement en `.env`/gestionnaire de secrets ; endpoints cron bearer-gardés ; RBAC appliqué **côté serveur** sur chaque action (pas seulement l'UI) ; un admin ne peut pas se verrouiller lui-même (anti-lockout).

---

## 9. Rôles (rappel)

| Rôle | Peut |
|---|---|
| **Admin** | tout, y compris Équipe & Intégrations. |
| **Éditeur** | revue, édition, publier/dépublier, gérer Sources RSS + Catégories/Tags. Pas d'accès Équipe/Intégrations. |
| **Journaliste** | rédaction/revue de ses articles. Aucun accès aux Réglages. |

---

## 10. Dépannage rapide

| Symptôme | Cause probable / action |
|---|---|
| `401` sur un cron | Secret absent/incorrect dans l'en-tête `Authorization: Bearer …`. Vérifier la variable côté ordonnanceur. |
| `409 already running` (pipeline) | Un run est déjà en cours — normal, l'anti-chevauchement protège. Réessayer plus tard. |
| Brouillons « dégradés » | Clés IA absentes/invalides → mode mock. Renseigner `OPENROUTER_API_KEY`/`JINA_API_KEY` et retester dans Intégrations. |
| « WordPress non configuré » à la publication | Une des 4 variables `WP_*` manque. Compléter puis « Tester » dans Intégrations. |
| Publication planifiée qui ne part pas | L'article doit être `approved` **et** avoir un `scheduledAt` passé ; le cron `/api/publish/due` doit tourner. |
| Erreur pgvector au build/migrate | Extension `vector` non activée sur la base. `CREATE EXTENSION IF NOT EXISTS vector;`. |
