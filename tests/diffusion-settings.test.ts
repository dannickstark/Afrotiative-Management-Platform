import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { db, articles, distributions, socialChannelSettings } from "@/db";
import { eq } from "drizzle-orm";
import { can } from "@/lib/rbac";
import { SOCIAL_CHANNELS } from "@/lib/diffusion/channels";
import { getChannelSettings, updateChannelSettingsCore } from "@/lib/diffusion/settings-core";
import { listDistributionsForArticle } from "@/lib/queries/diffusion";
import { socialChannelSettingsSchema } from "@/lib/validation";

// Channels this file owns exclusively as test fixtures (deleted in beforeAll/afterAll — same
// defensive-cleanup convention as tests/distributions-unique.test.ts). Picking DISTINCT channels
// per test avoids any cross-test row contention within this file.
const LAZY_CHANNEL = "tiktok" as const;
const CLAMP_CHANNEL = "facebook" as const;
const UPDATE_CHANNEL = "instagram" as const;

async function deleteSettingsRow(channel: string) {
  await db.delete(socialChannelSettings).where(eq(socialChannelSettings.channel, channel));
}

beforeAll(async () => {
  await deleteSettingsRow(LAZY_CHANNEL);
  await deleteSettingsRow(CLAMP_CHANNEL);
  await deleteSettingsRow(UPDATE_CHANNEL);
});

afterAll(async () => {
  await deleteSettingsRow(LAZY_CHANNEL);
  await deleteSettingsRow(CLAMP_CHANNEL);
  await deleteSettingsRow(UPDATE_CHANNEL);
});

describe("getChannelSettings — lazy creation (D1 §1/Task 3)", () => {
  afterEach(() => deleteSettingsRow(LAZY_CHANNEL));

  it("creates the row from registry defaults on first read", async () => {
    const before = await db.select().from(socialChannelSettings).where(eq(socialChannelSettings.channel, LAZY_CHANNEL));
    expect(before).toHaveLength(0);

    const settings = await getChannelSettings(LAZY_CHANNEL);

    expect(settings.channel).toBe(LAZY_CHANNEL);
    expect(settings.captionMaxChars).toBe(SOCIAL_CHANNELS[LAZY_CHANNEL].captionLimits.default);
    expect(settings.enabled).toBe(true);
    expect(settings.autoEnabled).toBe(false);
    expect(settings.captionPrompt).toBeNull();
    expect(settings.lastAutoSendAt).toBeNull();

    const after = await db.select().from(socialChannelSettings).where(eq(socialChannelSettings.channel, LAZY_CHANNEL));
    expect(after).toHaveLength(1); // the read actually persisted a row, not just an in-memory default
  });

  it("a second read returns the SAME row, not a fresh default (idempotent)", async () => {
    const first = await getChannelSettings(LAZY_CHANNEL);
    await db.update(socialChannelSettings).set({ captionPrompt: "Prompt personnalisé" })
      .where(eq(socialChannelSettings.channel, LAZY_CHANNEL));

    const second = await getChannelSettings(LAZY_CHANNEL);
    expect(second.channel).toBe(first.channel);
    expect(second.captionPrompt).toBe("Prompt personnalisé"); // proves it read back the row, not re-defaulted
  });

  it("lazy defaults differ per channel — captionMaxChars tracks THAT channel's captionLimits.default, not a fixed literal", async () => {
    const tiktok = await getChannelSettings("tiktok");
    const x = await getChannelSettings("x");
    try {
      expect(tiktok.captionMaxChars).toBe(SOCIAL_CHANNELS.tiktok.captionLimits.default);
      expect(x.captionMaxChars).toBe(SOCIAL_CHANNELS.x.captionLimits.default);
      expect(tiktok.captionMaxChars).not.toBe(x.captionMaxChars); // would coincidentally pass if both were e.g. 300 — assert the actual known values differ
      expect(SOCIAL_CHANNELS.tiktok.captionLimits.default).not.toBe(SOCIAL_CHANNELS.x.captionLimits.default);
    } finally {
      await deleteSettingsRow("x");
    }
  });
});

