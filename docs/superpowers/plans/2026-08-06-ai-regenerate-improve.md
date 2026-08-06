# AI Regenerate + Améliorer avec IA — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `regenerate()` stub with a real, **selective** AI regeneration of an article, and enable **"Améliorer avec IA"** (LLM body rewrite).

**Architecture:** Two sync server actions. `regenerate` re-extracts the article's sources, re-runs `generateArticle`, and (via a testable core `applyRegeneration`) overwrites only the checked fields, snapshots the prior content, and re-scores. `improveWithAi` rewrites the body via a new `improveArticleBody`. Both reuse the pipeline's building blocks through an **UPDATE** path (never `persistArticle`'s insert), refuse the mock/no-provider path, and set `status='pending'`.

**Tech Stack:** Next.js 16, Drizzle + Postgres (Neon), Vercel AI SDK (`ai`), shadcn/ui, `bun test`.

## Global Constraints

- **French UI copy** for all user-facing strings.
- **Never clobber real content with the mock.** If `generateArticle`/`improveArticleBody` returns `via === "mock"` (no AI provider configured), the action **refuses** and leaves the article unchanged. (Note: `embed`'s mock is fine — it yields a deterministic vector, not junk text.)
- **UPDATE, not INSERT.** Regeneration updates the existing article (id/distributions/cluster preserved); it must NOT call `persistArticle`.
- **Selective:** only the checked fields are overwritten. Body sanitized via `sanitizeArticleHtml`. `status='pending'` after any regenerate/improve.
- **Re-embed/cluster/score only when the body changes** (`computeArticleScore` needs `bestScore` from `decideCluster`, which only exists when we re-cluster). Non-body-only regen leaves embedding/cluster/score untouched.
- **Single revision** per action carries the snapshot (prior title+body) AND the traceability (action + field list).
- **SSRF-safe extraction:** stored `article_sources` URLs are untrusted → re-extract via `extractExternal` (never direct fetch).
- **RBAC:** `article:regenerate` (admin/editor) for both actions — unchanged.
- **Testability:** the core `applyRegeneration` takes the `draft` as a parameter, so its DB logic is integration-tested with a **synthetic draft** (no LLM). The full real-AI happy path is verified manually (extraction + providers aren't available in the test env).
- **Tests** run against the real Neon dev DB; pure helpers with no DB. No migration.

---

### Task 1: `lib/ai/improve-article.ts` — prompt + provider call

**Files:**
- Create: `lib/ai/improve-article.ts`
- Test: `tests/ai-improve.test.ts`

**Interfaces:**
- Produces: `type ImproveInput = { title: string; bodyHtml: string; instruction?: string }`; `buildImprovePrompt(input): string`; `improveArticleBody(input): Promise<{ bodyHtml: string; via: string }>` (returns `via:"mock"` + unchanged body when no provider).

- [ ] **Step 1: Write the failing test**

Create `tests/ai-improve.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { buildImprovePrompt, improveArticleBody } from "@/lib/ai/improve-article";

describe("buildImprovePrompt", () => {
  const base = { title: "BRVM en hausse", bodyHtml: "<p>La bourse progresse.</p>" };
  it("always instructs to keep facts and output only HTML body", () => {
    const p = buildImprovePrompt(base);
    expect(p).toContain("conserve TOUS les faits");
    expect(p).toContain(base.bodyHtml);
    expect(p).toContain(base.title);
  });
  it("includes the editor instruction when provided, omits it when absent/blank", () => {
    expect(buildImprovePrompt({ ...base, instruction: "raccourcir" })).toContain("raccourcir");
    expect(buildImprovePrompt({ ...base, instruction: "   " })).not.toContain("Consigne supplémentaire");
  });
});

describe("improveArticleBody (no provider configured)", () => {
  const keys = ["OPENROUTER_API_KEY", "OMNIROUTE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"];
  const snap: Record<string, string | undefined> = {};
  beforeAll(() => { for (const k of keys) { snap[k] = process.env[k]; delete process.env[k]; } });
  afterAll(() => { for (const k of keys) { if (snap[k] === undefined) delete process.env[k]; else process.env[k] = snap[k]; } });
  it("falls back to via:'mock' and returns the body unchanged (caller refuses on mock)", async () => {
    const r = await improveArticleBody({ title: "T", bodyHtml: "<p>Inchangé.</p>" });
    expect(r.via).toBe("mock");
    expect(r.bodyHtml).toBe("<p>Inchangé.</p>");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/ai-improve.test.ts`
Expected: FAIL — cannot resolve `@/lib/ai/improve-article`.

- [ ] **Step 3: Write the implementation**

Create `lib/ai/improve-article.ts`:

```ts
import { generateText } from "ai";
import { buildModel } from "./providers";
import { getPipelineConfig } from "@/lib/config/pipeline-config";

export type ImproveInput = { title: string; bodyHtml: string; instruction?: string };

// Exported for unit testing (like buildArticlePrompt in generate-article.ts).
export function buildImprovePrompt(input: ImproveInput): string {
  const lines = [
    "Tu es rédacteur en chef pour Afrotiative, média économique panafricain francophone.",
    "Améliore le CORPS HTML de l'article ci-dessous : clarté, style, structure (sous-titres <h2>/<h3> pertinents).",
    "IMPÉRATIF : conserve TOUS les faits, chiffres, noms et citations — n'invente rien, n'ajoute aucune source ni section « Sources ».",
    "Réponds UNIQUEMENT avec le HTML du corps amélioré : pas de préambule, pas de balises <html>/<body>, pas de bloc de code Markdown.",
  ];
  if (input.instruction?.trim()) lines.push(`Consigne supplémentaire de l'éditeur : ${input.instruction.trim()}`);
  lines.push(`\nTitre : ${input.title}\n\nCorps actuel :\n${input.bodyHtml}`);
  return lines.join("\n");
}

// Mirrors generateArticle's provider loop. Returns via:"mock" with the body UNCHANGED when no
// provider is configured or all fail — the caller (improveWithAi) refuses to persist a mock result.
export async function improveArticleBody(input: ImproveInput): Promise<{ bodyHtml: string; via: string }> {
  const cfg = getPipelineConfig();
  for (const name of cfg.llmOrder) {
    const model = buildModel(name, cfg);
    if (!model) continue;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { text } = await generateText({ model, prompt: buildImprovePrompt(input) });
        const body = text.trim();
        if (body.length > 0) return { bodyHtml: body, via: name };
        break; // empty output → next provider
      } catch (e) {
        console.warn(`[improve] fournisseur ${name} a échoué: ${(e as Error).message}`);
        if (attempt === 1) break;
      }
    }
  }
  return { bodyHtml: input.bodyHtml, via: "mock" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/ai-improve.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/ai/improve-article.ts tests/ai-improve.test.ts
git commit -m "feat(ai): improveArticleBody + buildImprovePrompt (LLM body rewrite, mock fallback)"
```

---

### Task 2: Validation schemas + pure `selectRegenerationColumns`

**Files:**
- Modify: `lib/validation.ts` (add two schemas)
- Create: `lib/pipeline/regenerate.ts` (pure part: the selector; the DB core is added in Task 3)
- Test: `tests/regenerate.test.ts`

**Interfaces:**
- Produces:
  - `regenerateFieldsSchema` + `type RegenerateFieldsInput` (`{title,body,excerpt,category,tags,image: boolean}`, ≥1 true)
  - `improveInputSchema` (`{ instruction?: string ≤500 }`)
  - `selectRegenerationColumns(draft: ArticleDraft, fields: RegenerateFieldsInput): { columns; bodyHtml: string | null; categoryName: string | null; tags: string[] | null; bodyChanged: boolean }`

- [ ] **Step 1: Write the failing test**

Create `tests/regenerate.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { regenerateFieldsSchema, improveInputSchema } from "@/lib/validation";
import { selectRegenerationColumns } from "@/lib/pipeline/regenerate";
import type { ArticleDraft } from "@/lib/ai/schema";

const draft: ArticleDraft = {
  title: "Nouveau titre", bodyHtml: "<p>Nouveau corps.</p>", excerpt: "Nouvel extrait",
  category: "Économie", tags: ["brvm", "bourse"],
  featuredImageUrl: "https://img/x.jpg", imageCredit: "Crédit", imageSourceUrl: "https://src/x",
  confidence: { categoryUncertain: false, imageMissing: false, clusterUncertain: false },
};
const ALL = { title: true, body: true, excerpt: true, category: true, tags: true, image: true };

describe("regenerateFieldsSchema / improveInputSchema", () => {
  it("requires at least one field", () => {
    expect(regenerateFieldsSchema.safeParse({ title: false, body: false, excerpt: false, category: false, tags: false, image: false }).success).toBe(false);
    expect(regenerateFieldsSchema.safeParse({ ...ALL, body: false }).success).toBe(true);
  });
  it("bounds the improve instruction length", () => {
    expect(improveInputSchema.safeParse({ instruction: "x".repeat(501) }).success).toBe(false);
    expect(improveInputSchema.safeParse({}).success).toBe(true);
  });
});

describe("selectRegenerationColumns", () => {
  it("with all fields checked, returns every column + body + category + tags", () => {
    const s = selectRegenerationColumns(draft, ALL);
    expect(s.columns.title).toBe("Nouveau titre");
    expect(s.columns.excerpt).toBe("Nouvel extrait");
    expect(s.columns.featuredImageUrl).toBe("https://img/x.jpg");
    expect(s.bodyHtml).toBe("<p>Nouveau corps.</p>");
    expect(s.bodyChanged).toBe(true);
    expect(s.categoryName).toBe("Économie");
    expect(s.tags).toEqual(["brvm", "bourse"]);
  });
  it("with only image checked, touches ONLY the image columns", () => {
    const s = selectRegenerationColumns(draft, { title: false, body: false, excerpt: false, category: false, tags: false, image: true });
    expect(s.columns).toEqual({ featuredImageUrl: "https://img/x.jpg", imageCredit: "Crédit", imageSourceUrl: "https://src/x" });
    expect(s.bodyHtml).toBeNull();
    expect(s.bodyChanged).toBe(false);
    expect(s.categoryName).toBeNull();
    expect(s.tags).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/regenerate.test.ts` — FAIL (unresolved exports).

- [ ] **Step 3a: Add the schemas to `lib/validation.ts`**

```ts
export const regenerateFieldsSchema = z.object({
  title: z.boolean(), body: z.boolean(), excerpt: z.boolean(),
  category: z.boolean(), tags: z.boolean(), image: z.boolean(),
}).refine((f) => Object.values(f).some(Boolean), { message: "Sélectionnez au moins un champ à régénérer." });
export type RegenerateFieldsInput = z.infer<typeof regenerateFieldsSchema>;

export const improveInputSchema = z.object({
  instruction: z.string().max(500, "Instruction trop longue (max 500 caractères).").optional(),
});
export type ImproveActionInput = z.infer<typeof improveInputSchema>;
```

- [ ] **Step 3b: Create `lib/pipeline/regenerate.ts` (pure selector only)**

```ts
import type { ArticleDraft } from "@/lib/ai/schema";
import type { RegenerateFieldsInput } from "@/lib/validation";

// Pure: given a freshly generated draft + the checked fields, return the exact article-column patch
// (only the checked SCALAR columns), the raw body to sanitize+write (or null), the category NAME to
// resolve (or null), and the tags to replace (or null). No DB/DOM — the caller sanitizes the body and
// resolves the category id. Keeping this pure makes the "only checked fields change" contract
// directly unit-testable.
export function selectRegenerationColumns(draft: ArticleDraft, fields: RegenerateFieldsInput): {
  columns: Partial<{ title: string; excerpt: string; featuredImageUrl: string | null; imageCredit: string | null; imageSourceUrl: string | null }>;
  bodyHtml: string | null;
  categoryName: string | null;
  tags: string[] | null;
  bodyChanged: boolean;
} {
  const columns: Record<string, unknown> = {};
  if (fields.title) columns.title = draft.title;
  if (fields.excerpt) columns.excerpt = draft.excerpt;
  if (fields.image) {
    columns.featuredImageUrl = draft.featuredImageUrl ?? null;
    columns.imageCredit = draft.imageCredit ?? null;
    columns.imageSourceUrl = draft.imageSourceUrl ?? null;
  }
  return {
    columns,
    bodyHtml: fields.body ? draft.bodyHtml : null,
    categoryName: fields.category ? draft.category : null,
    tags: fields.tags ? draft.tags : null,
    bodyChanged: fields.body,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/regenerate.test.ts` — PASS. Then `bun run typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add lib/validation.ts lib/pipeline/regenerate.ts tests/regenerate.test.ts
git commit -m "feat(regenerate): validation schemas + pure selectRegenerationColumns"
```

---

### Task 3: `applyRegeneration` core (DB update) + export helpers

**Files:**
- Modify: `lib/pipeline/stages.ts` (export `resolveCategoryId` + `insertTags`)
- Modify: `lib/pipeline/regenerate.ts` (add the DB core)
- Test: `tests/regenerate.test.ts` (append DB integration)

**Interfaces:**
- Consumes: `selectRegenerationColumns` (Task 2); `resolveCategoryId`/`insertTags` (stages.ts); `sanitizeArticleHtml`; `embed`; `decideCluster`; `computeArticleScore`; `ArticleDraft`.
- Produces: `applyRegeneration(input): Promise<void>` — see signature below. Updates only the selected fields, snapshots prior title+body in one revision, re-embeds/clusters/re-scores iff body changed, sets `status='pending'`.

- [ ] **Step 1: Export the two helpers from `lib/pipeline/stages.ts`**

Change `async function resolveCategoryId(...)` → `export async function resolveCategoryId(...)` and `async function insertTags(...)` → `export async function insertTags(...)` (they already exist at ~lines 388/398). No behavior change.

- [ ] **Step 2: Write the failing test (append to `tests/regenerate.test.ts`)**

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, articles, articleSources, articleTags, articleRevisions, articleEmbeddings, wpCategories, clusters } from "@/db";
import { eq, inArray, desc } from "drizzle-orm";
import { applyRegeneration } from "@/lib/pipeline/regenerate";
// (draft/ALL from the pure block above are reused)

describe("applyRegeneration (real DB, synthetic draft)", () => {
  const catIds: string[] = [];
  let articleId = "";
  beforeAll(async () => {
    for (const n of ["RegenTest Économie", "RegenTest Sport"]) {
      const [c] = await db.insert(wpCategories).values({ name: n, slug: n.toLowerCase().replace(/\W+/g, "-") }).returning({ id: wpCategories.id });
      catIds.push(c.id);
    }
    const [a] = await db.insert(articles).values({
      title: "Ancien titre", bodyHtml: "<p>Ancien corps.</p>", excerpt: "Ancien extrait",
      status: "approved", categoryId: catIds[1], aiAuthor: true, featuredImageUrl: "https://old/i.jpg", imageCredit: "Vieux",
    }).returning({ id: articles.id });
    articleId = a.id;
    await db.insert(articleSources).values({ articleId, mediaName: "Ecofin", url: "https://ex/1" });
    await db.insert(articleTags).values({ articleId, tagName: "ancien", isNew: false });
  });
  afterAll(async () => {
    await db.delete(articles).where(eq(articles.id, articleId)); // cascades sources/tags/embeddings/revisions
    if (catIds.length) await db.delete(wpCategories).where(inArray(wpCategories.id, catIds));
  });

  const priorOf = async () => (await db.select().from(articles).where(eq(articles.id, articleId)))[0];

  it("overwrites ONLY the checked fields, snapshots prior title+body, sets pending", async () => {
    const before = await priorOf();
    await applyRegeneration({
      articleId, prior: { title: before.title, bodyHtml: before.bodyHtml, featuredImageUrl: before.featuredImageUrl },
      draft, fields: { title: true, excerpt: true, body: false, category: false, tags: false, image: false },
      sourceCount: 1, categoryNames: ["RegenTest Économie", "RegenTest Sport"], actorId: null,
    });
    const after = await priorOf();
    expect(after.title).toBe("Nouveau titre");           // regenerated
    expect(after.excerpt).toBe("Nouvel extrait");        // regenerated
    expect(after.bodyHtml).toBe("<p>Ancien corps.</p>"); // body NOT checked → unchanged
    expect(after.categoryId).toBe(catIds[1]);            // category NOT checked → unchanged
    expect(after.status).toBe("pending");
    // snapshot revision carries the PRIOR title + body
    const [rev] = await db.select().from(articleRevisions).where(eq(articleRevisions.articleId, articleId)).orderBy(desc(articleRevisions.at)).limit(1);
    expect(rev.action).toBe("régénéré par IA");
    expect(rev.detail).toContain("Ancien titre");
    expect(rev.detail).toContain("Ancien corps");
  });

  it("re-embeds + re-scores when the body is regenerated", async () => {
    await applyRegeneration({
      articleId, prior: { title: "Nouveau titre", bodyHtml: "<p>Ancien corps.</p>", featuredImageUrl: "https://old/i.jpg" },
      draft, fields: { title: false, excerpt: false, body: true, category: true, tags: true, image: false },
      sourceCount: 1, categoryNames: ["RegenTest Économie", "RegenTest Sport"], actorId: null,
    });
    const after = await priorOf();
    expect(after.bodyHtml).toContain("Nouveau corps");    // sanitized new body
    expect(after.categoryId).toBe(catIds[0]);             // "Économie" resolved
    expect(after.score).not.toBeNull();                   // re-scored
    const [emb] = await db.select().from(articleEmbeddings).where(eq(articleEmbeddings.articleId, articleId));
    expect(emb).toBeDefined();                            // embedding written
    const tagRows = await db.select().from(articleTags).where(eq(articleTags.articleId, articleId));
    expect(tagRows.map((t) => t.tagName).sort()).toEqual(["bourse", "brvm"]); // tags replaced
  });
});
```

- [ ] **Step 3: Implement `applyRegeneration` in `lib/pipeline/regenerate.ts`**

Add imports + the function:

```ts
import { db, articles, articleTags, articleEmbeddings, articleRevisions } from "@/db";
import { eq } from "drizzle-orm";
import { sanitizeArticleHtml } from "@/lib/sanitize";
import { embed } from "@/lib/embeddings";
import { decideCluster } from "@/lib/pipeline/cluster";
import { computeArticleScore } from "@/lib/pipeline/score";
import { resolveCategoryId, insertTags } from "@/lib/pipeline/stages";

const FIELD_LABELS: Record<keyof RegenerateFieldsInput, string> = {
  title: "titre", body: "corps", excerpt: "extrait", category: "catégorie", tags: "tags", image: "image",
};

export async function applyRegeneration(input: {
  articleId: string;
  prior: { title: string; bodyHtml: string; featuredImageUrl: string | null };
  draft: ArticleDraft;
  fields: RegenerateFieldsInput;
  sourceCount: number;
  categoryNames: string[];
  actorId: string | null;
  revisionAction?: string; // "régénéré par IA" (default) | "amélioré par IA" (improveWithAi)
}): Promise<void> {
  const { articleId, prior, draft, fields, sourceCount, categoryNames, actorId, revisionAction = "régénéré par IA" } = input;
  const sel = selectRegenerationColumns(draft, fields);

  // Category (read-only lookup) + body sanitize happen outside the tx.
  const categoryId = sel.categoryName !== null ? await resolveCategoryId(sel.categoryName, categoryNames) : undefined;
  const sanitizedBody = sel.bodyHtml !== null ? sanitizeArticleHtml(sel.bodyHtml) : null;

  // Re-derive embedding/cluster/score ONLY when the body changed (see plan constraint).
  let vector: number[] | null = null, clusterId: string | undefined, score: number | undefined;
  if (sel.bodyChanged && sanitizedBody !== null) {
    const embedTitle = fields.title ? draft.title : prior.title;
    vector = (await embed(`${embedTitle}\n${sanitizedBody}`)).vector;
    const cluster = await decideCluster(vector);
    clusterId = cluster.clusterId ?? undefined;
    score = computeArticleScore({
      sourceCount,
      bestScore: cluster.bestScore,
      bodyHtml: sel.bodyHtml, // pre-sanitize body per computeArticleScore's contract
      hasImage: fields.image ? !!draft.featuredImageUrl : !!prior.featuredImageUrl,
      confidence: draft.confidence,
    });
  }

  const fieldList = (Object.keys(fields) as (keyof RegenerateFieldsInput)[]).filter((k) => fields[k]).map((k) => FIELD_LABELS[k]).join(", ");

  await db.transaction(async (tx) => {
    // ONE revision = snapshot (prior title+body) + traceability (fields). Insert BEFORE the update.
    await tx.insert(articleRevisions).values({
      articleId, actorId, action: revisionAction,
      detail: `Champs : ${fieldList}.\n— Titre précédent : ${prior.title}\n— Corps précédent :\n${prior.bodyHtml}`,
    });

    await tx.update(articles).set({
      ...sel.columns,
      ...(sanitizedBody !== null ? { bodyHtml: sanitizedBody } : {}),
      ...(categoryId !== undefined ? { categoryId } : {}),
      ...(clusterId !== undefined ? { clusterId } : {}),
      ...(score !== undefined ? { score } : {}),
      status: "pending", confidenceFlags: draft.confidence, aiAuthor: true, updatedAt: new Date(),
    }).where(eq(articles.id, articleId));

    if (sel.tags !== null) {
      // insertTags ONLY inserts (confirmed in stages.ts) — clear the old rows first so tags are replaced.
      await tx.delete(articleTags).where(eq(articleTags.articleId, articleId));
      await insertTags(tx, articleId, sel.tags);
    }
    if (vector !== null) {
      await tx.insert(articleEmbeddings).values({ articleId, embedding: vector })
        .onConflictDoUpdate({ target: articleEmbeddings.articleId, set: { embedding: vector } });
    }
  });
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/regenerate.test.ts` — PASS (pure + 2 DB tests). Then `bun run typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline/stages.ts lib/pipeline/regenerate.ts tests/regenerate.test.ts
git commit -m "feat(regenerate): applyRegeneration core — selective UPDATE, snapshot, re-embed/score on body change"
```

---

### Task 4: Server actions `regenerate(fields)` + `improveWithAi`

**Files:**
- Modify: `lib/actions/article-actions.ts` (rewrite `regenerate`, add `improveWithAi`)
- Test: `tests/regenerate.test.ts` (append action-guard integration)

**Interfaces:**
- Consumes: `regenerateFieldsSchema`/`improveInputSchema` (Task 2), `applyRegeneration` (Task 3), `improveArticleBody` (Task 1), `extractExternal`, `generateArticle`.
- Produces: `regenerate(articleId: string, fields: RegenerateFieldsInput): Promise<{ ok: boolean; message: string }>`; `improveWithAi(articleId: string, input?: ImproveActionInput): Promise<{ ok: boolean; message: string }>`.

- [ ] **Step 1: Write the failing test (append)**

```ts
import { regenerate } from "@/lib/actions/article-actions";
// NOTE: regenerate/improveWithAi call requireUser() → next/headers, which throws outside a request.
// So these guard tests can't call the actions directly; instead they assert the reachable guards
// via the same building blocks. If your harness supports a requireUser test-shim, call the action;
// otherwise assert the extraction/no-source guards at the query level. Keep whichever the repo's
// other action tests use (see tests/reprocess.test.ts / feed-actions.test.ts for the convention).
```

Because `regenerate`/`improveWithAi` start with `requireUser()` (unavailable under `bun test`, per the existing convention in `tests/feed-actions.test.ts`/`team-actions.test.ts`), do **not** unit-test the actions directly. The risky logic is already covered by Task 3 (`applyRegeneration`) and Task 1/2 (guards/selector). This task's test additions cover only what's callable: none beyond Tasks 1-3. Record in the report that the action wiring is verified by typecheck + the manual check in Task 6.

- [ ] **Step 2: Rewrite `regenerate` in `lib/actions/article-actions.ts`**

Replace the stub (`regenerate(id)` at ~line 59) with:

```ts
export async function regenerate(articleId: string, fields: RegenerateFieldsInput): Promise<{ ok: boolean; message: string }> {
  const user = await requireUser();
  requirePermission(user.role, "article", "regenerate");
  const parsed = regenerateFieldsSchema.safeParse(fields);
  if (!parsed.success) return { ok: false, message: "Sélectionnez au moins un champ à régénérer." };

  // Dynamic imports AFTER the RBAC check (mirrors reprocessRawItem: the extraction/generation graph
  // is jsdom-heavy and must stay out of this "use server" module's static analysis).
  const { db, articles, articleSources, wpCategories } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const [article] = await db.select().from(articles).where(eq(articles.id, articleId));
  if (!article) return { ok: false, message: "Article introuvable." };
  const sources = await db.select().from(articleSources).where(eq(articleSources.articleId, articleId));
  if (sources.length === 0) return { ok: false, message: "Aucune source à régénérer." };

  const { extractExternal } = await import("@/lib/extract");
  const extracted: { mediaName: string; url: string; text: string; images?: string[] }[] = [];
  const candidateImages: string[] = [];
  for (const s of sources) {
    try {
      const r = await extractExternal(s.url);
      if (r.text.trim().length > 0) { extracted.push({ mediaName: s.mediaName, url: s.url, text: r.text }); candidateImages.push(...r.images); }
    } catch { /* best-effort: skip a dead source */ }
  }
  if (extracted.length === 0) return { ok: false, message: "Impossible d'extraire les sources (indisponibles ou extracteur non configuré)." };

  const { generateArticle } = await import("@/lib/ai/generate-article");
  const categoryNames = (await db.select({ name: wpCategories.name }).from(wpCategories)).map((c) => c.name);
  const { draft, via } = await generateArticle({ sources: extracted, candidateImages, categories: categoryNames });
  if (via === "mock") return { ok: false, message: "Aucun fournisseur IA configuré — régénération impossible." };

  const { applyRegeneration } = await import("@/lib/pipeline/regenerate");
  await applyRegeneration({
    articleId, prior: { title: article.title, bodyHtml: article.bodyHtml, featuredImageUrl: article.featuredImageUrl },
    draft, fields: parsed.data, sourceCount: extracted.length, categoryNames, actorId: user.id,
  });

  const { revalidatePath } = await import("next/cache");
  revalidatePath(`/article/${articleId}`); revalidatePath("/queue");
  return { ok: true, message: "Article régénéré — déposé en revue." };
}
```

Add the static import at the top of the file: `import { regenerateFieldsSchema, improveInputSchema, type RegenerateFieldsInput, type ImproveActionInput } from "@/lib/validation";` (validation.ts is light — no jsdom/DB).

- [ ] **Step 3: Add `improveWithAi` in the same file**

```ts
export async function improveWithAi(articleId: string, input?: ImproveActionInput): Promise<{ ok: boolean; message: string }> {
  const user = await requireUser();
  requirePermission(user.role, "article", "regenerate");
  const instruction = improveInputSchema.safeParse(input ?? {});
  if (!instruction.success) return { ok: false, message: "Instruction invalide." };

  const { db, articles, articleSources } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const [article] = await db.select().from(articles).where(eq(articles.id, articleId));
  if (!article) return { ok: false, message: "Article introuvable." };

  const { improveArticleBody } = await import("@/lib/ai/improve-article");
  const { bodyHtml, via } = await improveArticleBody({ title: article.title, bodyHtml: article.bodyHtml, instruction: instruction.data.instruction });
  if (via === "mock") return { ok: false, message: "Aucun fournisseur IA configuré — amélioration impossible." };

  // Reuse applyRegeneration with a body-only "draft": only bodyHtml is applied (fields.body=true).
  const sources = await db.select().from(articleSources).where(eq(articleSources.articleId, articleId));
  const { applyRegeneration } = await import("@/lib/pipeline/regenerate");
  await applyRegeneration({
    articleId, prior: { title: article.title, bodyHtml: article.bodyHtml, featuredImageUrl: article.featuredImageUrl },
    draft: {
      title: article.title, bodyHtml, excerpt: article.excerpt ?? "", category: "", tags: [],
      featuredImageUrl: article.featuredImageUrl, imageCredit: article.imageCredit, imageSourceUrl: article.imageSourceUrl,
      confidence: (article.confidenceFlags ?? { categoryUncertain: false, imageMissing: false, clusterUncertain: false }) as ArticleDraft["confidence"],
    },
    fields: { title: false, body: true, excerpt: false, category: false, tags: false, image: false },
    sourceCount: sources.length, categoryNames: [], actorId: user.id,
    revisionAction: "amélioré par IA", // the param added in Task 3
  });

  const { revalidatePath } = await import("next/cache");
  revalidatePath(`/article/${articleId}`); revalidatePath("/queue");
  return { ok: true, message: "Corps amélioré — déposé en revue." };
}
```

(Import `ArticleDraft` as a type at the top: `import type { ArticleDraft } from "@/lib/ai/schema";` — type-only, erased.)

- [ ] **Step 4: Verify**

Run: `bun run typecheck` (clean) and `bun test tests/regenerate.test.ts` (Task 3 tests still pass; add the `revisionAction` param without breaking them).

- [ ] **Step 5: Commit**

```bash
git add lib/actions/article-actions.ts lib/pipeline/regenerate.ts tests/regenerate.test.ts
git commit -m "feat(article): real regenerate(fields) + improveWithAi actions (extract → generate → apply, mock-refusal)"
```

---

### Task 5: UI — regenerate dialog + improve dialog

**Files:**
- Create: `components/article/regenerate-dialog.tsx`, `components/article/improve-dialog.tsx`
- Modify: `components/article/action-bar.tsx` (open the regenerate dialog), `components/article/editor-shell.tsx` (enable "Améliorer avec IA" → improve dialog)

**Interfaces:** consumes `regenerate`/`improveWithAi` actions + `RegenerateFieldsInput` type. No unit test (no component harness). Gate: typecheck + build + manual.

- [ ] **Step 1: `regenerate-dialog.tsx`** — a `Dialog` (base-UI `render={<Button>}` trigger, per this repo's convention — see `add-member-dialog.tsx`) with 6 native `<input type="checkbox">` (Titre/Corps/Extrait/Catégorie/Tags/Image à la une), all default-checked, a **"Régénérer"** button disabled when none checked, and a `useTransition` spinner. On confirm → `await regenerate(articleId, fields)`, toast the result, close on success. Props: `{ articleId: string }`. French labels.

- [ ] **Step 2: `improve-dialog.tsx`** — a `Dialog` with a `Textarea` (optional instruction, placeholder "ex : raccourcir, ton plus formel…", `maxLength={500}`) and an **"Améliorer"** button + spinner. On confirm → `await improveWithAi(articleId, { instruction: value || undefined })`, toast, close. Props: `{ articleId: string }`.

- [ ] **Step 3: Wire `action-bar.tsx`** — replace the `<Button ... onClick={handleRegenerate}>Renvoyer à l'IA</Button>` with `<RegenerateDialog articleId={articleId} />` (which renders its own trigger button labelled "Renvoyer à l'IA"). Remove the now-unused `handleRegenerate` and the direct `regenerate` import.

- [ ] **Step 4: Wire `editor-shell.tsx`** — remove `disabled` + the `<TooltipContent>Bientôt (SP3)</TooltipContent>` on the "Améliorer avec IA" button; wrap it so it opens `<ImproveDialog articleId={article.id} />` (the button, with the `Sparkles` icon + "Améliorer avec IA", becomes the dialog trigger).

- [ ] **Step 5: Verify** — `bun run typecheck` (0), `bun run build` (0, no client-bundle "Module not found"). In the report, describe the manual check (open a pending article as editor: "Renvoyer à l'IA" opens the 6-checkbox dialog; "Améliorer avec IA" opens the instruction dialog; both show a spinner and refuse gracefully if no AI provider is configured).

- [ ] **Step 6: Commit**

```bash
git add components/article/
git commit -m "feat(article): regenerate field-selection dialog + Améliorer avec IA instruction dialog"
```

---

### Task 6: Full verification

- [ ] **Step 1:** `bun run typecheck` → 0.
- [ ] **Step 2:** `bun test` → all green (new `ai-improve`, `regenerate`, plus existing).
- [ ] **Step 3:** `bun run build` → 0.
- [ ] **Step 4 (manual, needs a configured AI provider):** as an editor, open a `pending` article with sources → "Renvoyer à l'IA" → uncheck a field → Régénérer → confirm only the checked fields changed, a "régénéré par IA" revision holds the prior title+body, and the article is back in the review queue. Then "Améliorer avec IA" with an instruction → body rewritten. With no provider configured, both must refuse with a clear French message and leave the article unchanged.

---

## Self-Review

**Spec coverage:** selective 6-field regenerate (T2 selector, T4 action, T5 dialog); snapshot prior title+body in one revision (T3); re-extract via `extractExternal` (T4); mock-refusal (T1/T4); re-embed/cluster/score on body change only (T3); `improveWithAi` with optional instruction (T1/T4/T5); enable "Améliorer avec IA" (T5); reuse pipeline blocks via UPDATE not INSERT (T3); RBAC `article:regenerate` (T4); no migration. ✅

**Type consistency:** `RegenerateFieldsInput` (T2) flows to `selectRegenerationColumns` (T2), `applyRegeneration` (T3), and the actions (T4). `ArticleDraft` (schema.ts) is the draft type throughout. `applyRegeneration`'s `input` shape (incl. `prior.featuredImageUrl`, `revisionAction`) is defined in T3 and consumed in T4.

**Placeholder scan:** resolved the one open question — `insertTags` only inserts, so T3 deletes existing `article_tags` first. No TBD/TODO; every code step is concrete and every test asserts real behavior.
