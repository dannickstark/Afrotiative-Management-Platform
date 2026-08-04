# Afrotiative SP3 — RSS → AI Ingestion Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the provider-agnostic ingestion pipeline that turns active RSS feeds into review-ready (`pending`) French articles — fetch → dedup → extract → embed+cluster → AI-rewrite → stage for human review — running credential-free by default and upgrading as keys land.

**Architecture:** Three pluggable, env-ordered, fallback-chained provider layers (LLM, extraction, embeddings) each terminating in a deterministic mock. In-app orchestration (`POST /api/pipeline/run` + a "run now" server action) writes `pipeline_runs`/`pipeline_steps` for observability and stops at the human-review gate (never auto-publishes). Builds on SP0+SP1's schema and review queue.

**Tech Stack:** TypeScript · Bun · Next.js 16 · Drizzle/Neon (pgvector) · Vercel AI SDK (`ai`) + `@ai-sdk/openai-compatible`/`@ai-sdk/openai`/`@ai-sdk/anthropic`/`@ai-sdk/google` · `rss-parser` · `@mozilla/readability` + `jsdom` + `isomorphic-dompurify` · `@mendable/firecrawl-js` · Jina embeddings v3 (direct fetch) · `zod`.

## Global Constraints

- **Runtime & toolchain: Bun** (package manager `bun add`/`bun add -d`, runner `bun run`, tests `bun test` from `bun:test`, TS exec `bun file.ts`). Bun auto-loads `.env.local`; the committed `test-setup.ts` preload also loads it in tests. Never touch/commit `.env.local`. Never `git clean`. Reseed (`bun run db:seed`) if a test/run mutates seeded rows.
- **Exact versions (pin; verify mutual compatibility at install):** ai@7.0.51, @ai-sdk/openai@4.0.29, @ai-sdk/anthropic@4.0.29, @ai-sdk/google@4.0.33, @ai-sdk/openai-compatible@3.0.22, rss-parser@3.13.0, @mozilla/readability@0.6.0, jsdom@30.0.1, isomorphic-dompurify@3.21.0, @mendable/firecrawl-js@4.32.0. zod@4.4.3 already installed. **The Vercel AI SDK API shifts across majors — after install, verify `generateObject`, `embed`, and the provider factory names (`createOpenAICompatible`, `createOpenAI`, etc.) against the installed `node_modules` types and adapt adapter code to the real API. The `LLMClient`/`Embedder` interfaces insulate the rest of the pipeline from provider-SDK churn.**
- **Provider-agnostic + graceful degradation:** every external layer (LLM, extraction, embeddings) is an interface + env-ordered adapter chain + a terminal mock. With NO keys the pipeline still completes a run (Readability + MockLLM + MockEmbedder). Config lives in `lib/config/pipeline-config.ts`; env names are already in `.env.local` and must be documented (no secrets) in `.env.example`.
- **Env (already set in `.env.local`):** `LLM_ORDER="openrouter,omniroute"`, `EXTRACT_ORDER="jina,firecrawl,readability"`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL="openai/gpt-4o-mini"`, `OMNIROUTE_BASE_URL`, `OMNIROUTE_API_KEY`, `OMNIROUTE_MODEL="auto/chat"`, `JINA_API_KEY`, `FIRECRAWL_API_KEY`, `EMBED_BASE_URL="https://api.jina.ai/v1"`, `EMBED_API_KEY="${JINA_API_KEY}"`, `EMBED_MODEL="jina-embeddings-v3"`, `EMBED_DIMENSIONS="1024"`, `PIPELINE_TRIGGER_SECRET`.
- **Provider quirks (live-verified 2026-08-04):** OpenRouter = clean OpenAI-compatible (LLM primary). OmniRoute = routing gateway, **defaults to SSE streaming** and `auto/chat` may route to a reasoning model — the OmniRoute adapter must force non-streaming or handle SSE; it's the fallback, not primary. OmniRoute has **no embeddings** provider → embeddings use **Jina v3** (`api.jina.ai/v1/embeddings`, `dimensions:1024`, confirmed 1024-dim). Extraction Jina Reader = `https://r.jina.ai/<url>`.
- **Embeddings are 1024-dim** (matches `article_embeddings.embedding vector(1024)`); adapters normalize to 1024.
- **UI language French**; pipeline error messages surfaced to humans are French + plain language (technical detail in a separate field). Never a raw stack trace in `pipeline_steps.error_message`.
- **Human-review gate:** the pipeline NEVER publishes. It stages articles as `status='pending'`, `ai_author=true`. WordPress = SP5 (out of scope).
- **RBAC:** the "run now" action requires `pipeline:configure` (Admin) — Editor has `pipeline:read`; Journalist has neither. The cron route requires the `PIPELINE_TRIGGER_SECRET` bearer.
- **DB:** pooled `DATABASE_URL` in app/pipeline code; direct `DIRECT_URL` only for migrations. Any schema change is an **additive** Drizzle migration (never destructive).
- **No silent caps:** `MAX_ITEMS_PER_RUN` (default 20) — log what was skipped/truncated into the run.
- **TDD where logic lives** (config parse, schema+repair, dedup keys, cluster threshold, mock determinism, provider ordering, RSS parse, image-candidate extraction). Network adapters get gated integration checks + the end-to-end verification (Task 10).

---

## File Structure

```
lib/config/pipeline-config.ts        # typed env config: orders, keys, models, thresholds, caps
lib/ai/
  schema.ts                          # Zod ArticleDraft + buildArticleSchema(categories)
  providers.ts                       # build AI-SDK model per provider from config
  generate-article.ts                # generateArticle() — fallback chain + retry-on-invalid
  mock.ts                            # MockLLM (deterministic FR draft)
  index.ts                           # LLMClient wiring (order + fallback + mock terminal)
lib/embeddings/
  jina.ts                            # Jina v3 embeddings (fetch, 1024-dim)
  mock.ts                            # MockEmbedder (deterministic hash-vector, 1024)
  index.ts                           # Embedder (order + fallback + mock); cosine()
lib/extract/
  jina.ts  firecrawl.ts  readability.ts   # extractor adapters
  images.ts                          # candidate image extraction from HTML
  index.ts                           # extract() chain (order + fallback + reason log)
lib/rss/parse-feed.ts                # rss-parser wrapper; normalizeUrl, contentHash
lib/pipeline/
  dedup.ts                           # isSeen()/markSeen() over raw_items
  cluster.ts                         # decideCluster(embedding) via pgvector NN + threshold
  stages.ts                          # per-item stage helpers (extract→embed→generate→stage)
  overlap.ts                         # run overlap guard
  run.ts                             # runPipeline(): orchestration + pipeline_runs/steps
lib/actions/pipeline-actions.ts      # "Lancer une exécution maintenant" (RBAC)
app/api/pipeline/run/route.ts        # POST — bearer-secret cron trigger
components/pipeline/run-now.tsx      # button (RoleGate) + latest runs
app/(app)/runs/page.tsx              # replace placeholder with minimal Runs surface
db/migrations/…                      # only if an additive column is truly needed
tests/{pipeline-config,ai-schema,mock-llm,embeddings,extract-images,extract-chain,rss-parse,dedup,cluster,pipeline-actions}.test.ts
```

