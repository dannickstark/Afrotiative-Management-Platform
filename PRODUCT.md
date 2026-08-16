# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Internal newsroom staff of **Afrotiative Media** — a small team of 2–5 people operating the console day-to-day. Access is gated behind `/login` with server-enforced RBAC (Better-Auth) across three roles:

- **Admin** — full control, including pipeline, social channels, and auto-publish settings.
- **Éditeur (Editor)** — reviews, edits, approves, and publishes articles.
- **Journaliste (Journalist)** — reviews and edits drafts.

In practice roles overlap: with a team this size, one person often wears several hats. The primary job is to take AI-rewritten French news drafts from the review queue, edit them in a constrained editor, approve them, and publish to WordPress — optionally syndicating to social channels.

## Product Purpose

Afrotiative Media — **Console éditoriale**: an internal back-office that automates and controls the editorial value chain (*chaîne de valeur*):

**RSS ingestion → content extraction → AI rewrite (French) + semantic clustering → human review queue → human edit → WordPress publication (schedulable) → optional social diffusion.**

Success is a small newsroom publishing at outlet-scale volume without sacrificing editorial control — turning a flood of raw feed items into finished, human-approved French business/finance articles on the live site.

## Positioning

The durable bet is **tiny-team leverage over an owned, end-to-end distribution chain**. Two things a neighboring product could not truthfully copy without rebuilding:

1. **Tiny-team leverage** — the AI pipeline (rewrite, embeddings, semantic dedup/clustering, field-level regeneration) does the heavy lifting so a 2–5 person team produces at a volume that would normally require a much larger newsroom.
2. **Owned distribution chain** — ingestion, extraction, rewrite, WordPress publishing, Studio imagery, and multi-channel social diffusion are all one owned pipeline the team controls end to end, not a stitched-together stack of third-party SaaS.

The human-review barrier and the Pan-African francophone business/finance beat are real and preserved, but they are table stakes, not the moat being defended.

## Operating Context

- **The review queue (`/queue`, "File de revue")** is the daily workspace: a filterable list of drafts, with single- and bulk **"Renvoyer à l'IA"** regeneration (regenerate any of 6 fields — Titre, Corps, Extrait, Catégorie, Tags, Image à la une).
- **The article editor (`/article/[id]`)** is a constrained Tiptap editor with an image panel ("Image originale" / "Aperçu final") and a "Diffusion" panel for social sending.
- **Studio (`/studio`)** is a template engine + visual editor (canevas, calques/layers, jetons/tokens, live preview, publish, history) for rendered images, plus an asset library and one-off generation (quote card / newsletter banner / recap).
- **Runs (`/runs`)** gives pipeline observability — runs, steps, reprocessing an item, relaunching a run.
- **Settings** covers feeds, mirrored taxonomy (taxonomie miroir), team, integrations, pipeline config, and social channels.
- An in-app scheduler (15-min tick) drives scheduled pipeline runs, scheduled publishing, and per-channel auto-diffusion.

## Capabilities and Constraints

**Confirmed capabilities**

- **Human-review barrier ("barrière de revue humaine")**: no article publishes without human approval. `article_status` flows `draft → pending → in_review → approved → published` (or `rejected`); only `approved` articles ever publish. A strictly-gated, admin-only, default-off auto-approval path is the sole exception.
- **AI rewrite** via Vercel AI SDK with provider chain OpenRouter → OmniRoute → mock. An **OpenRouter token pool** rotates over encrypted keys, retrying the next token with rate-limit/auth cooldowns on failures.
- **Content extraction chain**: Jina Reader → Firecrawl → Crawl4AI → Mozilla Readability fallback, with SSRF guarding for untrusted URLs.
- **Semantic clustering / dedup** of raw items using pgvector embeddings.
- **WordPress publishing** via WP REST API v2 — publish, unpublish, republish, scheduled publish.
- **Social diffusion**: real adapters for Facebook + Instagram (Meta Graph API) and LinkedIn (Community Management API); WhatsApp, X, TikTok are stubbed (log-only). Encrypted per-channel credentials.
- **Studio image rendering**: Satori + resvg (SVG→PNG), stored in Cloudflare R2. Studio is read-only with a banner when R2 storage is not configured.
- **Web-search augmentation** via Exa and Brave.

**Technical constraints**

- **Stack**: Next.js 16 (App Router, RSC + Server Actions), React 19, TypeScript; Postgres/Neon with pgvector; Drizzle ORM; Better-Auth; shadcn/ui on Base UI + Tailwind v4. Bun for tooling/tests; deploy on Railway with Neon branches.
- **UI copy is in French** (`<html lang="fr">`). French is the product language, not a localization layer.
- **Image dependencies**: Studio requires R2 to be configured; Crawl4AI runs on separate self-hosted infrastructure (also used for image backfill).

## Brand Commitments

- **Name**: **Afrotiative** (wordmark) with tagline **"Console éditoriale"**.
- The logo is a **typographic lockup**, not an image file: a serif **"A"** monogram on a terracotta accent chip. Fonts: **Inter** (sans) + **Lora** (editorial serif).
- Voice/identity direction (editorial character, monogram + Lora, terracotta accent, split-screen login) is captured in the go-live brand audit and is treated as a binding starting point for visual work, not reopened here.
- Reference briefs on disk: `afrotiative-uiux-brief.md` and `compass_artifact_*.md`.

## Evidence on Hand

- **Real, working integrations**: live WordPress REST publishing; real Meta and LinkedIn diffusion adapters; a real OpenRouter-backed AI pipeline.
- Reference/brief docs: `afrotiative-uiux-brief.md`, `compass_artifact_*.md`, `README.md`, `docs/DEPLOYMENT.md`.
- **Absences future work must not fabricate**: `public/` contains only default Next.js SVGs — there is **no custom logo image, no legal/terms/compliance docs, and no published testimonials, metrics, or case studies**. Do not invent readership numbers, client logos, awards, or proof points. WhatsApp, X, and TikTok diffusion are stubs — do not present them as live channels.

## Product Principles

1. **Human owns the byline.** The AI drafts; a person edits and approves. Nothing reaches the live site unreviewed (save the admin-only, off-by-default auto path).
2. **Leverage, not headcount.** Every workflow should let a 2–5 person team move at outlet scale — batch actions, regeneration, and observability exist to multiply a small team, not to replace judgment.
3. **Own the whole chain.** Ingestion through diffusion is one controlled pipeline; features should reinforce end-to-end control rather than offload steps to opaque third parties.
4. **French-first, Pan-African business/finance beat.** The language and the beat are fixed product truth, not options.
5. **Fail visibly, recover cheaply.** Pipeline runs, token-pool rotation, partial-success reporting, and reprocessing exist so failures are observable and one bad item never blocks the queue.

## Notes

- **"MAIMP"** is only the containing folder name; it appears nowhere in the code and is not a product or brand term.
