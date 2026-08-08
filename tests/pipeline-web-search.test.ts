import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  db, articles, articleSources, clusters, feeds, rawItems, pipelineRuns, pipelineSteps, pipelineSettings,
} from "@/db";
import { eq, inArray } from "drizzle-orm";
import { openRun, executeRun } from "@/lib/pipeline/run";
import { extractExternal, hasExternalExtractor } from "@/lib/extract";
import { ITEM_STAGES } from "@/lib/pipeline/live";

// ─────────────────────────────────────────────────────────────────────────────
// SP4 Task 6b — web-search augmentation of the per-story runner (lib/pipeline/run.ts). Real Neon
// dev DB, network-free: every external call this file could trigger is intercepted by ONE
// monkeypatched global.fetch (same technique as tests/extract-chain.test.ts), so nothing here ever
// touches the real internet:
//   - "http://localhost:*" (the RSS feed fixture, a REAL local Bun.serve server) is passed through
//     to the real fetch — loopback only, like every other pipeline test;
//   - "https://r.jina.ai/<url>" (jina reader — the EXTERNAL fetcher used here for BOTH member and
//     web-source extraction, since JINA_API_KEY is set) returns canned markdown keyed on the
//     wrapped URL, or a too-short body (forcing jinaExtract to throw) for a URL in
//     `jinaShouldFailFor`;
//   - "https://api.search.brave.com/…" (searchRelated's Brave provider) returns a canned Web
//     Search JSON body built from the test's `braveHits`;
//   - "https://api.jina.ai/…" (the EMBEDDINGS provider — also gated by JINA_API_KEY, since
//     lib/config/pipeline-config.ts falls the embed key back to JINA_API_KEY when EMBED_API_KEY is
//     unset) gets a 401 so embed() falls back cleanly to its own deterministic mock;
//   - anything else is a DIRECT, unwrapped fetch of a bare URL (readability, or the full chain's
//     raw-fetch image backfill after a member's jina success) — the SSRF-guard test (d) asserts
//     the web hit's raw URL never appears in that bucket.
//
// Member and web-source URLs use a random per-run tag so a prior crashed run's leftover raw_items
// row can never make a fresh run's candidate look "already seen" (the same trick a fresh
// Bun.serve({port:0}) URL gives other pipeline tests for free — these fixtures don't need a real
// backing server, since jina interception handles their "extraction" without ever touching them).

const RUN_TAG = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const PROVIDER_KEYS = [
  "FIRECRAWL_API_KEY", "OPENROUTER_API_KEY", "OMNIROUTE_API_KEY",
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY",
  "EMBED_API_KEY", "EMBED_BASE_URL", "EXTRACT_ORDER",
] as const;

function snapshotEnv(keys: readonly string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((k) => [k, process.env[k]]));
}
function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const JINA_READER_PREFIX = "https://r.jina.ai/";
const BRAVE_PREFIX = "https://api.search.brave.com/";
const JINA_EMBED_PREFIX = "https://api.jina.ai/";

function makeMarkdown(originalUrl: string): string {
  return (
    `# Contenu externe\n` +
    `Texte détaillé correspondant à ${originalUrl}, suffisamment long pour dépasser le seuil minimal exigé par Jina Reader. `.repeat(4)
  );
}