---

## Task 1: Pipeline config & env documentation

**Files:** Create `lib/config/pipeline-config.ts`, `.env.example` (update); Test `tests/pipeline-config.test.ts`

**Interfaces:**
- Produces: `getPipelineConfig()` → typed object `{ llmOrder: string[], extractOrder: string[], openrouter?:{apiKey,model}, omniroute?:{baseUrl,apiKey,model}, anthropic?, openai?, google?, jina?:{apiKey}, firecrawl?:{apiKey}, embed:{baseUrl,apiKey,model,dimensions}, clusterThreshold:number, maxItemsPerRun:number, windowHours:number, triggerSecret?:string }`. A provider entry is present only if its key/base is set (drives availability + fallback).

- [ ] **Step 1: Write the config test first**

`tests/pipeline-config.test.ts`:
```ts
import { describe, it, expect } from "bun:test";
import { parsePipelineConfig } from "@/lib/config/pipeline-config";

describe("parsePipelineConfig", () => {
  it("parses order lists and includes only providers with creds", () => {
    const c = parsePipelineConfig({
      LLM_ORDER: "openrouter,omniroute", EXTRACT_ORDER: "jina,firecrawl,readability",
      OPENROUTER_API_KEY: "k", OPENROUTER_MODEL: "openai/gpt-4o-mini",
      EMBED_BASE_URL: "https://api.jina.ai/v1", EMBED_API_KEY: "j", EMBED_MODEL: "jina-embeddings-v3", EMBED_DIMENSIONS: "1024",
    });
    expect(c.llmOrder).toEqual(["openrouter", "omniroute"]);
    expect(c.openrouter?.model).toBe("openai/gpt-4o-mini");
    expect(c.omniroute).toBeUndefined(); // no OMNIROUTE_* creds → not available
    expect(c.embed.dimensions).toBe(1024);
    expect(c.clusterThreshold).toBeCloseTo(0.83);
    expect(c.maxItemsPerRun).toBe(20);
  });
  it("defaults to safe values with an empty env (credential-free run)", () => {
    const c = parsePipelineConfig({});
    expect(c.extractOrder).toContain("readability");
    expect(c.openrouter).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it → FAIL** — `bun test tests/pipeline-config.test.ts` (module missing).

- [ ] **Step 3: Implement `lib/config/pipeline-config.ts`**

```ts
export type ProviderCreds = { apiKey: string; model: string; baseUrl?: string };
export type PipelineConfig = ReturnType<typeof parsePipelineConfig>;

function list(v: string | undefined, fallback: string[]): string[] {
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : fallback;
}

export function parsePipelineConfig(env: Record<string, string | undefined>) {
  const num = (v: string | undefined, d: number) => (v && !Number.isNaN(+v) ? +v : d);
  return {
    llmOrder: list(env.LLM_ORDER, ["openrouter", "omniroute"]),
    extractOrder: list(env.EXTRACT_ORDER, ["jina", "firecrawl", "readability"]),
    openrouter: env.OPENROUTER_API_KEY ? { apiKey: env.OPENROUTER_API_KEY, model: env.OPENROUTER_MODEL || "openai/gpt-4o-mini", baseUrl: "https://openrouter.ai/api/v1" } : undefined,
    omniroute: env.OMNIROUTE_API_KEY && env.OMNIROUTE_BASE_URL ? { apiKey: env.OMNIROUTE_API_KEY, model: env.OMNIROUTE_MODEL || "auto/chat", baseUrl: env.OMNIROUTE_BASE_URL } : undefined,
    anthropic: env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL || "claude-3-5-haiku-latest" } : undefined,
    openai: env.OPENAI_API_KEY ? { apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL || "gpt-4o-mini" } : undefined,
    google: env.GOOGLE_GENERATIVE_AI_API_KEY ? { apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY, model: env.GOOGLE_MODEL || "gemini-2.0-flash" } : undefined,
    jina: env.JINA_API_KEY ? { apiKey: env.JINA_API_KEY } : undefined,
    firecrawl: env.FIRECRAWL_API_KEY ? { apiKey: env.FIRECRAWL_API_KEY } : undefined,
    embed: {
      baseUrl: env.EMBED_BASE_URL || "https://api.jina.ai/v1",
      apiKey: env.EMBED_API_KEY || env.JINA_API_KEY || "",
      model: env.EMBED_MODEL || "jina-embeddings-v3",
      dimensions: num(env.EMBED_DIMENSIONS, 1024),
    },
    clusterThreshold: num(env.CLUSTER_THRESHOLD, 0.83),
    maxItemsPerRun: num(env.MAX_ITEMS_PER_RUN, 20),
    windowHours: num(env.CLUSTER_WINDOW_HOURS, 72),
    triggerSecret: env.PIPELINE_TRIGGER_SECRET,
  };
}

export function getPipelineConfig() { return parsePipelineConfig(process.env); }
```

- [ ] **Step 4: Run it → PASS.** Run: `bun test tests/pipeline-config.test.ts`.

- [ ] **Step 5: Document env in `.env.example`** — append the SP3 names (NO secret values), e.g.:
```bash
# SP3 pipeline (all optional — pipeline runs credential-free without them)
LLM_ORDER="openrouter,omniroute"
OPENROUTER_API_KEY=""      # OPENROUTER_MODEL="openai/gpt-4o-mini"
OMNIROUTE_BASE_URL=""      # OMNIROUTE_API_KEY=""  OMNIROUTE_MODEL="auto/chat"
EXTRACT_ORDER="jina,firecrawl,readability"
JINA_API_KEY=""            # covers Jina Reader (extract) AND Jina embeddings
FIRECRAWL_API_KEY=""
EMBED_BASE_URL="https://api.jina.ai/v1"  # EMBED_MODEL="jina-embeddings-v3" EMBED_DIMENSIONS="1024"
CLUSTER_THRESHOLD="0.83"   # MAX_ITEMS_PER_RUN="20"  CLUSTER_WINDOW_HOURS="72"
PIPELINE_TRIGGER_SECRET="" # required for the cron POST /api/pipeline/run
```

- [ ] **Step 6: typecheck + commit.** `bun run typecheck` clean. `git add -A && git commit -m "feat(pipeline): typed env config with provider availability + safe defaults"`

---

## Task 2: LLM provider layer (`lib/ai/`)

**Files:** Create `lib/ai/{schema.ts,providers.ts,generate-article.ts,mock.ts,index.ts}`; Test `tests/ai-schema.test.ts`, `tests/mock-llm.test.ts`

**Interfaces:**
- Consumes: `getPipelineConfig()`.
- Produces:
  - `type ArticleDraft = { title, bodyHtml, excerpt, category, tags: string[], featuredImageUrl: string|null, imageCredit: string|null, imageSourceUrl: string|null, confidence: {categoryUncertain:boolean, imageMissing:boolean, clusterUncertain:boolean} }`.
  - `buildArticleSchema(categoryNames: string[])` → a Zod schema whose `category` is `z.enum(categoryNames)` (falls back to `z.string()` if the list is empty).
  - `generateArticle(input: { sources: {mediaName,url,text}[], candidateImages: string[], categories: string[] }): Promise<{ draft: ArticleDraft; via: string }>` — tries `config.llmOrder` providers, falls through on error/quota/invalid-JSON, terminal `MockLLM`; returns which provider produced it (`via`).

- [ ] **Step 1: Article schema + test**

`lib/ai/schema.ts`:
```ts
import { z } from "zod";

