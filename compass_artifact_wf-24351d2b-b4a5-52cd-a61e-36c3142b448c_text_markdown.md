# Architecture Research: AI News Media Management Platform (Afrotiative Media)

**Stack:** TypeScript · Next.js (App Router) · shadcn/ui · NeonDB (serverless Postgres)

## TL;DR
- **Build the pipeline on a durable job engine, not Vercel Cron.** For a French-language RSS→AI→WordPress pipeline that must poll every 15–20 min, run retryable multi-step workflows, and give non-technical editors a visual "run history," **Trigger.dev v3+** (self-hostable, no execution timeout, OpenTelemetry run traces) or **Inngest** (event-driven step functions) are the two right choices — Vercel Cron alone cannot do it (Hobby = once/day, no retries, GET-only, 10s/300s function timeouts).
- **Use best-in-class TS libraries per stage:** `rss-parser` for feeds, self-hosted Jina Reader (Apache-2.0) or Mozilla Readability + jsdom for extraction, pgvector on Neon with a multilingual embedding model for dedup/clustering, the official `openai` SDK pointed at OmniRoute's baseURL with Zod validation for AI, and Application Passwords + raw fetch for WordPress publishing.
- **For the UI + auth:** Better-Auth (self-hosted, built-in RBAC/organizations, same Neon DB) + a shadcn/ui admin starter (e.g. Kiranism's Next.js 16 starter) + Novel/Tiptap v3 editor for article review.

## Key Findings

1. **Background jobs:** Trigger.dev and Inngest are the 2026 defaults for durable TS workflows. Both give per-step retries, concurrency/throttle control, and dashboards. Trigger.dev has no execution timeout and is fully self-hostable (Apache-2.0). Vercel Cron is only a trigger, not an orchestrator.
2. **RSS:** `rss-parser` (v3.13.0) is the recommended maintained parser; `feedparser` is deprecated.
3. **Extraction:** Hosted Jina Reader is fastest to ship; self-hosting (Jina Reader OSS, or Readability+jsdom) gives control/privacy. Readability requires DOMPurify sanitization.
4. **Dedup/clustering:** pgvector on Neon (fully supported, HNSW index) + multilingual embeddings + cosine similarity threshold is the right lightweight approach at this scale.
5. **Neon:** Use the pooled (`-pooler`/PgBouncer) connection string from serverless functions; direct connection for migrations. pgvector ships on all plans. Branching gives instant dev/staging clones.
6. **WordPress:** Application Passwords + Basic Auth over HTTPS is the current standard; media upload is a two-step binary POST then attach as `featured_media`.
7. **Auth/RBAC:** Better-Auth is the strongest self-hosted default in 2026 with built-in admin + organization plugins for role/permission access control, storing sessions in your Neon DB.
8. **UI:** Multiple free shadcn/ui admin starters exist; Novel (Notion-style, Tiptap-based, AI autocomplete) is the natural article editor.
9. **LLM gateway:** Point the official `openai` npm SDK at OmniRoute's baseURL; use JSON schema/Zod validation with a retry-on-invalid-JSON loop since structured-output reliability varies by underlying model.
10. **Comparable products:** WP RSS Aggregator (AI Rewriting), Wp NewsMaster, and AI-enabled headless CMSs (Storyblok, Sanity) show the feature space; Reuters/BBC show human-in-the-loop patterns.

## Details

### 1. Background jobs / cron / long-running automation

Your pipeline is a scheduled, multi-step, long-running workflow (LLM calls + image downloads) that non-technical editors must be able to observe. This rules out Vercel Cron as the orchestrator and points to a durable execution engine.

**Vercel Cron Jobs — trigger only, not an orchestrator.** On the Hobby plan you get at most 2 cron jobs at once-per-day minimum frequency; Pro unlocks per-minute schedules but is still just a scheduler. Critical limits: **no automatic retries** (a 500 is logged as failed, full stop), **no failure alerts**, **GET requests only**, **UTC only**, **no overlap prevention**, and the underlying function timeout applies (30s default Hobby, 300s Pro; up to 800s generally available / 1800s beta with Fluid Compute). For a 15–20 min poll you'd need Pro, and you'd still have to build retries, run history, and observability yourself. Verdict: fine as the *scheduler that pings your job engine*, wrong as the engine.

**Trigger.dev (recommended primary):** Open-source (Apache-2.0), self-hostable via Docker Compose, TypeScript-only. Tasks are plain async functions with **no execution timeout** — ideal for long LLM/image steps. It provides checkpoint-resume durability, built-in retries/queues/scheduling, and — decisively for your editorial-visibility requirement — a **real-time run page with OpenTelemetry trace view and logs per run**, tags, run metadata for live UI updates, bulk replay of failed runs, and email/Slack/webhook alerts. Custom dashboards use a SQL-style query language (TRQL). The v4 SDK (March 2026) added checkpointing and deferred functions. This is the closest analogue to n8n's visual run history while remaining code-first.

**Inngest (strong alternative):** Event-driven step functions. Each `step.run()` is independently checkpointed and retried (default 4 retries after the initial attempt = 5 total). First-class flow control: per-tenant/keyed **concurrency**, **throttling**, **rate limiting**, **debounce**, **batching**, and **fan-out**. Runs on your own compute (serverless or server) and includes a dashboard with run history + an Insights query layer. Known tradeoff: the step model breaks long operations into discrete HTTP requests, so each step is bound by your host's function timeout even though the overall workflow is unbounded — with Vercel that reintroduces the 300s/step ceiling. Not self-hostable as a managed control plane the way Trigger.dev is (though it deploys within your app).

**Others:**
- **QStash (Upstash):** Lightweight HTTP message queue with scheduling + guaranteed delivery; adds ~30–100ms HTTP hop per job and has no local dev mode (needs a tunnel). Good for simple fan-out, thin on multi-step observability.
- **BullMQ + Redis:** Maximum control, cheapest at high volume (~$15–50/mo Redis vs $75–150 on hosted at 500k jobs/mo), but you operate Redis, workers, scaling, and build your own dashboard. Overkill operationally for a small newsroom.
- **Temporal:** Powerful durable workflows for polyglot enterprise orchestration; heavier than a Cameroon news pipeline needs.

**Recommendation:** **Trigger.dev v3/v4** as the pipeline engine — self-hostable (matters for cost/data control in an African media context), no timeouts for LLM/image steps, and its run-trace UI directly satisfies the "editors see what happened on each run" requirement. Choose **Inngest** instead if you prefer event-driven fan-out semantics and are comfortable with per-step timeout boundaries. Either way, trigger the poll with a cron (Vercel Cron on Pro, the engine's own scheduler, or an external cron) that enqueues a run.

### 2. RSS parsing

- **`rss-parser` (v3.13.0)** is the recommended, widely-used (millions of weekly downloads, ~494 dependents) lightweight parser for Node + browser, with native TypeScript types and custom-field typing via generics. Handles RSS2 and Atom. Simple API: `new Parser().parseURL(...)`.
- **`feedparser` is deprecated** — do not use in new projects (unmaintained, no security patches).
- **Alternative:** `fast-xml-parser` (zero-dependency, ~104K) paired with your own fetch (e.g. `got`/native `fetch`) if you want maximum control over downloading, caching, and malformed-feed handling. This is a good fallback for feeds that `rss-parser` chokes on.
- **Gotchas:** Malformed feeds are common in the wild — always fetch with a timeout + retry, wrap parsing in try/catch per feed (never let one bad feed kill the run — this maps naturally to one Trigger.dev/Inngest step per feed), and normalize date fields (feeds mix RFC-822 and ISO-8601). Store raw `guid`/`link` per item for dedup keys.

### 3. Full-text article extraction

Two viable paths; use both (API primary, self-hosted fallback):

**Hosted Jina Reader (`r.jina.ai`):** Prepend `https://r.jina.ai/` to any URL → clean markdown. Fastest to ship, no infra. Jina "introduced a new pricing model on May 6th, 2025" (jina.ai/reader): usage-based at **$0.02 per 1M output tokens**, with **10M free tokens** per new API key shared across all Jina endpoints (Reader, Embeddings, Reranker). Rate limits: ~**20 RPM keyless**, stepping up to **500 RPM (paid)** and **5,000 RPM (premium)**. This is what your n8n flow used, so it's a drop-in.

**Self-hosted Jina Reader (OSS):** The Reader engine is **open source under Apache-2.0** (`github.com/jina-ai/reader`), with a published container image `ghcr.io/jina-ai/reader:oss` (bundles headless Chrome + LibreOffice). Run it via `docker compose up -d` when content must stay on your own infrastructure or to avoid per-token cost at scale. (Note: In October 2025 Jina AI was acquired by Elastic, which folds its retrieval stack into Elasticsearch's ML tooling — this does not affect the Apache-2.0 OSS licensing you'd rely on.)

**Mozilla Readability + jsdom (`@mozilla/readability` + `jsdom`):** The algorithm behind Firefox Reader View. Fetch HTML → `new JSDOM(html, {url})` → `new Readability(doc).parse()` → `{title, byline, content, textContent, excerpt}`. **Security-critical:** jsdom must keep script execution disabled (default), and you **must run output through DOMPurify** before storing/rendering to prevent script injection. Pair with a fallback selector chain (`article`, `main`, `[role=main]`) when Readability returns <100 chars.

**Optional self-hosted model:** Jina's **ReaderLM-v2** (1.5B params, built on Qwen2.5-1.5B-Instruct, HTML→markdown/JSON, 512K context, 29 languages incl. French) can be self-hosted — **but its weights are CC-BY-NC 4.0 (non-commercial only)**, which likely disqualifies it for a commercial outlet. The earlier `reader-lm-0.5b`/`reader-lm-1.5b` (Sept 2024, on Hugging Face) are more permissively distributed.

**Recommendation:** Start with **hosted Jina Reader** (matches existing n8n behavior, generous free tier), and implement **Readability+jsdom+DOMPurify as a self-hosted fallback** for when Jina is rate-limited or a source blocks it. Capture candidate images during extraction (og:image, inline `<img>` with reasonable dimensions) to feed the featured-image selection step.

### 4. Deduplication / near-duplicate detection

Two layers, cheap-to-expensive:

**Layer 1 — exact/near-exact dedup (heuristic):** Keep a `seen_articles` table keyed on RSS `guid` + normalized URL + a content hash (e.g. SHA-256 of normalized title+body). This replaces your old Postgres/Airtable "seen" table and catches literal repeats instantly with no ML. MinHash/SimHash (n-gram based) is the classic non-neural technique if you want fuzzy text-overlap detection without embeddings.

**Layer 2 — semantic clustering (embeddings + pgvector):** To detect *different sources covering the same story*, embed each article (title + body) and compare with **cosine similarity** in pgvector. Research consistently uses cosine over sentence embeddings for news-claim clustering; a similarity threshold (commonly ~0.75–0.85, tune on held-out data) flags near-duplicates/same-story clusters. Because your content is **French**, use a **multilingual embedding model**: strong options are **BGE-M3** (100+ languages, 8K context, self-hostable, strong on FR-MTEB), **multilingual-e5-large**, or hosted **OpenAI text-embedding-3-large** / **Cohere Embed** if you prefer an API. Note OmniRoute may expose an OpenAI-compatible `/v1/embeddings` endpoint you can reuse.

**Clustering approach at your scale:** For a small-to-medium newsroom (hundreds–low-thousands of articles/week), you don't need a clustering service. On each new article: embed → query pgvector for nearest neighbors within a recent time window (e.g. last 48–72h) above the threshold → if matches exist, attach to the existing "story cluster" (a `clusters` table with a `cluster_id` FK); else create a new cluster. This gives you the cross-referencing the AI step needs (pass all clustered sources into the rewrite prompt).

### 5. NeonDB best practices

- **Connection pooling:** Use the **pooled connection string** (hostname with `-pooler`, backed by PgBouncer in transaction mode) from all serverless/Next.js route handlers and job steps — a burst of invocations would otherwise exhaust `max_connections` (e.g. only 104 on a 0.25 CU compute). PgBouncer accepts up to 10,000 client connections and multiplexes them. **Use the direct (non-pooled) connection** only for migrations, `pg_dump`, and logical replication. **Gotcha:** transaction-mode pooling breaks session-scoped features (`SET`/`RESET`, `LISTEN/NOTIFY`, `WITH HOLD` cursors, SQL-level `PREPARE`) — fully qualify schema names or set search_path via `ALTER ROLE`.
- **Driver choice:** In long-running Node processes (a self-hosted Trigger.dev worker) use `node-postgres` (`pg`) with the pooled string. In edge/serverless one-shot contexts use `@neondatabase/serverless` (HTTP for single queries, WebSocket for transactions). Manage schema/migrations with one tool (e.g. Drizzle) only.
- **pgvector:** **Fully supported on every Neon plan, no add-on.** Enable per-database with `CREATE EXTENSION IF NOT EXISTS vector;` (SQL name is `vector`, not `pgvector`). Supports HNSW and IVFFlat indexes and L2/cosine/inner-product distance. For HNSW builds, raise `maintenance_work_mem` (≤50–60% of RAM) for the session; Neon's compute elasticity lets you temporarily scale up for index builds.
- **Branching:** Neon branches are instant copy-on-write clones — use one branch per environment (dev/staging/preview) and per-PR preview branches. **Scale-to-zero gotcha:** frontend polling (React Query intervals, health checks) can keep the compute awake and prevent scale-to-zero; and `pg_cron` only fires while compute is active, so don't rely on it for scheduling under scale-to-zero.
- Context: Neon was acquired by Databricks (announced May 14, 2025; Databricks confirmed to Informa TechTarget that the price was approximately $1 billion, with Neon having raised $129.6M and served 18,000+ customers including OpenAI and Vercel). Storage pricing dropped ~80% to $0.35/GB-month in late 2025.

### 6. WordPress REST API integration

- **Auth: Application Passwords** (built into WP core since 5.6) over HTTPS via Basic Auth is the current best practice. Create a dedicated bot user with the **minimum role** (Editor for content creation, or Author) and generate an Application Password under that user; send `Authorization: Basic base64(user:app_password)` on every request. JWT-plugin auth is an option but adds a dependency; Application Passwords are the 2026 default. Enforce pretty permalinks and don't move `wp-json`.
- **Media upload (two-step):** (1) POST the binary to `/wp-json/wp/v2/media` with headers `Content-Disposition: attachment; filename="x.jpg"` and `Content-Type: image/jpeg`, body = raw bytes (not JSON/FormData) → returns the attachment `id`. (2) Create/update the post at `/wp-json/wp/v2/posts` with `featured_media: <id>`. Practitioners report the single-request media+meta path is flaky, so do it in two requests. To pull the featured image from a *remote* source URL, download to a buffer server-side first, then upload the bytes.
- **Categories/tags:** GET `/wp/v2/categories` and `/wp/v2/tags` to resolve existing IDs; POST to `/wp/v2/tags` to create new tags (reuse-or-create matches your requirement). Assign via `categories: [ids]` and `tags: [ids]` on the post.
- **Client library vs raw fetch:** The historical `node-wpapi` client exists but is not actively maintained; in 2026 practitioners overwhelmingly use **raw `fetch`/`axios` with a thin typed wrapper** (see published TypeScript examples). Recommendation: write a small typed `WordPressClient` class over `fetch` — fewer dependencies, full control over the two-step media flow, easy to unit-test.

### 7. Auth / RBAC for the internal tool

The 2026 landscape has consolidated to three real choices; for a self-hosted internal newsroom tool on Neon:

- **Better-Auth (recommended):** Open-source, framework-agnostic, TypeScript-first, sessions stored in **your Neon DB** via a Drizzle/Prisma adapter. Ships an **admin plugin** and an **organization plugin** implementing a resource-action RBAC model (`createAccessControl({ resource: [actions] })`, roles via `newRole`, `hasPermission` checks). Built-in owner/admin/member roles plus custom roles — a clean fit for your Admin/Editor/Journalist hierarchy. v1 stable since early 2025; strong momentum. Caveat: full session checks need Node.js runtime (not edge), and client-side role inference requires passing the exact `createAccessControl` objects to the client plugin.
- **Auth.js v5 (NextAuth):** Largest ecosystem, 40+ OAuth providers, but **no built-in RBAC/2FA/passkeys** — you'd hand-roll roles. Now in maintenance mode; best as a migration bridge, not a greenfield default.
- **Clerk:** Fastest to production with prebuilt UI and managed orgs/RBAC, but it's hosted (auth state leaves your infra) and paid above the free tier — less ideal when data-locality and cost matter.

**Recommendation:** **Better-Auth** with the organization/admin plugins. Model roles as Admin (full control), Editor (approve/publish, manage feeds/categories), Journalist (create/edit drafts, cannot publish). Gate both Next.js server actions and pipeline "publish" steps on `hasPermission`. Note the recent Next.js middleware CVE (CVE-2025-29927) — keep Next.js patched and don't rely on middleware alone for authz.

### 8. Admin dashboard / internal-tool UI with shadcn/ui

- **Starter templates (all free/OSS):**
  - **Kiranism/next-shadcn-dashboard-starter** — Next.js 16 + shadcn/ui + Tailwind v4, with *working* tables (search/filter/sort/paginate), forms with validation, auth/orgs. Best "real, not demo" base for an internal tool.
  - **satnaing/shadcn-admin** — popular free Vite/React + shadcn admin with command palette, dark mode, RTL, WAI-ARIA.
  - **shadcnstore/shadcn-dashboard-landing-template** and **shadcndashboard** — additional free options; the latter bundles a Tiptap-powered blog editor.
- **Component patterns for your three surfaces:**
  - **Pipeline monitoring:** TanStack Table (v8) data grid of runs (status badges, source, timestamps, duration), a run-detail drawer showing step trace/logs. If you use Trigger.dev, you can embed its run data via `runs.list()`/Realtime and its metadata for live status, or mirror run records into your own `pipeline_runs` table and render them.
  - **Content calendar:** a calendar module (several starters ship one) over scheduled/published posts.
  - **Article review/editing:** a **rich text editor**. Use **Novel** (`novel.sh`, by Steven Tey — Notion-style WYSIWYG **built on Tiptap**, with **AI-powered autocomplete** via the Vercel AI SDK, MIT-licensed, ~14.8k GitHub stars, latest release v1.0.2 Feb 2025) or Tiptap directly. **Tiptap 3.0 went stable July 15, 2025**; v3 groups extensions (TableKit), swaps tippy.js for Floating UI, adds markdown render/parse helpers, and Tiptap shipped an AI Toolkit (Nov 19, 2025). Novel integrates cleanly with shadcn/ui + Tailwind. This gives editors an inline "improve/rewrite" affordance backed by OmniRoute.

### 9. Self-hosted OpenAI-compatible LLM gateway (OmniRoute)

- **Client:** Use the **official `openai` npm SDK** and set `baseURL` to OmniRoute's `/v1` endpoint (e.g. `new OpenAI({ baseURL: "https://omniroute.internal/v1", apiKey })`). This is the standard, well-trodden pattern (identical to how people point the SDK at Ollama/Anyscale/OpenRouter). It's the smallest-footprint, highest-adoption SDK (~10M weekly downloads).
- **Multi-provider option:** If you want to swap underlying models freely, the **Vercel AI SDK** (`ai` + a compatible provider) offers `generateObject` for schema-validated structured output across providers and integrates with Trigger.dev tasks — useful given OmniRoute may route to different backend models.
- **Streaming vs non-streaming:** For a background pipeline, **use non-streaming** (`chat.completions.create` without `stream`) — you want the complete validated object, not tokens. Reserve streaming for the interactive editor ("improve this paragraph") surface, where Trigger.dev Realtime or the AI SDK can stream to the client.
- **Structured output reliability — the key risk.** OpenAI's native Structured Outputs (strict JSON schema) *guarantees* schema conformance **only on models/endpoints that implement it**. Behind OmniRoute you may hit open models that only support looser "JSON mode" or nothing. So do **not** assume strict mode. Pattern:
  1. Define a **Zod schema** for the AI's output: `{ title, body_html, category, tags: string[], featured_image_url, summary }`.
  2. Request JSON (use `response_format: {type: "json_object"}` / `zodResponseFormat` where supported; otherwise instruct JSON-only in the prompt).
  3. **Parse defensively:** strip markdown code fences, extract the first `{...}` block, `JSON.parse`, then `schema.safeParse`.
  4. **Retry-on-invalid loop:** on parse/validation failure, re-prompt (up to N times) including the validation error so the model self-corrects — libraries like **Instructor-JS** or **zod-gpt** implement exactly this; the OpenRouter AI-SDK provider even has a "response-healing" plugin that repairs malformed JSON (trailing commas, fences). Wrap this whole call in a Trigger.dev/Inngest `step.run` so retries are durable and observable.
- **French rewriting:** Put the "rewrite in French, in Afrotiative's voice" instruction plus all clustered source texts in the prompt; keep category selection constrained to the fetched WordPress category list (pass the enum into the schema) so the model can't invent categories.

### 10. Comparable products (feature/architecture inspiration)

- **Purpose-built AI RSS→publish tools:** **WP RSS Aggregator (RebelCode)** added an **"AI Rewriting"** feature (Aggregator v5.2.0, Elite plan) that verbatim "AI Rewriting turns each import into an original post in your site's voice" — essentially your exact flow as a WordPress plugin, plus earlier AI Summaries/TL;DRs (v5.1.0). During beta, rewriting is capped at 2,500 words per item. **Wp NewsMaster** is a dedicated "AI Auto-Publisher" that fetches RSS, translates + rewrites via Gemini, auto-generates images, adds SEO schema, and publishes on cron with duplicate-hashing. **AutoWP** and **AI RSS Rewriter** are similar WordPress.org plugins. These validate your feature set and are worth studying, but are WordPress-plugin-bound and less flexible than your custom platform.
- **AI-enabled headless CMS (architecture patterns):** **Storyblok** (named a Leader in the *IDC MarketScape: Worldwide AI-Enabled Headless Content Management Systems 2025 Vendor Assessment*, IDC doc #US52993725, October 2025; "Strata" vector layer for RAG/AI search), **Sanity** (field-level AI actions with brand-compliance guardrails and content-lineage logging), **Contentful**, **Strapi 5** (open-source, REST+GraphQL). The transferable ideas: field-level AI actions (not a blank prompt), governance/spend limits, and content lineage/audit logging.
- **Content-automation pipeline framing:** Industry guides describe the four-layer stack — **Research → Generation → Quality (human) → Publishing** — and stress that the **human Quality/fact-check layer is essential** and the **publishing layer via an API-first CMS is the usual bottleneck**. Your WordPress REST integration is that publishing layer.
- **Newsroom precedent (human-in-the-loop):** Reuters uses internal AI tools ("Lynx Insight," "Fact Genie"); the BBC uses "BBC Style Assist" to reformat to house style — but **no story publishes without journalist review**. The evidence for a mandatory human gate is strong: the EBU/BBC "News Integrity in AI Assistants" study (published Oct 22, 2025; 3,000+ responses across ChatGPT, Copilot, Gemini, Perplexity from 22 public-service media orgs in 18 countries and 14 languages) found **45% of AI responses contained at least one significant issue and 81% had some form of problem**, with sourcing errors in 31%. An earlier Feb 2025 BBC study found **51% of AI-assistant responses to BBC news queries had significant issues**. This is a strong argument for a mandatory human-approval gate before publish in your pipeline.

## Recommendations

**Stage 1 — Foundation (weeks 1–2).**
- Provision Neon with branches (`main`/`dev`/`preview`); enable `CREATE EXTENSION vector`. Use the pooled connection string everywhere except migrations.
- Schema (core tables): `feeds`, `raw_items` (with `guid`, `url`, `content_hash`, `feed_id`), `articles` (extracted + AI output + status enum: `pending`/`review`/`approved`/`published`/`rejected`), `article_embeddings` (vector column + HNSW index), `clusters`, `wp_categories`/`wp_tags` (mirrored), `pipeline_runs` + `pipeline_steps` (for the editorial run-history UI), and Better-Auth's user/session/organization tables.
- Stand up Better-Auth with admin + organization plugins; seed Admin/Editor/Journalist roles.

**Stage 2 — Pipeline (weeks 2–5).**
- Deploy Trigger.dev (self-hosted or cloud). Model the pipeline as one parent task fanning out per feed → per article: `fetchFeed → dedupCheck → extractContent → embed+cluster → aiGenerate(rewrite/category/tags/image) → stageForReview`. Each stage is a `step.run` (durable retries).
- Extraction: Jina Reader hosted primary + Readability/jsdom+DOMPurify fallback.
- AI: `openai` SDK → OmniRoute baseURL, Zod schema + retry-on-invalid-JSON, categories constrained to the mirrored WP list.
- **Insert a mandatory human-approval gate** (status `review`→`approved`) before the publish step — justified by the EBU/BBC error-rate findings (45–51% of AI responses with significant issues) and standard content-automation practice.

**Stage 3 — UI (weeks 4–7).**
- Fork Kiranism's shadcn dashboard starter. Build: (a) **Runs** view (TanStack Table over `pipeline_runs` + step-trace drawer), (b) **Review queue** with the **Novel/Tiptap v3** editor and approve/reject actions gated by RBAC, (c) **Feeds admin**, (d) **Content calendar**.
- Publish step: typed `fetch` WordPress client — two-step media upload, then post with `featured_media`, `categories`, `tags`.

**Stage 4 — Extensibility hooks (design now, build later).**
- Keep publish/distribution as pluggable "channel" adapters (WordPress today; WhatsApp Channel + social later) so the same approved-article event fans out to new channels via new Trigger.dev tasks. Store per-channel publish status in a `distributions` table.

**Benchmarks that change these choices:**
- If article volume exceeds ~tens of thousands/month or you need sub-100ms dedup at scale → add an HNSW index tune / consider a dedicated vector store; below that, pgvector-in-Neon is right.
- If job volume exceeds ~500k runs/month and cost dominates → reconsider BullMQ+Redis over hosted Trigger.dev/Inngest.
- If editors need zero-code pipeline editing (not just observation) → revisit keeping a visual tool (n8n/Inngest) in the loop.
- If OmniRoute's models reliably support strict Structured Outputs → you can simplify the retry loop to a single call.

## Caveats
- **Search-sourced version numbers drift.** `rss-parser` 3.13.0, Tiptap 3.0 (stable 2025-07-15), Novel v1.0.2 (Feb 2025), Better-Auth v1, Trigger.dev v4 SDK, Neon pgvector — verify exact latest versions at build time (`npm view <pkg> version`).
- **Jina free-key RPM is inconsistently reported** across third-party sources (200 vs 500 RPM); keyless ≈20 RPM and paid=500/premium=5,000 are consistent. Confirm against Jina's current dashboard.
- **ReaderLM-v2 weights are non-commercial (CC-BY-NC 4.0)** — do not self-host that specific model for a commercial outlet; the Reader *engine* code is Apache-2.0 and fine.
- **Structured-output guarantees are model-specific**; behind a gateway like OmniRoute you must assume the weakest case and validate/retry.
- **Some sources cited are vendor/marketing or SEO content** (StarterPick, PkgPulse, buildmvpfast, etc.) — directional on tradeoffs but not authoritative on pricing; the primary docs (Neon, Vercel, Trigger.dev, Inngest, Better-Auth, WordPress) are the reliable references.
- **Neon scale-to-zero + polling/pg_cron interaction** can cause surprise cost or missed schedules — design the scheduler to live in Trigger.dev/external cron, not pg_cron on a scale-to-zero branch.
- **Africa-specific operational note:** given potential latency/data-locality and cost considerations for a Cameroon outlet, the self-hostable choices (Trigger.dev, Better-Auth, Jina Reader OSS, self-hosted embeddings) reduce dependence on paid US-metered APIs and keep content on infrastructure you control.