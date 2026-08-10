import { describe, it, test, expect, beforeAll, afterAll, afterEach, beforeEach, mock, spyOn } from "bun:test";
import { db, articles, wpCategories, socialChannelSettings, distributions } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { SOCIAL_CHANNELS } from "@/lib/diffusion/channels";
import { getChannelSettings, updateChannelSettingsCore } from "@/lib/diffusion/settings-core";

// This channel is this file's EXCLUSIVE static social_channel_settings scope — see the disjoint-
// scope convention documented in tests/studio-fixtures.ts and followed informally by
// tests/diffusion-settings.test.ts (tiktok/facebook/instagram there; "whatsapp" is untouched by
// that file, and by every other diffusion-*.test.ts, at the time of writing).
const TEST_CHANNEL = "whatsapp" as const;

// Same leak-safe mock.module() pattern as tests/ai-improve.test.ts: capture the REAL
// implementations BEFORE mocking, mock "ai" + "@/lib/ai/providers" via a stable indirection, and
// restore that indirection in afterAll so files that run afterwards see real behavior again.
const { buildModel: realBuildModel } = await import("@/lib/ai/providers");
const { generateText: realGenerateText } = await import("ai");

let buildModelImpl: (name: string, cfg: unknown) => unknown = realBuildModel as unknown as typeof buildModelImpl;
let generateTextImpl: (opts: { model: { name: string }; prompt: string }) => Promise<{ text: string }> =
  realGenerateText as unknown as typeof generateTextImpl;

mock.module("@/lib/ai/providers", () => ({
  buildModel: (name: string, cfg: unknown) => buildModelImpl(name, cfg),
}));
mock.module("ai", () => ({
  generateText: (opts: { model: { name: string }; prompt: string }) => generateTextImpl(opts),
}));

// Imported AFTER the mocks are registered so its static imports resolve to the mocks.
const { generateCaption, truncateCaption, buildCaptionPrompt } = await import("@/lib/diffusion/caption");

describe("truncateCaption (pure, word-boundary truncation)", () => {
  // Hand-computed boundary: "alpha beta gamma" is EXACTLY 16 chars, and character 16 of the full
  // string (index 16) is the space right after "gamma" — i.e. cutting at budget=16 lands ON a word
  // boundary, not mid-word. A naive "always back up to the previous space" implementation would
  // incorrectly drop "gamma" here too; this is the case that catches that bug.
  const text = "alpha beta gamma delta epsilon zeta eta theta";

  it("returns the text unchanged when it already fits", () => {
    expect(truncateCaption("Court.", 50)).toBe("Court.");
  });

  it("keeps a COMPLETE final word when the budget lands exactly on a space", () => {
    // budget = maxChars - 1 (ellipsis) = 16, and text[16] === " " (verified above).
    const result = truncateCaption(text, 17);
    expect(result).toBe("alpha beta gamma…");
    expect(result.length).toBe(17);
  });

  it("backs off to the PREVIOUS space when the budget lands mid-word", () => {
    // budget = 15 - 1 = 14, and text[14] === "m" (mid "gamma") — must NOT ship "alpha beta gam…".
    const result = truncateCaption(text, 15);
    expect(result).toBe("alpha beta…");
    expect(result.length).toBeLessThanOrEqual(15);
    expect(result).not.toContain("gam…"); // proves the mid-word slice was discarded, not kept
  });

  it("never exceeds maxChars, for a range of limits", () => {
    for (const max of [5, 10, 11, 16, 17, 18, 30, 100]) {
      expect(truncateCaption(text, max).length).toBeLessThanOrEqual(max);
    }
  });

  it("hard-cuts a single word with no spaces at all, still within the limit", () => {
    const oneWord = "a".repeat(500);
    const result = truncateCaption(oneWord, 20);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result.endsWith("…")).toBe(true);
  });

  // D1 final review, "Also fix — cheap": .length/.slice count UTF-16 CODE UNITS, not visible
  // characters — an emoji like 😀 (U+1F600, realistic in an X/Instagram caption) is a SURROGATE
  // PAIR, two code units wide. No spaces anywhere near the cut (deliberately, so the word-boundary
  // backup above can't accidentally paper over a split pair) — this isolates the surrogate-pair
  // fix specifically.
  describe("surrogate pairs (emoji) — never split across a hard cut", () => {
    const emoji = "\u{1F600}"; // 😀, high surrogate 0xD83D + low surrogate 0xDE00
    const text = `${"a".repeat(10)}${emoji}${"b".repeat(50)}`; // emoji occupies code units 10-11

    it("backs up PAST the whole pair when the raw cut would land between its two halves", () => {
      // budget = maxChars - 1 = 11 → a naive slice(0, 11) would end in the pair's lone high
      // surrogate (index 10) without its low surrogate (index 11) — invalid UTF-16.
      const result = truncateCaption(text, 12);
      expect(result.isWellFormed()).toBe(true);
      expect(result).toBe("aaaaaaaaaa…"); // the whole emoji dropped, not half of it
    });

    it("keeps the pair INTACT when the cut lands exactly after it — no over-correction", () => {
      // budget = maxChars - 1 = 12 → slice(0, 12) ends exactly on the pair's low surrogate: a
      // complete pair, nothing to back up from.
      const result = truncateCaption(text, 13);
      expect(result.isWellFormed()).toBe(true);
      expect(result).toBe(`${"a".repeat(10)}${emoji}…`);
    });
  });
});