export const confidenceSchema = z.object({
  categoryUncertain: z.boolean(), imageMissing: z.boolean(), clusterUncertain: z.boolean(),
});

export function buildArticleSchema(categoryNames: string[]) {
  const category = categoryNames.length >= 1
    ? z.enum(categoryNames as [string, ...string[]])
    : z.string();
  return z.object({
    title: z.string().min(5),
    bodyHtml: z.string().min(1),
    excerpt: z.string(),
    category,
    tags: z.array(z.string()).max(8),
    featuredImageUrl: z.string().url().nullable(),
    imageCredit: z.string().nullable(),
    imageSourceUrl: z.string().url().nullable(),
    confidence: confidenceSchema,
  });
}
export type ArticleDraft = z.infer<ReturnType<typeof buildArticleSchema>> & { category: string };
```

`tests/ai-schema.test.ts`:
```ts
import { describe, it, expect } from "bun:test";
import { buildArticleSchema } from "@/lib/ai/schema";

describe("buildArticleSchema", () => {
  it("constrains category to the provided list", () => {
    const s = buildArticleSchema(["Économie", "Finance"]);
    expect(s.safeParse({ title: "Titre long", bodyHtml: "<p>x</p>", excerpt: "e", category: "Sport",
      tags: [], featuredImageUrl: null, imageCredit: null, imageSourceUrl: null,
      confidence: { categoryUncertain: false, imageMissing: false, clusterUncertain: false } }).success).toBe(false);
    expect(s.safeParse({ title: "Titre long", bodyHtml: "<p>x</p>", excerpt: "e", category: "Finance",
      tags: ["BRVM"], featuredImageUrl: null, imageCredit: null, imageSourceUrl: null,
      confidence: { categoryUncertain: false, imageMissing: false, clusterUncertain: false } }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Install AI SDK + verify API**

Run: `bun add ai@7.0.51 @ai-sdk/openai@4.0.29 @ai-sdk/anthropic@4.0.29 @ai-sdk/google@4.0.33 @ai-sdk/openai-compatible@3.0.22`
Then VERIFY the installed API: read `node_modules/ai/dist/index.d.ts` (or `.d.mts`) for the `generateObject` signature and `node_modules/@ai-sdk/openai-compatible/…` for the factory name/signature. If any pinned versions have peer-dep conflicts, install the latest mutually-compatible set instead and note it in the report. The provider/`generateObject` calls in Step 4 must match the INSTALLED API.

- [ ] **Step 3: MockLLM + test**

`lib/ai/mock.ts`:
```ts
import type { ArticleDraft } from "./schema";

export function mockGenerateArticle(input: { sources: { mediaName: string; text: string }[]; candidateImages: string[]; categories: string[] }): ArticleDraft {
  const first = input.sources[0];
  const base = (first?.text ?? "Contenu indisponible").slice(0, 400);
  return {
    title: `[MOCK] ${base.slice(0, 60)}`.trim(),
    bodyHtml: `<p>${base}</p><h2>Contexte</h2><p>Article de substitution généré sans fournisseur IA configuré.</p>`,
    excerpt: base.slice(0, 140),
    category: input.categories[0] ?? "Économie",
    tags: ["à vérifier"],
    featuredImageUrl: input.candidateImages[0] ?? null,
    imageCredit: input.candidateImages[0] ? (first?.mediaName ?? null) : null,
    imageSourceUrl: null,
    confidence: { categoryUncertain: true, imageMissing: !input.candidateImages[0], clusterUncertain: true },
  };
}
```

`tests/mock-llm.test.ts`:
```ts
import { describe, it, expect } from "bun:test";
import { mockGenerateArticle } from "@/lib/ai/mock";

describe("mockGenerateArticle", () => {
  it("is deterministic and always low-confidence", () => {
    const input = { sources: [{ mediaName: "Ecofin", text: "La BRVM progresse fortement cette semaine." }], candidateImages: [], categories: ["Marchés"] };
    const a = mockGenerateArticle(input), b = mockGenerateArticle(input);
    expect(a).toEqual(b);
    expect(a.category).toBe("Marchés");
    expect(a.confidence.categoryUncertain).toBe(true);
  });
});
```

- [ ] **Step 4: Providers + generateArticle (fallback chain)**

`lib/ai/providers.ts` — build an AI-SDK `LanguageModel` for a provider name from config, using the INSTALLED API. Representative (adapt to verified API):
```ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { PipelineConfig } from "@/lib/config/pipeline-config";

export function buildModel(name: string, cfg: PipelineConfig) {
  switch (name) {
    case "openrouter":
      if (!cfg.openrouter) return null;
      return createOpenAICompatible({ name: "openrouter", baseURL: cfg.openrouter.baseUrl!, apiKey: cfg.openrouter.apiKey })(cfg.openrouter.model);
    case "omniroute":
      if (!cfg.omniroute) return null;
      // OmniRoute defaults to SSE + may route to a reasoning model — force non-streaming downstream.
      return createOpenAICompatible({ name: "omniroute", baseURL: cfg.omniroute.baseUrl!, apiKey: cfg.omniroute.apiKey })(cfg.omniroute.model);
    case "anthropic": return cfg.anthropic ? createAnthropic({ apiKey: cfg.anthropic.apiKey })(cfg.anthropic.model) : null;
    case "openai": return cfg.openai ? createOpenAI({ apiKey: cfg.openai.apiKey })(cfg.openai.model) : null;
    case "google": return cfg.google ? createGoogleGenerativeAI({ apiKey: cfg.google.apiKey })(cfg.google.model) : null;
    default: return null;
  }
}
```

`lib/ai/generate-article.ts` — the chain with retry-on-invalid; `generateObject` is non-streaming (this is what constrains OmniRoute to non-streaming). On any provider throw / schema failure, move to the next; terminal mock:
```ts
import { generateObject } from "ai";
import { buildArticleSchema, type ArticleDraft } from "./schema";
import { buildModel } from "./providers";
import { mockGenerateArticle } from "./mock";
import { getPipelineConfig } from "@/lib/config/pipeline-config";

export type GenerateInput = { sources: { mediaName: string; url: string; text: string }[]; candidateImages: string[]; categories: string[] };

function prompt(input: GenerateInput): string {
  const cats = input.categories.join(", ");
  const srcs = input.sources.map((s, i) => `Source ${i + 1} — ${s.mediaName} (${s.url}):\n${s.text.slice(0, 6000)}`).join("\n\n");
  return [
    "Tu es journaliste économique pour Afrotiative, média panafricain business & finance francophone.",
    "À partir des sources ci-dessous couvrant le même sujet, rédige UN article original en français, ton professionnel, factuel, sourcé.",
    `Choisis la catégorie STRICTEMENT dans cette liste: ${cats}. Si aucune ne convient, choisis la plus proche et mets confidence.categoryUncertain=true.`,
    "Propose des tags courts. Si une image candidate convient, choisis featuredImageUrl parmi les sources et renseigne imageCredit; sinon featuredImageUrl=null et confidence.imageMissing=true.",
    "Réponds uniquement via le schéma structuré demandé.",
    "\n" + srcs,
  ].join("\n");
}

export async function generateArticle(input: GenerateInput): Promise<{ draft: ArticleDraft; via: string }> {
  const cfg = getPipelineConfig();
  const schema = buildArticleSchema(input.categories);
  for (const name of cfg.llmOrder) {
    const model = buildModel(name, cfg);
    if (!model) continue;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { object } = await generateObject({ model, schema, prompt: prompt(input) });
        return { draft: object as ArticleDraft, via: name };
      } catch (e) {
        if (attempt === 1) break; // exhausted this provider's retries → next provider
      }
    }
  }
  return { draft: mockGenerateArticle(input), via: "mock" };
}
```

`lib/ai/index.ts`: `export { generateArticle } from "./generate-article"; export * from "./schema";`

- [ ] **Step 5: Run tests + typecheck.** `bun test tests/ai-schema.test.ts tests/mock-llm.test.ts && bun run typecheck` → PASS/clean.

- [ ] **Step 6: (Gated) live LLM smoke** — with keys present, a throwaway `bun -e` calling `generateArticle` on one fake source + `["Économie","Marchés"]` should return a `draft` with `via` in `["openrouter","omniroute"]` and a category in the list. If OmniRoute-only is exercised and streaming breaks `generateObject`, note it — OpenRouter primary is the guaranteed path; mock is the floor. Do NOT commit throwaway scripts.

- [ ] **Step 7: Commit.** `git add -A && git commit -m "feat(ai): provider-agnostic generateArticle (fallback chain + Zod repair + mock)"`

---

## Task 3: Embeddings provider layer (`lib/embeddings/`)

**Files:** Create `lib/embeddings/{jina.ts,mock.ts,index.ts}`; Test `tests/embeddings.test.ts`

**Interfaces:**
- Produces: `embed(text: string): Promise<number[]>` (length = config.embed.dimensions = 1024; Jina first, MockEmbedder fallback); `cosine(a:number[], b:number[]): number`; `mockEmbed(text, dims)`.

- [ ] **Step 1: Test first**

`tests/embeddings.test.ts`:
```ts
import { describe, it, expect } from "bun:test";
import { mockEmbed, cosine } from "@/lib/embeddings";

describe("embeddings", () => {
  it("mockEmbed is deterministic, 1024-dim, unit-normalized", () => {
    const a = mockEmbed("La BRVM progresse", 1024), b = mockEmbed("La BRVM progresse", 1024);
    expect(a.length).toBe(1024);
    expect(a).toEqual(b);
    expect(cosine(a, b)).toBeCloseTo(1, 5);
  });
  it("cosine of orthogonal-ish differs from identical", () => {
    const a = mockEmbed("texte A", 1024), c = mockEmbed("texte totalement different", 1024);
    expect(cosine(a, c)).toBeLessThan(0.999);
  });
});
```

- [ ] **Step 2: Run → FAIL.** `bun test tests/embeddings.test.ts`.

- [ ] **Step 3: Implement**

`lib/embeddings/mock.ts`:
```ts
export function mockEmbed(text: string, dims: number): number[] {
  // deterministic hash → pseudo-random unit vector
  const v = new Array(dims).fill(0);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  for (let i = 0; i < dims; i++) { h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0; v[i] = ((h % 2000) / 1000) - 1; }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}
```

`lib/embeddings/jina.ts`:
```ts
export async function jinaEmbed(text: string, opts: { baseUrl: string; apiKey: string; model: string; dimensions: number }): Promise<number[]> {
  const res = await fetch(`${opts.baseUrl.replace(/\/$/, "")}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: opts.model, dimensions: opts.dimensions, input: [text.slice(0, 8000)] }),
  });
  if (!res.ok) throw new Error(`Jina embeddings ${res.status}`);
  const data = await res.json();
  const emb = data?.data?.[0]?.embedding;
  if (!Array.isArray(emb)) throw new Error("Jina embeddings: réponse invalide");
  return emb.length === opts.dimensions ? emb : normalizeDims(emb, opts.dimensions);
}
function normalizeDims(v: number[], dims: number): number[] {
  if (v.length > dims) return v.slice(0, dims);
  return v.concat(new Array(dims - v.length).fill(0));
}
```

`lib/embeddings/index.ts`:
```ts
import { getPipelineConfig } from "@/lib/config/pipeline-config";
import { jinaEmbed } from "./jina";
import { mockEmbed } from "./mock";
export { mockEmbed } from "./mock";

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export async function embed(text: string): Promise<{ vector: number[]; via: string }> {
  const cfg = getPipelineConfig();
  if (cfg.embed.apiKey) {
    try { return { vector: await jinaEmbed(text, cfg.embed), via: "jina" }; } catch {}
  }
  return { vector: mockEmbed(text, cfg.embed.dimensions), via: "mock" };
}
```

- [ ] **Step 4: Run → PASS + typecheck.** `bun test tests/embeddings.test.ts && bun run typecheck`.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(embeddings): Jina v3 1024-dim embeddings + deterministic mock + cosine"`

---

## Task 4: Extraction provider chain (`lib/extract/`)

**Files:** Create `lib/extract/{jina.ts,firecrawl.ts,readability.ts,images.ts,index.ts}`; Test `tests/extract-images.test.ts`, `tests/extract-chain.test.ts`

**Interfaces:**
- Produces: `type Extracted = { title: string; text: string; images: string[]; via: string }`; `extract(url): Promise<Extracted>` (chain per `config.extractOrder`, reasons logged); `extractImages(html, baseUrl): string[]`; `readabilityExtract(url|html): Promise<Extracted>`.

- [ ] **Step 1: Install deps** — `bun add rss-parser@3.13.0 @mozilla/readability@0.6.0 jsdom@30.0.1 isomorphic-dompurify@3.21.0 @mendable/firecrawl-js@4.32.0` (rss-parser used in Task 5). Verify `@mendable/firecrawl-js` export/scrape API against `node_modules` types.

- [ ] **Step 2: Image extraction (test-first)**

`tests/extract-images.test.ts`:
```ts
import { describe, it, expect } from "bun:test";
import { extractImages } from "@/lib/extract/images";

describe("extractImages", () => {
  it("collects og:image and reasonable inline imgs, absolutized", () => {
    const html = `<html><head><meta property="og:image" content="/hero.jpg"></head>
      <body><img src="https://cdn.x/a.png" width="800"><img src="/spacer.gif" width="1"></body></html>`;
    const imgs = extractImages(html, "https://example.com/article");
    expect(imgs).toContain("https://example.com/hero.jpg");
    expect(imgs).toContain("https://cdn.x/a.png");
    expect(imgs.some((u) => u.includes("spacer.gif"))).toBe(false); // 1px filtered
  });
});
```

`lib/extract/images.ts`:
```ts
import { JSDOM } from "jsdom";
export function extractImages(html: string, baseUrl: string): string[] {
  const doc = new JSDOM(html, { url: baseUrl }).window.document;
  const out = new Set<string>();
  const og = doc.querySelector('meta[property="og:image"]')?.getAttribute("content");
  const abs = (u: string | null | undefined) => { try { return u ? new URL(u, baseUrl).href : null; } catch { return null; } };
  const ogAbs = abs(og); if (ogAbs) out.add(ogAbs);
  doc.querySelectorAll("img").forEach((img) => {
    const w = parseInt(img.getAttribute("width") || "0", 10);
    const src = abs(img.getAttribute("src"));
    if (src && (w === 0 || w >= 200) && !/\.svg($|\?)/i.test(src)) out.add(src);
  });
  return [...out].slice(0, 8);
}
```

- [ ] **Step 3: Readability adapter (no network for the HTML path — test on a fixture)**

`lib/extract/readability.ts`:
```ts
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import DOMPurify from "isomorphic-dompurify";
import { extractImages } from "./images";
import type { Extracted } from "./index";

export function readabilityFromHtml(html: string, url: string): Extracted {
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const parsed = reader.parse();
  const clean = parsed?.content ? DOMPurify.sanitize(parsed.content) : "";
  const text = (parsed?.textContent ?? "").trim();
  const fallback = text.length < 100
    ? (dom.window.document.querySelector("article,main,[role=main]")?.textContent ?? "").trim()
    : text;
  return { title: parsed?.title ?? "", text: (fallback || clean).slice(0, 20000), images: extractImages(html, url), via: "readability" };
}

export async function readabilityExtract(url: string): Promise<Extracted> {
  const res = await fetch(url, { headers: { "user-agent": "AfrotiativeBot/1.0" } });
  const html = await res.text();
  return readabilityFromHtml(html, url);
}
```

`tests/extract-chain.test.ts` (readability on a fixture — no network):
```ts
import { describe, it, expect } from "bun:test";
import { readabilityFromHtml } from "@/lib/extract/readability";

describe("readabilityFromHtml", () => {
  it("extracts article text + title + images from HTML", () => {
    const html = `<html><head><title>La BRVM</title><meta property="og:image" content="https://x/h.jpg"></head>
      <body><article><h1>La BRVM franchit un record</h1>
      <p>${"La bourse régionale progresse fortement. ".repeat(20)}</p></article></body></html>`;
    const e = readabilityFromHtml(html, "https://example.com/a");
    expect(e.text.length).toBeGreaterThan(100);
    expect(e.images).toContain("https://x/h.jpg");
    expect(e.via).toBe("readability");
  });
});
```

- [ ] **Step 4: Jina + Firecrawl adapters**

`lib/extract/jina.ts`:
```ts
import { extractImages } from "./images";
import type { Extracted } from "./index";
export async function jinaExtract(url: string, apiKey: string): Promise<Extracted> {
  const res = await fetch(`https://r.jina.ai/${url}`, { headers: { Authorization: `Bearer ${apiKey}`, "X-Return-Format": "markdown" } });
  if (!res.ok) throw new Error(`Jina Reader ${res.status}`);
  const md = await res.text();
  if (md.trim().length < 100) throw new Error("Jina Reader: contenu trop court");
  // Jina returns markdown; images are captured separately by the caller from the raw page when needed.
  return { title: "", text: md.slice(0, 20000), images: [], via: "jina" };
}
```

`lib/extract/firecrawl.ts` — use `@mendable/firecrawl-js` (verify API); scrape → markdown/html; on non-OK/quota throw so the chain falls through:
```ts
import Firecrawl from "@mendable/firecrawl-js";
import type { Extracted } from "./index";
export async function firecrawlExtract(url: string, apiKey: string): Promise<Extracted> {
  const fc = new Firecrawl({ apiKey });
  const doc: any = await fc.scrape(url, { formats: ["markdown"] }); // adapt to the installed SDK's method/shape
  const text: string = doc?.markdown ?? doc?.data?.markdown ?? "";
  if (!text || text.trim().length < 100) throw new Error("Firecrawl: contenu trop court");
  return { title: doc?.metadata?.title ?? "", text: text.slice(0, 20000), images: [], via: "firecrawl" };
}
```

- [ ] **Step 5: Chain with fallback + reason log**

`lib/extract/index.ts`:
```ts
import { getPipelineConfig } from "@/lib/config/pipeline-config";
import { jinaExtract } from "./jina";
import { firecrawlExtract } from "./firecrawl";
import { readabilityExtract } from "./readability";
export type Extracted = { title: string; text: string; images: string[]; via: string };
export type ExtractResult = Extracted & { attempts: { provider: string; ok: boolean; reason?: string }[] };

