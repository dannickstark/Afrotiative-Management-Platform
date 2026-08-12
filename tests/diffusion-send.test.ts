import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import sharp from "sharp";
import {
  db, articles, wpCategories, renderTemplates, renderTemplateVersions, renders,
  distributions, articleRevisions, socialChannelSettings,
} from "@/db";
import { eq, and, inArray } from "drizzle-orm";
import { sendToChannelCore } from "@/lib/diffusion/send-core";
import { MemoryRenderStore } from "@/lib/studio/store";
import { SOCIAL_CHANNELS, type SocialChannel, type SendInput, type SendResult } from "@/lib/diffusion/channels";
import { FB_TEMPLATE } from "@/db/studio-templates";
import type { Channel, TemplateContext, FormatKey } from "@/lib/studio";

// This file's EXCLUSIVE static social_channel_settings scope: "tiktok" (lazy-enabled default,
// used for every render-reaching test below), "x" (explicitly disabled), and "whatsapp" (lazy-
// enabled default, used ONLY for the "no template configured" test below). None of the three is a
// static settings-row scope owned by tests/diffusion-settings.test.ts (tiktok/facebook/instagram
// there are deleted in ITS OWN beforeAll/afterAll — self-healing, same convention documented in
// tests/studio-fixtures.ts). render_templates scope: (social_post, "tiktok", <fresh categoryId>) —
// collision-free by construction (categoryId is a freshly generated UUID each run), same pattern
// tests/studio-e2e.test.ts and tests/studio-bindings.test.ts already rely on. "whatsapp" gets NO
// render_templates row at all, anywhere, on purpose (db/studio-templates.ts only seeds starter
// defaults for facebook/instagram — see its STARTERS array — so whatsapp/x/tiktok start with none):
// that absence is exactly what the "no template configured" test needs resolveTemplate to hit.
const TEMPLATE_CHANNEL = "tiktok" as const;
const DISABLED_CHANNEL = "x" as const;
const NO_TEMPLATE_CHANNEL = "whatsapp" as const;

// Controllable SocialChannel double — every REGISTERED channel's `send` delegates to StubChannel
// (lib/diffusion/channels.ts), which always succeeds and can never be made to fail. sendToChannelCore
// accepts a test-only `channelOverride` (same convention as renderForArticle's `store`/`fetchImpl`/
// `assets` — lib/studio/index.ts) precisely so failure/retry behavior is exercisable at all.
class FakeChannel implements SocialChannel {
  readonly key: Channel = TEMPLATE_CHANNEL;
  readonly label = SOCIAL_CHANNELS[TEMPLATE_CHANNEL].label;
  readonly context: TemplateContext = "social_post";
  readonly format: FormatKey = "story";
  readonly captionLimits = SOCIAL_CHANNELS[TEMPLATE_CHANNEL].captionLimits;
  readonly credentialFields = SOCIAL_CHANNELS[TEMPLATE_CHANNEL].credentialFields;
  readonly available = SOCIAL_CHANNELS[TEMPLATE_CHANNEL].available;
  readonly calls: SendInput[] = [];
  constructor(private readonly results: SendResult[]) {}
  async send(input: SendInput): Promise<SendResult> {
    this.calls.push(input);
    return this.results[this.calls.length - 1] ?? this.results[this.results.length - 1];
  }
}

let server: ReturnType<typeof Bun.serve>;
let categoryId: string;
let templateId: string;
let articleUnpublished: string;
let articleDisabled: string;
let articleRenderFails: string;
let articleSuccess: string;
let articleRetry: string;
let articleSecondSend: string;
let articleNoTemplate: string;

async function deleteSettingsRows() {
  await db.delete(socialChannelSettings).where(inArray(socialChannelSettings.channel, [TEMPLATE_CHANNEL, DISABLED_CHANNEL, NO_TEMPLATE_CHANNEL]));
}

