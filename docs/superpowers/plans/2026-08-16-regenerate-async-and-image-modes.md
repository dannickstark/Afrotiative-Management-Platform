# Renvoyer à l'IA — exécution asynchrone et modes d'image — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make « Renvoyer à l'IA » report live progress instead of blocking silently, stop it from destroying existing featured images, and let the editor choose between an AI-picked image and a manual pick from scraped candidates.

**Architecture:** Three phases. Phase 1 fixes the two bugs and bounds/parallelizes source extraction — no migration, no new UI. Phase 2 moves execution into a detached job (`regen_jobs` / `regen_job_items`) polled at 1.5 s, mirroring the existing `pipeline_runs` + `live-run-panel` pattern. Phase 3 adds the `auto`/`manual` image modes, the `pending_image_candidates` tray on /queue, and the pick wizard.

**Tech Stack:** Next.js 16 (App Router, Server Actions), React 19, Drizzle ORM + Postgres (Neon), Zod, `bun:test`, shadcn/ui, Tailwind. Runtime is a single long-lived Bun/Node process on Railway.

**Spec:** [`docs/superpowers/specs/2026-08-16-regenerate-async-and-image-modes-design.md`](../specs/2026-08-16-regenerate-async-and-image-modes-design.md)

## Global Constraints

- **Language:** all user-facing strings, comments and commit messages in **French**. Code identifiers in English.
- **New status columns use `text`, never `pgEnum`.** Drizzle applies all pending migrations in ONE transaction; PostgreSQL forbids referencing a newly-added enum value in the transaction that added it (SQLSTATE 55P04). See the long comment at `db/schema.ts:256-287`.
- **`"use server"` files may only export async functions.** Schemas and pure helpers go in `lib/validation.ts` or a plain module.
- **Heavy graphs stay behind `await import(...)`** inside `"use server"` modules, so jsdom/extraction never enters their static analysis. Existing convention — see `lib/actions/article-actions.ts:75`.
- **Pure logic lives in a DB-free sibling module** so it can be unit-tested without pulling `@/db` (`queue-sort.ts`, `live.ts`, `settings-write.ts` are the precedents).
- **Migrations are generated, never hand-written:** `bun run db:generate`, then commit the generated `db/migrations/NNNN_*.sql` + `meta/` files.
- Tests: `bun test <file>` for one file, `bun run test:pure` for the fast lane. A test file added to `PURE_FILES` in `scripts/test-fast.ts` must touch neither DB nor network.
- Never write `null` over an existing `featuredImageUrl` / `imageCredit` / `imageSourceUrl`.
- Image sources remain scraping + Crawl4AI only. No stock, no generated, no house placeholder.

---

# Phase 1 — Correctifs et vitesse

No migration, no new UI. Ships on its own and already fixes the reported image bug.

---

### Task 1: `selectRegenerationColumns` ne détruit jamais une image existante