export async function extract(url: string): Promise<ExtractResult> {
  const cfg = getPipelineConfig();
  const attempts: ExtractResult["attempts"] = [];
  for (const name of cfg.extractOrder) {
    try {
      let r: Extracted;
      if (name === "jina") { if (!cfg.jina) { attempts.push({ provider: name, ok: false, reason: "pas de clé Jina" }); continue; } r = await jinaExtract(url, cfg.jina.apiKey); }
      else if (name === "firecrawl") { if (!cfg.firecrawl) { attempts.push({ provider: name, ok: false, reason: "pas de clé Firecrawl" }); continue; } r = await firecrawlExtract(url, cfg.firecrawl.apiKey); }
      else if (name === "readability") { r = await readabilityExtract(url); }
      else continue;
      attempts.push({ provider: name, ok: true });
      // Jina/Firecrawl return clean text but no images — backfill candidate images from a best-effort raw fetch.
      if (r.images.length === 0 && name !== "readability") r.images = await backfillImages(url);
      return { ...r, attempts };
    } catch (e) {
      attempts.push({ provider: name, ok: false, reason: (e as Error).message });
    }
  }
  return { title: "", text: "", images: [], via: "none", attempts };
}

async function backfillImages(url: string): Promise<string[]> {
  try {
    const res = await fetch(url, { headers: { "user-agent": "AfrotiativeBot/1.0" }, signal: AbortSignal.timeout(10000) });
    return extractImages(await res.text(), url);
  } catch { return []; }
}
```
(Import `extractImages` from `./images` at the top of `index.ts`.)

- [ ] **Step 6: Run tests + typecheck.** `bun test tests/extract-images.test.ts tests/extract-chain.test.ts && bun run typecheck`. (Gated) live check: `extract("<a real feed article url>")` returns `via:"jina"` and non-empty text with keys present.

- [ ] **Step 7: Commit.** `git add -A && git commit -m "feat(extract): Jina→Firecrawl→Readability chain with fallback reasons + image candidates"`

---

## Task 5: RSS parsing (`lib/rss/parse-feed.ts`)

**Files:** Create `lib/rss/parse-feed.ts`; Test `tests/rss-parse.test.ts`

**Interfaces:**
- Produces: `parseFeed(feedUrl): Promise<RawItem[]>` where `RawItem = { guid, url, title, contentSnippet, isoDate, contentHash }`; `normalizeUrl(u): string`; `contentHash(title, body): string`.

- [ ] **Step 1: Test the pure helpers first**

`tests/rss-parse.test.ts`:
```ts
import { describe, it, expect } from "bun:test";
import { normalizeUrl, contentHash } from "@/lib/rss/parse-feed";