describe("buildCaptionPrompt", () => {
  it("is French and carries the title, excerpt, category, and the numeric character limit", () => {
    const p = buildCaptionPrompt({
      title: "La BRVM franchit un nouveau record",
      excerpt: "La bourse régionale progresse pour la sixième séance consécutive.",
      category: "Marchés",
      maxChars: 300,
    });
    expect(p).toContain("La BRVM franchit un nouveau record");
    expect(p).toContain("La bourse régionale progresse");
    expect(p).toContain("Marchés");
    expect(p).toContain("300");
    expect(p.toLowerCase()).toContain("légende");
  });

  it("omits excerpt/category lines when absent, without throwing", () => {
    const p = buildCaptionPrompt({ title: "Titre seul", excerpt: null, category: null, maxChars: 100 });
    expect(p).toContain("Titre seul");
    expect(p).not.toContain("Chapô");
    expect(p).not.toContain("Catégorie :");
  });

  it("uses the operator's captionPrompt override instead of the default instruction when provided", () => {
    const withOverride = buildCaptionPrompt({
      title: "T", excerpt: null, category: null, maxChars: 100, promptOverride: "Ton très formel, jamais d'emoji.",
    });
    const withoutOverride = buildCaptionPrompt({ title: "T", excerpt: null, category: null, maxChars: 100 });
    expect(withOverride).toContain("Ton très formel, jamais d'emoji.");
    expect(withOverride).not.toBe(withoutOverride);
  });
});

