# Afrotiative Media — Back-office rédaction

Plateforme interne d'**Afrotiative Media** (média panafricain francophone business & finance). Elle
automatise la chaîne **RSS → réécriture IA (français) → revue humaine → publication WordPress**, et
donne à la rédaction le contrôle en application de ses flux, de son équipe, de sa taxonomie et de ses
intégrations.

> **Barrière de revue humaine (non négociable) :** aucun article n'est publié sans qu'un humain l'ait
> approuvé — sauf exception explicite (voir ci-dessous). La publication planifiée ne touche que des
> articles déjà approuvés.
>
> **Exception — publication automatique (SP6) :** optionnelle, **désactivée par défaut**, et
> réservée aux administrateurs (`/settings/pipeline`). Quand elle est activée, un article n'est
> auto-approuvé (statut `approved` + planifié immédiatement) que s'il passe des conditions de
> sûreté strictes : score de qualité ≥ seuil configuré, ≥ N sources corroborantes, image à la une
> présente, et **aucun** drapeau de faible confiance (catégorie incertaine, image manquante,
> cluster incertain, génération dégradée). Chaque auto-approbation est **auditée** : une entrée
> « publié automatiquement » est ajoutée à l'historique de l'article (`article_revisions`). Le
> point d'application de la barrière ne change pas : seuls les articles `status='approved'` sont
> jamais publiés (`publishDueArticles`) — l'auto-publication ne fait qu'ajouter une seconde façon,
> strictement contrôlée, d'atteindre ce statut sans clic humain.
>
> **Image publiée = image générée au moment de publier (V3) :** les images ne sont **pas**
> générées pendant le pipeline normal ; si un gabarit `article_image` est configuré (Studio),
> l'image poussée dans la médiathèque WordPress est produite au moment précis du clic sur
> *Approuver & publier* (ou de l'exécution planifiée), pas avant. `articles.featuredImageUrl`
> (l'image brute, avec son crédit et son lien source) n'est **jamais** réécrit — c'est la trace de
> l'image d'origine, et c'est ce dont le gabarit repart à chaque rendu. Sans gabarit configuré pour
> la catégorie de l'article, l'image brute est publiée telle quelle, comme avant V3. Avec un
> gabarit configuré, un rendu en échec (informations manquantes, moteur en erreur) fait **échouer
> toute la publication** — l'article reste `approved`, donc réessayable — plutôt que de publier un
> article visiblement cassé sans son illustration.
>
> **Publication automatique sur les réseaux sociaux (D1) :** optionnelle, **désactivée par défaut**
> canal par canal, réservée aux administrateurs (`/settings/social/[canal]`). Une fois activée pour
> un canal, un planificateur in-app (`lib/pipeline/scheduler.ts`, un tic toutes les 15 min) choisit
> automatiquement **un** article publié sur WordPress le jour même et non encore envoyé sur ce
> canal, du plus ancien au plus récent ; s'il n'y a plus rien pour aujourd'hui, il remonte à la
> veille, et ainsi de suite (`autoMaxBacklogDays` borne cette remontée). Respecte une fenêtre
> horaire configurable (`autoWindowStartHour`/`autoWindowEndHour` — un média ne poste pas à 4 h du
> matin) et un intervalle minimum entre deux envois (`autoIntervalHours`). Chaque envoi, automatique
> ou manuel, est audité (`article_revisions`) et protégé par un index unique partiel qui empêche
> tout doublon sur le même (article, canal). **Facebook, Instagram et LinkedIn ont un adaptateur réel
> (D2+D3 + D7)** et publient effectivement — Facebook/Instagram via l'API Graph de Meta, LinkedIn via
> sa Community Management API — une fois des identifiants chiffrés enregistrés sur
> `/settings/social/facebook`/`instagram`/`linkedin` (voir la ligne « Diffusion » ci-dessous).
> **WhatsApp, X et TikTok restent sur `StubChannel`**, qui consigne l'envoi (log + identifiant
> factice) sans jamais toucher un vrai réseau.

## Chaîne de valeur

```
Flux RSS  →  Extraction  →  Réécriture IA (FR)  →  File de revue  →  Édition humaine  →  Publication WordPress
(SP3)        Jina/Firecrawl   Vercel AI SDK          /queue           Tiptap /article/[id]   REST API v2 (SP5)
             /Readability      + embeddings + clustering
```

## Ce qui est inclus

| Domaine | Surfaces |
|---|---|
| **Authentification & rôles** | `/login`, RBAC serveur (Admin / Éditeur / Journaliste) via Better-Auth. |
| **Revue & édition** | `/dashboard`, `/queue` (file), `/article/[id]` (éditeur Tiptap contraint — panneau image à onglets « Image originale » / « Aperçu final », V3), `/published`, `/calendar`. |
| **Pipeline (SP3)** | ingestion RSS, extraction, réécriture IA, embeddings pgvector, clustering sémantique. |
| **Observabilité (SP4)** | `/runs` — exécutions, étapes, retraitement d'un item, relance d'un run. |
| **Publication (SP5)** | publier / dépublier / republier WordPress + publication planifiée. Image à la une **générée au moment de publier** si un gabarit `article_image` est configuré (V3 — voir l'encadré ci-dessus) ; sinon image brute inchangée. |
| **Studio (V1 + V2 + V3)** | moteur de gabarits + éditeur visuel. `/studio` (liste, groupée par contexte), `/studio/[id]` (éditeur : canevas, calques, jetons, aperçu réel, publication, historique), `/studio/assets` (bibliothèque images/polices), `/studio/generer` (génération ponctuelle citation / bandeau newsletter / récap). Lecture seule avec bannière explicite si le stockage R2 n'est pas configuré (voir `docs/DEPLOYMENT.md`). V3 : `/article/[id]` prévisualise le rendu `article_image` à la demande (onglet « Aperçu final ») et la publication l'utilise réellement (voir « Publication »). |
| **Diffusion (D1 + D2/D3 + D7)** | Panneau « Diffusion » sur `/article/[id]` (légende générée par IA, envoi manuel, réessai après échec) pour Facebook / Instagram / WhatsApp / X / TikTok / LinkedIn. `/settings/social` (liste) et `/settings/social/[canal]` (identifiants chiffrés + « Tester la connexion », guide de connexion par canal, activation, limite de légende, prompt, publication automatique) — admin uniquement. **Facebook, Instagram et LinkedIn ont un adaptateur réel** (API Graph de Meta pour les deux premiers, `lib/diffusion/meta/` ; Community Management API pour le troisième, `lib/diffusion/linkedin/`) ; **WhatsApp, X et TikTok délèguent encore à `StubChannel`**, qui journalise sans jamais appeler un vrai réseau. |
| **Réglages (SP2 + D1)** | `/settings/{feeds, taxonomy, team, integrations, pipeline, social}` — sources, taxonomie miroir, équipe, statut des intégrations, réglages pipeline, réseaux sociaux. |
| **Crons** | `POST /api/pipeline/run` (ingestion) · `POST /api/publish/due` (publication planifiée), tous deux bearer-gardés · planificateur in-app (`lib/pipeline/scheduler.ts`, démarré par `instrumentation.ts`) pour l'exécution planifiée du pipeline ET le tic de diffusion automatique D1 (toutes les 15 min, désactivé canal par canal par défaut). |

## Stack

Next.js 16 (App Router, RSC + Server Actions) · TypeScript · **Bun** (paquets / tests / scripts ;
l'app tourne sur Node) · Drizzle ORM + Postgres/Neon (**pgvector**) · Better-Auth · Tiptap v3 ·
shadcn/ui sur Base UI · Vercel AI SDK (OpenRouter → OmniRoute → mock) · WordPress REST API v2.

## Démarrage rapide (développement)

```bash
bun install
cp .env.example .env.local        # DATABASE_URL/DIRECT_URL = branche Neon « dev » ; BETTER_AUTH_SECRET…
bun run db:migrate                # + activer l'extension pgvector sur la base
CONFIRM_SEED=1 bun run db:seed     # données de démo (25 articles, 6 flux, 3 comptes) — DEV UNIQUEMENT, destructif
bun run dev                       # http://localhost:3000
```

Comptes de démo (seed) : `admin@` / `editor@` / `journaliste@afrotiative.com`, mot de passe `Afrotiative2026!`.

> **Branches Neon :** `.env.local` (gitignoré) pointe sur la branche **`dev`** ; la branche **`production`** ne se
> configure que dans les variables d'env de l'hôte déployé. Détails et garde-fous : [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) §3.

## Commandes

| Commande | Effet |
|---|---|
| `bun run dev` | serveur de dev (Turbopack). |
| `bun run build` / `bun run start` | build & serveur de production. |
| `bun test` | ~850 tests (sans réseau ni clés). |
| `bun run typecheck` | `tsc --noEmit`. |
| `bun run db:migrate` / `db:push` / `db:generate` | migrations Drizzle (dev). |
| `bun run db:migrate:deploy` | applique les migrations avec les seules deps de runtime (utilisé au déploiement). |
| `bun run db:baseline` | réconcilie une base créée via `db:push` avec le journal de migration (one-time). |
| `CONFIRM_SEED=1 bun run db:seed` | seed de démo (**efface les tables applicatives** ; garde-fous anti-production). |
| `bun run db:studio-templates` | installe les 3 gabarits de départ (idempotent). |
| `bun run db:create-admin` | crée **un** admin en production (voir runbook §4). |

## Déploiement & exploitation

Voir **[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)** — prérequis, variables d'environnement, base de
données, création du premier admin, les deux tâches cron, checklist de première mise en route et
dépannage.

## Documentation de conception

Specs et plans par sous-projet dans `docs/superpowers/specs/` et `docs/superpowers/plans/`
(SP0/SP1 back-office, SP2 réglages, SP3 pipeline, SP4 observabilité, SP5 publication).