describe("rss helpers", () => {
  it("normalizeUrl strips utm + trailing slash + lowercases host", () => {
    expect(normalizeUrl("https://Example.com/a/?utm_source=x&id=2#frag"))
      .toBe("https://example.com/a?id=2");
  });
  it("contentHash is stable for same normalized content", () => {
    expect(contentHash("Titre", "Corps")).toBe(contentHash("Titre", "Corps"));
    expect(contentHash("Titre", "Corps")).not.toBe(contentHash("Titre", "Autre"));
  });
});
```

- [ ] **Step 2: Run → FAIL.** `bun test tests/rss-parse.test.ts`.

- [ ] **Step 3: Implement**

```ts
import Parser from "rss-parser";
import { createHash } from "node:crypto";

export type RawItem = { guid: string; url: string; title: string; contentSnippet: string; isoDate: string | null; contentHash: string };

export function normalizeUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = "";
    url.host = url.host.toLowerCase();
    [...url.searchParams.keys()].forEach((k) => { if (/^utm_|^fbclid$|^gclid$/i.test(k)) url.searchParams.delete(k); });
    let s = url.toString();
    s = s.replace(/\/(\?|$)/, "$1").replace(/\?$/, "");
    return s;
  } catch { return u; }
}
export function contentHash(title: string, body: string): string {
  return createHash("sha256").update(`${title.trim().toLowerCase()}\n${body.trim().toLowerCase()}`).digest("hex");
}