describe("generateCaption (D1 §3, Task 4)", () => {
  let articleId: string;
  let categoryId: string;
  // Save/restore LLM_ORDER around this describe block — same convention as
  // tests/ai-improve.test.ts:58-70 and tests/ai-fallback.test.ts:73-80. Without this, every `it`
  // below setting process.env.LLM_ORDER = "openrouter" leaks into whichever OTHER test file runs
  // next in this single-process `bun test` run (D1 final review, "Also fix — cheap").
  const originalOrder = process.env.LLM_ORDER;

  beforeAll(async () => {
    await db.delete(socialChannelSettings).where(eq(socialChannelSettings.channel, TEST_CHANNEL));

    const [cat] = await db.insert(wpCategories).values({
      name: "Test Légendes IA", slug: `test-legendes-ia-${Date.now()}`,
    }).returning();
    categoryId = cat.id;

    const [a] = await db.insert(articles).values({
      title: "L'inflation ralentit nettement dans la zone UEMOA ce trimestre",
      bodyHtml: "<p>x</p>",
      excerpt: "Les prix à la consommation reculent pour le troisième mois d'affilée selon la BCEAO.",
      categoryId,
      status: "approved",
    }).returning();
    articleId = a.id;
  });

  afterAll(async () => {
    if (articleId) await db.delete(articles).where(eq(articles.id, articleId));
    if (categoryId) await db.delete(wpCategories).where(eq(wpCategories.id, categoryId));
    await db.delete(socialChannelSettings).where(eq(socialChannelSettings.channel, TEST_CHANNEL));
  });

  beforeEach(() => {
    spyOn(console, "warn").mockImplementation(() => {});
  });

  afterAll(() => {
    buildModelImpl = realBuildModel as unknown as typeof buildModelImpl;
    generateTextImpl = realGenerateText as unknown as typeof generateTextImpl;
    if (originalOrder === undefined) delete process.env.LLM_ORDER;
    else process.env.LLM_ORDER = originalOrder;
    mock.restore();
  });

  it("truncates a deliberately over-long provider response — result never exceeds captionMaxChars", async () => {
    process.env.LLM_ORDER = "openrouter";
    buildModelImpl = (name: string) => ({ name });
    const overLong = "Un marché en pleine effervescence ".repeat(20).trim(); // ~700 chars, way over any channel's default
    generateTextImpl = async () => ({ text: overLong });

    const settings = await getChannelSettings(TEST_CHANNEL);
    const r = await generateCaption({ articleId, channel: TEST_CHANNEL });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.caption.length).toBeLessThanOrEqual(settings.captionMaxChars);
    // Proves REAL truncation happened (not coincidentally already short) and that it happened on a
    // word boundary — composes with truncateCaption's OWN independently hand-verified tests above,
    // rather than re-deriving the boundary math here.
    expect(r.caption.length).toBeLessThan(overLong.length);
    const { truncateCaption: t } = await import("@/lib/diffusion/caption");
    expect(r.caption).toBe(t(overLong, settings.captionMaxChars));
  });

  it("falls back deterministically to a truncated title when no provider is usable — still ok:true, still within the limit", async () => {
    process.env.LLM_ORDER = "openrouter";
    buildModelImpl = () => null; // every provider unconfigured

    const settings = await getChannelSettings(TEST_CHANNEL);
    const r = await generateCaption({ articleId, channel: TEST_CHANNEL });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.caption.length).toBeLessThanOrEqual(settings.captionMaxChars);
    const { truncateCaption: t } = await import("@/lib/diffusion/caption");
    const [article] = await db.select().from(articles).where(eq(articles.id, articleId));
    expect(r.caption).toBe(t(article!.title, settings.captionMaxChars));
  });

  it("also falls back when the provider returns empty text", async () => {
    process.env.LLM_ORDER = "openrouter";
    buildModelImpl = (name: string) => ({ name });
    generateTextImpl = async () => ({ text: "   " });

    const r = await generateCaption({ articleId, channel: TEST_CHANNEL });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [article] = await db.select().from(articles).where(eq(articles.id, articleId));
    const settings = await getChannelSettings(TEST_CHANNEL);
    expect(r.caption).toBe(truncateCaption(article!.title, settings.captionMaxChars));
  });

  it("returns a usable caption on a normal (short) provider response, unmodified apart from trimming", async () => {
    process.env.LLM_ORDER = "openrouter";
    buildModelImpl = (name: string) => ({ name });
    generateTextImpl = async () => ({ text: "  L'UEMOA respire : l'inflation recule pour le 3e mois.  " });

    const r = await generateCaption({ articleId, channel: TEST_CHANNEL });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.caption).toBe("L'UEMOA respire : l'inflation recule pour le 3e mois.");
  });

  it("returns ok:false for a non-existent article", async () => {
    const r = await generateCaption({ articleId: "00000000-0000-0000-0000-000000000000", channel: TEST_CHANNEL });
    expect(r.ok).toBe(false);
  });
});