describe("updateChannelSettingsCore — captionMaxChars clamp (D1 §2/§6, Task 3)", () => {
  afterEach(() => deleteSettingsRow(CLAMP_CHANNEL));

  it("refuses a captionMaxChars above the channel's captionLimits.max, naming the actual bound", async () => {
    const { max, min } = SOCIAL_CHANNELS[CLAMP_CHANNEL].captionLimits;
    const res = await updateChannelSettingsCore(CLAMP_CHANNEL, { captionMaxChars: max + 1000 });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).toContain(String(max));
      expect(res.message).toContain(String(min));
    }

    // Refused — the row's captionMaxChars must NOT have moved off the lazy default.
    const settings = await getChannelSettings(CLAMP_CHANNEL);
    expect(settings.captionMaxChars).toBe(SOCIAL_CHANNELS[CLAMP_CHANNEL].captionLimits.default);
  });

  it("refuses a captionMaxChars below the channel's captionLimits.min", async () => {
    const { min } = SOCIAL_CHANNELS[CLAMP_CHANNEL].captionLimits;
    if (min <= 0) return; // no lower bound to violate for this channel — skip rather than assert something false
    const res = await updateChannelSettingsCore(CLAMP_CHANNEL, { captionMaxChars: min - 1 });
    expect(res.ok).toBe(false);
  });

  it("accepts a captionMaxChars inside [min, max]", async () => {
    const { min, max } = SOCIAL_CHANNELS[CLAMP_CHANNEL].captionLimits;
    const mid = Math.floor((min + max) / 2);
    const res = await updateChannelSettingsCore(CLAMP_CHANNEL, { captionMaxChars: mid });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.settings.captionMaxChars).toBe(mid);
  });
});