const parser = new Parser({ timeout: 15000, headers: { "user-agent": "AfrotiativeBot/1.0" } });

export async function parseFeed(feedUrl: string): Promise<RawItem[]> {
  const feed = await parser.parseURL(feedUrl);
  return (feed.items ?? []).map((it) => {
    const url = normalizeUrl(it.link ?? "");
    const title = it.title ?? "";
    const body = it.contentSnippet ?? it.content ?? "";
    return { guid: it.guid ?? url, url, title, contentSnippet: body, isoDate: it.isoDate ?? null, contentHash: contentHash(title, body) };
  }).filter((r) => r.url);
}
```

- [ ] **Step 4: Run → PASS + typecheck.** `bun test tests/rss-parse.test.ts && bun run typecheck`. (Gated) live: `parseFeed("https://www.financialafrik.com/feed/")` returns ≥1 item.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(rss): rss-parser wrapper with url normalization + content hashing"`

---

## Task 6: Dedup & clustering (`lib/pipeline/dedup.ts`, `cluster.ts`)

**Files:** Create `lib/pipeline/dedup.ts`, `lib/pipeline/cluster.ts`; Test `tests/dedup.test.ts`, `tests/cluster.test.ts`

**Interfaces:**
- Produces:
  - `isSeen(feedId, item): Promise<boolean>` (guid OR normalized-url OR contentHash already in `raw_items`); `recordRawItem(feedId, item): Promise<void>`.
  - `decideCluster(embedding: number[]): Promise<{ clusterId: string | null; isNew: boolean; bestScore: number }>` — pgvector nearest article within `windowHours` above `clusterThreshold`; returns its `cluster_id` (or null → new cluster created at stage time); pure decision function `chooseCluster(bestScore, threshold)` for unit testing.

- [ ] **Step 1: Unit tests (pure decision + dedup keying)**

`tests/cluster.test.ts`:
```ts
import { describe, it, expect } from "bun:test";
import { chooseCluster } from "@/lib/pipeline/cluster";

describe("chooseCluster", () => {
  it("attaches when score ≥ threshold, else new", () => {
    expect(chooseCluster(0.9, 0.83)).toBe("attach");
    expect(chooseCluster(0.7, 0.83)).toBe("new");
  });
});
```

`tests/dedup.test.ts`:
```ts
import { describe, it, expect } from "bun:test";
import { dedupKeys } from "@/lib/pipeline/dedup";

describe("dedupKeys", () => {
  it("derives guid/url/hash keys used for the seen-check", () => {
    const k = dedupKeys({ guid: "g1", url: "https://x/a", contentHash: "h1" } as any);
    expect(k).toEqual(["g1", "https://x/a", "h1"]);
  });
});
```

- [ ] **Step 2: Run → FAIL.** `bun test tests/dedup.test.ts tests/cluster.test.ts`.

- [ ] **Step 3: Implement dedup**

```ts
// lib/pipeline/dedup.ts
import { db, rawItems } from "@/db";
import { and, eq, or } from "drizzle-orm";
import type { RawItem } from "@/lib/rss/parse-feed";

export function dedupKeys(item: RawItem): [string, string, string] { return [item.guid, item.url, item.contentHash]; }

export async function isSeen(feedId: string, item: RawItem): Promise<boolean> {
  const [g, u, h] = dedupKeys(item);
  const hit = await db.select({ id: rawItems.id }).from(rawItems)
    .where(or(eq(rawItems.guid, g), eq(rawItems.url, u), eq(rawItems.contentHash, h))).limit(1);
  return hit.length > 0;
}
export async function recordRawItem(feedId: string, item: RawItem): Promise<string> {
  const [row] = await db.insert(rawItems).values({
    feedId, guid: item.guid, url: item.url, contentHash: item.contentHash,
    rawTitle: item.title, rawBody: item.contentSnippet,
  }).returning({ id: rawItems.id });
  return row.id;
}
```

- [ ] **Step 4: Implement cluster**

```ts
// lib/pipeline/cluster.ts
import { db, articles, articleEmbeddings } from "@/db";
import { sql, gte, and } from "drizzle-orm";
import { getPipelineConfig } from "@/lib/config/pipeline-config";

export function chooseCluster(bestScore: number, threshold: number): "attach" | "new" {
  return bestScore >= threshold ? "attach" : "new";
}

// nearest existing article embedding within the recency window, by cosine distance (pgvector <=>)
export async function decideCluster(embedding: number[]): Promise<{ clusterId: string | null; bestScore: number }> {
  const cfg = getPipelineConfig();
  const since = new Date(Date.now() - cfg.windowHours * 3600_000);
  const vec = `[${embedding.join(",")}]`;
  const rows = await db.execute(sql`
    select a.cluster_id as cluster_id, 1 - (e.embedding <=> ${vec}::vector) as score
    from ${articleEmbeddings} e join ${articles} a on a.id = e.article_id
    where a.generated_at >= ${since} and a.cluster_id is not null
    order by e.embedding <=> ${vec}::vector asc limit 1`);
  const top = (rows as any).rows?.[0] ?? (rows as any)[0];
  const bestScore = top ? Number(top.score) : 0;
  if (top && chooseCluster(bestScore, cfg.clusterThreshold) === "attach") return { clusterId: top.cluster_id, bestScore };
  return { clusterId: null, bestScore };
}
```
> Verify the Drizzle `db.execute` raw-SQL result shape against the installed drizzle-orm (Task 2 SP0 used `pg`); adapt `.rows` access accordingly. The `<=>` operator + `::vector` cast rely on the pgvector extension already enabled in SP0.