// D7 Task 5 (spec §2) — the article permalink appended to the LinkedIn caption. "linkedin" is this
// describe block's own EXCLUSIVE static social_channel_settings scope (same disjoint-scope
// convention as TEST_CHANNEL's header comment above): the third test below writes captionMaxChars
// through updateChannelSettingsCore, so the row is reset to a known-absent state in beforeAll and
// wiped again after every test (afterEach) and at the end (afterAll) — mirrors
// tests/diffusion-linkedin.test.ts's own clearLinkedInCredentials, which does the exact same thing
// for the exact same channel key for the exact same reason (another file's own use of "linkedin"
// settings must never see this file's captionMaxChars: 300 leak in, and vice versa).
//
// wpPostUrl (lib/wp/post-url.ts) needs getWpConfig()'s three env vars, which test-setup.ts
// deliberately does NOT load from .env.local (DB tests run credential-free by default) — posed here
// exactly as tests/studio-bindings.test.ts already does for the same helper.
describe("generateCaption — permalien LinkedIn dans la légende (D7 spec §2, Task 5)", () => {
  const LINKEDIN = "linkedin" as const;
  const WP_ENV = { WP_BASE_URL: "https://wp.example.com", WP_USER: "u", WP_APP_PASSWORD: "p" };
  const wpEnvSnapshot: Record<string, string | undefined> = {};
  const articleIds: string[] = [];

  async function resetLinkedInSettings() {
    await db.delete(socialChannelSettings).where(eq(socialChannelSettings.channel, LINKEDIN));
  }

  beforeAll(async () => {
    for (const k of Object.keys(WP_ENV)) {
      wpEnvSnapshot[k] = process.env[k];
      process.env[k] = (WP_ENV as Record<string, string>)[k];
    }
    await resetLinkedInSettings();
  });

  afterEach(async () => {
    await resetLinkedInSettings();
    if (articleIds.length) {
      await db.delete(articles).where(inArray(articles.id, articleIds)); // cascade: distributions
      articleIds.length = 0;
    }
  });

  afterAll(async () => {
    await resetLinkedInSettings();
    for (const k of Object.keys(WP_ENV)) {
      if (wpEnvSnapshot[k] === undefined) delete process.env[k]; else process.env[k] = wpEnvSnapshot[k];
    }
  });

  async function seedArticleWithWordpressDistribution(o: { externalId: string; title?: string }): Promise<string> {
    const [a] = await db.insert(articles).values({
      title: o.title ?? "Un article déjà publié sur WordPress",
      bodyHtml: "<p>x</p>",
      status: "approved",
    }).returning();
    articleIds.push(a.id);
    await db.insert(distributions).values({
      articleId: a.id, channel: "wordpress", status: "sent", externalId: o.externalId,
    });
    return a.id;
  }

  async function seedArticleWithoutWordpressDistribution(): Promise<string> {
    const [a] = await db.insert(articles).values({
      title: "Un article jamais publié sur WordPress",
      bodyHtml: "<p>x</p>",
      status: "approved",
    }).returning();
    articleIds.push(a.id);
    return a.id;
  }

  test("LinkedIn: the permalink is appended when the article is published to WordPress", async () => {
    const id = await seedArticleWithWordpressDistribution({ externalId: "1234" });
    const res = await generateCaption({ articleId: id, channel: "linkedin" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.caption).toContain("/?p=1234");
  });

  test("LinkedIn: no WordPress distribution means no URL, and the send still works", async () => {
    const id = await seedArticleWithoutWordpressDistribution();
    const res = await generateCaption({ articleId: id, channel: "linkedin" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.caption).not.toMatch(/https?:\/\//);
  });

  test("the URL is reserved BEFORE truncation — result within budget, link intact", async () => {
    const id = await seedArticleWithWordpressDistribution({ externalId: "1234", title: "x".repeat(5000) });
    await updateChannelSettingsCore("linkedin", { captionMaxChars: 300 });
    const res = await generateCaption({ articleId: id, channel: "linkedin" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.caption.length).toBeLessThanOrEqual(300);
      expect(res.caption).toContain("/?p=1234");   // the link is never what gets cut
    }
  });

  test("Facebook and Instagram captions are untouched", async () => {
    const id = await seedArticleWithWordpressDistribution({ externalId: "1234" });
    for (const channel of ["facebook", "instagram"] as const) {
      const res = await generateCaption({ articleId: id, channel });
      if (res.ok) expect(res.caption).not.toContain("/?p=1234");
    }
  });
});
