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

**Studio de gabarits (V1 + V2 + V3) — laisser les 5 vides désactive proprement le studio** (`getStudioConfig()`
renvoie `null`) :

| Variable | Rôle |
|---|---|
| `R2_ACCOUNT_ID` | Identifiant de compte Cloudflare. |
| `R2_ACCESS_KEY_ID` | Jeton API R2. |
| `R2_SECRET_ACCESS_KEY` | Secret associé au jeton API R2. |
| `R2_BUCKET` | Nom du bucket (ex. `afrotiative-media`). |
| `R2_PUBLIC_BASE_URL` | Base des URLs publiques (ex. `https://media.afrotiative.com`). |

Sans ces cinq variables, le studio bascule en **lecture seule** plutôt que d'échouer au clic avec une
pile brute :

- **Pipeline (V1)** : `renderForArticle` (déclenché par l'onglet « Aperçu final » de `/article/[id]`
  et par `buildPublishPayload`, V3 — voir « Publication (V3) » ci-dessous) répond avec
  `{ ok: false, message: "Stockage R2 non configuré." }`, jamais une exception. Côté publication,
  ce cas précis **n'échoue pas** : c'est un réglage d'opérateur (le studio visuel n'est pas activé
  du tout), pas un échec par article — la publication retombe sur l'image brute
  (`articles.featuredImageUrl`), exactement comme avant V3.
- **Interface (V2)** : `/studio`, `/studio/[id]`, `/studio/assets` et `/studio/generer` affichent
  chacune une bannière française explicite (« Stockage R2 non configuré ») et désactivent
  téléversement, aperçu, publication et génération — l'écran ne permet même pas de déclencher
  l'action, plutôt que de la laisser échouer.
- **Publication (V3) — le rendu devient une PRÉCONDITION de publier dès qu'un gabarit
  `article_image` est configuré** : `buildPublishPayload` (`lib/wp/publish.ts`) demande à V1 le
  rendu `article_image` (résolu pour la catégorie de l'article) avant de téléverser l'image à la
  une. Si R2 **est** configuré et qu'un gabarit se résout (le gabarit de départ « Image à la une —
  défaut », sans catégorie, couvre déjà toute catégorie qui n'a pas son propre gabarit — voir §7
  point 3), c'est **son rendu** qui est publié, pas l'image brute — et un rendu en échec (jetons
  manquants, ex. `{{brand.logo}}` sans `STUDIO_BRAND_LOGO_URL`, ou toute autre erreur du moteur)
  **fait échouer toute la publication** avec le message français du moteur : l'article reste
  `approved`, donc réessayable une fois la cause corrigée. C'est un durcissement délibéré par
  rapport au fail-soft de l'image brute décrit juste en dessous (§8, « Image fail-soft ») : une
  fois le gabarit en place, l'image générée **est** l'illustration de l'article, et publier sans
  elle produirait un article visiblement cassé sur le site public. `articles.featuredImageUrl`
  n'est jamais réécrit par la publication — voir l'encadré en tête du `README.md`.

**Optionnel — jeton `{{brand.logo}}` :**

| Variable | Rôle |
|---|---|
| `STUDIO_BRAND_LOGO_URL` | URL du logo de marque injecté dans le jeton `{{brand.logo}}` (`lib/studio/bindings.ts`). |

Laissée vide, le jeton `{{brand.logo}}` est simplement **absent** des valeurs — comme n'importe quel
autre jeton non fourni. Tout gabarit qui l'utilise (les trois contextes à saisie manuelle —
citation, bandeau, récap — le référencent tous par défaut, voir `CONTEXT_TOKENS` dans
`lib/studio/tokens.ts`) échoue alors avec **« Valeurs manquantes pour : brand.logo. »** plutôt que
de planter silencieusement ou d'afficher un logo cassé. C'est la seule variable du studio qui est
réellement optionnelle : les cinq `R2_*` ci-dessus sont tout-ou-rien, celle-ci dégrade gabarit par
gabarit selon qu'il référence `{{brand.logo}}` ou non.

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

Vérification rapide : `bun test` (~850 tests, sans réseau ni clés), `bun run typecheck`.

### 5.1 Déploiement sur Railway — migrations automatiques à chaque déploiement

Le fichier **`railway.json`** (à la racine, commité) pilote le build et surtout la **commande de pré-déploiement**, qui applique les migrations **une fois par déploiement, avant que le trafic ne bascule** sur la nouvelle version :

```json
{
  "build":  { "buildCommand": "bun run build" },
  "deploy": {
    "preDeployCommand": "bun run db:migrate:deploy",
    "startCommand": "bun run start",
    "restartPolicyType": "ON_FAILURE"
  }
}
```