- [ ] **Step 5: Run unit tests → PASS + typecheck.** `bun test tests/dedup.test.ts tests/cluster.test.ts && bun run typecheck`.

- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(pipeline): exact dedup + pgvector semantic clustering decision"`

---

## Task 7: Pipeline orchestration (`lib/pipeline/{run,stages,overlap}.ts`)

**Files:** Create `lib/pipeline/run.ts`, `lib/pipeline/stages.ts`, `lib/pipeline/overlap.ts`; Test `tests/pipeline-run.test.ts` (mock-provider end-to-end against a stubbed feed)

**Interfaces:**
- Consumes: everything above + `db` tables (`feeds, articles, articleSources, articleTags, articleEmbeddings, clusters, wpCategories, wpTags, pipelineRuns, pipelineSteps`).
- Produces: `runPipeline(opts: { triggeredBy: "manual"|"scheduled"; feedIds?: string[] }): Promise<{ runId: string; status: string; produced: number }>`; `stageItem(...)` per-item helper; `hasRunningRun(): Promise<boolean>`.

- [ ] **Step 1: Overlap guard**

```ts
// lib/pipeline/overlap.ts
import { db, pipelineRuns } from "@/db";
import { eq } from "drizzle-orm";
export async function hasRunningRun(): Promise<boolean> {
  const rows = await db.select({ id: pipelineRuns.id }).from(pipelineRuns).where(eq(pipelineRuns.status, "running")).limit(1);
  return rows.length > 0;
}
```

- [ ] **Step 2: Stage helper (one item → pending article) + step recording**