describe("updateChannelSettingsCore — general patch (Task 3)", () => {
  afterEach(() => deleteSettingsRow(UPDATE_CHANNEL));

  it("updates enabled/autoEnabled/captionPrompt and bumps updatedAt", async () => {
    await getChannelSettings(UPDATE_CHANNEL); // lazy-create the row before the update below

    // Compared against a LOCAL clock reading taken just before the call, not the row's own
    // `before.updatedAt` (a DB-server `defaultNow()` value): that would compare a Neon-host clock
    // against updateChannelSettingsCore's client-side `new Date()`, which can disagree by a couple
    // ms even when the update genuinely ran after — exactly the flake this produced once already.
    // Same-clock-domain comparison (t0 vs the returned updatedAt, both from this process) removes
    // that cross-machine skew entirely.
    const t0 = Date.now();
    const res = await updateChannelSettingsCore(UPDATE_CHANNEL, {
      enabled: false, autoEnabled: true, autoIntervalHours: 12, captionPrompt: "Ton plus formel.",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.settings.enabled).toBe(false);
    expect(res.settings.autoEnabled).toBe(true);
    expect(res.settings.autoIntervalHours).toBe(12);
    expect(res.settings.captionPrompt).toBe("Ton plus formel.");
    expect(res.settings.updatedAt.getTime()).toBeGreaterThanOrEqual(t0);
  });
});

// D1 final review, Important 4: updateChannelSettings (the Server Action — a PUBLIC network
// endpoint) validated only captionMaxChars server-side; every other field relied entirely on
// components/settings/social-channel-form.tsx's CLIENT-side guards, bypassable by any direct
// caller. Mirrors tests/pipeline-settings.test.ts's own "pipelineSettingsSchema validation"
// describe block: exercises the schema directly (unit-level), not through the guarded action
// itself (which needs a real session — see that file's own comment on why).
describe("socialChannelSettingsSchema validation (D1 final review, Important 4)", () => {
  it("accepts a fully valid patch", () => {
    const r = socialChannelSettingsSchema.safeParse({
      enabled: true, captionMaxChars: 280, captionPrompt: null,
      autoEnabled: true, autoIntervalHours: 6, autoMaxBacklogDays: 3,
      autoWindowStartHour: 8, autoWindowEndHour: 20,
    });
    expect(r.success).toBe(true);
  });

  it("accepts a PARTIAL patch — every field is optional, matching UpdateChannelSettingsPatch", () => {
    expect(socialChannelSettingsSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(socialChannelSettingsSchema.safeParse({}).success).toBe(true);
  });

  // The concrete failure the review called out by name: autoIntervalHours: 0 made isDue
  // (lib/diffusion/schedule-core.ts) unconditionally true — `now - lastAutoSendAt >= 0` always
  // holds — so a channel would fire on EVERY scheduler tick instead of once per configured
  // interval.
  it("refuses autoIntervalHours: 0, in French", () => {
    const r = socialChannelSettingsSchema.safeParse({ autoIntervalHours: 0 });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toMatch(/positif/i);
  });

  it("refuses a negative autoIntervalHours", () => {
    expect(socialChannelSettingsSchema.safeParse({ autoIntervalHours: -1 }).success).toBe(false);
  });

  // The other concrete failure: a non-integer would have reached an `integer` Postgres column and
  // surfaced as a raw, untranslated driver error rather than a clean French message.
  it("refuses a non-integer autoIntervalHours, in French", () => {
    const r = socialChannelSettingsSchema.safeParse({ autoIntervalHours: 2.5 });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toMatch(/entier/i);
  });

  it("refuses a non-integer captionMaxChars", () => {
    expect(socialChannelSettingsSchema.safeParse({ captionMaxChars: 100.5 }).success).toBe(false);
  });

  it("refuses autoMaxBacklogDays: 0 or negative", () => {
    expect(socialChannelSettingsSchema.safeParse({ autoMaxBacklogDays: 0 }).success).toBe(false);
    expect(socialChannelSettingsSchema.safeParse({ autoMaxBacklogDays: -3 }).success).toBe(false);
  });

  it("refuses an out-of-range window hour (only 0-23 is valid)", () => {
    expect(socialChannelSettingsSchema.safeParse({ autoWindowStartHour: 24 }).success).toBe(false);
    expect(socialChannelSettingsSchema.safeParse({ autoWindowStartHour: -1 }).success).toBe(false);
    expect(socialChannelSettingsSchema.safeParse({ autoWindowEndHour: 24 }).success).toBe(false);
  });

  it("accepts window hours at the boundaries (0 and 23)", () => {
    expect(socialChannelSettingsSchema.safeParse({ autoWindowStartHour: 0, autoWindowEndHour: 23 }).success).toBe(true);
  });

  it("accepts a null captionPrompt (clears the override)", () => {
    expect(socialChannelSettingsSchema.safeParse({ captionPrompt: null }).success).toBe(true);
  });
});

describe('can() — social:manage requis pour updateChannelSettings (D1 §6, Task 3)', () => {
  it("l'éditeur est refusé sur manage (donc sur la mise à jour des réglages)", () => {
    expect(can("editor", "social", "manage")).toBe(false);
  });
  it("l'admin est autorisé sur manage", () => {
    expect(can("admin", "social", "manage")).toBe(true);
  });
  it("le journaliste est refusé sur manage", () => {
    expect(can("journalist", "social", "manage")).toBe(false);
  });
});

describe("listDistributionsForArticle (D1 §4 panel query)", () => {
  let articleId: string;

  beforeAll(async () => {
    const [article] = await db.insert(articles).values({
      title: "Article de test (liste diffusions)", bodyHtml: "<p>Contenu.</p>", status: "approved",
    }).returning();
    articleId = article.id;
    await db.insert(distributions).values([
      { articleId, channel: "wordpress", status: "sent", externalId: "1" },
      { articleId, channel: "facebook", status: "failed", lastError: "Erreur simulée.", attempts: 1 },
    ]);
  });

  afterAll(async () => {
    if (articleId) {
      await db.delete(distributions).where(eq(distributions.articleId, articleId));
      await db.delete(articles).where(eq(articles.id, articleId));
    }
  });

  it("returns every distribution row for the article, across channels", async () => {
    const rows = await listDistributionsForArticle(articleId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.channel).sort()).toEqual(["facebook", "wordpress"]);
  });

  it("returns an empty array for an article with no distributions", async () => {
    const [other] = await db.insert(articles).values({
      title: "Article de test (aucune diffusion)", bodyHtml: "<p>x</p>", status: "draft",
    }).returning();
    try {
      const rows = await listDistributionsForArticle(other.id);
      expect(rows).toEqual([]);
    } finally {
      await db.delete(articles).where(eq(articles.id, other.id));
    }
  });
});
