# Afrotiative Media — Back-office rédaction

Plateforme interne d'**Afrotiative Media** (média panafricain francophone business & finance). Elle
automatise la chaîne **RSS → réécriture IA (français) → revue humaine → publication WordPress**, et
donne à la rédaction le contrôle en application de ses flux, de son équipe, de sa taxonomie et de ses
intégrations.

> **Barrière de revue humaine (non négociable) :** aucun article n'est publié sans qu'un humain l'ait
> approuvé. La publication planifiée ne touche que des articles déjà approuvés.

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
| **Revue & édition** | `/dashboard`, `/queue` (file), `/article/[id]` (éditeur Tiptap contraint), `/published`, `/calendar`. |
| **Pipeline (SP3)** | ingestion RSS, extraction, réécriture IA, embeddings pgvector, clustering sémantique. |
| **Observabilité (SP4)** | `/runs` — exécutions, étapes, retraitement d'un item, relance d'un run. |
| **Publication (SP5)** | publier / dépublier / republier WordPress + publication planifiée. |
| **Réglages (SP2)** | `/settings/{feeds, taxonomy, team, integrations}` — sources, taxonomie miroir, équipe, statut des intégrations. |
| **Crons** | `POST /api/pipeline/run` (ingestion) · `POST /api/publish/due` (publication planifiée), tous deux bearer-gardés. |

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
| `bun test` | 135 tests (sans réseau ni clés). |
| `bun run typecheck` | `tsc --noEmit`. |
| `bun run db:migrate` / `db:push` / `db:generate` | migrations Drizzle. |
| `CONFIRM_SEED=1 bun run db:seed` | seed de démo (**efface les tables applicatives** ; garde-fous anti-production). |
| `bun run db:create-admin` | crée **un** admin en production (voir runbook §4). |

## Déploiement & exploitation

Voir **[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)** — prérequis, variables d'environnement, base de
données, création du premier admin, les deux tâches cron, checklist de première mise en route et
dépannage.

## Documentation de conception

Specs et plans par sous-projet dans `docs/superpowers/specs/` et `docs/superpowers/plans/`
(SP0/SP1 back-office, SP2 réglages, SP3 pipeline, SP4 observabilité, SP5 publication).
