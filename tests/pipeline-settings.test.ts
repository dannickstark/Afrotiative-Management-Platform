import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, pipelineSettings } from "@/db";
import { eq } from "drizzle-orm";
import { getPipelineSettings, type PipelineSettings } from "@/lib/queries/settings";
import { pipelineSettingsSchema } from "@/lib/validation";
import { persistPipelineSettings } from "@/lib/pipeline/settings-write";
import { can } from "@/lib/rbac";

// pipeline_settings row id=1 is a shared, app-wide singleton (possibly holding a real
// admin-configured value) — never assume it's absent or default. Snapshot once before this file's
// tests run and restore exactly (present with original values, or absent) once at the very end.
// Tests within a describe block run sequentially (bun:test default, same assumption
// tests/live-progress.test.ts's file-scoped self-heal relies on), so a single file-scoped
// snapshot/restore is safe here.
let snapshot: PipelineSettings | null = null;

beforeAll(async () => {
  const [row] = await db.select().from(pipelineSettings).where(eq(pipelineSettings.id, 1));
  snapshot = row ?? null;
});

afterAll(async () => {
  await db.delete(pipelineSettings).where(eq(pipelineSettings.id, 1));
  if (snapshot) await db.insert(pipelineSettings).values(snapshot);
});

describe("pipeline_settings table (migration 0004)", () => {
  it("round-trips an insert with explicit values, defaults for the rest, and reads back", async () => {
    await db.delete(pipelineSettings).where(eq(pipelineSettings.id, 1));
    const [row] = await db.insert(pipelineSettings)
      .values({ id: 1, maxItemsPerRun: 42, clusterThreshold: 0.5 })
      .returning();

    expect(row.id).toBe(1);
    expect(row.maxItemsPerRun).toBe(42);
    expect(row.clusterThreshold).toBeCloseTo(0.5, 5);
    // defaults for everything not explicitly set
    expect(row.perOperationTimeoutMs).toBe(300000);
    expect(row.scoreThreshold).toBe(70);
    expect(row.autoPublishEnabled).toBe(false);
    expect(row.autoPublishMinSources).toBe(2);
    expect(row.webSearchEnabled).toBe(false);
    expect(row.scheduleCron).toBeNull();
    expect(row.updatedAt).not.toBeNull();

    const [read] = await db.select().from(pipelineSettings).where(eq(pipelineSettings.id, 1));
    expect(read.maxItemsPerRun).toBe(42);
  });
});

describe("getPipelineSettings()", () => {
  it("seeds row id=1 from env defaults when absent, and is idempotent on a second call", async () => {
    await db.delete(pipelineSettings).where(eq(pipelineSettings.id, 1));

    const first = await getPipelineSettings();
    expect(first.id).toBe(1);
    expect(first.maxItemsPerRun).toBeGreaterThan(0);

    const second = await getPipelineSettings();
    expect(second.maxItemsPerRun).toBe(first.maxItemsPerRun);

    // idempotent: exactly one row, no duplicate seed insert
    const rows = await db.select().from(pipelineSettings).where(eq(pipelineSettings.id, 1));
    expect(rows.length).toBe(1);
  });

  it("returns the existing row unchanged when one is already present (DB authoritative)", async () => {
    await db.delete(pipelineSettings).where(eq(pipelineSettings.id, 1));
    await db.insert(pipelineSettings).values({ id: 1, maxItemsPerRun: 7 });

    const settings = await getPipelineSettings();
    expect(settings.maxItemsPerRun).toBe(7);
  });

  it("honors MAX_ITEMS_PER_RUN as the seed value on first call (env → DB seed)", async () => {
    await db.delete(pipelineSettings).where(eq(pipelineSettings.id, 1));
    const prevEnv = process.env.MAX_ITEMS_PER_RUN;
    process.env.MAX_ITEMS_PER_RUN = "5";
    try {
      const settings = await getPipelineSettings();
      expect(settings.maxItemsPerRun).toBe(5);
    } finally {
      if (prevEnv === undefined) delete process.env.MAX_ITEMS_PER_RUN;
      else process.env.MAX_ITEMS_PER_RUN = prevEnv;
    }
  });
});

describe("persistPipelineSettings — default recency (defaultMaxItemAgeHours)", () => {
  it("persists and clears the default recency (defaultMaxItemAgeHours)", async () => {
    const base = {
      maxItemsPerRun: 20, perOperationTimeoutMs: 300000, clusterThreshold: 0.83, scoreThreshold: 70,
      autoPublishEnabled: false, autoPublishMinSources: 2, webSearchEnabled: false,
      scheduleCron: null, alertEmailEnabled: false, alertEmailRecipients: null,
      regenerateImageMode: "auto" as const,
    };
    await persistPipelineSettings({ ...base, defaultMaxItemAgeHours: 96 });
    expect((await getPipelineSettings()).defaultMaxItemAgeHours).toBe(96);
    await persistPipelineSettings({ ...base, defaultMaxItemAgeHours: null });
    expect((await getPipelineSettings()).defaultMaxItemAgeHours).toBeNull();
  });
});