- **`preDeployCommand` = `bun run db:migrate:deploy`** → c'est la réponse à « comment garantir la migration à chaque déploiement ». Railway l'exécute **une seule fois** (pas par réplica), avec les variables d'env du service (`DIRECT_URL` = branche `production`), **avant** de promouvoir la version. Si la migration **échoue**, le déploiement est **stoppé** et l'ancienne version continue de servir — jamais de version applicative en avance de phase sur son schéma.
- Le runner de migration (`db/migrate.ts`) n'utilise **que** `drizzle-orm` + `pg` (dépendances de runtime) — pas `drizzle-kit` (devDependency, absente de l'image de prod). Il est **idempotent** : les migrations déjà enregistrées sont ignorées.
- Railway fournit `PORT` ; `next start` l'utilise automatiquement. Le builder détecte Bun via `bun.lock`.

> **Sans Railway :** exécutez `bun run db:migrate:deploy` comme étape de release de votre CI/hôte (même effet), puis démarrez l'app.

### 5.2 Bootstrap **unique** de la base `production` (avant le tout premier déploiement)

Les bases actuelles ont été créées via `db:push` : elles ont le **schéma** mais **pas le journal de migration** de drizzle. Sans réconciliation, le tout premier `db:migrate:deploy` tenterait de recréer des objets existants et **échouerait**. À faire **une fois** sur `production`, **avant** le premier déploiement (via `railway run`, qui injecte l'env du service — aucune credential de prod sur votre poste) :

```bash
# 1. Réconcilier le journal de migration sur la branche production :
railway run bun run db:baseline
#    → « Baseline terminé… » : le schéma existait déjà (cas normal, branche clonée depuis dev).
#    → « Base vide… » : la branche est vide → lancez à la place :
railway run bun run db:migrate:deploy   # applique tout le schéma depuis zéro

# 2. pgvector (idempotent ; déjà présent si la branche a été clonée depuis dev) :
#    CREATE EXTENSION IF NOT EXISTS vector;   (via la console SQL Neon sur la branche production)

# 3. Premier administrateur (§4), dans l'env production :
railway run env ADMIN_EMAIL="vous@afrotiative.com" ADMIN_NAME="Votre Nom" ADMIN_PASSWORD='…' \
  bun run db:create-admin
```

Après ce bootstrap unique, chaque déploiement applique **seulement les nouvelles** migrations via le `preDeployCommand`. Vous ne relancez plus jamais `db:baseline`.

> **Note :** le même bootstrap vaut pour la branche `dev` (déjà baseline en local). En développement, régénérez les migrations avec `bun run db:generate` après un changement de schéma, puis `bun run db:migrate` (ou `db:migrate:deploy`). Évitez `db:push` sur les branches que vous déployez — il désynchronise le journal.

### 5.3 Variables d'env à poser dans Railway (Service → Variables)

Toutes celles du §2, avec les valeurs de **production** :

- `DATABASE_URL`, `DIRECT_URL` → branche Neon **`production`**.
- `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (= l'URL publique Railway ou votre domaine).
- `PIPELINE_TRIGGER_SECRET`, `PUBLISH_TRIGGER_SECRET` (deux secrets distincts).
- `WP_BASE_URL`, `WP_USER`, `WP_APP_PASSWORD` (pour publier).
- Clés pipeline : `OPENROUTER_API_KEY`, `JINA_API_KEY`, `FIRECRAWL_API_KEY`, `LLM_ORDER`, `EXTRACT_ORDER`, `EMBED_*`…
- `PRODUCTION_DB_HOST` = le hostname de l'endpoint `production` (garde-fou anti-seed).
- `NODE_ENV=production` (active aussi le refus de `db:seed`).

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

### 6.5 Publication automatique sur les réseaux sociaux (D1) — planificateur **in-app**, pas un cron externe

Contrairement aux deux tâches ci-dessus, la publication automatique D1 ne demande **aucune**
configuration côté ordonnanceur externe : c'est un tic in-process (`lib/pipeline/scheduler.ts`,
démarré une seule fois par `instrumentation.ts` au boot du serveur, toutes les 15 min via
[croner](https://github.com/hexagon/croner)), cohérent avec le déploiement Railway **mono-instance**
de cette plateforme — il tourne tant que le processus Next.js tourne, sans endpoint HTTP à appeler.

- **Désactivée par défaut, canal par canal** — `social_channel_settings.autoEnabled` vaut `false`
  jusqu'à ce qu'un admin l'active explicitement sur `/settings/social/[canal]`. Aucune action
  requise ici pour un déploiement qui n'utilise pas cette fonctionnalité.
- **Ce que fait un tic dû** (par canal, indépendamment) : choisit **un** article `published` sur
  WordPress non encore envoyé sur ce canal, du plus ancien au plus récent (remonte aux jours
  précédents si la journée est épuisée, borné par `autoMaxBacklogDays`), respecte une fenêtre
  horaire (`autoWindowStartHour`/`autoWindowEndHour`) et un intervalle minimum
  (`autoIntervalHours`) depuis le dernier envoi automatique. Génère une légende IA (repli
  déterministe sans clé configurée), envoie, consigne le résultat (`article_revisions`).
  `lastAutoSendAt` est posé **avant** l'envoi et persisté en base — un redémarrage/redéploiement ne
  provoque jamais de rafale de rattrapage.
- **Aucun adaptateur réel en D1** : chaque canal (Facebook, Instagram, WhatsApp, X, TikTok)
  délègue à `StubChannel`, qui journalise l'envoi (log `[diffusion:stub]`) et renvoie un
  identifiant factice **sans jamais appeler un vrai réseau social**. Activer la publication
  automatique en D1 ne pousse donc rien de visible en dehors de cette plateforme — c'est un socle
  vérifiable de bout en bout, en attendant qu'un vrai adaptateur remplace `StubChannel` canal par
  canal dans une itération future.
- **Récupération des envois bloqués** : le même tic marque `failed` toute ligne `distributions`
  restée `pending` plus de 10 min par défaut, configurable via `DIFFUSION_STALE_PENDING_MINUTES`
  (processus interrompu entre l'écriture `pending` et le résultat final) — sans quoi cet article
  resterait bloqué indéfiniment sur ce canal (index unique partiel, §1 de la conception D1).
- **Diffusion bloquée avant tout envoi (alerte)** : si un tic dû se voit refuser AVANT même
  d'écrire une ligne `distributions` (rendu en échec, stockage R2 non configuré, aucun gabarit
  « post social » configuré pour ce canal), l'article resterait sinon sélectionné identiquement à
  chaque tic suivant, bloquant silencieusement tout le canal. Le tic lève désormais une alerte
  (« diffusion_blocked », visible dans la cloche de notifications et le tableau de bord) et essaie
  jusqu'à deux autres candidats sur le même tic avant d'abandonner — de quoi contourner UN article
  mal configuré sans laisser tout le canal à l'arrêt.

---

## 7. Checklist de première mise en route

1. [ ] Variables d'env posées (§2) ; `DATABASE_URL`/`DIRECT_URL` valides ; les deux `*_TRIGGER_SECRET` générés et distincts.
2. [ ] `bun install && bun run db:migrate` ; extension pgvector active.
3. [ ] `bun run db:studio-templates` → installe les 3 gabarits de départ du studio (**non destructif,
   sûr en production**, contrairement à `db:seed` — se relance sans risque, un gabarit déjà présent
   est laissé intact).
4. [ ] `bun run db:create-admin` → premier admin créé (§4).
5. [ ] `bun run build && bun run start` (ou déploiement hôte) ; l'app répond sur `/login`.
6. [ ] Connexion admin → **Réglages → Sources RSS** : ajouter les vrais flux, **« Vérifier ce flux »** avant d'activer.
7. [ ] **Réglages → Intégrations** : « Tester » WordPress (doit être *configuré* + connexion OK) et les fournisseurs IA.
8. [ ] **Réglages → Catégories & Tags** : « Synchroniser depuis WordPress » → la vraie taxonomie remplace les placeholders (l'IA choisit une catégorie dans ce miroir).
9. [ ] **Réglages → Équipe** : créer les comptes éditeurs/journalistes (mot de passe temporaire communiqué à chacun).
10. [ ] Déclencher **une** fois le pipeline manuellement (curl §6.1) → vérifier des brouillons dans **/queue**.
11. [ ] Revue humaine : ouvrir un article dans l'éditeur, corriger, **« Approuver & publier »** → post WordPress en ligne (vérifier titre/catégorie/tags/image/crédit + pied de sources).
12. [ ] Seulement ensuite : **activer les deux crons** (§6). L'automatisation tourne.

---

## 8. Notes d'exploitation

- **Observabilité** : `/runs` liste chaque exécution du pipeline (statut, étapes, items, erreurs) ; le tiroir de détail permet de **retraiter** un item ou **relancer** un run.
- **Mode dégradé** : sans clés IA, les brouillons sont produits mais marqués dégradés (`confidenceFlags.aiDegraded`) — visibles en revue, jamais publiés automatiquement.
- **WordPress non configuré** : toute tentative de publication renvoie « WordPress non configuré » et laisse l'article `approved` (jamais de faux succès).
- **Image fail-soft — nuancé depuis V3** : le TÉLÉVERSEMENT WordPress de l'image reste fail-soft
  (`uploadFeaturedImage`, inchangé) — si le téléchargement de l'image (brute ou générée) ou
  l'envoi à la médiathèque WP échoue, le post part **sans** image (jamais de post à moitié cassé) ;
  l'éditeur peut corriger puis **Republier**. Mais le RENDU du gabarit `article_image`, lui, n'est
  **plus** fail-soft dès qu'un gabarit est configuré pour la catégorie : un rendu en échec bloque
  **toute** la publication (voir §2, « Publication (V3) »), l'article restant `approved` pour un
  nouvel essai — l'image générée est trop centrale à l'article publié pour partir silencieusement
  sans elle.
- **Studio — couleur de catégorie** : éditable depuis **Réglages → Catégories & Tags** (colonne *Couleur*, pastille + sélecteur `#RRGGBB` strict, vide = retour au défaut). Toute catégorie sans couleur posée rend avec `DEFAULT_CATEGORY_COLOR` (`lib/studio/bindings.ts`).
- **Studio — surfaces V2** : `/studio` liste les gabarits par contexte (portée canal/catégorie, état brouillon/publié/modifications non publiées) ; `/studio/[id]` est l'éditeur (canevas DOM, calques, liaison de jetons, aperçu réel produit par le moteur V1, publication versionnée avec historique) ; `/studio/assets` téléverse et gère images (PNG/JPEG/WebP/SVG, 5 Mo max) et polices (TTF/OTF, 2 Mo max — **le WOFF2 est refusé**, Satori ne sait pas le lire) ; `/studio/generer` produit une image ponctuelle pour les trois contextes à saisie manuelle (citation, bandeau newsletter, récap), en choisissant éventuellement un canal/une catégorie de portée.
- **Studio — `/studio/generer` sans gabarit publié** : les trois contextes à saisie manuelle (`quote_card`, `newsletter_header`, `recap_card`) n'ont **aucun gabarit de départ** (`bun run db:studio-templates` ne sème que `article_image`/`social_post`) — tant que personne n'en a créé un depuis **Studio → Gabarits** (`/studio`, bouton « Nouveau gabarit ») puis publié dans son éditeur (`/studio/[id]`), la génération répond « Aucun gabarit publié pour ce contexte. Créez-en un et publiez-le depuis Studio → Gabarits avant de générer. » plutôt qu'un état vide silencieux.
- **Idempotence** : republier met à jour le post WP existant (via `distributions.externalId`), jamais de doublon.
- **Dépublier / Republier** : depuis l'éditeur d'un article publié (rôles Éditeur/Admin).
- **Diffusion réseaux sociaux (D1)** : `/settings/social/[canal]` (admin uniquement) — activation du
  canal, limite de légende (bornée par le plafond officiel de chaque réseau), prompt personnalisé,
  et publication automatique (désactivée par défaut, voir §6.5). D1 ne fournit aucun adaptateur
  réel : tout envoi (manuel depuis `/article/[id]` ou automatique) passe par `StubChannel`, qui
  journalise sans jamais contacter un vrai réseau.
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
| Studio en lecture seule, bannière « Stockage R2 non configuré » | Une des cinq variables `R2_*` manque (§2). Les compléter — aucun redémarrage de la base requis. |
| « Aucun gabarit publié pour ce contexte » sur `/studio/generer` | Normal pour `quote_card`/`newsletter_header`/`recap_card` tant qu'aucun gabarit n'a été créé (**Studio → Gabarits**, `/studio`, bouton « Nouveau gabarit ») **et publié** dans son éditeur (`/studio/[id]`) pour ce contexte (aucun gabarit de départ ne les couvre). |
| Gabarit qui échoue avec « Valeurs manquantes pour : brand.logo. » | `STUDIO_BRAND_LOGO_URL` n'est pas posée (§2) — optionnelle, mais tout gabarit qui référence `{{brand.logo}}` l'exige. |
| Publication qui échoue avec « Génération de l'image échouée — … » (article laissé `approved`) | R2 **est** configuré et un gabarit `article_image` s'est résolu pour la catégorie de l'article, mais son rendu a échoué (V3, §2/§8) — le message nomme la cause (jetons manquants, échec moteur…). Corriger la cause (ex. compléter l'image/la catégorie de l'article, ou `STUDIO_BRAND_LOGO_URL` si le gabarit y fait référence) puis relancer la publication (« Approuver & publier » ou **Republier**) ; la barrière de revue n'est pas affectée, l'article reste réessayable. |
