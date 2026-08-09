import { describe, it, expect, beforeAll, afterAll, beforeEach, mock, spyOn } from "bun:test";
import { db, articles, wpCategories, socialChannelSettings } from "@/db";
import { eq } from "drizzle-orm";
import { SOCIAL_CHANNELS } from "@/lib/diffusion/channels";
import { getChannelSettings } from "@/lib/diffusion/settings-core";

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