**Files:**
- Modify: `lib/pipeline/regenerate.ts:16-38`
- Test: `tests/regenerate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `selectRegenerationColumns(draft, fields)` keeps its exact signature and return type. New behaviour only: when `fields.image` is true but `draft.featuredImageUrl` is null/undefined, `columns` carries **no** image key at all (so the caller's `set({...sel.columns})` leaves the prior values untouched).

- [ ] **Step 1: Write the failing test**

Add to the existing `describe("selectRegenerationColumns", ...)` block in `tests/regenerate.test.ts`:

```ts
  it("image cochée mais brouillon sans image : n'émet AUCUNE colonne image (ne détruit pas l'existant)", () => {
    const noImageDraft: ArticleDraft = { ...draft, featuredImageUrl: null, imageCredit: null, imageSourceUrl: null };
    const s = selectRegenerationColumns(noImageDraft, { title: false, body: false, excerpt: false, category: false, tags: false, image: true });
    expect(s.columns).toEqual({});
    expect("featuredImageUrl" in s.columns).toBe(false);
    expect("imageCredit" in s.columns).toBe(false);
    expect("imageSourceUrl" in s.columns).toBe(false);
  });

  it("image cochée avec d'autres champs, brouillon sans image : les autres colonnes passent, l'image est épargnée", () => {
    const noImageDraft: ArticleDraft = { ...draft, featuredImageUrl: null, imageCredit: null, imageSourceUrl: null };
    const s = selectRegenerationColumns(noImageDraft, { title: true, body: false, excerpt: false, category: false, tags: false, image: true });
    expect(s.columns).toEqual({ title: "Nouveau titre" });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/regenerate.test.ts`
Expected: FAIL — the first new test reports `columns` as `{ featuredImageUrl: null, imageCredit: null, imageSourceUrl: null }` instead of `{}`.

- [ ] **Step 3: Write the minimal implementation**

In `lib/pipeline/regenerate.ts`, replace the `if (fields.image) { ... }` block (lines 26-30) with:

```ts
  // INVARIANT « ne jamais détruire une image » : une régénération dont le brouillon n'a retenu
  // AUCUNE image (liste de candidats vide, ou choix du modèle rejeté par sanitizeDraft) ne doit pas
  // écrire null par-dessus l'image existante — c'était le bug d'une régénération « image seule »,
  // qui coûtait une génération complète pour ne faire qu'effacer l'image. Sans clé émise ici, le
  // `set({ ...sel.columns })` de l'appelant laisse simplement les trois colonnes intactes.
  if (fields.image && draft.featuredImageUrl) {
    columns.featuredImageUrl = draft.featuredImageUrl;
    columns.imageCredit = draft.imageCredit ?? null;
    columns.imageSourceUrl = draft.imageSourceUrl ?? null;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/regenerate.test.ts`
Expected: PASS, including the pre-existing "with only image checked, touches ONLY the image columns" test (its draft HAS an image, so it is unaffected).

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline/regenerate.ts tests/regenerate.test.ts
git commit -m "fix(regenerate): ne jamais effacer une image existante quand le brouillon n'en a pas"
```

---

### Task 2: `lib/pipeline/regen-plan.ts` — décision pure sur les candidats d'image

**Files:**
- Create: `lib/pipeline/regen-plan.ts`
- Create: `tests/regen-plan.test.ts`
- Modify: `scripts/test-fast.ts` (add `"regen-plan.test.ts"` to `PURE_FILES`)

**Interfaces:**
- Consumes: `RegenerateFieldsInput` from `@/lib/validation`.
- Produces:
  ```ts
  export type ImageAction = "from-draft" | "skip";
  export type RegenPlan = {
    runGeneration: boolean;
    imageAction: ImageAction;
    effectiveFields: RegenerateFieldsInput;
    abort: string | null;
    warning: string | null;
  };
  export function planRegeneration(input: {
    fields: RegenerateFieldsInput;
    candidateCount: number;
  }): RegenPlan;
  ```
  Task 12 (Phase 3) widens this with an `imageMode` input and two more `ImageAction` values.

- [ ] **Step 1: Write the failing test**

Create `tests/regen-plan.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { planRegeneration } from "@/lib/pipeline/regen-plan";
import type { RegenerateFieldsInput } from "@/lib/validation";

const NONE: RegenerateFieldsInput = { title: false, body: false, excerpt: false, category: false, tags: false, image: false };
const IMAGE_ONLY: RegenerateFieldsInput = { ...NONE, image: true };
const IMAGE_AND_TITLE: RegenerateFieldsInput = { ...NONE, image: true, title: true };
const TITLE_ONLY: RegenerateFieldsInput = { ...NONE, title: true };

describe("planRegeneration", () => {
  it("sans image cochée, génère et ignore l'image", () => {
    const p = planRegeneration({ fields: TITLE_ONLY, candidateCount: 0 });
    expect(p.runGeneration).toBe(true);
    expect(p.imageAction).toBe("skip");
    expect(p.abort).toBeNull();
    expect(p.warning).toBeNull();
    expect(p.effectiveFields).toEqual(TITLE_ONLY);
  });

  it("image seule sans candidat : abandonne sans rien écrire", () => {
    const p = planRegeneration({ fields: IMAGE_ONLY, candidateCount: 0 });
    expect(p.abort).toBe("Aucune image candidate trouvée — image inchangée.");
    expect(p.runGeneration).toBe(false);
  });

  it("image + autres champs sans candidat : applique les autres, épargne l'image, avertit", () => {
    const p = planRegeneration({ fields: IMAGE_AND_TITLE, candidateCount: 0 });
    expect(p.abort).toBeNull();
    expect(p.runGeneration).toBe(true);
    expect(p.imageAction).toBe("skip");
    expect(p.effectiveFields.image).toBe(false);
    expect(p.effectiveFields.title).toBe(true);
    expect(p.warning).toBe("Aucune image candidate trouvée — image inchangée.");
  });

  it("image cochée avec des candidats : prend l'image du brouillon", () => {
    const p = planRegeneration({ fields: IMAGE_ONLY, candidateCount: 3 });
    expect(p.runGeneration).toBe(true);
    expect(p.imageAction).toBe("from-draft");
    expect(p.abort).toBeNull();
    expect(p.warning).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/regen-plan.test.ts`
Expected: FAIL — `Cannot find module '@/lib/pipeline/regen-plan'`.

- [ ] **Step 3: Write the minimal implementation**

Create `lib/pipeline/regen-plan.ts`:

```ts
import type { RegenerateFieldsInput } from "@/lib/validation";

// PUR — décide, AVANT tout appel LLM, ce qu'une régénération doit réellement faire une fois les
// sources extraites et les images candidates connues. Vit dans son propre module sans DB ni réseau
// pour être testable en table de fixtures (voie test:pure), comme lib/queries/queue-sort.ts et
// lib/pipeline/live.ts. C'est le seul endroit où se décide « faut-il générer », « que fait-on de
// l'image » et « faut-il abandonner » — regenerateArticle ne fait qu'exécuter le plan.
export type ImageAction = "from-draft" | "skip";

export type RegenPlan = {
  /** Faut-il appeler generateArticle ? */
  runGeneration: boolean;
  /** Ce qu'on fait de l'image à la une une fois la génération faite (ou non). */
  imageAction: ImageAction;
  /** Champs réellement appliqués — peut retirer `image` que l'appelant avait coché. */
  effectiveFields: RegenerateFieldsInput;
  /** Non-null = on n'écrit RIEN et on renvoie ce message en échec. */
  abort: string | null;
  /** Non-null = on écrit, mais le message de succès porte cet avertissement. */
  warning: string | null;
};

export const NO_CANDIDATE_MESSAGE = "Aucune image candidate trouvée — image inchangée.";

function hasOtherFields(fields: RegenerateFieldsInput): boolean {
  return fields.title || fields.body || fields.excerpt || fields.category || fields.tags;
}

export function planRegeneration(input: {
  fields: RegenerateFieldsInput;
  candidateCount: number;
}): RegenPlan {
  const { fields, candidateCount } = input;
  const base: RegenPlan = {
    runGeneration: true, imageAction: "skip", effectiveFields: fields, abort: null, warning: null,
  };

  if (!fields.image) return base;

  if (candidateCount === 0) {
    // Zéro candidat n'autorise JAMAIS à effacer l'image en place (voir l'invariant dans
    // lib/pipeline/regenerate.ts). Image seule → l'opération n'a plus d'objet, on échoue
    // explicitement plutôt que de facturer une génération complète pour un no-op.
    if (!hasOtherFields(fields)) return { ...base, runGeneration: false, abort: NO_CANDIDATE_MESSAGE };
    return { ...base, effectiveFields: { ...fields, image: false }, warning: NO_CANDIDATE_MESSAGE };
  }

  return { ...base, imageAction: "from-draft" };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/regen-plan.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Add the file to the pure lane and verify**

In `scripts/test-fast.ts`, add `"regen-plan.test.ts",` to the `PURE_FILES` set (keep the existing alphabetical grouping — put it next to `"published.test.ts", "queue-queries.test.ts"`).

Run: `bun run test:pure`
Expected: PASS, `regen-plan.test.ts` among the files run.

- [ ] **Step 6: Commit**

```bash
git add lib/pipeline/regen-plan.ts tests/regen-plan.test.ts scripts/test-fast.ts
git commit -m "feat(regenerate): module pur de décision sur les images candidates"
```

---

### Task 3: `regenerateArticle` extrait en parallèle, borné par timeout, via `extract`

**Files:**
- Modify: `lib/pipeline/regenerate-core.ts:34-45`
- Test: `tests/regenerate-core.test.ts`

**Interfaces:**
- Consumes: `withTimeout(promise, ms, opName)` from `@/lib/pipeline/timeout`; `getPipelineSettings()` from `@/lib/queries/settings` (returns a row with `perOperationTimeoutMs: number`).
- Produces: `regenerateArticle(articleId, fields, actorId, opts?)` — new optional 4th parameter `opts?: { timeoutMs?: number }`. Return type unchanged: `{ ok: boolean; message: string; title: string }`.

**Context for the implementer:** `tests/regenerate-core.test.ts` mocks `@/lib/extract` with `mock.module`. That mock currently exports only `extractExternal`. Because `regenerate-core.ts` imports the module dynamically at call time, the mock must export **both** names once this task lands.

- [ ] **Step 1: Write the failing test**

In `tests/regenerate-core.test.ts`, change the `mock.module("@/lib/extract", ...)` factory near the top to export both functions, and add a spy counter:

```ts
const { extractExternal: realExtractExternal, extract: realExtract } = await import("@/lib/extract");

let extractCalls: string[] = [];
let extractImpl: (url: string) => Promise<{ title: string; text: string; images: string[]; via: string; attempts: unknown[] }> =
  async () => ({ title: "t", text: "Contenu extrait de test, assez long.", images: [], via: "test", attempts: [] });
let extractExternalImpl = extractImpl;
mock.module("@/lib/extract", () => ({
  extract: (url: string) => { extractCalls.push(url); return extractImpl(url); },
  extractExternal: (url: string) => extractExternalImpl(url),
}));
```

Update the existing `afterAll` to also restore `extract`:

```ts
  extractImpl = realExtract as typeof extractImpl;
  extractExternalImpl = realExtractExternal as typeof extractExternalImpl;
```

Then add a new `describe` block at the end of the file:

```ts
describe("regenerateArticle — extraction", () => {
  it("utilise extract() (et non extractExternal) sur les sources de l'article", async () => {
    const { articleId } = await seedArticleWithSources(["https://a.test/1"]);
    extractCalls = [];
    generateArticleImpl = async () => ({ draft: draftFixture, via: "openrouter" });
    await regenerateArticle(articleId, { ...ALL_FIELDS }, null);
    expect(extractCalls).toEqual(["https://a.test/1"]);
  });

  it("extrait les sources EN PARALLÈLE", async () => {
    const { articleId } = await seedArticleWithSources([
      "https://a.test/1", "https://a.test/2", "https://a.test/3",
    ]);
    extractCalls = [];
    extractImpl = async () => {
      await new Promise((r) => setTimeout(r, 300));
      return { title: "t", text: "Contenu extrait de test, assez long.", images: [], via: "test", attempts: [] };
    };
    generateArticleImpl = async () => ({ draft: draftFixture, via: "openrouter" });
    const t0 = Date.now();
    await regenerateArticle(articleId, { ...ALL_FIELDS }, null);
    const elapsed = Date.now() - t0;
    // Séquentiel = ~900 ms ; parallèle = ~300 ms. La borne à 700 ms laisse de la marge au CI.
    expect(elapsed).toBeLessThan(700);
  });

  it("une source qui dépasse le délai est ignorée, les autres passent", async () => {
    const { articleId } = await seedArticleWithSources(["https://slow.test/1", "https://fast.test/2"]);
    extractImpl = async (url) => {
      if (url.includes("slow")) await new Promise((r) => setTimeout(r, 5000));
      return { title: "t", text: `Contenu de ${url}, assez long pour compter.`, images: [], via: "test", attempts: [] };
    };
    let seenSources = 0;
    generateArticleImpl = async () => { seenSources = lastGenerateInput?.sources.length ?? 0; return { draft: draftFixture, via: "openrouter" }; };
    const r = await regenerateArticle(articleId, { ...ALL_FIELDS }, null, { timeoutMs: 5000 });
    expect(r.ok).toBe(true);
    expect(seenSources).toBe(1);
  }, 15000);
});
```

The test file already has fixtures for seeding; if `seedArticleWithSources`, `ALL_FIELDS`, `draftFixture` or `lastGenerateInput` do not yet exist in it, add them near the existing fixtures:

```ts
const ALL_FIELDS = { title: true, body: true, excerpt: true, category: true, tags: true, image: true };
const draftFixture: ArticleDraft = {
  title: "Titre régénéré", bodyHtml: "<p>Corps régénéré assez long pour passer.</p>",
  excerpt: "Extrait", category: "Économie", tags: ["a"],
  featuredImageUrl: null, imageCredit: null, imageSourceUrl: null,
  confidence: { categoryUncertain: false, imageMissing: true, clusterUncertain: false },
};
let lastGenerateInput: { sources: { url: string }[] } | null = null;

async function seedArticleWithSources(urls: string[]): Promise<{ articleId: string }> {
  const [a] = await db.insert(articles).values({
    title: `Article ${faker.string.uuid()}`, bodyHtml: "<p>Corps initial.</p>",
  }).returning({ id: articles.id });
  await db.insert(articleSources).values(urls.map((url) => ({ articleId: a.id, mediaName: "Test", url })));
  seededArticleIds.push(a.id);
  return { articleId: a.id };
}
```

and record the generate input inside the existing `mock.module("@/lib/ai/generate-article", ...)` factory:

```ts
mock.module("@/lib/ai/generate-article", () => ({
  generateArticle: (input: { sources: { url: string }[] }) => { lastGenerateInput = input; return generateArticleImpl(); },
}));
```

Make sure `seededArticleIds` is cleaned up in the file's existing `afterAll` (follow whatever cleanup array the file already uses; if it uses a different name, reuse that one instead of adding a second).

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/regenerate-core.test.ts`
Expected: FAIL — `extractCalls` is empty (the code still calls `extractExternal`), and the parallel test takes ~900 ms.

- [ ] **Step 3: Write the minimal implementation**

In `lib/pipeline/regenerate-core.ts`, change the signature and replace the extraction loop.

Signature (line 18):

```ts
export async function regenerateArticle(
  articleId: string,
  fields: RegenerateFieldsInput,
  actorId: string | null,
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; message: string; title: string }> {
```

Replace lines 34-45 with:

```ts
  // extract() et NON extractExternal() : ce sont les URLs des sources de l'article, déjà crawlées
  // telles quelles à l'ingestion par extract() (voir la justification à lib/pipeline/stages.ts:192).
  // extractExternal coupait le backfill d'images par fetch direct (lib/extract/index.ts:173-178) et
  // ne laissait que Crawl4AI : c'est ce qui rendait la liste de candidats vide et provoquait
  // l'effacement de l'image en régénération « image seule ».
  const { extract } = await import("@/lib/extract");
  const { withTimeout } = await import("@/lib/pipeline/timeout");
  const { getPipelineSettings } = await import("@/lib/queries/settings");
  const timeoutMs = opts.timeoutMs ?? (await getPipelineSettings()).perOperationTimeoutMs;

  // EN PARALLÈLE : les sources sont indépendantes, et la boucle séquentielle d'origine faisait
  // payer la somme des latences réseau avant le moindre retour à l'éditeur. Chaque source est
  // bornée par le même délai par opération que le chemin d'ingestion (lib/pipeline/run.ts:448) —
  // une source pendue ne peut plus bloquer la régénération indéfiniment. Un échec (ou un
  // dépassement) est best-effort : la source est ignorée, jamais fatale, tant qu'il en reste une.
  const results = await Promise.all(sources.map(async (s) => {
    try {
      const r = await withTimeout(extract(s.url), timeoutMs, "Extraction du contenu");
      if (r.text.trim().length === 0) return null;
      return { mediaName: s.mediaName, url: s.url, text: r.text, images: r.images };
    } catch (e) {
      console.warn(`[regenerate] extraction échouée pour ${s.url}: ${(e as Error).message}`);
      return null;
    }
  }));

  const extracted: { mediaName: string; url: string; text: string }[] = [];
  const candidateImages: string[] = [];
  for (const r of results) {
    if (r === null) continue;
    extracted.push({ mediaName: r.mediaName, url: r.url, text: r.text });
    candidateImages.push(...r.images);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/regenerate-core.test.ts`
Expected: PASS, all three new tests plus the pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline/regenerate-core.ts tests/regenerate-core.test.ts
git commit -m "perf(regenerate): extraction parallèle bornée, et extract() au lieu d'extractExternal"
```

---

### Task 4: brancher `planRegeneration` dans `regenerateArticle`

**Files:**
- Modify: `lib/pipeline/regenerate-core.ts:47-58`
- Test: `tests/regenerate-core.test.ts`

**Interfaces:**
- Consumes: `planRegeneration`, `NO_CANDIDATE_MESSAGE` from Task 2; `regenerateArticle`'s `opts` from Task 3.
- Produces: `regenerateArticle` now short-circuits before `generateArticle` when the plan aborts, and applies `plan.effectiveFields` rather than the raw `fields`.

- [ ] **Step 1: Write the failing test**

Add to `tests/regenerate-core.test.ts`:

```ts
describe("regenerateArticle — image sans candidat", () => {
  it("image SEULE et zéro candidat : échoue sans appeler l'IA et sans toucher l'article", async () => {
    const { articleId } = await seedArticleWithSources(["https://a.test/1"]);
    await db.update(articles).set({ featuredImageUrl: "https://ancienne/img.jpg", imageCredit: "Ancien" }).where(eq(articles.id, articleId));
    extractImpl = async () => ({ title: "t", text: "Contenu extrait de test, assez long.", images: [], via: "test", attempts: [] });
    let called = false;
    generateArticleImpl = async () => { called = true; return { draft: draftFixture, via: "openrouter" }; };

    const r = await regenerateArticle(articleId, { title: false, body: false, excerpt: false, category: false, tags: false, image: true }, null, { timeoutMs: 5000 });

    expect(r.ok).toBe(false);
    expect(r.message).toBe("Aucune image candidate trouvée — image inchangée.");
    expect(called).toBe(false);
    const [row] = await db.select().from(articles).where(eq(articles.id, articleId));
    expect(row.featuredImageUrl).toBe("https://ancienne/img.jpg");
    expect(row.imageCredit).toBe("Ancien");
  });

  it("image + titre et zéro candidat : applique le titre, épargne l'image, avertit", async () => {
    const { articleId } = await seedArticleWithSources(["https://a.test/1"]);
    await db.update(articles).set({ featuredImageUrl: "https://ancienne/img.jpg" }).where(eq(articles.id, articleId));
    extractImpl = async () => ({ title: "t", text: "Contenu extrait de test, assez long.", images: [], via: "test", attempts: [] });
    generateArticleImpl = async () => ({ draft: { ...draftFixture, title: "Titre tout neuf" }, via: "openrouter" });

    const r = await regenerateArticle(articleId, { title: true, body: false, excerpt: false, category: false, tags: false, image: true }, null, { timeoutMs: 5000 });

    expect(r.ok).toBe(true);
    expect(r.message).toContain("Aucune image candidate trouvée");
    const [row] = await db.select().from(articles).where(eq(articles.id, articleId));
    expect(row.title).toBe("Titre tout neuf");
    expect(row.featuredImageUrl).toBe("https://ancienne/img.jpg");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/regenerate-core.test.ts`
Expected: FAIL — the first test reports `called === true` (the LLM is still invoked) and `r.ok === true`.

- [ ] **Step 3: Write the minimal implementation**

In `lib/pipeline/regenerate-core.ts`, add the static import at the top:

```ts
import { planRegeneration } from "@/lib/pipeline/regen-plan";
```

(Static is correct here for the same reason as `aiFailureMessage`, already documented at line 12: the module is pure, with no DB/network/jsdom dependency, so it adds nothing to the `"use server"` callers' static graph.)

Then, between the extraction block and the `generateArticle` call, insert:

```ts
  // Le plan tranche AVANT de payer un appel LLM : une régénération « image seule » sans le moindre
  // candidat n'a plus d'objet, et une régénération mixte doit épargner l'image sans renoncer aux
  // autres champs. Voir lib/pipeline/regen-plan.ts.
  const plan = planRegeneration({ fields: parsed.data, candidateCount: candidateImages.length });
  if (plan.abort !== null) return { ok: false, message: plan.abort, title: article.title };
```

and change the two lines that follow to use `plan.effectiveFields`:

```ts
  await applyRegeneration({
    articleId, prior: { title: article.title, bodyHtml: article.bodyHtml, featuredImageUrl: article.featuredImageUrl, confidenceFlags: article.confidenceFlags },
    draft, fields: plan.effectiveFields, sourceCount: extracted.length, categoryNames, actorId,
  });

  const message = plan.warning !== null
    ? `Article régénéré — déposé en revue. ${plan.warning}`
    : "Article régénéré — déposé en revue.";
  return { ok: true, message, title: article.title };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/regenerate-core.test.ts tests/regenerate.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full pure lane as a regression check**

Run: `bun run test:pure`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/pipeline/regenerate-core.ts tests/regenerate-core.test.ts
git commit -m "fix(regenerate): image seule sans candidat échoue explicitement au lieu d'effacer l'image"
```

---

# Phase 2 — Job asynchrone et progression

---

### Task 5: tables `regen_jobs` / `regen_job_items` + migration

**Files:**
- Modify: `db/schema.ts` (append after the `pipelineSteps` block, before the `pipeline settings` section)
- Create: `db/migrations/NNNN_*.sql` (generated)

**Interfaces:**
- Produces: drizzle tables `regenJobs`, `regenJobItems`, exported from `db/schema.ts` (and therefore from `@/db`, which re-exports `./schema`).

- [ ] **Step 1: Add the tables to the schema**

```ts
// ---- « Renvoyer à l'IA » asynchrone (job détaché + progression sondée) ----
// Volontairement SÉPARÉ de pipeline_runs : l'index unique partiel « un seul run actif » de cette
// table doit rester valable, et une régénération doit pouvoir tourner PENDANT une ingestion.
// Les colonnes de statut sont en `text` et non en pgEnum : drizzle applique toutes les migrations
// en attente dans UNE transaction, et PostgreSQL interdit de référencer une valeur d'enum ajoutée
// dans cette même transaction (SQLSTATE 55P04) — voir le long commentaire sur pipeline_runs.
export const regenJobs = pgTable("regen_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorId: text("actor_id").references(() => user.id),
  fields: jsonb("fields").notNull(),        // RegenerateFieldsInput
  imageMode: text("image_mode").notNull().default("auto"), // auto | manual (câblé en phase 3)
  total: integer("total").notNull(),
  done: integer("done").notNull().default(0),
  status: text("status").notNull().default("running"), // running | done | failed | cancelled
  cancelRequested: boolean("cancel_requested").notNull().default(false),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  finishedAt: timestamp("finished_at"),
});

export const regenJobItems = pgTable("regen_job_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => regenJobs.id, { onDelete: "cascade" }),
  articleId: uuid("article_id").notNull().references(() => articles.id, { onDelete: "cascade" }),
  title: text("title").notNull(),           // instantané, pour un rapport d'échec lisible
  stage: text("stage").notNull().default("queued"), // queued | extracting | generating | writing
  status: text("status").notNull().default("pending"), // pending | ok | failed | awaiting_image
  message: text("message"),
  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
}, (t) => [
  // Un article est dans AU PLUS un item non terminé : deux jobs ne peuvent pas régénérer le même
  // article en même temps (double écriture, révisions entrelacées). Prédicat sur `finished_at is
  // null` et non sur `status`, pour la même raison d'immutabilité que pipeline_runs_one_running.
  // `awaiting_image` est TERMINAL : finished_at est renseigné, l'article redevient éligible — le
  // choix d'image en attente vit dans articles.pending_image_candidates, pas dans le job.
  uniqueIndex("regen_job_items_one_inflight_per_article").on(t.articleId).where(sql`${t.finishedAt} is null`),
  index("regen_job_items_job_idx").on(t.jobId),
]);
```

- [ ] **Step 2: Generate the migration**

Run: `bun run db:generate`
Expected: a new `db/migrations/00NN_<name>.sql` plus `db/migrations/meta/00NN_snapshot.json` and an updated `_journal.json`. Open the `.sql` and confirm it contains `CREATE TABLE "regen_jobs"`, `CREATE TABLE "regen_job_items"`, and the two indexes. Do not edit it by hand.

- [ ] **Step 3: Apply the migration locally**

Run: `bun run db:migrate`
Expected: applies cleanly, no error.

- [ ] **Step 4: Verify the tables exist and the interlock bites**

Run:

```bash
bun -e 'const {db,regenJobs,regenJobItems}=await import("./db/index.ts");console.log(await db.select().from(regenJobs).limit(1), await db.select().from(regenJobItems).limit(1))'
```

Expected: two empty arrays, no error.

- [ ] **Step 5: Commit**

```bash
git add db/schema.ts db/migrations
git commit -m "feat(regenerate): tables regen_jobs / regen_job_items pour le renvoi asynchrone"
```

---

### Task 6: `lib/pipeline/regen-live.ts` — dérivation pure de la progression

**Files:**
- Create: `lib/pipeline/regen-live.ts`
- Create: `tests/regen-live.test.ts`
- Modify: `scripts/test-fast.ts` (`PURE_FILES`)

**Interfaces:**
- Produces:
  ```ts
  export type RegenStage = "queued" | "extracting" | "generating" | "writing";
  export type RegenItemStatus = "pending" | "ok" | "failed" | "awaiting_image";
  export type RegenItemView = { id: string; articleId: string; title: string; stage: RegenStage; status: RegenItemStatus; message: string | null };
  export type RegenJobView = { id: string; total: number; done: number; status: "running" | "done" | "failed" | "cancelled"; imageMode: "auto" | "manual"; items: RegenItemView[] };
  export const STAGE_LABELS: Record<RegenStage, string>;
  export function deriveRegenHeader(job: RegenJobView): { label: string; done: number; total: number; percent: number };
  export function summarizeRegenJob(job: RegenJobView): { ok: number; failed: number; awaitingImage: number };
  ```
  Tasks 7-10 all import these types; this is the shared vocabulary of the phase.

- [ ] **Step 1: Write the failing test**

Create `tests/regen-live.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { deriveRegenHeader, summarizeRegenJob, STAGE_LABELS, type RegenJobView } from "@/lib/pipeline/regen-live";

function job(over: Partial<RegenJobView> = {}): RegenJobView {
  return { id: "j1", total: 3, done: 1, status: "running", imageMode: "auto", items: [], ...over };
}

describe("deriveRegenHeader", () => {
  it("montre l'étape en cours de l'article courant", () => {
    const h = deriveRegenHeader(job({
      items: [
        { id: "i1", articleId: "a1", title: "A", stage: "writing", status: "ok", message: null },
        { id: "i2", articleId: "a2", title: "B", stage: "extracting", status: "pending", message: null },
      ],
    }));
    expect(h.label).toBe("Extraction des sources — B");
    expect(h.done).toBe(1);
    expect(h.total).toBe(3);
  });

  it("sans article en cours, annonce la fin", () => {
    const h = deriveRegenHeader(job({ status: "done", done: 3, items: [] }));
    expect(h.label).toBe("Terminé");
    expect(h.percent).toBe(100);
  });

  it("un total à zéro ne divise pas par zéro", () => {
    expect(deriveRegenHeader(job({ total: 0, done: 0 })).percent).toBe(0);
  });

  it("arrondit le pourcentage", () => {
    expect(deriveRegenHeader(job({ total: 3, done: 1 })).percent).toBe(33);
  });
});

describe("summarizeRegenJob", () => {
  it("compte succès, échecs et images en attente", () => {
    const s = summarizeRegenJob(job({
      items: [
        { id: "1", articleId: "a", title: "A", stage: "writing", status: "ok", message: null },
        { id: "2", articleId: "b", title: "B", stage: "writing", status: "failed", message: "boum" },
        { id: "3", articleId: "c", title: "C", stage: "extracting", status: "awaiting_image", message: null },
        { id: "4", articleId: "d", title: "D", stage: "queued", status: "pending", message: null },
      ],
    }));
    expect(s).toEqual({ ok: 1, failed: 1, awaitingImage: 1 });
  });
});

describe("STAGE_LABELS", () => {
  it("couvre les quatre étapes en français", () => {
    expect(STAGE_LABELS.queued).toBe("En attente");
    expect(STAGE_LABELS.extracting).toBe("Extraction des sources");
    expect(STAGE_LABELS.generating).toBe("Génération IA");
    expect(STAGE_LABELS.writing).toBe("Écriture");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/regen-live.test.ts`
Expected: FAIL — `Cannot find module '@/lib/pipeline/regen-live'`.

- [ ] **Step 3: Write the minimal implementation**

Create `lib/pipeline/regen-live.ts`:

```ts
// PUR — dérivations d'affichage pour le panneau de progression du renvoi à l'IA. Aucun accès DB ni
// réseau, exactement comme lib/pipeline/live.ts le fait pour le panneau d'exécution du pipeline :
// la logique d'affichage est ainsi testable en table de fixtures sur la voie test:pure, et le
// composant client se réduit au sondage + au rendu.
export type RegenStage = "queued" | "extracting" | "generating" | "writing";
export type RegenItemStatus = "pending" | "ok" | "failed" | "awaiting_image";

export type RegenItemView = {
  id: string; articleId: string; title: string;
  stage: RegenStage; status: RegenItemStatus; message: string | null;
};

export type RegenJobView = {
  id: string; total: number; done: number;
  status: "running" | "done" | "failed" | "cancelled";
  imageMode: "auto" | "manual";
  items: RegenItemView[];
};

export const STAGE_LABELS: Record<RegenStage, string> = {
  queued: "En attente",
  extracting: "Extraction des sources",
  generating: "Génération IA",
  writing: "Écriture",
};

export function deriveRegenHeader(job: RegenJobView): { label: string; done: number; total: number; percent: number } {
  const percent = job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;
  // L'article « en cours » est le premier item encore pending : le runner est strictement sériel,
  // il ne peut donc jamais y en avoir deux.
  const current = job.items.find((i) => i.status === "pending" && i.stage !== "queued");
  if (current === undefined) {
    const label = job.status === "running" ? "Préparation…" : job.status === "cancelled" ? "Annulé" : "Terminé";
    return { label, done: job.done, total: job.total, percent: job.status === "running" ? percent : 100 };
  }
  return { label: `${STAGE_LABELS[current.stage]} — ${current.title}`, done: job.done, total: job.total, percent };
}

export function summarizeRegenJob(job: RegenJobView): { ok: number; failed: number; awaitingImage: number } {
  let ok = 0, failed = 0, awaitingImage = 0;
  for (const i of job.items) {
    if (i.status === "ok") ok += 1;
    else if (i.status === "failed") failed += 1;
    else if (i.status === "awaiting_image") awaitingImage += 1;
  }
  return { ok, failed, awaitingImage };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/regen-live.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Add to the pure lane**

Add `"regen-live.test.ts",` to `PURE_FILES` in `scripts/test-fast.ts`, next to `"regen-plan.test.ts"`.

Run: `bun run test:pure`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/pipeline/regen-live.ts tests/regen-live.test.ts scripts/test-fast.ts
git commit -m "feat(regenerate): dérivations pures de la progression du job"
```

---

### Task 7: `lib/pipeline/regen-store.ts` — ouverture, avancement, clôture du job

**Files:**
- Create: `lib/pipeline/regen-store.ts`
- Create: `tests/regen-store.test.ts` (DB lane — do NOT add to `PURE_FILES`)

**Interfaces:**
- Consumes: `regenJobs`, `regenJobItems` (Task 5); `RegenStage`, `RegenItemStatus`, `RegenJobView` (Task 6).
- Produces:
  ```ts
  export async function openRegenJob(input: {
    actorId: string | null;
    articles: { id: string; title: string }[];
    fields: RegenerateFieldsInput;
    imageMode: "auto" | "manual";
  }): Promise<{ ok: true; jobId: string } | { ok: false; message: string }>;
  export async function listJobItems(jobId: string): Promise<{ id: string; articleId: string; title: string }[]>;
  export async function setItemStage(itemId: string, stage: RegenStage): Promise<void>;
  export async function finishItem(itemId: string, status: Exclude<RegenItemStatus, "pending">, message: string | null): Promise<void>;
  export async function isCancelRequested(jobId: string): Promise<boolean>;
  export async function finalizeRegenJob(jobId: string): Promise<void>;
  export async function readRegenJob(jobId: string): Promise<RegenJobView | null>;
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/regen-store.test.ts`:

```ts
import { describe, it, expect, afterAll } from "bun:test";
import { db, articles, regenJobs, regenJobItems } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { faker } from "@faker-js/faker";
import {
  openRegenJob, listJobItems, setItemStage, finishItem, isCancelRequested,
  finalizeRegenJob, readRegenJob,
} from "@/lib/pipeline/regen-store";

const ALL = { title: true, body: true, excerpt: true, category: true, tags: true, image: true };
const createdArticles: string[] = [];

async function seedArticle(): Promise<{ id: string; title: string }> {
  const title = `Article ${faker.string.uuid()}`;
  const [a] = await db.insert(articles).values({ title, bodyHtml: "<p>x</p>" }).returning({ id: articles.id });
  createdArticles.push(a.id);
  return { id: a.id, title };
}

afterAll(async () => {
  if (createdArticles.length) await db.delete(articles).where(inArray(articles.id, createdArticles));
});

describe("openRegenJob", () => {
  it("crée le job et un item par article", async () => {
    const a = await seedArticle(); const b = await seedArticle();
    const r = await openRegenJob({ actorId: null, articles: [a, b], fields: ALL, imageMode: "auto" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const view = await readRegenJob(r.jobId);
    expect(view?.total).toBe(2);
    expect(view?.done).toBe(0);
    expect(view?.status).toBe("running");
    expect(view?.items.map((i) => i.title).sort()).toEqual([a.title, b.title].sort());
    expect(view?.items.every((i) => i.stage === "queued" && i.status === "pending")).toBe(true);
  });

  it("refuse un article déjà présent dans un job en vol", async () => {
    const a = await seedArticle();
    const first = await openRegenJob({ actorId: null, articles: [a], fields: ALL, imageMode: "auto" });
    expect(first.ok).toBe(true);
    const second = await openRegenJob({ actorId: null, articles: [a], fields: ALL, imageMode: "auto" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.message).toContain("déjà en cours");
  });

  it("un article redevient éligible une fois son item terminé", async () => {
    const a = await seedArticle();
    const first = await openRegenJob({ actorId: null, articles: [a], fields: ALL, imageMode: "auto" });
    if (!first.ok) throw new Error("setup");
    const [item] = await listJobItems(first.jobId);
    await finishItem(item.id, "ok", null);
    const second = await openRegenJob({ actorId: null, articles: [a], fields: ALL, imageMode: "auto" });
    expect(second.ok).toBe(true);
  });
});

describe("avancement et clôture", () => {
  it("setItemStage / finishItem incrémentent done et alimentent la vue", async () => {
    const a = await seedArticle(); const b = await seedArticle();
    const r = await openRegenJob({ actorId: null, articles: [a, b], fields: ALL, imageMode: "auto" });
    if (!r.ok) throw new Error("setup");
    const items = await listJobItems(r.jobId);
    await setItemStage(items[0].id, "extracting");
    let view = await readRegenJob(r.jobId);
    expect(view?.items.find((i) => i.id === items[0].id)?.stage).toBe("extracting");
    await finishItem(items[0].id, "ok", null);
    await finishItem(items[1].id, "failed", "boum");
    view = await readRegenJob(r.jobId);
    expect(view?.done).toBe(2);
    expect(view?.items.find((i) => i.id === items[1].id)?.message).toBe("boum");
  });

  it("finalizeRegenJob : failed seulement si TOUS les items ont échoué", async () => {
    const a = await seedArticle(); const b = await seedArticle();
    const r = await openRegenJob({ actorId: null, articles: [a, b], fields: ALL, imageMode: "auto" });
    if (!r.ok) throw new Error("setup");
    const items = await listJobItems(r.jobId);
    await finishItem(items[0].id, "failed", "boum");
    await finishItem(items[1].id, "awaiting_image", null);
    await finalizeRegenJob(r.jobId);
    expect((await readRegenJob(r.jobId))?.status).toBe("done");

    const c = await seedArticle();
    const r2 = await openRegenJob({ actorId: null, articles: [c], fields: ALL, imageMode: "auto" });
    if (!r2.ok) throw new Error("setup");
    const [only] = await listJobItems(r2.jobId);
    await finishItem(only.id, "failed", "boum");
    await finalizeRegenJob(r2.jobId);
    expect((await readRegenJob(r2.jobId))?.status).toBe("failed");
  });

  it("isCancelRequested reflète le drapeau", async () => {
    const a = await seedArticle();
    const r = await openRegenJob({ actorId: null, articles: [a], fields: ALL, imageMode: "auto" });
    if (!r.ok) throw new Error("setup");
    expect(await isCancelRequested(r.jobId)).toBe(false);
    await db.update(regenJobs).set({ cancelRequested: true }).where(eq(regenJobs.id, r.jobId));
    expect(await isCancelRequested(r.jobId)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/regen-store.test.ts`
Expected: FAIL — `Cannot find module '@/lib/pipeline/regen-store'`.

- [ ] **Step 3: Write the minimal implementation**

Create `lib/pipeline/regen-store.ts`:

```ts
import { db, regenJobs, regenJobItems } from "@/db";
import { eq, sql } from "drizzle-orm";
import type { RegenerateFieldsInput } from "@/lib/validation";
import type { RegenStage, RegenItemStatus, RegenJobView } from "@/lib/pipeline/regen-live";

// Accès DB du job de régénération, isolé du runner (lib/pipeline/regen-job.ts) et des actions
// (lib/actions/regen-actions.ts) : le runner ne fait qu'orchestrer, ce module possède toutes les
// écritures d'état. Même découpe que openRun/executeRun côté pipeline.

/**
 * Ouvre un job et ses items dans UNE transaction. L'index unique partiel
 * regen_job_items_one_inflight_per_article rejette l'insert si l'un des articles est déjà dans un
 * item non terminé — on traduit cette violation en message métier plutôt que de la laisser remonter.
 */
export async function openRegenJob(input: {
  actorId: string | null;
  articles: { id: string; title: string }[];
  fields: RegenerateFieldsInput;
  imageMode: "auto" | "manual";
}): Promise<{ ok: true; jobId: string } | { ok: false; message: string }> {
  if (input.articles.length === 0) return { ok: false, message: "Aucun article sélectionné." };
  try {
    const jobId = await db.transaction(async (tx) => {
      const [job] = await tx.insert(regenJobs).values({
        actorId: input.actorId, fields: input.fields, imageMode: input.imageMode,
        total: input.articles.length,
      }).returning({ id: regenJobs.id });
      await tx.insert(regenJobItems).values(input.articles.map((a) => ({
        jobId: job.id, articleId: a.id, title: a.title,
      })));
      return job.id;
    });
    return { ok: true, jobId };
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("regen_job_items_one_inflight_per_article")) {
      return { ok: false, message: "Un renvoi à l'IA est déjà en cours sur l'un de ces articles." };
    }
    throw e;
  }
}

export async function listJobItems(jobId: string): Promise<{ id: string; articleId: string; title: string }[]> {
  return db.select({ id: regenJobItems.id, articleId: regenJobItems.articleId, title: regenJobItems.title })
    .from(regenJobItems).where(eq(regenJobItems.jobId, jobId)).orderBy(regenJobItems.title);
}

export async function setItemStage(itemId: string, stage: RegenStage): Promise<void> {
  await db.update(regenJobItems)
    .set({ stage, startedAt: sql`coalesce(${regenJobItems.startedAt}, now())` })
    .where(eq(regenJobItems.id, itemId));
}

/**
 * Termine un item et incrémente le compteur du job dans la même transaction, pour qu'un sondage ne
 * puisse jamais voir un `done` en retard sur les items. `awaiting_image` est TERMINAL (finished_at
 * renseigné) : l'article redevient immédiatement éligible à un nouveau renvoi, l'attente de choix
 * vivant dans articles.pending_image_candidates.
 */
export async function finishItem(
  itemId: string,
  status: Exclude<RegenItemStatus, "pending">,
  message: string | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.update(regenJobItems)
      .set({ status, message, finishedAt: new Date() })
      .where(eq(regenJobItems.id, itemId))
      .returning({ jobId: regenJobItems.jobId });
    if (row) {
      await tx.update(regenJobs)
        .set({ done: sql`${regenJobs.done} + 1` })
        .where(eq(regenJobs.id, row.jobId));
    }
  });
}

export async function isCancelRequested(jobId: string): Promise<boolean> {
  const [row] = await db.select({ c: regenJobs.cancelRequested }).from(regenJobs).where(eq(regenJobs.id, jobId));
  return row?.c ?? false;
}

/**
 * Clôture le job. `failed` est réservé au cas où TOUS les items ont échoué ; sinon `done`, avec le
 * rapport d'échecs partiels porté par les items (même convention que les lots existants). Un job
 * dont l'annulation a été demandée se termine en `cancelled`.
 */
export async function finalizeRegenJob(jobId: string): Promise<void> {
  const items = await db.select({ status: regenJobItems.status })
    .from(regenJobItems).where(eq(regenJobItems.jobId, jobId));
  const cancelled = await isCancelRequested(jobId);
  const allFailed = items.length > 0 && items.every((i) => i.status === "failed");
  const status = cancelled ? "cancelled" : allFailed ? "failed" : "done";
  await db.update(regenJobs).set({ status, finishedAt: new Date() }).where(eq(regenJobs.id, jobId));
}

export async function readRegenJob(jobId: string): Promise<RegenJobView | null> {
  const [job] = await db.select().from(regenJobs).where(eq(regenJobs.id, jobId));
  if (!job) return null;
  const items = await db.select().from(regenJobItems)
    .where(eq(regenJobItems.jobId, jobId)).orderBy(regenJobItems.title);
  return {
    id: job.id, total: job.total, done: job.done,
    status: job.status as RegenJobView["status"],
    imageMode: job.imageMode as RegenJobView["imageMode"],
    items: items.map((i) => ({
      id: i.id, articleId: i.articleId, title: i.title,
      stage: i.stage as RegenJobView["items"][number]["stage"],
      status: i.status as RegenJobView["items"][number]["status"],
      message: i.message,
    })),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/regen-store.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline/regen-store.ts tests/regen-store.test.ts
git commit -m "feat(regenerate): magasin d'état du job de renvoi à l'IA"
```

---

### Task 8: `regenerateArticle` publie ses étapes, et le runner `runRegenJob`

**Files:**
- Modify: `lib/pipeline/regenerate-core.ts` (add `onStage` to `opts`)
- Create: `lib/pipeline/regen-job.ts`
- Create: `tests/regen-job.test.ts` (DB lane)

**Interfaces:**
- Consumes: `openRegenJob`, `listJobItems`, `setItemStage`, `finishItem`, `isCancelRequested`, `finalizeRegenJob` (Task 7); `regenerateArticle` (Tasks 3-4).
- Produces:
  - `regenerateArticle(articleId, fields, actorId, opts?)` where `opts` gains `onStage?: (stage: RegenStage) => void | Promise<void>`.
  - `export async function runRegenJob(jobId: string): Promise<void>` — never throws; always finalizes.

- [ ] **Step 1: Write the failing test**

Create `tests/regen-job.test.ts`:

```ts
import { describe, it, expect, afterAll, mock } from "bun:test";
import { db, articles, articleSources, regenJobs } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { faker } from "@faker-js/faker";
import { openRegenJob, readRegenJob } from "@/lib/pipeline/regen-store";

// runRegenJob importe regenerateArticle DYNAMIQUEMENT : le mock ci-dessous, posé avant tout appel,
// est donc vu par cet `await import(...)` — même motif que tests/regenerate-core.test.ts.
const { regenerateArticle: realRegenerateArticle } = await import("@/lib/pipeline/regenerate-core");
let regenerateImpl: (id: string) => Promise<{ ok: boolean; message: string; title: string; awaitingImage?: boolean }> =
  async () => ({ ok: true, message: "ok", title: "T" });
mock.module("@/lib/pipeline/regenerate-core", () => ({
  regenerateArticle: (id: string) => regenerateImpl(id),
}));

const { runRegenJob } = await import("@/lib/pipeline/regen-job");

const ALL = { title: true, body: true, excerpt: true, category: true, tags: true, image: true };
const created: string[] = [];

async function seedArticle() {
  const title = `Article ${faker.string.uuid()}`;
  const [a] = await db.insert(articles).values({ title, bodyHtml: "<p>x</p>" }).returning({ id: articles.id });
  created.push(a.id);
  return { id: a.id, title };
}

afterAll(async () => {
  if (created.length) await db.delete(articles).where(inArray(articles.id, created));
  regenerateImpl = realRegenerateArticle as unknown as typeof regenerateImpl;
});

describe("runRegenJob", () => {
  it("traite chaque item et clôt le job", async () => {
    const a = await seedArticle(); const b = await seedArticle();
    const r = await openRegenJob({ actorId: null, articles: [a, b], fields: ALL, imageMode: "auto" });
    if (!r.ok) throw new Error("setup");
    regenerateImpl = async () => ({ ok: true, message: "Article régénéré.", title: "T" });
    await runRegenJob(r.jobId);
    const view = await readRegenJob(r.jobId);
    expect(view?.status).toBe("done");
    expect(view?.done).toBe(2);
    expect(view?.items.every((i) => i.status === "ok")).toBe(true);
  });

  it("un échec métier n'interrompt pas le lot", async () => {
    const a = await seedArticle(); const b = await seedArticle();
    const r = await openRegenJob({ actorId: null, articles: [a, b], fields: ALL, imageMode: "auto" });
    if (!r.ok) throw new Error("setup");
    regenerateImpl = async (id) => id === a.id
      ? { ok: false, message: "Aucune source à régénérer.", title: a.title }
      : { ok: true, message: "Article régénéré.", title: b.title };
    await runRegenJob(r.jobId);
    const view = await readRegenJob(r.jobId);
    expect(view?.status).toBe("done");
    expect(view?.items.find((i) => i.articleId === a.id)?.status).toBe("failed");
    expect(view?.items.find((i) => i.articleId === b.id)?.status).toBe("ok");
  });

  it("une exception inattendue marque l'item en échec sans faire tomber le job", async () => {
    const a = await seedArticle();
    const r = await openRegenJob({ actorId: null, articles: [a], fields: ALL, imageMode: "auto" });
    if (!r.ok) throw new Error("setup");
    regenerateImpl = async () => { throw new Error("réseau mort"); };
    await runRegenJob(r.jobId);
    const view = await readRegenJob(r.jobId);
    expect(view?.status).toBe("failed");
    expect(view?.items[0].status).toBe("failed");
    expect(view?.items[0].message).toContain("réseau mort");
  });

  it("respecte l'annulation entre deux articles", async () => {
    const a = await seedArticle(); const b = await seedArticle();
    const r = await openRegenJob({ actorId: null, articles: [a, b], fields: ALL, imageMode: "auto" });
    if (!r.ok) throw new Error("setup");
    let calls = 0;
    regenerateImpl = async () => {
      calls += 1;
      await db.update(regenJobs).set({ cancelRequested: true }).where(eq(regenJobs.id, r.jobId));
      return { ok: true, message: "ok", title: "T" };
    };
    await runRegenJob(r.jobId);
    expect(calls).toBe(1);
    const view = await readRegenJob(r.jobId);
    expect(view?.status).toBe("cancelled");
  });

  it("propage awaitingImage en statut awaiting_image", async () => {
    const a = await seedArticle();
    const r = await openRegenJob({ actorId: null, articles: [a], fields: ALL, imageMode: "manual" });
    if (!r.ok) throw new Error("setup");
    regenerateImpl = async () => ({ ok: true, message: "Image à choisir.", title: a.title, awaitingImage: true });
    await runRegenJob(r.jobId);
    const view = await readRegenJob(r.jobId);
    expect(view?.items[0].status).toBe("awaiting_image");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/regen-job.test.ts`
Expected: FAIL — `Cannot find module '@/lib/pipeline/regen-job'`.

- [ ] **Step 3: Add `onStage` and `awaitingImage` to `regenerateArticle`**

In `lib/pipeline/regenerate-core.ts`, widen the options and the return type:

```ts
import type { RegenStage } from "@/lib/pipeline/regen-live";

export async function regenerateArticle(
  articleId: string,
  fields: RegenerateFieldsInput,
  actorId: string | null,
  opts: { timeoutMs?: number; onStage?: (stage: RegenStage) => void | Promise<void> } = {},
): Promise<{ ok: boolean; message: string; title: string; awaitingImage?: boolean }> {
```

Then call the hook at the three boundaries. Immediately before the `Promise.all` extraction block added in Task 3:

```ts
  await opts.onStage?.("extracting");
```

Immediately before the `generateArticle` call:

```ts
  await opts.onStage?.("generating");
```

Immediately before the `applyRegeneration` call:

```ts
  await opts.onStage?.("writing");
```

`awaitingImage` is not produced yet — Task 14 wires it. The field is declared now so the runner in Step 4 can be written once.

- [ ] **Step 4: Write the runner**

Create `lib/pipeline/regen-job.ts`:

```ts
import { setItemStage, finishItem, isCancelRequested, finalizeRegenJob, listJobItems } from "@/lib/pipeline/regen-store";
import { db, regenJobs } from "@/db";
import { eq } from "drizzle-orm";
import type { RegenerateFieldsInput } from "@/lib/validation";

/**
 * Boucle détachée du renvoi à l'IA — l'équivalent d'executeRun pour la régénération. Lancée sans
 * await par startRegenJob (lib/actions/regen-actions.ts) : le serveur Railway est un processus
 * long, la promesse survit donc à la réponse de l'action, et le client suit l'avancement en sondant
 * getRegenJobAction.
 *
 * STRICTEMENT SÉRIELLE, délibérément : le pool de jetons OpenRouter est partagé et tourne jusqu'à
 * 2 × N jetons par appel (lib/ai/with-token-pool.ts) — des appels LLM parallèles multiplieraient les
 * périodes de récupération pour dépassement de quota. Le sériel est acceptable dès lors que la
 * progression est visible, ce qui est tout l'objet de ce job.
 *
 * NE JETTE JAMAIS : chaque article est isolé dans son try/catch (un échec ne coûte pas le lot) et
 * le job est clos dans un finally, pour qu'aucun job ne reste « running » à jamais.
 */
export async function runRegenJob(jobId: string): Promise<void> {
  try {
    const [job] = await db.select().from(regenJobs).where(eq(regenJobs.id, jobId));
    if (!job) return;
    const fields = job.fields as RegenerateFieldsInput;
    const imageMode = job.imageMode as "auto" | "manual";
    const items = await listJobItems(jobId);

    // Import dynamique : garde le graphe d'extraction/génération lourd (jsdom) hors de l'analyse
    // statique des modules qui importent ce runner.
    const { regenerateArticle } = await import("@/lib/pipeline/regenerate-core");

    for (const item of items) {
      // Annulation coopérative, sondée à la frontière sûre entre deux articles — jamais au milieu
      // d'une écriture. Les items restants gardent leur statut `pending`.
      if (await isCancelRequested(jobId)) break;
      try {
        const r = await regenerateArticle(item.articleId, fields, job.actorId, {
          imageMode,
          onStage: (stage) => setItemStage(item.id, stage),
        });
        const status = r.ok ? (r.awaitingImage ? "awaiting_image" : "ok") : "failed";
        await finishItem(item.id, status, r.ok && !r.awaitingImage ? null : r.message);
      } catch (e) {
        console.warn(`[regen-job] article ${item.articleId} en échec : ${(e as Error).message}`);
        await finishItem(item.id, "failed", (e as Error).message);
      }
    }
  } finally {
    await finalizeRegenJob(jobId).catch(() => {});
  }
}
```

Note the `imageMode` option passed to `regenerateArticle` — add it to that function's `opts` type now so this compiles, even though it is unused until Task 14:

```ts
  opts: { timeoutMs?: number; imageMode?: "auto" | "manual"; onStage?: (stage: RegenStage) => void | Promise<void> } = {},
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/regen-job.test.ts tests/regenerate-core.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add lib/pipeline/regen-job.ts lib/pipeline/regenerate-core.ts tests/regen-job.test.ts
git commit -m "feat(regenerate): runner détaché du job avec étapes publiées et annulation"
```

---

### Task 9: actions serveur `startRegenJob` / `getRegenJobAction` / `cancelRegenJob`

**Files:**
- Create: `lib/actions/regen-actions.ts`
- Modify: `lib/validation.ts` (add `startRegenJobSchema`)

**Interfaces:**
- Consumes: `openRegenJob`, `readRegenJob` (Task 7); `runRegenJob` (Task 8); `requireUser` (`@/lib/session`), `requirePermission` (`@/lib/permissions`).
- Produces:
  ```ts
  export async function startRegenJob(input: { articleIds: string[]; fields: RegenerateFieldsInput; imageMode?: "auto" | "manual" }): Promise<{ ok: true; jobId: string } | { ok: false; message: string }>;
  export async function getRegenJobAction(jobId: string): Promise<RegenJobView | null>;
  export async function cancelRegenJob(jobId: string): Promise<void>;
  ```

- [ ] **Step 1: Add the input schema**

In `lib/validation.ts`, after `regenerateFieldsSchema` (line 142-146):

```ts
// Entrée de startRegenJob. Le plafond de 10 est la même garde de coût que la barre d'actions du
// /queue applique côté client (extraction réseau + appel IA par article) — répété ici parce qu'une
// action serveur ne fait jamais confiance à la garde d'UI.
export const startRegenJobSchema = z.object({
  articleIds: z.array(z.string().uuid()).min(1, "Sélectionnez au moins un article.").max(10, "Maximum 10 articles par renvoi."),
  fields: regenerateFieldsSchema,
  imageMode: z.enum(["auto", "manual"]).default("auto"),
});
export type StartRegenJobInput = z.infer<typeof startRegenJobSchema>;
```

- [ ] **Step 2: Write the action module**

Create `lib/actions/regen-actions.ts`:

```ts
"use server";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/permissions";
import { revalidatePath } from "next/cache";
import { startRegenJobSchema, type StartRegenJobInput } from "@/lib/validation";
import type { RegenJobView } from "@/lib/pipeline/regen-live";

/**
 * Déclencheur NON BLOQUANT du renvoi à l'IA : ouvre le job (ce qui donne un jobId tout de suite),
 * lance le runner DÉTACHÉ, et rend la main immédiatement. Le client sonde ensuite
 * getRegenJobAction. Même motif que startPipelineRun (lib/actions/pipeline-actions.ts) — la
 * promesse détachée survit sur le processus Node long de Railway.
 *
 * L'unitaire passe par ici aussi, avec un seul id : un job de un. Un seul chemin de code, et la
 * page article gagne la même bande de progression que le lot.
 */
export async function startRegenJob(input: StartRegenJobInput): Promise<{ ok: true; jobId: string } | { ok: false; message: string }> {
  const user = await requireUser();
  requirePermission(user.role, "article", "regenerate");
  const parsed = startRegenJobSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Entrée invalide." };

  // Imports dynamiques APRÈS la garde RBAC — convention du fichier (voir article-actions.ts:75).
  const { db, articles } = await import("@/db");
  const { inArray } = await import("drizzle-orm");
  const { openRegenJob } = await import("@/lib/pipeline/regen-store");
  const { runRegenJob } = await import("@/lib/pipeline/regen-job");

  const rows = await db.select({ id: articles.id, title: articles.title })
    .from(articles).where(inArray(articles.id, parsed.data.articleIds));
  if (rows.length === 0) return { ok: false, message: "Aucun article trouvé." };

  const opened = await openRegenJob({
    actorId: user.id, articles: rows, fields: parsed.data.fields, imageMode: parsed.data.imageMode,
  });
  if (!opened.ok) return opened;

  // Détaché — ne PAS attendre. runRegenJob clôt toujours le job dans son propre finally, donc un
  // rejet est impossible en pratique ; le catch est une ceinture contre un rejet non géré.
  void runRegenJob(opened.jobId).catch(() => {});
  return { ok: true, jobId: opened.jobId };
}

/** Lecture seule pour le sondage du panneau de progression (1,5 s). */
export async function getRegenJobAction(jobId: string): Promise<RegenJobView | null> {
  const user = await requireUser();
  requirePermission(user.role, "article", "regenerate");
  const { readRegenJob } = await import("@/lib/pipeline/regen-store");
  return readRegenJob(jobId);
}

/**
 * Annulation coopérative : pose le drapeau, que runRegenJob observe à la frontière entre deux
 * articles. L'article en cours va jusqu'au bout — on n'interrompt jamais une écriture à mi-chemin.
 */
export async function cancelRegenJob(jobId: string): Promise<void> {
  const user = await requireUser();
  requirePermission(user.role, "article", "regenerate");
  const { db, regenJobs } = await import("@/db");
  const { eq, isNull, and } = await import("drizzle-orm");
  await db.update(regenJobs).set({ cancelRequested: true })
    .where(and(eq(regenJobs.id, jobId), isNull(regenJobs.finishedAt)));
  revalidatePath("/queue");
}
```

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Verify the schema with a test**

Add to `tests/regen-plan.test.ts` (it is already in the pure lane and `lib/validation.ts` is DB-free):

```ts
import { startRegenJobSchema } from "@/lib/validation";

describe("startRegenJobSchema", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const fields = { title: true, body: false, excerpt: false, category: false, tags: false, image: false };
  it("plafonne à 10 articles", () => {
    expect(startRegenJobSchema.safeParse({ articleIds: Array(11).fill(id), fields }).success).toBe(false);
    expect(startRegenJobSchema.safeParse({ articleIds: Array(10).fill(id), fields }).success).toBe(true);
  });
  it("imageMode vaut auto par défaut", () => {
    const r = startRegenJobSchema.safeParse({ articleIds: [id], fields });
    expect(r.success && r.data.imageMode).toBe("auto");
  });
  it("refuse une liste vide", () => {
    expect(startRegenJobSchema.safeParse({ articleIds: [], fields }).success).toBe(false);
  });
});
```

Run: `bun test tests/regen-plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/actions/regen-actions.ts lib/validation.ts tests/regen-plan.test.ts
git commit -m "feat(regenerate): actions de démarrage, sondage et annulation du job"
```

---

### Task 10: `RegenProgress` — le panneau de progression sondé

**Files:**
- Create: `components/queue/regen-progress.tsx`
- Create: `tests/regen-progress.test.ts` (pure lane — renders with `react-dom/server`)
- Modify: `scripts/test-fast.ts` (`PURE_FILES`)

**Interfaces:**
- Consumes: `getRegenJobAction`, `cancelRegenJob` (Task 9); `deriveRegenHeader`, `summarizeRegenJob`, `RegenJobView` (Task 6).
- Produces:
  ```ts
  export function RegenProgress({ jobId, onFinished }: { jobId: string; onFinished: (job: RegenJobView) => void }): JSX.Element | null;
  ```
  Renders nothing once the job is terminal; calls `onFinished` exactly once with the final view.

- [ ] **Step 1: Write the failing test**

Create `tests/regen-progress.test.ts`. It exercises the pure header rendering, not the polling (the poll needs a server action):

```ts
import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { RegenProgressView } from "@/components/queue/regen-progress";
import type { RegenJobView } from "@/lib/pipeline/regen-live";

const job: RegenJobView = {
  id: "j1", total: 3, done: 1, status: "running", imageMode: "auto",
  items: [
    { id: "i1", articleId: "a1", title: "Alpha", stage: "writing", status: "ok", message: null },
    { id: "i2", articleId: "a2", title: "Bravo", stage: "generating", status: "pending", message: null },
    { id: "i3", articleId: "a3", title: "Charlie", stage: "queued", status: "pending", message: null },
  ],
};

describe("RegenProgressView", () => {
  it("affiche l'étape en cours, le compteur et la barre", () => {
    const html = renderToStaticMarkup(createElement(RegenProgressView, { job, onCancel: () => {} }));
    expect(html).toContain("Génération IA — Bravo");
    expect(html).toContain("1/3");
    expect(html).toContain("33%");
  });

  it("affiche le rapport d'échecs partiels", () => {
    const failed: RegenJobView = {
      ...job, status: "done", done: 3,
      items: [
        { id: "i1", articleId: "a1", title: "Alpha", stage: "writing", status: "ok", message: null },
        { id: "i2", articleId: "a2", title: "Bravo", stage: "extracting", status: "failed", message: "Aucune source à régénérer." },
        { id: "i3", articleId: "a3", title: "Charlie", stage: "extracting", status: "awaiting_image", message: null },
      ],
    };
    const html = renderToStaticMarkup(createElement(RegenProgressView, { job: failed, onCancel: () => {} }));
    expect(html).toContain("Bravo");
    expect(html).toContain("Aucune source à régénérer.");
    expect(html).toContain("1 image à choisir");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/regen-progress.test.ts`
Expected: FAIL — `Cannot find module '@/components/queue/regen-progress'`.

- [ ] **Step 3: Write the component**

Create `components/queue/regen-progress.tsx`:

```tsx
"use client";
import { useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getRegenJobAction, cancelRegenJob } from "@/lib/actions/regen-actions";
import { deriveRegenHeader, summarizeRegenJob, type RegenJobView } from "@/lib/pipeline/regen-live";

const POLL_MS = 1500; // même cadence que le panneau d'exécution du pipeline

// PRÉSENTATIONNEL PUR, exporté séparément pour être rendu sous react-dom/server dans les tests
// (voie test:pure) : aucun état, aucun effet, aucun accès réseau — seulement une vue du job.
export function RegenProgressView({ job, onCancel }: { job: RegenJobView; onCancel: () => void }) {
  const header = deriveRegenHeader(job);
  const summary = summarizeRegenJob(job);
  const running = job.status === "running";
  const failures = job.items.filter((i) => i.status === "failed");

  return (
    <div className="space-y-2" aria-live="polite">
      <div className="flex items-center gap-3">
        {running && <Loader2 className="size-4 animate-spin" aria-hidden />}
        <span className="text-sm font-medium">{header.label}</span>
        <span className="text-sm text-muted-foreground">{header.done}/{header.total}</span>
        <span className="text-sm text-muted-foreground">{header.percent}%</span>
        {running && (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            <X aria-hidden /> Annuler
          </Button>
        )}
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
        <div className="h-full bg-primary transition-all" style={{ width: `${header.percent}%` }} />
      </div>
      {summary.awaitingImage > 0 && (
        <p className="text-sm text-muted-foreground">
          {summary.awaitingImage} image{summary.awaitingImage > 1 ? "s" : ""} à choisir
        </p>
      )}
      {failures.length > 0 && (
        <ul className="space-y-1 text-sm text-destructive">
          {failures.map((f) => <li key={f.id}>{f.title} — {f.message}</li>)}
        </ul>
      )}
    </div>
  );
}

/**
 * Sonde getRegenJobAction toutes les 1,5 s jusqu'à ce que le job soit terminal, puis appelle
 * onFinished UNE seule fois. Un throw du sondage est traité comme transitoire (on réessaie au tic
 * suivant), exactement comme components/pipeline/live-run-panel.tsx.
 */
export function RegenProgress({ jobId, onFinished }: { jobId: string; onFinished: (job: RegenJobView) => void }) {
  const [job, setJob] = useState<RegenJobView | null>(null);
  const finishedRef = useRef(false);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  useEffect(() => {
    finishedRef.current = false;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await getRegenJobAction(jobId);
        if (cancelled || res === null) return;
        setJob(res);
        if (res.status !== "running" && !finishedRef.current) {
          finishedRef.current = true;
          onFinishedRef.current(res);
        }
      } catch { /* transitoire — on réessaie au tic suivant */ }
    };
    void tick();
    const id = setInterval(() => { if (!finishedRef.current) void tick(); }, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [jobId]);

  if (job === null) return null;
  return <RegenProgressView job={job} onCancel={() => { void cancelRegenJob(jobId); }} />;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/regen-progress.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add to the pure lane**

Add `"regen-progress.test.ts",` to `PURE_FILES` in `scripts/test-fast.ts`.

Run: `bun run test:pure`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add components/queue/regen-progress.tsx tests/regen-progress.test.ts scripts/test-fast.ts
git commit -m "feat(regenerate): panneau de progression sondé du renvoi à l'IA"
```

---

### Task 11: brancher le lot et l'unitaire sur le job

**Files:**
- Modify: `components/queue/bulk-action-bar.tsx:54-88` (replace `runRegenerate`) and its render block
- Modify: `components/article/regenerate-dialog.tsx:45-61` (replace `handleConfirm`)
- Delete: the now-unused `regenerateInQueue` export in `lib/actions/queue-actions.ts:96-122`

**Interfaces:**
- Consumes: `startRegenJob` (Task 9), `RegenProgress` (Task 10).
- Produces: no new exports. `regenerateInQueue` is removed; `regenerate` in `lib/actions/article-actions.ts` stays (it is still the synchronous core used by tests and by `improveWithAi`'s sibling path) but is no longer called from the dialog.

- [ ] **Step 1: Rewrite the bulk bar's regenerate flow**

In `components/queue/bulk-action-bar.tsx`, replace the `runRegenerate` function with:

```tsx
  // Le lot n'est plus une boucle client : on ouvre UN job côté serveur et on sonde sa progression
  // (components/queue/regen-progress.tsx). La barre reste montée pendant tout le job — aucune
  // revalidation en cours de route ne peut plus effacer la sélection à mi-parcours.
  async function runRegenerate(fields: RegenerateFieldsInput, imageMode: "auto" | "manual") {
    setFailures([]);
    const res = await startRegenJob({ articleIds: rows.map((r) => r.id), fields, imageMode });
    if (!res.ok) { toast.error(res.message); return; }
    setJobId(res.jobId);
  }

  function handleJobFinished(job: RegenJobView) {
    setJobId(null);
    const { ok, failed, awaitingImage } = summarizeRegenJob(job);
    setFailures(job.items.filter((i) => i.status === "failed").map((i) => ({ id: i.articleId, title: i.title, message: i.message ?? "Échec." })));
    if (failed === 0) {
      const extra = awaitingImage > 0 ? ` — ${awaitingImage} image${awaitingImage > 1 ? "s" : ""} à choisir` : "";
      toast.success(`${ok + awaitingImage} article${ok + awaitingImage > 1 ? "s" : ""} renvoyé${ok + awaitingImage > 1 ? "s" : ""} à l'IA${extra}.`);
      onDone();
      router.refresh();
    } else {
      // Succès partiel : PAS de refresh, pour garder la barre montée et la liste des échecs visible.
      toast.warning(`${ok} renvoyé${ok > 1 ? "s" : ""} à l'IA, ${failed} en échec.`);
    }
  }
```

Add the state and imports at the top of the component:

```tsx
import { startRegenJob } from "@/lib/actions/regen-actions";
import { RegenProgress } from "@/components/queue/regen-progress";
import { summarizeRegenJob, type RegenJobView } from "@/lib/pipeline/regen-live";
...
  const [jobId, setJobId] = useState<string | null>(null);
```

Remove the `progress` state and the `regenerateInQueue` import. In the render block, replace the `progress ? ... : ...` span with:

```tsx
        {jobId !== null
          ? <RegenProgress jobId={jobId} onFinished={handleJobFinished} />
          : <span className="flex items-center gap-2 text-sm font-medium">
              {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
              {n} sélectionné{n > 1 ? "s" : ""}
            </span>}
```

and pass `disabled={jobId !== null || pending || tooMany}` to `BulkRegenerateDialog`.

- [ ] **Step 2: Rewrite the single-article dialog's confirm**

In `components/article/regenerate-dialog.tsx`, replace `handleConfirm` and add job state:

```tsx
  const [jobId, setJobId] = useState<string | null>(null);

  function handleConfirm() {
    if (noneChecked) return;
    startTransition(async () => {
      const r = await startRegenJob({ articleIds: [articleId], fields, imageMode });
      if (!r.ok) { toast.error(r.message); return; }
      setJobId(r.jobId);
    });
  }

  function handleJobFinished(job: RegenJobView) {
    setJobId(null);
    const item = job.items[0];
    if (item?.status === "failed") toast.error(item.message ?? "Échec du renvoi à l'IA.");
    else if (item?.status === "awaiting_image") toast.success("Sources extraites — image à choisir.");
    else toast.success("Article régénéré — déposé en revue.");
    setOpen(false);
    setFields(ALL_CHECKED);
    router.refresh();
  }
```

Render `<RegenProgress jobId={jobId} onFinished={handleJobFinished} />` inside `DialogFooter`'s sibling area when `jobId !== null`, and disable both footer buttons while a job runs. Add `const router = useRouter()` from `next/navigation`. `imageMode` arrives in Task 15 — until then pass the literal `"auto"`.

- [ ] **Step 3: Remove the dead server action**

Delete the whole `regenerateInQueue` function and its doc comment (`lib/actions/queue-actions.ts:96-122`), plus the now-unused `regenerateFieldsSchema` / `RegenerateFieldsInput` imports on line 9 if nothing else in the file uses them.

- [ ] **Step 4: Typecheck and run the suite**

Run: `bunx tsc --noEmit`
Expected: no errors. If a test still imports `regenerateInQueue`, update it to call `startRegenJob` or delete the assertion.

Run: `bun run test:pure`
Expected: PASS.

- [ ] **Step 5: Verify in the browser**

Start the dev server via the preview tool (`.claude/launch.json`), open `/queue`, select two pending articles, click « Renvoyer à l'IA », confirm.
Expected: the bar immediately shows « Extraction des sources — <titre> 0/2 0% » and advances without the page freezing; a « Annuler » button is present.

- [ ] **Step 6: Commit**

```bash
git add components/queue/bulk-action-bar.tsx components/article/regenerate-dialog.tsx lib/actions/queue-actions.ts
git commit -m "feat(regenerate): le lot et l'unitaire passent par le job asynchrone"
```

---

# Phase 3 — Modes d'image, bac et assistant

---

### Task 12: réglage `regenerateImageMode`

**Files:**
- Modify: `db/schema.ts` (`pipelineSettings`), `lib/validation.ts` (`pipelineSettingsSchema`), `lib/pipeline/settings-write.ts`, `components/settings/pipeline-settings-form.tsx`
- Create: `db/migrations/NNNN_*.sql` (generated)
- Test: `tests/pipeline-settings.test.ts`

**Interfaces:**
- Produces: `PipelineSettings.regenerateImageMode: "auto" | "manual"` (default `"auto"`), readable via `getPipelineSettings()`.

**Warning for the implementer:** step 3 (`settings-write.ts`) is the step historically forgotten in this codebase — omitting it makes the whole setting a silent no-op. See the comment at the top of that file.

- [ ] **Step 1: Write the failing test**

Add to `tests/pipeline-settings.test.ts`:

```ts
  it("persiste regenerateImageMode", async () => {
    const base = await getPipelineSettings();
    await persistPipelineSettings({ ...toInput(base), regenerateImageMode: "manual" });
    expect((await getPipelineSettings()).regenerateImageMode).toBe("manual");
    await persistPipelineSettings({ ...toInput(base), regenerateImageMode: "auto" });
    expect((await getPipelineSettings()).regenerateImageMode).toBe("auto");
  });
```

If the file has no `toInput` helper, add one next to the existing fixtures that maps a `PipelineSettings` row to a `PipelineSettingsInput` (drop `id` and `updatedAt`, keep every other field).

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/pipeline-settings.test.ts`
Expected: FAIL — `regenerateImageMode` does not exist on the settings type.

- [ ] **Step 3: Add the column**

In `db/schema.ts`, inside `pipelineSettings`, just before `updatedAt`:

```ts
  // Mode de choix de l'image à la une lors d'un renvoi à l'IA : `auto` = un appel LLM dédié choisit
  // parmi les images scrapées ; `manual` = les candidats sont garés sur l'article et l'éditeur
  // tranche depuis le bac du /queue. `text` et non pgEnum — voir la contrainte globale du plan.
  regenerateImageMode: text("regenerate_image_mode").notNull().default("auto"),
```

- [ ] **Step 4: Add the validation field**

In `lib/validation.ts`, inside `pipelineSettingsSchema`:

```ts
  // `.default("auto")` (et non un enum nu) pour la même raison qu'alertEmailEnabled ci-dessus : le
  // payload existant de PipelineSettingsForm n'envoie pas encore ce champ, et un champ requis
  // casserait le safeParse côté client au moment même où ce schéma change.
  regenerateImageMode: z.enum(["auto", "manual"]).default("auto"),
```

- [ ] **Step 5: Add it to the upsert**

In `lib/pipeline/settings-write.ts`, add to the `values` object:

```ts
    regenerateImageMode: data.regenerateImageMode,
```

- [ ] **Step 6: Add it to the form**

In `components/settings/pipeline-settings-form.tsx`:
- `FormState`: `regenerateImageMode: "auto" | "manual";`
- `toFormState`: `regenerateImageMode: settings.regenerateImageMode as "auto" | "manual",`
- `payload` in `handleSave`: `regenerateImageMode: form.regenerateImageMode,`
- Render inside the « Exécution » card:

```tsx
            <div className="space-y-2">
              <Label htmlFor="regen-image-mode">Choix de l&apos;image à la une (renvoi à l&apos;IA)</Label>
              <select
                id="regen-image-mode"
                className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                value={form.regenerateImageMode}
                onChange={(e) => setForm((f) => ({ ...f, regenerateImageMode: e.target.value as "auto" | "manual" }))}
              >
                <option value="auto">Automatique — l&apos;IA choisit parmi les images trouvées</option>
                <option value="manual">Manuel — je choisis depuis le bac de la file</option>
              </select>
              <p className="text-sm text-muted-foreground">
                Valeur par défaut. Chaque renvoi à l&apos;IA peut la surcharger dans sa fenêtre.
              </p>
            </div>
```

- [ ] **Step 7: Generate and apply the migration**

Run: `bun run db:generate && bun run db:migrate`
Expected: a new migration adding `regenerate_image_mode` with default `'auto'`, applied cleanly.

- [ ] **Step 8: Run the tests**

Run: `bun test tests/pipeline-settings.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add db/schema.ts db/migrations lib/validation.ts lib/pipeline/settings-write.ts components/settings/pipeline-settings-form.tsx tests/pipeline-settings.test.ts
git commit -m "feat(settings): mode de choix de l'image pour le renvoi à l'IA"
```

---

### Task 13: colonne `pending_image_candidates` et candidats porteurs de provenance

**Files:**
- Modify: `db/schema.ts` (`articles`), `lib/pipeline/regenerate-core.ts`
- Create: `db/migrations/NNNN_*.sql` (generated)
- Test: `tests/regenerate-core.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // db/schema.ts
  export type ImageCandidate = { url: string; sourceUrl: string; mediaName: string };
  // articles.pendingImageCandidates: ImageCandidate[] | null
  ```
  `regenerateArticle` now builds a `candidates: ImageCandidate[]` internally alongside the flat `candidateImages: string[]` it still passes to `generateArticle`.

- [ ] **Step 1: Add the column and type**

In `db/schema.ts`, above the `articles` table:

```ts
// Image candidate scrapée, avec sa provenance : le crédit et le lien source d'un choix MANUEL en
// découlent directement, ce qui est plus fiable qu'un crédit deviné par le modèle.
export type ImageCandidate = { url: string; sourceUrl: string; mediaName: string };
```

and inside `articles`, after `imageSourceUrl`:

```ts
  // Images candidates en attente d'un choix manuel (mode `manual` du renvoi à l'IA). NULL = rien à
  // choisir. C'est cette seule colonne qui alimente le bac, le badge et le filtre du /queue — l'état
  // vit sur l'article, pas sur le job, pour survivre à la purge de celui-ci.
  pendingImageCandidates: jsonb("pending_image_candidates").$type<ImageCandidate[]>(),
```

- [ ] **Step 2: Generate and apply the migration**

Run: `bun run db:generate && bun run db:migrate`
Expected: a nullable `pending_image_candidates jsonb` column added to `articles`.

- [ ] **Step 3: Write the failing test**

Add to `tests/regenerate-core.test.ts`:

```ts
describe("candidats d'image avec provenance", () => {
  it("étiquette chaque image candidate avec sa source", async () => {
    const { articleId } = await seedArticleWithSources(["https://media-a.test/1"]);
    extractImpl = async () => ({
      title: "t", text: "Contenu extrait de test, assez long.",
      images: ["https://media-a.test/img1.jpg", "https://media-a.test/img2.jpg"],
      via: "test", attempts: [],
    });
    let seenCandidates: string[] = [];
    generateArticleImpl = async () => {
      seenCandidates = (lastGenerateInput as { candidateImages: string[] } | null)?.candidateImages ?? [];
      return { draft: { ...draftFixture, featuredImageUrl: "https://media-a.test/img1.jpg" }, via: "openrouter" };
    };
    const r = await regenerateArticle(articleId, { title: false, body: false, excerpt: false, category: false, tags: false, image: true }, null, { timeoutMs: 5000 });
    expect(r.ok).toBe(true);
    expect(seenCandidates).toEqual(["https://media-a.test/img1.jpg", "https://media-a.test/img2.jpg"]);
  });
});
```

Widen `lastGenerateInput`'s type in the fixtures to `{ sources: { url: string }[]; candidateImages: string[] } | null`.

- [ ] **Step 4: Run the test to verify it fails or passes**

Run: `bun test tests/regenerate-core.test.ts`
Expected: PASS already (the flat list is unchanged) — this test is a guard so Step 5 cannot regress it.

- [ ] **Step 5: Build the provenance-carrying list**

In `lib/pipeline/regenerate-core.ts`, replace the accumulation loop from Task 3 with:

```ts
  const extracted: { mediaName: string; url: string; text: string }[] = [];
  const candidates: ImageCandidate[] = [];
  for (const r of results) {
    if (r === null) continue;
    extracted.push({ mediaName: r.mediaName, url: r.url, text: r.text });
    // Une même image peut être servie par deux sources — on déduplique sur l'URL, en gardant la
    // PREMIÈRE provenance vue (l'ordre des sources est stable, celui de article_sources).
    for (const img of r.images) {
      if (!candidates.some((c) => c.url === img)) {
        candidates.push({ url: img, sourceUrl: r.url, mediaName: r.mediaName });
      }
    }
  }
  const candidateImages = candidates.map((c) => c.url);
```

with `import type { ImageCandidate } from "@/db";` at the top.

- [ ] **Step 6: Run the tests**

Run: `bun test tests/regenerate-core.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add db/schema.ts db/migrations lib/pipeline/regenerate-core.ts tests/regenerate-core.test.ts
git commit -m "feat(regenerate): candidats d'image porteurs de leur provenance + colonne d'attente"
```

---

### Task 14: `planRegeneration` connaît les modes, `pickFeaturedImage` choisit

**Files:**
- Modify: `lib/pipeline/regen-plan.ts`, `tests/regen-plan.test.ts`
- Create: `lib/ai/pick-image.ts`, `tests/pick-image.test.ts`
- Modify: `scripts/test-fast.ts` (`PURE_FILES`)

**Interfaces:**
- Produces:
  ```ts
  // regen-plan.ts — widened
  export type ImageAction = "from-draft" | "skip" | "pick" | "park";
  export function planRegeneration(input: {
    fields: RegenerateFieldsInput;
    candidateCount: number;
    imageMode: "auto" | "manual";
  }): RegenPlan;

  // pick-image.ts
  export function sanitizeImagePick(pick: { url: string; credit?: string | null }, candidates: ImageCandidate[]): ImageCandidate & { credit: string | null } | null;
  export async function pickFeaturedImage(input: {
    title: string; bodyHtml: string; candidates: ImageCandidate[];
  }): Promise<{ picked: (ImageCandidate & { credit: string | null }) | null; via: string }>;
  ```

- [ ] **Step 1: Write the failing plan tests**

Replace the `planRegeneration` describe block in `tests/regen-plan.test.ts` with one that passes `imageMode`, and add the two new cases:

```ts
describe("planRegeneration — mode auto", () => {
  it("image seule avec candidats : PAS de génération, on choisit l'image", () => {
    const p = planRegeneration({ fields: IMAGE_ONLY, candidateCount: 3, imageMode: "auto" });
    expect(p.runGeneration).toBe(false);
    expect(p.imageAction).toBe("pick");
  });
  it("image + autres avec candidats : génération, image issue du brouillon", () => {
    const p = planRegeneration({ fields: IMAGE_AND_TITLE, candidateCount: 3, imageMode: "auto" });
    expect(p.runGeneration).toBe(true);
    expect(p.imageAction).toBe("from-draft");
  });
});

describe("planRegeneration — mode manuel", () => {
  it("image seule avec candidats : aucun LLM, on gare les candidats", () => {
    const p = planRegeneration({ fields: IMAGE_ONLY, candidateCount: 3, imageMode: "manual" });
    expect(p.runGeneration).toBe(false);
    expect(p.imageAction).toBe("park");
    expect(p.effectiveFields.image).toBe(false);
  });
  it("image + autres : génère les autres champs et gare les candidats", () => {
    const p = planRegeneration({ fields: IMAGE_AND_TITLE, candidateCount: 3, imageMode: "manual" });
    expect(p.runGeneration).toBe(true);
    expect(p.imageAction).toBe("park");
    expect(p.effectiveFields.image).toBe(false);
    expect(p.effectiveFields.title).toBe(true);
  });
  it("zéro candidat reste prioritaire sur le mode", () => {
    expect(planRegeneration({ fields: IMAGE_ONLY, candidateCount: 0, imageMode: "manual" }).abort)
      .toBe("Aucune image candidate trouvée — image inchangée.");
  });
});
```

Add `imageMode: "auto"` to every pre-existing call in the file.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/regen-plan.test.ts`
Expected: FAIL — `imageAction` is `"from-draft"` where `"pick"` / `"park"` is expected.

- [ ] **Step 3: Widen the plan**

In `lib/pipeline/regen-plan.ts`, change `ImageAction` to `"from-draft" | "skip" | "pick" | "park"`, add `imageMode: "auto" | "manual"` to the input type, and replace the final `return`:

```ts
  // Des candidats existent. Le mode décide qui tranche, et le fait qu'il y ait ou non d'AUTRES
  // champs cochés décide si une génération complète se justifie. Une régénération « image seule »
  // ne doit jamais payer une génération d'article entière pour n'en garder que trois colonnes.
  if (input.imageMode === "manual") {
    // L'éditeur tranchera depuis le bac : on n'appelle aucun LLM pour l'image, et on retire `image`
    // des champs appliqués (les colonnes ne bougent qu'au moment du choix).
    return {
      ...base,
      runGeneration: hasOtherFields(fields),
      imageAction: "park",
      effectiveFields: { ...fields, image: false },
    };
  }
  if (!hasOtherFields(fields)) return { ...base, runGeneration: false, imageAction: "pick" };
  return { ...base, imageAction: "from-draft" };
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/regen-plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing pick-image test**

Create `tests/pick-image.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { sanitizeImagePick } from "@/lib/ai/pick-image";
import type { ImageCandidate } from "@/db";

const candidates: ImageCandidate[] = [
  { url: "https://a.test/1.jpg", sourceUrl: "https://a.test/article", mediaName: "Média A" },
  { url: "https://b.test/2.jpg", sourceUrl: "https://b.test/article", mediaName: "Média B" },
];

describe("sanitizeImagePick", () => {
  it("accepte une URL de la liste et hérite de la provenance", () => {
    const p = sanitizeImagePick({ url: "https://b.test/2.jpg" }, candidates);
    expect(p).toEqual({ url: "https://b.test/2.jpg", sourceUrl: "https://b.test/article", mediaName: "Média B", credit: "Média B" });
  });
  it("le crédit du modèle l'emporte s'il est fourni", () => {
    expect(sanitizeImagePick({ url: "https://a.test/1.jpg", credit: "Photo X / Média A" }, candidates)?.credit)
      .toBe("Photo X / Média A");
  });
  it("rejette une URL hors liste (le modèle a inventé)", () => {
    expect(sanitizeImagePick({ url: "https://ailleurs.test/z.jpg" }, candidates)).toBeNull();
  });
  it("rejette sur une liste vide", () => {
    expect(sanitizeImagePick({ url: "https://a.test/1.jpg" }, [])).toBeNull();
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `bun test tests/pick-image.test.ts`
Expected: FAIL — `Cannot find module '@/lib/ai/pick-image'`.

- [ ] **Step 7: Write pick-image**

Create `lib/ai/pick-image.ts`:

```ts
import { z } from "zod";
import { generateObject } from "ai";
import { buildOpenRouterModel } from "./providers";
import { getPipelineConfig } from "@/lib/config/pipeline-config";
import { runWithOpenRouterPool } from "./with-token-pool";
import type { ImageCandidate } from "@/db";

// Appel dédié, BEAUCOUP plus court qu'une génération d'article : on ne régénère pas six champs pour
// n'en garder qu'un. Utilisé sur le seul chemin « image seule, mode auto » — quand d'autres champs
// sont cochés, generateArticle a déjà choisi une image contrainte à la même liste de candidats et un
// second appel serait du gaspillage (voir lib/pipeline/regen-plan.ts).
const pickSchema = z.object({
  url: z.string(),
  credit: z.string().nullish(),
});

export type PickedImage = ImageCandidate & { credit: string | null };

/**
 * PUR — garde de sortie : une URL choisie DOIT appartenir à la liste de candidats (même règle que
 * sanitizeDraft dans generate-article.ts — un modèle invente régulièrement une URL plausible). La
 * provenance vient toujours du candidat, jamais du modèle ; seul le crédit peut être enrichi par lui.
 */
export function sanitizeImagePick(
  pick: { url: string; credit?: string | null },
  candidates: ImageCandidate[],
): PickedImage | null {
  const match = candidates.find((c) => c.url === pick.url);
  if (match === undefined) return null;
  return { ...match, credit: pick.credit?.trim() ? pick.credit.trim() : match.mediaName };
}

export async function pickFeaturedImage(input: {
  title: string; bodyHtml: string; candidates: ImageCandidate[];
}): Promise<{ picked: PickedImage | null; via: string }> {
  if (input.candidates.length === 0) return { picked: null, via: "none" };
  const cfg = getPipelineConfig();
  const list = input.candidates.map((c, i) => `${i + 1}. ${c.url} (source : ${c.mediaName})`).join("\n");
  const prompt = [
    "Tu choisis l'image à la une d'un article de presse économique panafricaine.",
    `Titre : ${input.title}`,
    `Extrait du corps : ${input.bodyHtml.replace(/<[^>]+>/g, " ").slice(0, 1200)}`,
    "Choisis l'image la plus pertinente et la plus illustrative STRICTEMENT parmi cette liste, en recopiant son URL exacte.",
    "Évite les logos, bandeaux publicitaires, avatars et icônes.",
    list,
  ].join("\n");

  const r = await runWithOpenRouterPool(
    async (apiKey) => {
      const { object } = await generateObject({
        model: buildOpenRouterModel(cfg, apiKey),
        schema: pickSchema,
        prompt,
        providerOptions: { openaiCompatible: { strictJsonSchema: false } },
      });
      return object;
    },
    // « Flaky » ici = une URL hors liste : le jeton suivant a une vraie chance de mieux faire.
    (object) => sanitizeImagePick(object, input.candidates) === null,
  );

  if (!r.ok) return { picked: null, via: "mock" };
  return { picked: sanitizeImagePick(r.value, input.candidates), via: "openrouter" };
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `bun test tests/pick-image.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 9: Add to the pure lane**

Add `"pick-image.test.ts",` to `PURE_FILES`.

Run: `bun run test:pure`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add lib/pipeline/regen-plan.ts lib/ai/pick-image.ts tests/regen-plan.test.ts tests/pick-image.test.ts scripts/test-fast.ts
git commit -m "feat(regenerate): modes auto/manuel du plan et choix d'image dédié"
```

---

### Task 15: exécuter les quatre cas dans `regenerateArticle`

**Files:**
- Modify: `lib/pipeline/regenerate-core.ts`
- Test: `tests/regenerate-core.test.ts`

**Interfaces:**
- Consumes: `planRegeneration` with `imageMode` (Task 14), `pickFeaturedImage` (Task 14), `ImageCandidate` (Task 13).
- Produces: `regenerateArticle` returns `awaitingImage: true` on the `park` path; writes `articles.pendingImageCandidates` there; writes the picked image columns directly on the `pick` path.

- [ ] **Step 1: Write the failing tests**

Add to `tests/regenerate-core.test.ts` (mock `@/lib/ai/pick-image` the same way the file already mocks `generate-article`):

```ts
const { pickFeaturedImage: realPickFeaturedImage } = await import("@/lib/ai/pick-image");
let pickImpl: () => Promise<{ picked: { url: string; sourceUrl: string; mediaName: string; credit: string | null } | null; via: string }> =
  async () => ({ picked: null, via: "none" });
mock.module("@/lib/ai/pick-image", () => ({ pickFeaturedImage: () => pickImpl() }));

describe("regenerateArticle — modes d'image", () => {
  const IMAGE_ONLY = { title: false, body: false, excerpt: false, category: false, tags: false, image: true };

  it("auto, image seule : n'appelle PAS generateArticle et écrit l'image choisie", async () => {
    const { articleId } = await seedArticleWithSources(["https://a.test/1"]);
    extractImpl = async () => ({ title: "t", text: "Contenu assez long pour compter.", images: ["https://a.test/i.jpg"], via: "test", attempts: [] });
    let generated = false;
    generateArticleImpl = async () => { generated = true; return { draft: draftFixture, via: "openrouter" }; };
    pickImpl = async () => ({ picked: { url: "https://a.test/i.jpg", sourceUrl: "https://a.test/1", mediaName: "Test", credit: "Test" }, via: "openrouter" });

    const r = await regenerateArticle(articleId, IMAGE_ONLY, null, { imageMode: "auto", timeoutMs: 5000 });

    expect(r.ok).toBe(true);
    expect(generated).toBe(false);
    const [row] = await db.select().from(articles).where(eq(articles.id, articleId));
    expect(row.featuredImageUrl).toBe("https://a.test/i.jpg");
    expect(row.imageCredit).toBe("Test");
    expect(row.imageSourceUrl).toBe("https://a.test/1");
  });

  it("manuel, image seule : aucun LLM, gare les candidats, awaitingImage", async () => {
    const { articleId } = await seedArticleWithSources(["https://a.test/1"]);
    extractImpl = async () => ({ title: "t", text: "Contenu assez long pour compter.", images: ["https://a.test/i.jpg", "https://a.test/j.jpg"], via: "test", attempts: [] });
    let generated = false, picked = false;
    generateArticleImpl = async () => { generated = true; return { draft: draftFixture, via: "openrouter" }; };
    pickImpl = async () => { picked = true; return { picked: null, via: "none" }; };

    const r = await regenerateArticle(articleId, IMAGE_ONLY, null, { imageMode: "manual", timeoutMs: 5000 });

    expect(r.ok).toBe(true);
    expect(r.awaitingImage).toBe(true);
    expect(generated).toBe(false);
    expect(picked).toBe(false);
    const [row] = await db.select().from(articles).where(eq(articles.id, articleId));
    expect(row.pendingImageCandidates).toEqual([
      { url: "https://a.test/i.jpg", sourceUrl: "https://a.test/1", mediaName: "Test" },
      { url: "https://a.test/j.jpg", sourceUrl: "https://a.test/1", mediaName: "Test" },
    ]);
  });

  it("manuel, image + titre : applique le titre ET gare les candidats", async () => {
    const { articleId } = await seedArticleWithSources(["https://a.test/1"]);
    await db.update(articles).set({ featuredImageUrl: "https://ancienne/img.jpg" }).where(eq(articles.id, articleId));
    extractImpl = async () => ({ title: "t", text: "Contenu assez long pour compter.", images: ["https://a.test/i.jpg"], via: "test", attempts: [] });
    generateArticleImpl = async () => ({ draft: { ...draftFixture, title: "Titre neuf", featuredImageUrl: "https://a.test/i.jpg" }, via: "openrouter" });

    const r = await regenerateArticle(articleId, { ...IMAGE_ONLY, title: true }, null, { imageMode: "manual", timeoutMs: 5000 });

    expect(r.awaitingImage).toBe(true);
    const [row] = await db.select().from(articles).where(eq(articles.id, articleId));
    expect(row.title).toBe("Titre neuf");
    expect(row.featuredImageUrl).toBe("https://ancienne/img.jpg"); // intacte jusqu'au choix
    expect(row.pendingImageCandidates).toHaveLength(1);
  });
});
```

Restore `pickImpl` in the file's `afterAll`: `pickImpl = realPickFeaturedImage as unknown as typeof pickImpl;`

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/regenerate-core.test.ts`
Expected: FAIL — `generated` is `true` and `awaitingImage` is undefined.

- [ ] **Step 3: Implement the four paths**

In `lib/pipeline/regenerate-core.ts`, replace everything from the `planRegeneration` call to the final `return` with:

```ts
  const plan = planRegeneration({
    fields: parsed.data,
    candidateCount: candidates.length,
    imageMode: opts.imageMode ?? "auto",
  });
  if (plan.abort !== null) return { ok: false, message: plan.abort, title: article.title };

  // Chemin « choix manuel » : aucun appel LLM pour l'image. On gare les candidats sur l'article —
  // c'est cette colonne, et elle seule, qui alimente le bac du /queue — et on laisse les colonnes
  // d'image intactes jusqu'au choix de l'éditeur.
  if (plan.imageAction === "park") {
    await db.update(articles).set({ pendingImageCandidates: candidates }).where(eq(articles.id, articleId));
  }

  // Chemin « image seule, mode auto » : un appel dédié bon marché, pas une génération d'article
  // complète dont on ne garderait que trois colonnes.
  if (plan.imageAction === "pick") {
    await opts.onStage?.("generating");
    const { pickFeaturedImage } = await import("@/lib/ai/pick-image");
    const { picked } = await pickFeaturedImage({ title: article.title, bodyHtml: article.bodyHtml, candidates });
    if (picked === null) {
      return { ok: false, message: "L'IA n'a retenu aucune image parmi les candidates — image inchangée.", title: article.title };
    }
    await opts.onStage?.("writing");
    await db.update(articles).set({
      featuredImageUrl: picked.url, imageCredit: picked.credit, imageSourceUrl: picked.sourceUrl,
      pendingImageCandidates: null, updatedAt: new Date(),
    }).where(eq(articles.id, articleId));
    await db.insert(articleRevisions).values({
      articleId, actorId, action: "image régénérée par IA",
      detail: `Image retenue : ${picked.url}\n— Image précédente : ${article.featuredImageUrl ?? "(aucune)"}`,
    });
    return { ok: true, message: "Image à la une régénérée.", title: article.title };
  }

  if (!plan.runGeneration) {
    // Manuel + image seule : l'extraction a suffi, les candidats sont garés, rien d'autre à écrire.
    return { ok: true, message: "Sources extraites — image à choisir.", title: article.title, awaitingImage: true };
  }

  await opts.onStage?.("generating");
  const { generateArticle } = await import("@/lib/ai/generate-article");
  const categoryNames = (await db.select({ name: wpCategories.name }).from(wpCategories)).map((c) => c.name);
  const { draft, via, failure, failureDetail } = await generateArticle({ sources: extracted, candidateImages, categories: categoryNames });
  if (via === "mock") return { ok: false, message: aiFailureMessage(failure ?? "unconfigured", "régénération", failureDetail), title: article.title };

  await opts.onStage?.("writing");
  const { applyRegeneration } = await import("@/lib/pipeline/regenerate");
  await applyRegeneration({
    articleId, prior: { title: article.title, bodyHtml: article.bodyHtml, featuredImageUrl: article.featuredImageUrl, confidenceFlags: article.confidenceFlags },
    draft, fields: plan.effectiveFields, sourceCount: extracted.length, categoryNames, actorId,
  });

  const awaitingImage = plan.imageAction === "park";
  const message = awaitingImage
    ? "Article régénéré — déposé en revue. Image à choisir."
    : plan.warning !== null
      ? `Article régénéré — déposé en revue. ${plan.warning}`
      : "Article régénéré — déposé en revue.";
  return { ok: true, message, title: article.title, awaitingImage };
```

Add `articleRevisions` to the `@/db` import at the top of the file.

- [ ] **Step 4: Run the tests**

Run: `bun test tests/regenerate-core.test.ts tests/regen-job.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline/regenerate-core.ts tests/regenerate-core.test.ts
git commit -m "feat(regenerate): exécute les quatre cas de choix d'image"
```

---

### Task 16: action `pickRegeneratedImage`

**Files:**
- Modify: `lib/actions/regen-actions.ts`, `lib/validation.ts`
- Create: `tests/pick-regenerated-image.test.ts` (DB lane)

**Interfaces:**
- Produces:
  ```ts
  export const imagePickSchema: z.ZodType<{ url: string; credit: string | null; sourceUrl: string | null } | null>;
  export async function pickRegeneratedImage(articleId: string, choice: { url: string; credit: string | null; sourceUrl: string | null } | null): Promise<{ ok: boolean; message: string }>;
  ```
  `choice === null` means « Aucune image » — clears the pending list, leaves the current image untouched.

- [ ] **Step 1: Add the schema**

In `lib/validation.ts`, after `startRegenJobSchema`:

```ts
// Choix d'image manuel. `null` = « Aucune image » : on vide la liste en attente SANS toucher à
// l'image en place (l'invariant « ne jamais détruire une image » vaut aussi pour un choix humain —
// vider l'image est une action distincte, disponible dans le panneau image de l'article).
export const imagePickSchema = z.object({
  url: z.string().url(),
  credit: z.string().nullable(),
  sourceUrl: z.string().url().nullable(),
}).nullable();
export type ImagePickInput = z.infer<typeof imagePickSchema>;
```

- [ ] **Step 2: Write the failing test**

Create `tests/pick-regenerated-image.test.ts`:

```ts
import { describe, it, expect, afterAll } from "bun:test";
import { db, articles, articleRevisions } from "@/db";
import { eq, inArray, desc } from "drizzle-orm";
import { faker } from "@faker-js/faker";
import { applyImagePick } from "@/lib/pipeline/regen-store";

const created: string[] = [];
const candidates = [
  { url: "https://a.test/1.jpg", sourceUrl: "https://a.test/art", mediaName: "Média A" },
  { url: "https://b.test/2.jpg", sourceUrl: "https://b.test/art", mediaName: "Média B" },
];

async function seed(withImage: string | null) {
  const [a] = await db.insert(articles).values({
    title: `Article ${faker.string.uuid()}`, bodyHtml: "<p>x</p>",
    featuredImageUrl: withImage, pendingImageCandidates: candidates,
  }).returning({ id: articles.id });
  created.push(a.id);
  return a.id;
}

afterAll(async () => {
  if (created.length) await db.delete(articles).where(inArray(articles.id, created));
});

describe("applyImagePick", () => {
  it("écrit l'image choisie, vide l'attente et laisse une révision", async () => {
    const id = await seed(null);
    const r = await applyImagePick(id, { url: "https://b.test/2.jpg", credit: "Média B", sourceUrl: "https://b.test/art" }, null);
    expect(r.ok).toBe(true);
    const [row] = await db.select().from(articles).where(eq(articles.id, id));
    expect(row.featuredImageUrl).toBe("https://b.test/2.jpg");
    expect(row.imageCredit).toBe("Média B");
    expect(row.imageSourceUrl).toBe("https://b.test/art");
    expect(row.pendingImageCandidates).toBeNull();
    const [rev] = await db.select().from(articleRevisions).where(eq(articleRevisions.articleId, id)).orderBy(desc(articleRevisions.at));
    expect(rev.action).toBe("image choisie");
  });

  it("« Aucune image » vide l'attente SANS toucher l'image en place", async () => {
    const id = await seed("https://ancienne/img.jpg");
    const r = await applyImagePick(id, null, null);
    expect(r.ok).toBe(true);
    const [row] = await db.select().from(articles).where(eq(articles.id, id));
    expect(row.featuredImageUrl).toBe("https://ancienne/img.jpg");
    expect(row.pendingImageCandidates).toBeNull();
  });

  it("refuse une URL absente de la liste en attente", async () => {
    const id = await seed(null);
    const r = await applyImagePick(id, { url: "https://ailleurs.test/z.jpg", credit: null, sourceUrl: null }, null);
    expect(r.ok).toBe(false);
    const [row] = await db.select().from(articles).where(eq(articles.id, id));
    expect(row.featuredImageUrl).toBeNull();
    expect(row.pendingImageCandidates).not.toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `bun test tests/pick-regenerated-image.test.ts`
Expected: FAIL — `applyImagePick` is not exported from `regen-store`.

- [ ] **Step 4: Implement the core in `regen-store.ts`**

```ts
/**
 * Applique un choix d'image manuel. Le cœur vit ici (module plain, testable sans contexte de
 * requête) ; l'action pickRegeneratedImage n'ajoute que RBAC + revalidation autour.
 *
 * L'URL choisie DOIT figurer dans la liste en attente de CET article : le client envoie une URL,
 * et une action serveur ne fait jamais confiance à une URL arbitraire venue du navigateur (elle
 * finirait en `src` d'une image publiée). `choice === null` = « Aucune image » : on vide l'attente
 * sans jamais effacer l'image en place.
 */
export async function applyImagePick(
  articleId: string,
  choice: { url: string; credit: string | null; sourceUrl: string | null } | null,
  actorId: string | null,
): Promise<{ ok: boolean; message: string }> {
  const { articles, articleRevisions } = await import("@/db");
  const [article] = await db.select().from(articles).where(eq(articles.id, articleId));
  if (!article) return { ok: false, message: "Article introuvable." };

  if (choice === null) {
    await db.update(articles).set({ pendingImageCandidates: null }).where(eq(articles.id, articleId));
    return { ok: true, message: "Aucune image retenue — image inchangée." };
  }

  const pending = article.pendingImageCandidates ?? [];
  const match = pending.find((c) => c.url === choice.url);
  if (match === undefined) return { ok: false, message: "Cette image ne fait pas partie des candidates." };

  await db.transaction(async (tx) => {
    await tx.insert(articleRevisions).values({
      articleId, actorId, action: "image choisie",
      detail: `Image retenue : ${match.url}\n— Image précédente : ${article.featuredImageUrl ?? "(aucune)"}`,
    });
    await tx.update(articles).set({
      featuredImageUrl: match.url,
      imageCredit: choice.credit ?? match.mediaName,
      imageSourceUrl: choice.sourceUrl ?? match.sourceUrl,
      pendingImageCandidates: null,
      updatedAt: new Date(),
    }).where(eq(articles.id, articleId));
  });
  return { ok: true, message: "Image à la une mise à jour." };
}
```

- [ ] **Step 5: Add the action wrapper**

In `lib/actions/regen-actions.ts`:

```ts
/** Choix d'image manuel depuis le bac / l'assistant du /queue. */
export async function pickRegeneratedImage(articleId: string, choice: ImagePickInput): Promise<{ ok: boolean; message: string }> {
  const user = await requireUser();
  requirePermission(user.role, "article", "regenerate");
  const parsed = imagePickSchema.safeParse(choice);
  if (!parsed.success) return { ok: false, message: "Choix invalide." };
  const { applyImagePick } = await import("@/lib/pipeline/regen-store");
  const r = await applyImagePick(articleId, parsed.data, user.id);
  revalidatePath("/queue"); revalidatePath(`/article/${articleId}`);
  return r;
}
```

with `import { imagePickSchema, type ImagePickInput } from "@/lib/validation";` added to the existing validation import.

- [ ] **Step 6: Run the tests**

Run: `bun test tests/pick-regenerated-image.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add lib/actions/regen-actions.ts lib/pipeline/regen-store.ts lib/validation.ts tests/pick-regenerated-image.test.ts
git commit -m "feat(regenerate): action de choix manuel de l'image à la une"
```

---

### Task 17: bac du /queue — filtre `img=pending` et badge

**Files:**
- Modify: `lib/queries/queue.ts` (`QueueFilters` type, `parseQueueSearchParams`, `getQueue`), `components/queue/queue-filters.tsx`, `components/queue/columns.tsx`
- Test: `tests/queue-queries.test.ts` (already in the pure lane — `parseQueueSearchParams` is pure)

**Interfaces:**
- Produces: `QueueFilters` gains `pendingImage?: true`; `QueueRow` gains `pendingImageCount: number`.

- [ ] **Step 1: Write the failing test**

Add to `tests/queue-queries.test.ts`:

```ts
  it("?img=pending active le filtre du bac d'images", () => {
    expect(parseQueueSearchParams({ img: "pending" }).pendingImage).toBe(true);
  });
  it("une valeur img inconnue est ignorée", () => {
    expect(parseQueueSearchParams({ img: "nimporte" }).pendingImage).toBeUndefined();
    expect(parseQueueSearchParams({}).pendingImage).toBeUndefined();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/queue-queries.test.ts`
Expected: FAIL — `pendingImage` does not exist on the returned filters.

- [ ] **Step 3: Implement the filter**

In `lib/queries/queue.ts`:
- add `pendingImage?: true;` to the `QueueFilters` type;
- in `parseQueueSearchParams`, before the return:

```ts
  // Bac « images à choisir » : les articles dont une régénération en mode manuel a garé des
  // candidats. Paramètre séparé du statut — un article en attente d'image reste `pending`.
  const pendingImage = str(sp.img) === "pending" ? (true as const) : undefined;
```
  and add `pendingImage` to the returned object;
- in `getQueue`, after the `source` conditions:

```ts
  if (f.pendingImage) conds.push(isNotNull(articles.pendingImageCandidates));
```
  with `isNotNull` added to the `drizzle-orm` import;
- add to the `db.select({...})` projection: `pendingImageCandidates: articles.pendingImageCandidates,` and to the row mapping: `pendingImageCount: (r.pendingImageCandidates ?? []).length,`;
- add `pendingImageCount: number;` to the `QueueRow` type.

- [ ] **Step 4: Add the filter control**

In `components/queue/queue-filters.tsx`, add a `Select` next to the source one:

```tsx
      <Select value={filters.img ?? "all"} onValueChange={(v) => update({ img: v === "all" ? undefined : v })}>
        <SelectTrigger className="w-[190px]"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Toutes les images</SelectItem>
          <SelectItem value="pending">Images à choisir</SelectItem>
        </SelectContent>
      </Select>
```

Follow the file's existing `update(...)` helper signature exactly — read the neighbouring source `Select` and mirror it, including how it writes to the URL and to `usePersistedFilters`.

- [ ] **Step 5: Add the badge**

In `components/queue/columns.tsx`, in the `image` column cell, when `row.original.pendingImageCount > 0`, render a badge instead of / next to the thumbnail:

```tsx
      {row.original.pendingImageCount > 0 && (
        <Badge variant="secondary" title="Une régénération a trouvé des images candidates en attente de votre choix">
          {row.original.pendingImageCount} à choisir
        </Badge>
      )}
```

Import `Badge` from `@/components/ui/badge` if it is not already imported.

- [ ] **Step 6: Run the tests and typecheck**

Run: `bun test tests/queue-queries.test.ts && bunx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add lib/queries/queue.ts components/queue/queue-filters.tsx components/queue/columns.tsx tests/queue-queries.test.ts
git commit -m "feat(queue): filtre et badge du bac d'images à choisir"
```

---

### Task 18: assistant de choix d'image

**Files:**
- Create: `components/queue/image-pick-wizard.tsx`
- Create: `tests/image-pick-wizard.test.ts` (pure lane)
- Modify: `scripts/test-fast.ts` (`PURE_FILES`), `components/queue/queue-table.tsx` (mount the entry button)

**Interfaces:**
- Consumes: `pickRegeneratedImage` (Task 16).
- Produces:
  ```ts
  export type PendingPick = { articleId: string; title: string; currentImageUrl: string | null; candidates: ImageCandidate[] };
  export function nextPendingIndex(picks: PendingPick[], done: Set<string>, from: number): number | null;
  export function ImagePickWizard({ picks, open, onOpenChange, onAllDone }: { picks: PendingPick[]; open: boolean; onOpenChange: (v: boolean) => void; onAllDone: () => void }): JSX.Element;
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/image-pick-wizard.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { nextPendingIndex, type PendingPick } from "@/components/queue/image-pick-wizard";

const picks: PendingPick[] = [
  { articleId: "a", title: "Alpha", currentImageUrl: null, candidates: [] },
  { articleId: "b", title: "Bravo", currentImageUrl: null, candidates: [] },
  { articleId: "c", title: "Charlie", currentImageUrl: null, candidates: [] },
];

describe("nextPendingIndex", () => {
  it("avance jusqu'au prochain non traité", () => {
    expect(nextPendingIndex(picks, new Set(["a"]), 0)).toBe(1);
  });
  it("saute plusieurs déjà traités", () => {
    expect(nextPendingIndex(picks, new Set(["a", "b"]), 0)).toBe(2);
  });
  it("renvoie null quand tout est traité", () => {
    expect(nextPendingIndex(picks, new Set(["a", "b", "c"]), 0)).toBeNull();
  });
  it("boucle sur le début pour rattraper un « Passer »", () => {
    expect(nextPendingIndex(picks, new Set(["c"]), 2)).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/image-pick-wizard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the component**

Create `components/queue/image-pick-wizard.tsx`:

```tsx
"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { pickRegeneratedImage } from "@/lib/actions/regen-actions";
import type { ImageCandidate } from "@/db";

export type PendingPick = {
  articleId: string; title: string; currentImageUrl: string | null; candidates: ImageCandidate[];
};

/**
 * PUR — index du prochain article encore à traiter, en repartant de `from` et en BOUCLANT sur le
 * début : c'est ce qui rattrape les articles « Passés » plus tôt dans la session, plutôt que de
 * terminer l'assistant en les laissant silencieusement de côté. Renvoie null quand tout est traité.
 */
export function nextPendingIndex(picks: PendingPick[], done: Set<string>, from: number): number | null {
  for (let k = 0; k < picks.length; k += 1) {
    const i = (from + k) % picks.length;
    if (!done.has(picks[i].articleId)) return i;
  }
  return null;
}

/**
 * Parcourt un par un les articles dont une régénération en mode manuel a garé des candidats.
 * Le fermer ne perd RIEN : la source de vérité est articles.pending_image_candidates (le bac), pas
 * l'état de ce composant — un article « Passé » réapparaîtra au prochain lancement.
 */
export function ImagePickWizard({ picks, open, onOpenChange, onAllDone }: {
  picks: PendingPick[]; open: boolean; onOpenChange: (v: boolean) => void; onAllDone: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const current = picks[index];
  const remaining = picks.length - done.size;

  function advance(articleId: string, markDone: boolean) {
    const nextDone = markDone ? new Set(done).add(articleId) : done;
    setDone(nextDone);
    const next = nextPendingIndex(picks, nextDone, index + 1);
    if (next === null) { onOpenChange(false); onAllDone(); return; }
    setIndex(next);
  }

  async function choose(candidate: ImageCandidate | null) {
    if (!current || busy) return;
    setBusy(true);
    try {
      const r = await pickRegeneratedImage(current.articleId, candidate === null ? null : {
        url: candidate.url, credit: candidate.mediaName, sourceUrl: candidate.sourceUrl,
      });
      if (!r.ok) { toast.error(r.message); return; }
      advance(current.articleId, true);
    } finally { setBusy(false); }
  }

  if (!current) return <></>;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Choisir l&apos;image à la une</DialogTitle>
          <DialogDescription>
            {current.title} — {picks.length - remaining + 1}/{picks.length}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-[200px_1fr]">
          <div className="space-y-1">
            <p className="text-sm font-medium">Image actuelle</p>
            {current.currentImageUrl
              // eslint-disable-next-line @next/next/no-img-element -- URLs distantes arbitraires, non optimisables
              ? <img src={current.currentImageUrl} alt="" className="w-full rounded border object-cover" />
              : <p className="text-sm text-muted-foreground">Aucune</p>}
          </div>
          <div className="grid max-h-96 grid-cols-2 gap-2 overflow-y-auto lg:grid-cols-3">
            {current.candidates.map((c) => (
              <button
                key={c.url} type="button" disabled={busy} onClick={() => void choose(c)}
                className="group overflow-hidden rounded border text-left hover:ring-2 hover:ring-primary disabled:opacity-50"
                title={`${c.mediaName} — ${c.url}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- idem */}
                <img src={c.url} alt="" className="aspect-video w-full object-cover" />
                <span className="block truncate px-1 py-0.5 text-xs text-muted-foreground">{c.mediaName}</span>
              </button>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => advance(current.articleId, false)}>Passer</Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void choose(null)}>Aucune image</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/image-pick-wizard.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Mount the entry point**

In `components/queue/queue-table.tsx`, above the table, when any visible row has `pendingImageCount > 0`:

```tsx
      {pendingPicks.length > 0 && (
        <Button type="button" variant="secondary" size="sm" onClick={() => setWizardOpen(true)}>
          Choisir les images ({pendingPicks.length})
        </Button>
      )}
      <ImagePickWizard picks={pendingPicks} open={wizardOpen} onOpenChange={setWizardOpen} onAllDone={() => router.refresh()} />
```

`pendingPicks` needs the full candidate lists, which `getQueue` does not project. Add them: in `lib/queries/queue.ts` include `pendingImageCandidates` in the mapped `QueueRow` (`pendingImageCandidates: (r.pendingImageCandidates ?? []) as ImageCandidate[]`), then in the table:

```tsx
  const pendingPicks: PendingPick[] = rows
    .filter((r) => r.pendingImageCandidates.length > 0)
    .map((r) => ({ articleId: r.id, title: r.title, currentImageUrl: r.imageUrl, candidates: r.pendingImageCandidates }));
```

- [ ] **Step 6: Add to the pure lane, typecheck, run**

Add `"image-pick-wizard.test.ts",` to `PURE_FILES`.

Run: `bunx tsc --noEmit && bun run test:pure`
Expected: no type errors, PASS.

- [ ] **Step 7: Commit**

```bash
git add components/queue/image-pick-wizard.tsx components/queue/queue-table.tsx lib/queries/queue.ts tests/image-pick-wizard.test.ts scripts/test-fast.ts
git commit -m "feat(queue): assistant de choix des images candidates"
```

---

### Task 19: radio auto/manuel dans les deux dialogues

**Files:**
- Modify: `components/article/regenerate-dialog.tsx`, `components/queue/bulk-regenerate-dialog.tsx`
- Modify: `app/(app)/article/[id]/page.tsx` and `app/(app)/queue/page.tsx` (pass the default down)

**Interfaces:**
- Consumes: `PipelineSettings.regenerateImageMode` (Task 12), `startRegenJob`'s `imageMode` (Task 9).
- Produces: `RegenerateDialog` and `BulkRegenerateDialog` both gain a required prop `defaultImageMode: "auto" | "manual"`; `BulkRegenerateDialog`'s `onConfirm` becomes `(fields: RegenerateFieldsInput, imageMode: "auto" | "manual") => void`.

- [ ] **Step 1: Add the control to both dialogs**

In each dialog, add state and the radio, shown only when `fields.image` is checked:

```tsx
  const [imageMode, setImageMode] = useState<"auto" | "manual">(defaultImageMode);
```

and, immediately under the checkbox list:

```tsx
        {fields.image && (
          <fieldset className="space-y-1 rounded border p-2">
            <legend className="px-1 text-sm font-medium">Choix de l&apos;image</legend>
            {([["auto", "L'IA choisit parmi les images trouvées"], ["manual", "Je choisis moi-même (depuis la file)"]] as const).map(([value, label]) => (
              <Label key={value} htmlFor={`${idPrefix}-mode-${value}`} className="flex cursor-pointer items-center gap-2 font-normal">
                <input
                  id={`${idPrefix}-mode-${value}`} type="radio" name={`${idPrefix}-mode`}
                  checked={imageMode === value} onChange={() => setImageMode(value)}
                />
                {label}
              </Label>
            ))}
          </fieldset>
        )}
```

Use `idPrefix = "regen"` in the single dialog and `"bulk-regen"` in the bulk one, matching their existing checkbox id conventions. Reset `imageMode` to `defaultImageMode` in each dialog's existing `handleOpenChange` close branch, alongside the `setFields(ALL_CHECKED)` it already does.

- [ ] **Step 2: Thread it through**

- `RegenerateDialog.handleConfirm`: pass `imageMode` to `startRegenJob` (replacing the literal `"auto"` from Task 11).
- `BulkRegenerateDialog.handleConfirm`: `onConfirm(fields, imageMode)`.
- `bulk-action-bar.tsx`: `runRegenerate(fields, imageMode)` already takes the second parameter from Task 11; forward it and add `defaultImageMode` to the props it passes down.
- Both pages: read the setting server-side and pass it in:

```tsx
  const settings = await getPipelineSettings();
  // ...
  defaultImageMode={settings.regenerateImageMode as "auto" | "manual"}
```

with `import { getPipelineSettings } from "@/lib/queries/settings";`. In `app/(app)/queue/page.tsx` the prop travels `QueueView` → `QueueTable` → `BulkActionBar` → `BulkRegenerateDialog`; add it to each component's props type along the way.

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: End-to-end verification in the browser**

Start the dev server via the preview tool and check both flows:

1. `/queue` → select 2 articles → « Renvoyer à l'IA » → check only « Image à la une » → choose « Je choisis moi-même » → confirm.
   Expected: progress advances, no full generation, and on completion the toast reads « … 2 images à choisir ».
2. Reload `/queue`, set the image filter to « Images à choisir ».
   Expected: exactly those 2 articles, each with a « N à choisir » badge, and a « Choisir les images (2) » button.
3. Click it, pick a thumbnail on the first, « Passer » on the second.
   Expected: the wizard closes after looping back to the skipped one; the article that got a pick shows the new thumbnail and no badge; the skipped one keeps its badge.
4. Single article page → « Renvoyer à l'IA » → « Image à la une » only → « L'IA choisit » → confirm.
   Expected: a progress strip showing « Extraction des sources » then « Génération IA », finishing in far less time than a full regeneration.

- [ ] **Step 5: Full test suite**

Run: `bun test`
Expected: PASS. This is the canonical suite and it hits the shared Neon dev DB — if a failure looks unrelated to this work, re-run that single file alone before treating it as a regression.

- [ ] **Step 6: Commit**

```bash
git add components/article/regenerate-dialog.tsx components/queue/bulk-regenerate-dialog.tsx components/queue/bulk-action-bar.tsx components/queue/queue-table.tsx "app/(app)/article/[id]/page.tsx" "app/(app)/queue/page.tsx"
git commit -m "feat(regenerate): surcharge auto/manuel du choix d'image par exécution"
```

---

## Self-review notes

- **Spec coverage:** every spec section maps to a task — data model (5, 12, 13), async job (5-11), image modes (12, 14, 15), tray/wizard (17, 18), mode configuration (12, 19), the two problem-2 fixes (1, 3, 4), testing (throughout, with the regression test in Task 4).
- **`awaitingImage`** is declared on `regenerateArticle`'s return type in Task 8 but only produced in Task 15; the runner reads it defensively (`r.awaitingImage ? …`), so Phase 2 is correct on its own.
- **`imageMode`** is added to `regenerateArticle`'s `opts` in Task 8 (unused) and consumed in Task 15, so `runRegenJob` never needs rewriting.
- **`planRegeneration`** deliberately gains its third input in Task 14 rather than being stubbed with dead branches in Task 2 — Phase 1 ships an honest two-action version.