beforeAll(async () => {
  await deleteSettingsRows();
  // Explicit row for the disabled-channel test; TEMPLATE_CHANNEL is left ABSENT so
  // getChannelSettings lazily creates it with the registry default (enabled: true).
  await db.insert(socialChannelSettings).values({
    channel: DISABLED_CHANNEL, enabled: false, captionMaxChars: SOCIAL_CHANNELS[DISABLED_CHANNEL].captionLimits.default,
  });

  const png = await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 10, g: 80, b: 140 } } }).png().toBuffer();
  server = Bun.serve({ port: 0, fetch: () => new Response(png, { headers: { "content-type": "image/png" } }) });

  const [cat] = await db.insert(wpCategories).values({
    name: "Test Diffusion Send", slug: `test-diffusion-send-${Date.now()}`, color: "#2244AA",
  }).returning();
  categoryId = cat.id;

  const [t] = await db.insert(renderTemplates).values({
    name: "Test — post social", context: "social_post", channel: TEMPLATE_CHANNEL, categoryId,
    format: "fb_link", width: 1200, height: 630, scene: FB_TEMPLATE,
  }).returning();
  templateId = t.id;
  await db.insert(renderTemplateVersions).values({ templateId, version: 1, scene: FB_TEMPLATE });
  await db.update(renderTemplates).set({ publishedVersion: 1 }).where(eq(renderTemplates.id, templateId));

  const imageUrl = `http://127.0.0.1:${server.port}/photo.png`;
  const mk = (title: string, overrides: Partial<typeof articles.$inferInsert>) =>
    db.insert(articles).values({ title, bodyHtml: "<p>x</p>", status: "approved", ...overrides }).returning();

  const publishedAt = new Date();
  [{ id: articleUnpublished }] = await mk("Diffusion — non publié", { status: "draft" });
  [{ id: articleDisabled }] = await mk("Diffusion — canal désactivé", { status: "published", publishedAt, categoryId, featuredImageUrl: imageUrl });
  [{ id: articleRenderFails }] = await mk("Diffusion — rendu en échec", { status: "published", publishedAt, categoryId, featuredImageUrl: null });
  [{ id: articleSuccess }] = await mk("Diffusion — envoi réussi", { status: "published", publishedAt, categoryId, featuredImageUrl: imageUrl });
  [{ id: articleRetry }] = await mk("Diffusion — échec puis réessai", { status: "published", publishedAt, categoryId, featuredImageUrl: imageUrl });
  [{ id: articleSecondSend }] = await mk("Diffusion — second envoi bloqué", { status: "published", publishedAt, categoryId, featuredImageUrl: imageUrl });
  // categoryId reused deliberately (not a fresh one): no render_templates row exists anywhere for
  // (social_post, "whatsapp", *) — see NO_TEMPLATE_CHANNEL's comment above — so which category this
  // article carries is irrelevant to which template resolveTemplate lands on (there is none).
  [{ id: articleNoTemplate }] = await mk("Diffusion — aucun gabarit configuré", { status: "published", publishedAt, categoryId, featuredImageUrl: imageUrl });
});

afterAll(async () => {
  server?.stop(true);
  const ids = [articleUnpublished, articleDisabled, articleRenderFails, articleSuccess, articleRetry, articleSecondSend, articleNoTemplate].filter(Boolean);
  if (ids.length) {
    await db.delete(renders).where(inArray(renders.subjectId, ids));
    await db.delete(distributions).where(inArray(distributions.articleId, ids));
    await db.delete(articleRevisions).where(inArray(articleRevisions.articleId, ids));
    await db.delete(articles).where(inArray(articles.id, ids));
  }
  if (templateId) await db.delete(renderTemplates).where(eq(renderTemplates.id, templateId));
  if (categoryId) await db.delete(wpCategories).where(eq(wpCategories.id, categoryId));
  await deleteSettingsRows();
});