`lib/pipeline/stages.ts` — extract → embed → cluster-decide → generate → insert article+sources+tags+embedding; returns the created article id + the ordered step records. Full implementation (record each step's status/duration/plain-fr-error):
```ts
import { db, articles, articleSources, articleTags, articleEmbeddings, clusters, wpTags } from "@/db";
import { extract } from "@/lib/extract";
import { embed } from "@/lib/embeddings";
import { decideCluster } from "./cluster";
import { generateArticle } from "@/lib/ai";
import { inArray } from "drizzle-orm";
import type { RawItem } from "@/lib/rss/parse-feed";

export type StepRec = { name: string; status: "success" | "failed"; durationMs: number; errorMessage?: string; errorTechnical?: string };

export async function stageItem(item: RawItem, mediaName: string, categoryNames: string[]): Promise<{ articleId: string | null; steps: StepRec[] }> {
  const steps: StepRec[] = [];
  const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try { const r = await fn(); steps.push({ name, status: "success", durationMs: Date.now() - t0 }); return r; }
    catch (e) { steps.push({ name, status: "failed", durationMs: Date.now() - t0, errorMessage: humanError(name, e as Error), errorTechnical: (e as Error).stack }); throw e; }
  };
  try {
    const ex = await timed("Extraction du contenu", () => extract(item.url));
    const text = ex.text || item.contentSnippet;
    const { vector } = await timed("Calcul de l'embedding", () => embed(`${item.title}\n${text}`));
    const cluster = await timed("Regroupement (clustering)", () => decideCluster(vector));
    const { draft } = await timed("Génération IA", () => generateArticle({
      sources: [{ mediaName, url: item.url, text }], candidateImages: ex.images, categories: categoryNames,
    }));
    const articleId = await timed("Dépôt en revue", async () => {
      let clusterId = cluster.clusterId;
      if (!clusterId) { const [c] = await db.insert(clusters).values({ label: draft.title.slice(0, 80) }).returning({ id: clusters.id }); clusterId = c.id; }
      const catId = await resolveCategoryId(draft.category, categoryNames);
      const [a] = await db.insert(articles).values({
        title: draft.title, bodyHtml: draft.bodyHtml, excerpt: draft.excerpt, status: "pending", aiAuthor: true,
        categoryId: catId, featuredImageUrl: draft.featuredImageUrl, imageCredit: draft.imageCredit, imageSourceUrl: draft.imageSourceUrl,
        clusterId, confidenceFlags: draft.confidence, generatedAt: new Date(),
      }).returning({ id: articles.id });
      await db.insert(articleSources).values({ articleId: a.id, mediaName, url: item.url });
      await db.insert(articleEmbeddings).values({ articleId: a.id, embedding: vector });
      await insertTags(a.id, draft.tags);
      return a.id;
    });
    return { articleId, steps };
  } catch { return { articleId: null, steps }; }
}

function humanError(step: string, e: Error): string {
  return `${step} a échoué : ${e.message}`; // plain French, no stack
}
// resolveCategoryId + insertTags: look up wpCategories by name; wpTags membership → is_new. (Implement with db lookups.)
```
Provide the referenced helpers (`resolveCategoryId`, `insertTags`) fully in this file: look up `wpCategories` by exact name (null if not found), and for each tag set `isNew` = not present in `wpTags`.

- [ ] **Step 3: `runPipeline` orchestration**

`lib/pipeline/run.ts` — opens a `pipeline_runs` row; iterates active feeds; per feed parseFeed (try/catch → step `failed`, continue); per new item (dedup) up to `MAX_ITEMS_PER_RUN` → `recordRawItem` then `stageItem`; persists each item's steps as `pipeline_steps` rows; tallies `feeds_read/new_items`; sets final status `success`/`partial`/`failed`; logs truncation when the cap is hit. Full implementation with the config cap and the plain-language run summary.

- [ ] **Step 4: End-to-end test with mock providers (no network)**

`tests/pipeline-run.test.ts` — force credential-free (mock LLM + mock embed + readability), stub one feed's items by inserting a temporary `feeds` row pointing at a data: or local fixture is hard; instead test `stageItem` directly with a fabricated `RawItem` whose `url` resolves via readability on an inline HTML served by a tiny `Bun.serve` fixture, asserting it creates a `pending` article + embedding + source, then clean up (delete the created article/cluster/embedding). Keep it self-cleaning and reseed if needed. Assert `article.status === "pending"`, `aiAuthor === true`, one `article_sources` row, one `article_embeddings` row.

- [ ] **Step 5: Run test + typecheck.** `bun test tests/pipeline-run.test.ts && bun run typecheck`. Reseed if rows were mutated.

- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(pipeline): run orchestration — per-feed/per-item stages, steps, overlap-safe, capped"`

---

## Task 8: Trigger surface — route + action + RBAC

**Files:** Create `app/api/pipeline/run/route.ts`, `lib/actions/pipeline-actions.ts`; Test `tests/pipeline-actions.test.ts`

**Interfaces:**
- Produces: `POST /api/pipeline/run` (requires `Authorization: Bearer $PIPELINE_TRIGGER_SECRET`; 401 otherwise; overlap → 409; else runs and returns `{runId,status,produced}`); server action `runPipelineNow()` (RBAC `pipeline:configure`; overlap-guarded).

- [ ] **Step 1: Guard test (RBAC + secret)**

`tests/pipeline-actions.test.ts`:
```ts
import { describe, it, expect } from "bun:test";
import { can } from "@/lib/rbac";
describe("pipeline trigger authz", () => {
  it("only admin may configure/run the pipeline", () => {
    expect(can("admin", "pipeline", "configure")).toBe(true);
    expect(can("editor", "pipeline", "configure")).toBe(false);
    expect(can("journalist", "pipeline", "configure")).toBe(false);
  });
});
```

- [ ] **Step 2: Run → PASS** (rbac already exists). `bun test tests/pipeline-actions.test.ts`.

- [ ] **Step 3: Server action**

```ts
// lib/actions/pipeline-actions.ts
"use server";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { runPipeline } from "@/lib/pipeline/run";
import { hasRunningRun } from "@/lib/pipeline/overlap";
import { revalidatePath } from "next/cache";

export async function runPipelineNow() {
  const user = await requireUser();
  requirePermission(user.role, "pipeline", "configure");
  if (await hasRunningRun()) return { ok: false as const, message: "Une exécution est déjà en cours." };
  const res = await runPipeline({ triggeredBy: "manual" });
  revalidatePath("/runs"); revalidatePath("/dashboard"); revalidatePath("/queue");
  return { ok: true as const, ...res };
}
```

- [ ] **Step 4: Route handler (cron)**

```ts
// app/api/pipeline/run/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getPipelineConfig } from "@/lib/config/pipeline-config";
import { runPipeline } from "@/lib/pipeline/run";
import { hasRunningRun } from "@/lib/pipeline/overlap";

export async function POST(req: NextRequest) {
  const secret = getPipelineConfig().triggerSecret;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (await hasRunningRun()) return NextResponse.json({ error: "already running" }, { status: 409 });
  const res = await runPipeline({ triggeredBy: "scheduled" });
  return NextResponse.json(res);
}
export const maxDuration = 300;
```

- [ ] **Step 5: typecheck + build + commit.** `bun run typecheck && bun run build`. `git add -A && git commit -m "feat(pipeline): secured cron route + RBAC 'run now' action"`

---

## Task 9: Minimal Runs surface

**Files:** Create `components/pipeline/run-now.tsx`; Modify `app/(app)/runs/page.tsx` (replace placeholder); Test: manual/browser.

**Interfaces:** Consumes `runPipelineNow`, `RoleGate`, `db` (pipelineRuns/steps), `pipelineStatusLabel`, `StatusBadge`/status tokens.

- [ ] **Step 1: Run-now button (client)** — `components/pipeline/run-now.tsx`: inside `RoleGate allow={["admin","editor"]}` (only Admin's action will succeed server-side; Editor sees it but the action enforces `configure` — OR gate to admin-only to match RBAC exactly; gate to `["admin"]` for honesty). A `Button` "Lancer une exécution maintenant" calling `runPipelineNow()` in a transition; toast the result (`produced` count or the "déjà en cours" message). French.

- [ ] **Step 2: Runs page (RSC)** — `app/(app)/runs/page.tsx`: fetch the latest ~20 `pipeline_runs` (desc by startedAt) with a count of failed steps; render a compact table (horodatage via `formatDate`, déclencheur, flux lus, nouveaux articles, statut via `pipelineStatusLabel` + color token) + the `<RunNow/>` button in the header. Empty state "Aucune exécution pour l'instant." (The full step-trace drawer stays SP4.)

- [ ] **Step 3: typecheck + build.** `bun run typecheck && bun run build` clean.

- [ ] **Step 4: Commit.** `git add -A && git commit -m "feat(pipeline): minimal Runs surface — run-now button + latest runs table"`

---

## Task 10: End-to-end integration run & verification

**Files:** none (verification). May add a self-cleaning `tests/pipeline-e2e.test.ts` (gated on keys present).

- [ ] **Step 1: Full typecheck + unit suite + build.** `bun run typecheck && bun test && bun run build` — all green (unit tests network-free).

- [ ] **Step 2: Real end-to-end run (with the configured keys).** Trigger a run against the seeded active feeds — via the route (`curl -s -X POST localhost:3000/api/pipeline/run -H "Authorization: Bearer $PIPELINE_TRIGGER_SECRET"` while `bun run dev` is up) OR a `bun -e` calling `runPipeline({triggeredBy:"manual"})`. Expect: a `pipeline_runs` row `success`/`partial`, several `pipeline_steps`, and ≥1 NEW `articles` row `status='pending'`, `ai_author=true`, with an `article_sources` row, an `article_embeddings` row, and (when Jina embeddings active) a real `cluster_id`. Record which providers were used (`via`).

- [ ] **Step 3: Drive the app (run/verify).** Sign in as editor, open the Review Queue — the newly generated article(s) appear as `pending`; open one in the editor — title/body/sources/category/tags render; the low-confidence flag shows when the AI was unsure. Confirm nothing was auto-published (no `published` created by the run).

- [ ] **Step 4: Cleanup / reseed.** Delete the articles/embeddings/clusters/raw_items/runs created by the verification run (or `bun run db:seed` to restore the demo baseline), so the demo dataset is clean. Note in the report what real data was produced and removed.

- [ ] **Step 5: Final commit / tag.** `git add -A && git commit -m "chore: SP3 verified — RSS→AI pipeline stages review-ready articles end-to-end" || echo "nothing to commit"; git tag sp3-complete`

---

## Self-Review Notes (coverage map)

- **Spec §4.1 LLM layer** → Task 2. **§4.2 extraction** → Task 4. **§4.3 embeddings** → Task 3. **§5 stages (fetch/dedup/extract/embed+cluster/aiGenerate/stage)** → Tasks 5 (fetch), 6 (dedup+cluster), 7 (extract+embed+generate+stage orchestration). **§6 config/credential-free** → Task 1. **§7 trigger/security/RBAC/overlap/observability** → Tasks 8, 9. **§8 no new tables (additive only)** → Tasks 6–7 (uses existing schema; window via `articles.generated_at`). **§9 error handling (fallbacks, plain-fr, repair)** → Tasks 2,4,7. **§10 tests/verification** → each task's tests + Task 10.
- **Provider quirks:** OmniRoute non-streaming/reasoning + OpenRouter-primary (Task 2 Step 2/6); Jina embeddings 1024 (Task 3); extraction reasons logged (Task 4).
- **Human-review gate:** the run only ever writes `status='pending'` (Task 7 stageItem); publish stays SP5.
- **Deferred:** SP0+SP1 Tasks 14–15 + final SP0+SP1 review (resume after SP3); full Runs UI/step-trace drawer = SP4.
```
