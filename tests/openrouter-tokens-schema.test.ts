import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, pipelineSettings, openrouterTokens } from "@/db";
import { eq } from "drizzle-orm";
import { getPipelineSettings, type PipelineSettings } from "@/lib/queries/settings";

// pipeline_settings row id=1 is a shared, app-wide singleton (possibly holding a real
// admin-configured value) — never assume it's absent or default. Snapshot once before this file's
// tests run and restore exactly (present with original values, or absent) once at the very end.
// Same pattern as tests/pipeline-settings.test.ts.
let snapshot: PipelineSettings | null = null;

beforeAll(async () => {
  const [row] = await db.select().from(pipelineSettings).where(eq(pipelineSettings.id, 1));
  snapshot = row ?? null;
});

afterAll(async () => {
  await db.delete(pipelineSettings).where(eq(pipelineSettings.id, 1));
  if (snapshot) await db.insert(pipelineSettings).values(snapshot);
});

describe("pipeline_settings.openrouter_min_content_chars (migration 0019)", () => {
  it("defaults to 400 on a freshly-seeded singleton via getPipelineSettings()", async () => {
    await db.delete(pipelineSettings).where(eq(pipelineSettings.id, 1));
    const settings = await getPipelineSettings();
    expect(settings.openrouterMinContentChars).toBe(400);
  });

  it("round-trips a custom value through a direct insert", async () => {
    await db.delete(pipelineSettings).where(eq(pipelineSettings.id, 1));
    const [row] = await db.insert(pipelineSettings)
      .values({ id: 1, maxItemsPerRun: 20, clusterThreshold: 0.83, openrouterMinContentChars: 800 })
      .returning();
    expect(row.openrouterMinContentChars).toBe(800);

    const [read] = await db.select().from(pipelineSettings).where(eq(pipelineSettings.id, 1));
    expect(read.openrouterMinContentChars).toBe(800);
  });
});

describe("openrouter_tokens table (migration 0019)", () => {
  it("inserts a row with defaults for active/sortOrder and nullable rotation/audit fields", async () => {
    const [row] = await db.insert(openrouterTokens)
      .values({ label: "test-token", tokenCiphertext: "iv:tag:ciphertext" })
      .returning();

    try {
      expect(row.id).toBeTruthy();
      expect(row.label).toBe("test-token");
      expect(row.tokenCiphertext).toBe("iv:tag:ciphertext");
      expect(row.active).toBe(true);
      expect(row.sortOrder).toBe(0);
      expect(row.cooldownUntil).toBeNull();
      expect(row.lastStatus).toBeNull();
      expect(row.lastUsedAt).toBeNull();
      expect(row.lastError).toBeNull();
      expect(row.createdBy).toBeNull();
      expect(row.createdAt).not.toBeNull();
      expect(row.updatedAt).not.toBeNull();
    } finally {
      await db.delete(openrouterTokens).where(eq(openrouterTokens.id, row.id));
    }
  });
});