describe("sendToChannelCore — ordonnancement (D1 §4/§7, Task 5)", () => {
  it("refuse un article non publié — aucune ligne distributions écrite", async () => {
    const r = await sendToChannelCore({
      articleId: articleUnpublished, channel: TEMPLATE_CHANNEL, caption: "x", triggeredBy: "manual", actorId: null,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message.toLowerCase()).toContain("publi");
    const rows = await db.select().from(distributions).where(and(eq(distributions.articleId, articleUnpublished), eq(distributions.channel, TEMPLATE_CHANNEL)));
    expect(rows).toHaveLength(0);
  });

  it("refuse un canal désactivé, en le nommant — aucune ligne écrite", async () => {
    const r = await sendToChannelCore({
      articleId: articleDisabled, channel: DISABLED_CHANNEL, caption: "x", triggeredBy: "manual", actorId: null,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain(SOCIAL_CHANNELS[DISABLED_CHANNEL].label);
    const rows = await db.select().from(distributions).where(and(eq(distributions.articleId, articleDisabled), eq(distributions.channel, DISABLED_CHANNEL)));
    expect(rows).toHaveLength(0);
  });

  it("un rendu en échec refuse l'envoi et n'écrit AUCUNE ligne distributions", async () => {
    const r = await sendToChannelCore({
      articleId: articleRenderFails, channel: TEMPLATE_CHANNEL, caption: "x", triggeredBy: "manual", actorId: null,
      renderStore: new MemoryRenderStore(), fetchImpl: fetch,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message.length).toBeGreaterThan(0);
    const rows = await db.select().from(distributions).where(and(eq(distributions.articleId, articleRenderFails), eq(distributions.channel, TEMPLATE_CHANNEL)));
    expect(rows).toHaveLength(0);
  });

  // D1 final review, "Also fix — cheap": the {ok:true, url:null} branch of renderForArticle (no
  // `social_post` template resolves for this channel at all — lib/studio/index.ts, "aucun gabarit
  // n'est un cas NORMAL, pas une erreur") was previously verified only by reading send-core.ts's
  // step 3, never by a test. It is distinct from "un rendu en échec" above: that test's article has
  // a RESOLVED template that then fails during rendering (missing image token); this one never
  // resolves a template at all.
  it("aucun gabarit « post social » configuré (ok:true,url:null) refuse l'envoi, en nommant le canal — aucune ligne distributions écrite", async () => {
    const r = await sendToChannelCore({
      articleId: articleNoTemplate, channel: NO_TEMPLATE_CHANNEL, caption: "x", triggeredBy: "manual", actorId: null,
      renderStore: new MemoryRenderStore(), fetchImpl: fetch,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain(SOCIAL_CHANNELS[NO_TEMPLATE_CHANNEL].label);
    expect(r.message.toLowerCase()).toContain("gabarit");
    const rows = await db.select().from(distributions).where(and(eq(distributions.articleId, articleNoTemplate), eq(distributions.channel, NO_TEMPLATE_CHANNEL)));
    expect(rows).toHaveLength(0);
  });

  it("un envoi réussi pose renderId/sentAt/externalId et ajoute une entrée d'audit", async () => {
    const fake = new FakeChannel([{ ok: true, externalId: "ext-123" }]);
    const r = await sendToChannelCore({
      articleId: articleSuccess, channel: TEMPLATE_CHANNEL, caption: "Ma légende.", triggeredBy: "manual", actorId: null,
      renderStore: new MemoryRenderStore(), fetchImpl: fetch, channelOverride: fake,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.externalId).toBe("ext-123");
    expect(typeof r.renderId).toBe("string");
    expect(r.renderId.length).toBeGreaterThan(0);

    const [row] = await db.select().from(distributions).where(and(eq(distributions.articleId, articleSuccess), eq(distributions.channel, TEMPLATE_CHANNEL)));
    expect(row.status).toBe("sent");
    expect(row.renderId).toBe(r.renderId);
    expect(row.externalId).toBe("ext-123");
    expect(row.sentAt).not.toBeNull();
    expect(row.caption).toBe("Ma légende.");

    const revisions = await db.select().from(articleRevisions).where(eq(articleRevisions.articleId, articleSuccess));
    expect(revisions.length).toBeGreaterThan(0);
    expect(revisions.some((rv) => rv.action.includes(SOCIAL_CHANNELS[TEMPLATE_CHANNEL].label))).toBe(true);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].caption).toBe("Ma légende.");
    expect(fake.calls[0].imageUrl.length).toBeGreaterThan(0);
  });

  // The sharpest sabotage check this task calls out by name: does this assertion merely check
  // "a renderId is present", or does it compare the EXACT value across the two attempts? It's the
  // latter — r2.renderId (and the DB row's renderId after the retry) are compared for STRICT
  // EQUALITY against firstRenderId, a value actually captured from the FIRST attempt. A silent
  // re-render on retry (a real bug this test would need to catch) would produce a DIFFERENT id and
  // fail this assertion, even though "a renderId is present" would still trivially hold either way.
  // The render-store object count (unchanged at 1 after the retry) is the second, independent
  // witness: it can only stay at 1 if renderForArticle's renderScene path was never re-invoked.
  it("un échec pose status=failed/attempts=1/lastError, et un RÉESSAI réutilise EXACTEMENT le même renderId (aucun second rendu)", async () => {
    const store = new MemoryRenderStore();
    const failing = new FakeChannel([{ ok: false, message: "Erreur simulée du réseau." }]);
    const r1 = await sendToChannelCore({
      articleId: articleRetry, channel: TEMPLATE_CHANNEL, caption: "Première tentative.", triggeredBy: "manual", actorId: null,
      renderStore: store, fetchImpl: fetch, channelOverride: failing,
    });
    expect(r1.ok).toBe(false);
    if (r1.ok) return;
    expect(r1.message).toContain("Erreur simulée du réseau.");

    const [afterFail] = await db.select().from(distributions).where(and(eq(distributions.articleId, articleRetry), eq(distributions.channel, TEMPLATE_CHANNEL)));
    expect(afterFail.status).toBe("failed");
    expect(afterFail.attempts).toBe(1);
    expect(afterFail.lastError).toBe("Erreur simulée du réseau.");
    expect(afterFail.renderId).not.toBeNull();
    const firstRenderId = afterFail.renderId as string;
    expect(store.objects.size).toBe(1); // exactly one render happened so far

    const succeeding = new FakeChannel([{ ok: true, externalId: "ext-retry-456" }]);
    const r2 = await sendToChannelCore({
      articleId: articleRetry, channel: TEMPLATE_CHANNEL, caption: "Tentative corrigée.", triggeredBy: "manual", actorId: null,
      renderStore: store, fetchImpl: fetch, channelOverride: succeeding,
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    expect(r2.renderId).toBe(firstRenderId); // ← exact-value comparison, not mere presence
    expect(store.objects.size).toBe(1); // still 1 — renderForArticle was NOT called again

    const [afterRetry] = await db.select().from(distributions).where(and(eq(distributions.articleId, articleRetry), eq(distributions.channel, TEMPLATE_CHANNEL)));
    expect(afterRetry.status).toBe("sent");
    expect(afterRetry.renderId).toBe(firstRenderId);
    expect(afterRetry.externalId).toBe("ext-retry-456");
    expect(afterRetry.caption).toBe("Tentative corrigée."); // caption IS refreshed on retry
    expect(afterRetry.sentAt).not.toBeNull();

    // Update-in-place throughout: never a second inserted row for this (article, channel).
    const allRows = await db.select().from(distributions).where(and(eq(distributions.articleId, articleRetry), eq(distributions.channel, TEMPLATE_CHANNEL)));
    expect(allRows).toHaveLength(1);
  });

  it("un second envoi après un succès est refusé — channel.send n'est PAS rappelé, la ligne d'origine reste intacte", async () => {
    const store = new MemoryRenderStore();
    const first = new FakeChannel([{ ok: true, externalId: "ext-first" }]);
    const r1 = await sendToChannelCore({
      articleId: articleSecondSend, channel: TEMPLATE_CHANNEL, caption: "Envoi initial.", triggeredBy: "manual", actorId: null,
      renderStore: store, fetchImpl: fetch, channelOverride: first,
    });
    expect(r1.ok).toBe(true);

    const second = new FakeChannel([{ ok: true, externalId: "ne-devrait-jamais-apparaitre" }]);
    const r2 = await sendToChannelCore({
      articleId: articleSecondSend, channel: TEMPLATE_CHANNEL, caption: "Second envoi.", triggeredBy: "manual", actorId: null,
      renderStore: store, fetchImpl: fetch, channelOverride: second,
    });
    expect(r2.ok).toBe(false);
    expect(second.calls).toHaveLength(0); // the send call itself never fired

    const rows = await db.select().from(distributions).where(and(eq(distributions.articleId, articleSecondSend), eq(distributions.channel, TEMPLATE_CHANNEL)));
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe("ext-first");
    expect(rows[0].caption).toBe("Envoi initial.");
  });
});