// Maps a PipelineSettings row (DB read) to a PipelineSettingsInput (validated payload shape),
// dropping id/updatedAt — keeps every other field so a test can round-trip a real settings row
// through persistPipelineSettings without repeating its fields by hand.
function toInput(settings: PipelineSettings) {
  const { id, updatedAt, ...rest } = settings;
  return rest;
}

describe("persistPipelineSettings — regenerateImageMode", () => {
  it("persiste regenerateImageMode", async () => {
    const base = await getPipelineSettings();
    await persistPipelineSettings({ ...toInput(base), regenerateImageMode: "manual" });
    expect((await getPipelineSettings()).regenerateImageMode).toBe("manual");
    await persistPipelineSettings({ ...toInput(base), regenerateImageMode: "auto" });
    expect((await getPipelineSettings()).regenerateImageMode).toBe("auto");
  });
});

describe("pipelineSettingsSchema validation", () => {
  const VALID = {
    maxItemsPerRun: 20,
    perOperationTimeoutMs: 300000,
    clusterThreshold: 0.83,
    scoreThreshold: 70,
    autoPublishEnabled: false,
    autoPublishMinSources: 2,
    webSearchEnabled: false,
    scheduleCron: "",
  };

  it("accepts a valid payload", () => {
    expect(pipelineSettingsSchema.safeParse(VALID).success).toBe(true);
  });
  it("accepts a well-formed 5-field cron string", () => {
    expect(pipelineSettingsSchema.safeParse({ ...VALID, scheduleCron: "0 */2 * * *" }).success).toBe(true);
  });
  it("rejects a negative maxItemsPerRun", () => {
    expect(pipelineSettingsSchema.safeParse({ ...VALID, maxItemsPerRun: -1 }).success).toBe(false);
  });
  it("rejects scoreThreshold above 100", () => {
    expect(pipelineSettingsSchema.safeParse({ ...VALID, scoreThreshold: 150 }).success).toBe(false);
  });
  it("rejects clusterThreshold above 1", () => {
    expect(pipelineSettingsSchema.safeParse({ ...VALID, clusterThreshold: 1.5 }).success).toBe(false);
  });
  it("rejects a malformed cron string", () => {
    expect(pipelineSettingsSchema.safeParse({ ...VALID, scheduleCron: "not a cron" }).success).toBe(false);
  });
  // SP5 Task 2 review, Finding 1 — the per-operation timeout floor closes the phantom-commit
  // window around the "Dépôt en revue" DB transaction (a timeout below commit latency could report
  // the stage failed while the write still lands).
  it("rejects a perOperationTimeoutMs below the 5 s floor", () => {
    expect(pipelineSettingsSchema.safeParse({ ...VALID, perOperationTimeoutMs: 100 }).success).toBe(false);
    expect(pipelineSettingsSchema.safeParse({ ...VALID, perOperationTimeoutMs: 4999 }).success).toBe(false);
  });
  it("accepts a perOperationTimeoutMs at or above the 5 s floor", () => {
    expect(pipelineSettingsSchema.safeParse({ ...VALID, perOperationTimeoutMs: 5000 }).success).toBe(true);
    expect(pipelineSettingsSchema.safeParse({ ...VALID, perOperationTimeoutMs: 300000 }).success).toBe(true);
  });

  // SP9a — alertEmailEnabled/alertEmailRecipients. alertEmailEnabled is `.default(false)` (not a
  // bare z.boolean()) specifically so VALID above — which predates SP9a and omits both fields
  // entirely — keeps validating: PipelineSettingsForm's payload doesn't send these yet either
  // (SP9b builds that UI), so a required boolean here would break the EXISTING client-side
  // safeParse call the moment this schema change landed.
  it("defaults alertEmailEnabled to false and leaves alertEmailRecipients undefined when both are omitted", () => {
    const r = pipelineSettingsSchema.safeParse(VALID);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.alertEmailEnabled).toBe(false);
      expect(r.data.alertEmailRecipients).toBeUndefined();
    }
  });
  it("accepts alertEmailEnabled=true with a valid comma-separated recipients list", () => {
    expect(pipelineSettingsSchema.safeParse({
      ...VALID, alertEmailEnabled: true, alertEmailRecipients: "a@example.com, b@example.com",
    }).success).toBe(true);
  });
  it("accepts an empty alertEmailRecipients string (alerts stay in-app-only)", () => {
    expect(pipelineSettingsSchema.safeParse({ ...VALID, alertEmailRecipients: "" }).success).toBe(true);
    expect(pipelineSettingsSchema.safeParse({ ...VALID, alertEmailRecipients: null }).success).toBe(true);
  });
  it("rejects a malformed recipient email (single entry, or one bad entry in a list)", () => {
    expect(pipelineSettingsSchema.safeParse({ ...VALID, alertEmailRecipients: "not-an-email" }).success).toBe(false);
    expect(pipelineSettingsSchema.safeParse({
      ...VALID, alertEmailRecipients: "a@example.com, not-an-email",
    }).success).toBe(false);
  });
});

describe("updatePipelineSettings authz", () => {
  it("only admin may configure pipeline settings", () => {
    expect(can("admin", "pipeline", "configure")).toBe(true);
    expect(can("editor", "pipeline", "configure")).toBe(false);
    expect(can("journalist", "pipeline", "configure")).toBe(false);
  });
});
