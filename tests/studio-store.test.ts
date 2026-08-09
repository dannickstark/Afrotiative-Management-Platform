import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { computeInputHash, storageKeyFor, MemoryRenderStore, R2RenderStore, findCachedRender, saveRender } from "@/lib/studio/store";
import { db, renders } from "@/db";
import { eq } from "drizzle-orm";

// Isolate R2 env vars for testing
const R2_KEYS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE_URL"] as const;
const r2Saved: Record<string, string | undefined> = {};
for (const k of R2_KEYS) r2Saved[k] = process.env[k];

function setAllR2(v: string | undefined) {
  for (const k of R2_KEYS) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

const baseInput = {
  templateId: "11111111-1111-1111-1111-111111111111",
  templateVersion: 3,
  values: { "article.title": "Titre", "category.color": "#1B7F4A" } as const,
};

describe("computeInputHash", () => {
  it("est stable pour des entrées identiques", () => {
    expect(computeInputHash(baseInput)).toBe(computeInputHash(structuredClone(baseInput)));
  });

  it("est insensible à l'ordre des clés de valeurs", () => {
    const reordered = { ...baseInput, values: { "category.color": "#1B7F4A", "article.title": "Titre" } as const };
    expect(computeInputHash(reordered)).toBe(computeInputHash(baseInput));
  });

  it("change si la version du gabarit change", () => {
    expect(computeInputHash({ ...baseInput, templateVersion: 4 })).not.toBe(computeInputHash(baseInput));
  });

  it("change si une valeur change", () => {
    expect(computeInputHash({ ...baseInput, values: { ...baseInput.values, "article.title": "Autre" } }))
      .not.toBe(computeInputHash(baseInput));
  });
});

describe("storageKeyFor", () => {
  it("range par année et mois avec la bonne extension", () => {
    expect(storageKeyFor("abc123", "image/jpeg", new Date("2026-08-09T10:00:00Z")))
      .toBe("renders/2026/08/abc123.jpg");
    expect(storageKeyFor("abc123", "image/webp", new Date("2026-01-02T10:00:00Z")))
      .toBe("renders/2026/01/abc123.webp");
  });

  it("utilise UTC et ne bascule pas au fuseau local à la limite des mois", () => {
    // 2026-01-31T23:30:00Z is late in January UTC.
    // This would roll to February in some local timezones; the test ensures we use UTC.
    expect(storageKeyFor("abc123", "image/jpeg", new Date("2026-01-31T23:30:00Z")))
      .toBe("renders/2026/01/abc123.jpg");
  });
});

describe("MemoryRenderStore", () => {
  it("conserve les octets et renvoie une URL utilisable", async () => {
    const store = new MemoryRenderStore();
    const url = await store.put("renders/2026/08/x.jpg", new Uint8Array([1, 2, 3]), "image/jpeg");
    expect(url).toContain("renders/2026/08/x.jpg");
    expect(store.objects.get("renders/2026/08/x.jpg")).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("R2RenderStore", () => {
  beforeEach(() => setAllR2(undefined));
  afterAll(() => { for (const k of R2_KEYS) { if (r2Saved[k] === undefined) delete process.env[k]; else process.env[k] = r2Saved[k]!; } });

  it("lève une erreur si R2 n'est pas configuré", async () => {
    const store = new R2RenderStore();
    try {
      await store.put("test/key", new Uint8Array([1, 2, 3]), "image/jpeg");
      expect.unreachable("R2RenderStore.put should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("Stockage R2 non configuré");
    }
  });
});

describe("Cache round-trip (DB-backed)", () => {
  let testHash: string;

  beforeAll(() => {
    testHash = computeInputHash({
      templateId: "22222222-2222-2222-2222-222222222222",
      templateVersion: 1,
      values: { "article.title": "Test Article" },
    });
  });

  afterAll(async () => {
    // Clean up test data
    await db.delete(renders).where(eq(renders.inputHash, testHash));
  });

  it("sauvegarde et retrouve un rendu en cache par son hash", async () => {
    const row = await saveRender({
      templateId: "22222222-2222-2222-2222-222222222222",
      templateVersion: 1,
      context: "article",
      subjectType: "article",
      subjectId: "33333333-3333-3333-3333-333333333333",
      inputHash: testHash,
      storageKey: "renders/2026/08/test.jpg",
      url: "https://example.com/renders/2026/08/test.jpg",
      width: 1200,
      height: 630,
      bytes: 12345,
      degraded: false,
    });
    expect(row.id).toBeDefined();
    expect(row.inputHash).toBe(testHash);

    const cached = await findCachedRender(testHash);
    expect(cached).toBeDefined();
    expect(cached?.inputHash).toBe(testHash);
    expect(cached?.url).toBe("https://example.com/renders/2026/08/test.jpg");
  });
});