describe("executeRun — web-search augmentation (SP4 Task 6b)", () => {
  const envSnap = snapshotEnv([...PROVIDER_KEYS, "JINA_API_KEY", "BRAVE_SEARCH_API_KEY"]);
  let settingsSnapshot: typeof pipelineSettings.$inferSelect | undefined;
  let originalFetch: typeof fetch;
  let fetchCalls: string[] = [];
  let braveHits: { title: string; url: string; description: string }[] = [];
  let jinaShouldFailFor: Set<string> = new Set();

  beforeAll(async () => {
    for (const k of PROVIDER_KEYS) delete process.env[k];
    process.env.EXTRACT_ORDER = "jina,firecrawl,readability";
    process.env.JINA_API_KEY = "test-jina-key";
    process.env.BRAVE_SEARCH_API_KEY = "test-brave-key";

    [settingsSnapshot] = await db.select().from(pipelineSettings).where(eq(pipelineSettings.id, 1));

    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      fetchCalls.push(url);

      if (url.startsWith("http://localhost:")) return originalFetch(input, init);
      if (url.startsWith(JINA_EMBED_PREFIX)) return new Response("unauthorized", { status: 401 });
      if (url.startsWith(JINA_READER_PREFIX)) {
        const original = url.slice(JINA_READER_PREFIX.length);
        if (jinaShouldFailFor.has(original)) return new Response("trop court", { status: 200 });
        return new Response(makeMarkdown(original), { status: 200 });
      }
      if (url.startsWith(BRAVE_PREFIX)) {
        return new Response(JSON.stringify({ web: { results: braveHits } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      // A DIRECT, unwrapped fetch of a bare URL — acceptable for a MEMBER source (the full chain's
      // raw-fetch image backfill after jina succeeds with images:[]), but the SSRF-guard test
      // below asserts the web hit's own bare URL never lands here.
      return new Response("<html><body></body></html>", { status: 200, headers: { "content-type": "text/html" } });
    }) as typeof fetch;
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    restoreEnv(envSnap);
    await db.delete(pipelineSettings).where(eq(pipelineSettings.id, 1));
    if (settingsSnapshot) await db.insert(pipelineSettings).values(settingsSnapshot);
  });

  async function setWebSearchEnabled(enabled: boolean): Promise<void> {
    await db.delete(pipelineSettings).where(eq(pipelineSettings.id, 1));
    await db.insert(pipelineSettings).values({ id: 1, webSearchEnabled: enabled, maxItemsPerRun: 20, clusterThreshold: 0.83 });
  }

  async function makeFeed(label: string, itemUrl: string, itemTitle: string, description = `Résumé de l'article pour ${label}.`) {
    // description="" gives the RSS item an EMPTY contentSnippet — scenario (f) uses this so a
    // member whose extraction also yields empty text has NO snippet to fall back on, making the
    // member (and thus the whole story) genuinely source-less.
    const rss = Bun.serve({
      port: 0,
      fetch: () => new Response(
        `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture ${label}</title>
         <item><title>${itemTitle}</title><link>${itemUrl}</link>
         <guid>test:web-search:${label}:${RUN_TAG}</guid>
         <description>${description}</description></item>
         </channel></rss>`,
        { headers: { "content-type": "application/xml" } },
      ),
    });
    const [f] = await db.insert(feeds).values({
      name: `Fixture web-search ${label} ${RUN_TAG}`, feedUrl: `http://localhost:${rss.port}/feed`, active: true,
    }).returning({ id: feeds.id });
    return { feedId: f.id, stop: () => rss.stop(true) };
  }

  async function cleanupStory(runId: string | null, feedId: string, urls: string[]): Promise<void> {
    const srcRows = await db.select({ articleId: articleSources.articleId }).from(articleSources).where(inArray(articleSources.url, urls));
    const articleIds = [...new Set(srcRows.map((r) => r.articleId))];
    let clusterIds: string[] = [];
    if (articleIds.length > 0) {
      const staged = await db.select({ clusterId: articles.clusterId }).from(articles).where(inArray(articles.id, articleIds));
      clusterIds = [...new Set(staged.map((a) => a.clusterId).filter((c): c is string => c !== null))];
      await db.delete(articles).where(inArray(articles.id, articleIds)); // cascades sources/embeddings/tags
    }
    for (const clusterId of clusterIds) {
      const stillUsed = await db.select({ id: articles.id }).from(articles).where(eq(articles.clusterId, clusterId)).limit(1);
      if (stillUsed.length === 0) await db.delete(clusters).where(eq(clusters.id, clusterId));
    }
    await db.delete(rawItems).where(eq(rawItems.feedId, feedId));
    if (runId) await db.delete(pipelineRuns).where(eq(pipelineRuns.id, runId)); // cascades pipeline_steps
    await db.delete(feeds).where(eq(feeds.id, feedId));
  }

  it("(a) adds a web source alongside the member source when enabled + a hit + external extraction succeed", async () => {
    const MEMBER_URL = `https://member-a-${RUN_TAG}.example.com/article`;
    const WEB_HIT_URL = `https://web-hit-a-${RUN_TAG}.example.com/coverage`;
    fetchCalls = [];
    jinaShouldFailFor = new Set();
    braveHits = [{ title: "Couverture externe A", url: WEB_HIT_URL, description: "Un extrait de couverture externe." }];
    await setWebSearchEnabled(true);
    const { feedId, stop } = await makeFeed("a", MEMBER_URL, "Une histoire régionale majeure A");
    let runId: string | null = null;
    try {
      runId = await openRun({ triggeredBy: "manual", feedsTotal: 1 });
      expect(runId).not.toBeNull();
      const res = await executeRun(runId!, { feedIds: [feedId] });
      expect(res.status).toBe("success");
      expect(res.produced).toBe(1);

      // The story's article now has TWO article_sources rows: the member AND the web hit.
      const srcs = await db.select().from(articleSources).where(inArray(articleSources.url, [MEMBER_URL, WEB_HIT_URL]));
      expect(srcs.length).toBe(2);
      const webRow = srcs.find((s) => s.url === WEB_HIT_URL);
      expect(webRow).toBeDefined();
      expect(webRow!.mediaName).toBe(new URL(WEB_HIT_URL).hostname); // hostname label, per spec

      // Score reflects the (now 2-source) uniqueSources.length — computeArticleScore is fed
      // uniqueSources.length verbatim in stageSources, so this is a structural guarantee, not a
      // fragile numeric assertion (bestScore/confidence vary with the shared dev DB's clusters).
      const [article] = await db.select().from(articles).where(eq(articles.id, srcs[0].articleId));
      expect(article.score).not.toBeNull();
      expect(article.status).toBe("pending");

      const steps = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, runId!));
      const webStep = steps.find((s) => s.name === "Recherche web");
      expect(webStep).toBeDefined();
      expect(webStep!.status).toBe("success");
      expect(webStep!.errorMessage).toBe("1 source(s) web ajoutée(s).");
      // Not one of the 5 stepper stages — an extra journal line only.
      expect(ITEM_STAGES as readonly string[]).not.toContain("Recherche web");

      // SSRF proof (also see the dedicated (d) test below and the standalone extract() unit
      // tests): the web hit was fetched ONLY via the jina reader wrapper, never directly.
      expect(fetchCalls).toContain(`${JINA_READER_PREFIX}${WEB_HIT_URL}`);
      expect(fetchCalls).not.toContain(WEB_HIT_URL);
    } finally {
      await cleanupStory(runId, feedId, [MEMBER_URL, WEB_HIT_URL]);
      stop();
    }
  }, 20000);

  it("(b) adds no web sources and behaves like 6a when webSearchEnabled=false", async () => {
    const MEMBER_URL = `https://member-b-${RUN_TAG}.example.com/article`;
    fetchCalls = [];
    braveHits = []; // must never even be reached
    await setWebSearchEnabled(false);
    const { feedId, stop } = await makeFeed("b", MEMBER_URL, "Une histoire régionale majeure B");
    let runId: string | null = null;
    try {
      runId = await openRun({ triggeredBy: "manual", feedsTotal: 1 });
      const res = await executeRun(runId!, { feedIds: [feedId] });
      expect(res.status).toBe("success");
      expect(res.produced).toBe(1);

      const srcs = await db.select().from(articleSources).where(eq(articleSources.url, MEMBER_URL));
      expect(srcs.length).toBe(1); // member only — no web augmentation

      const steps = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, runId!));
      expect(steps.some((s) => s.name === "Recherche web")).toBe(false); // no extra journal line at all
      expect(fetchCalls.some((u) => u.startsWith(BRAVE_PREFIX))).toBe(false); // searchRelated never even called
    } finally {
      await cleanupStory(runId, feedId, [MEMBER_URL]);
      stop();
    }
  }, 20000);

  it("(c) skips a web hit whose external extraction fails — the story still succeeds with member sources only", async () => {
    const MEMBER_URL = `https://member-c-${RUN_TAG}.example.com/article`;
    const WEB_HIT_URL = `https://web-hit-c-${RUN_TAG}.example.com/coverage`;
    fetchCalls = [];
    jinaShouldFailFor = new Set([WEB_HIT_URL]); // jina returns a too-short body → jinaExtract throws
    braveHits = [{ title: "Couverture externe C", url: WEB_HIT_URL, description: "Extrait." }];
    await setWebSearchEnabled(true);
    const { feedId, stop } = await makeFeed("c", MEMBER_URL, "Une histoire régionale majeure C");
    let runId: string | null = null;
    try {
      runId = await openRun({ triggeredBy: "manual", feedsTotal: 1 });
      const res = await executeRun(runId!, { feedIds: [feedId] });
      expect(res.status).toBe("success"); // a failed web source never fails the story
      expect(res.produced).toBe(1);

      const srcs = await db.select().from(articleSources).where(inArray(articleSources.url, [MEMBER_URL, WEB_HIT_URL]));
      expect(srcs.length).toBe(1);
      expect(srcs[0].url).toBe(MEMBER_URL);

      const steps = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, runId!));
      const webStep = steps.find((s) => s.name === "Recherche web");
      expect(webStep?.status).toBe("success"); // the search/augmentation step itself did not fail
      expect(webStep?.errorMessage).toBe("0 source(s) web ajoutée(s).");
    } finally {
      await cleanupStory(runId, feedId, [MEMBER_URL, WEB_HIT_URL]);
      stop();
    }
  }, 20000);

  it("(d) SSRF guard: the web hit's raw URL is never fetched directly — only via the external (jina) path", async () => {
    const MEMBER_URL = `https://member-d-${RUN_TAG}.example.com/article`;
    const WEB_HIT_URL = `https://web-hit-d-${RUN_TAG}.example.com/coverage`;
    fetchCalls = [];
    jinaShouldFailFor = new Set();
    braveHits = [{ title: "Couverture externe D", url: WEB_HIT_URL, description: "Extrait." }];
    await setWebSearchEnabled(true);
    const { feedId, stop } = await makeFeed("d", MEMBER_URL, "Une histoire régionale majeure D");
    let runId: string | null = null;
    try {
      runId = await openRun({ triggeredBy: "manual", feedsTotal: 1 });
      await executeRun(runId!, { feedIds: [feedId] });

      // The decisive SSRF assertion: our server never issued a bare fetch(WEB_HIT_URL) — every
      // request touching that URL went through the jina reader wrapper (external infra fetches
      // it, not us). Complemented by the standalone extract()/extractExternal() unit tests below,
      // which prove the SAME guarantee at the extract-chain level (readability filtered out of
      // the provider order entirely, not merely "tried and skipped").
      expect(fetchCalls).not.toContain(WEB_HIT_URL);
      expect(fetchCalls).toContain(`${JINA_READER_PREFIX}${WEB_HIT_URL}`);
    } finally {
      await cleanupStory(runId, feedId, [MEMBER_URL, WEB_HIT_URL]);
      stop();
    }
  }, 20000);

  it("(e) does not duplicate a web hit whose URL matches a member's URL", async () => {
    // Deliberately reused as BOTH the member's URL and the web hit's URL.
    const MEMBER_URL = `https://member-e-${RUN_TAG}.example.com/article`;
    fetchCalls = [];
    jinaShouldFailFor = new Set();
    braveHits = [{ title: "Même histoire, autre moteur de recherche", url: MEMBER_URL, description: "Extrait." }];
    await setWebSearchEnabled(true);
    const { feedId, stop } = await makeFeed("e", MEMBER_URL, "Une histoire régionale majeure E");
    let runId: string | null = null;
    try {
      runId = await openRun({ triggeredBy: "manual", feedsTotal: 1 });
      const res = await executeRun(runId!, { feedIds: [feedId] });
      expect(res.status).toBe("success");

      const srcs = await db.select().from(articleSources).where(eq(articleSources.url, MEMBER_URL));
      expect(srcs.length).toBe(1); // deduped — no second row for the same URL

      const steps = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, runId!));
      const webStep = steps.find((s) => s.name === "Recherche web");
      expect(webStep?.errorMessage).toBe("0 source(s) web ajoutée(s).");
      // The member's URL was already fetched via jina for member extraction; make sure that
      // wasn't double-counted as a "web-search extraction" call for the SAME url a second time.
      // TWO calls are the expected truth (still 2 after pipeline completeness Task 4b's per-source
      // origin marking, though the SECOND call's mechanism changed): (1) the initial member
      // extraction (lib/pipeline/run.ts's member loop, always the raw extract()); (2) the
      // "Vérification & complétion" stage's repairDraft fallback, which re-extracts every unique
      // source when génération produced no candidate image (the case here — the fixture markdown
      // has none). This member source carries `origin: "feed"` (Task 4b), so repairDraft now picks
      // `extract` (raw, backfill included) rather than `extractExternal` for it — but `extract`
      // still calls jina FIRST, so the jina hit count for this URL is unchanged at 2; what DID
      // change (untested here) is that the fallback's own raw-fetch image backfill now also runs a
      // SECOND time (once per full extract() call) since it's no longer routed through
      // extractExternal's externalOnly mode. The ORIGINAL concern this assertion guards against —
      // the web hit (same URL as the member) being extracted as if it were a SEPARATE, distinct web
      // source — is still disproved: 2, not 3.
      const jinaCallsForUrl = fetchCalls.filter((u) => u === `${JINA_READER_PREFIX}${MEMBER_URL}`);
      expect(jinaCallsForUrl.length).toBe(2);
    } finally {
      await cleanupStory(runId, feedId, [MEMBER_URL]);
      stop();
    }
  }, 20000);

  it("(f) web cannot rescue a zero-member story: when ALL members' extraction fails, the story FAILS even with web hits available", async () => {
    // Member extraction is engineered to yield NO usable text: jina returns a too-short body (→
    // throws), firecrawl is unconfigured, and the readability fallback direct-fetches the member
    // URL to an EMPTY document — combined with an empty RSS description (no snippet fallback), the
    // member contributes zero sources. A valid Brave hit IS available, proving the failure is the
    // corrected semantics (web is enrichment, not rescue), not merely "no hit to add".
    const MEMBER_URL = `https://member-f-${RUN_TAG}.example.com/article`;
    const WEB_HIT_URL = `https://web-hit-f-${RUN_TAG}.example.com/coverage`;
    fetchCalls = [];
    jinaShouldFailFor = new Set([MEMBER_URL]); // member's jina extraction throws (too-short body)
    braveHits = [{ title: "Couverture externe F", url: WEB_HIT_URL, description: "Un extrait qui NE doit PAS sauver l'histoire." }];
    await setWebSearchEnabled(true);
    const { feedId, stop } = await makeFeed("f", MEMBER_URL, "Une histoire régionale majeure F", ""); // empty description → empty snippet
    let runId: string | null = null;
    try {
      runId = await openRun({ triggeredBy: "manual", feedsTotal: 1 });
      const res = await executeRun(runId!, { feedIds: [feedId] });

      // The story failed — web did NOT rescue it.
      expect(res.status).toBe("failed");
      expect(res.produced).toBe(0);

      // No article was staged from web coverage alone.
      const srcs = await db.select().from(articleSources).where(inArray(articleSources.url, [MEMBER_URL, WEB_HIT_URL]));
      expect(srcs.length).toBe(0);

      const steps = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, runId!));
      // The extraction step is FAILED, exactly as in 6a for a source-less story.
      const extractStep = steps.find((s) => s.name === "Extraction du contenu");
      expect(extractStep?.status).toBe("failed");
      // Web augmentation was never even attempted for the zero-member story.
      expect(steps.some((s) => s.name === "Recherche web")).toBe(false);
      // searchRelated() was never reached — Brave was not called, and the web hit URL was never
      // fetched (not even via the jina reader).
      expect(fetchCalls.some((u) => u.startsWith(BRAVE_PREFIX))).toBe(false);
      expect(fetchCalls).not.toContain(`${JINA_READER_PREFIX}${WEB_HIT_URL}`);
    } finally {
      await cleanupStory(runId, feedId, [MEMBER_URL, WEB_HIT_URL]);
      stop();
    }
  }, 20000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Focused unit tests on the SSRF guard itself, independent of the runner: extract(url,
// {externalOnly:true}) (and its extractExternal() wrapper) must skip readability ENTIRELY — never
// attempt it, never issue a direct fetch — even when no jina/firecrawl key is configured and
// readability WOULD otherwise succeed against the very same URL.
describe("extract externalOnly / extractExternal — SSRF guard (SP4 Task 6b)", () => {
  const original = {
    EXTRACT_ORDER: process.env.EXTRACT_ORDER,
    JINA_API_KEY: process.env.JINA_API_KEY,
    FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY,
  };
  let originalFetch: typeof fetch;
  let directFetchCalled = false;

  beforeAll(() => {
    process.env.EXTRACT_ORDER = "jina,firecrawl,readability";
    delete process.env.JINA_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      directFetchCalled = true;
      // If this DID get called, prove readability would have succeeded — i.e. a real regression
      // (readability silently invoked despite externalOnly), not an accidental network failure
      // masking the bug.
      return new Response(
        `<html><body><article><p>${"contenu de test ".repeat(30)}</p></article></body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }) as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("extract(url, {externalOnly:true}) returns via='none' and calls fetch() ZERO times when no external provider is configured", async () => {
    const r = await extractExternal("https://untrusted.example.com/article");
    expect(r.via).toBe("none");
    expect(r.text).toBe("");
    expect(directFetchCalled).toBe(false); // readability (a direct fetch) was never attempted
    // "readability" doesn't even appear in attempts — it was FILTERED OUT of the provider order,
    // not attempted-and-skipped, which is the load-bearing distinction for the SSRF guarantee.
    expect(r.attempts).toEqual([
      { provider: "jina", ok: false, reason: "pas de clé Jina" },
      { provider: "firecrawl", ok: false, reason: "pas de clé Firecrawl" },
    ]);
  });

  it("extractExternal() is the same guarded path as extract(url, {externalOnly:true}) (thin wrapper)", async () => {
    const r = await extractExternal("https://untrusted.example.com/article2");
    expect(r.via).toBe("none");
    expect(directFetchCalled).toBe(false);
  });
});

describe("hasExternalExtractor (SP4 Task 6b)", () => {
  const original = {
    JINA_API_KEY: process.env.JINA_API_KEY,
    FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY,
    EXTRACT_ORDER: process.env.EXTRACT_ORDER,
  };

  beforeAll(() => { process.env.EXTRACT_ORDER = "jina,firecrawl,readability"; });

  afterAll(() => {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("is false when neither jina nor firecrawl is configured, true when either alone is (both in EXTRACT_ORDER)", () => {
    delete process.env.JINA_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;
    expect(hasExternalExtractor()).toBe(false);

    process.env.JINA_API_KEY = "k";
    expect(hasExternalExtractor()).toBe(true);

    delete process.env.JINA_API_KEY;
    process.env.FIRECRAWL_API_KEY = "k";
    expect(hasExternalExtractor()).toBe(true);
  });

  it("is false when keys are set but EXTRACT_ORDER excludes both external providers (FINDING 3)", () => {
    // Keys present, but the operator pinned EXTRACT_ORDER to readability only → extractExternal()
    // would filter the order down to nothing and no-op per hit. hasExternalExtractor() must return
    // false so the runner skips web augmentation cleanly instead of wasting a Brave call.
    process.env.JINA_API_KEY = "k";
    process.env.FIRECRAWL_API_KEY = "k";
    process.env.EXTRACT_ORDER = "readability";
    expect(hasExternalExtractor()).toBe(false);

    // A partial order (only jina enabled) with both keys set → true via the enabled provider.
    process.env.EXTRACT_ORDER = "jina,readability";
    expect(hasExternalExtractor()).toBe(true);

    // Only firecrawl enabled → true.
    process.env.EXTRACT_ORDER = "readability,firecrawl";
    expect(hasExternalExtractor()).toBe(true);
  });
});
