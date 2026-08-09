import { describe, it, expect, mock, beforeAll, afterAll } from "bun:test";
import { db, wpCategories, user } from "@/db";
import { eq } from "drizzle-orm";

// setCategoryColor — like every RBAC-guarded Server Action in this app (bulkApprove/bulkReject in
// tests/queue-actions.test.ts, createTemplate/etc. in tests/studio-template-actions.test.ts) —
// starts with requireUser() -> next/headers() and ends with revalidatePath() -> next/cache, both
// of which need a real Next.js request/render scope absent from plain `bun test`. Same mock.module
// recipe as those files: capture the REAL exports first (mock.module() mutates a module's exports
// in place, so a live namespace reference would go stale the moment we mock it), register the
// mocks, dynamically import taxonomy-actions.ts so its own static imports resolve against the
// mocks, then restore the real exports in afterAll so nothing leaks into files that run later in
// the same `bun test` process.
const { requireUser: realRequireUser, getSession: realGetSession } = await import("@/lib/session");
const { revalidatePath: realRevalidatePath, revalidateTag: realRevalidateTag } = await import("next/cache");

const [seededEditor] = await db.select({ id: user.id, role: user.role })
  .from(user).where(eq(user.email, "editor@afrotiative.com"));
if (!seededEditor) throw new Error("Seed manquant : editor@afrotiative.com introuvable (bun run db:seed).");
const FAKE_EDITOR = {
  id: seededEditor.id, name: "Test Éditeur", email: "editor@afrotiative.com",
  role: seededEditor.role, banned: false, image: null,
};

// Utilisé uniquement par le describe RBAC ci-dessous : requirePermission lève avant toute écriture,
// mais on réutilise le compte journaliste seedé (README) par cohérence avec FAKE_EDITOR ci-dessus.
const [seededJournalist] = await db.select({ id: user.id, role: user.role })
  .from(user).where(eq(user.email, "journaliste@afrotiative.com"));
if (!seededJournalist) throw new Error("Seed manquant : journaliste@afrotiative.com introuvable (bun run db:seed).");
const FAKE_JOURNALIST = {
  id: seededJournalist.id, name: "Test Journaliste", email: "journaliste@afrotiative.com",
  role: seededJournalist.role, banned: false, image: null,
};

mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: async () => FAKE_EDITOR }));
mock.module("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: realRevalidateTag }));

const { setCategoryColor } = await import("@/lib/actions/taxonomy-actions");

// ─────────────────────────────────────────────────────────────────────────────
// Self-cleaning: this suite creates its OWN category row (unique ZZZTEST_ name, same convention as
// tests/taxonomy-sync.test.ts) rather than touching a seeded one — so a failed assertion never
// leaves a seeded category's colour mutated. Cleanup runs in afterAll unconditionally.
const CAT_NAME = "ZZZTEST_COLOR_CAT";
let categoryId: string;

beforeAll(async () => {
  await db.delete(wpCategories).where(eq(wpCategories.name, CAT_NAME)); // sweep a stray row from an aborted prior run
  const [row] = await db.insert(wpCategories)
    .values({ name: CAT_NAME, slug: "zzztest-color-cat", wpId: null, articleCount: 0 })
    .returning({ id: wpCategories.id });
  categoryId = row.id;
});

afterAll(async () => {
  mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: realRequireUser }));
  mock.module("next/cache", () => ({ revalidatePath: realRevalidatePath, revalidateTag: realRevalidateTag }));
  await db.delete(wpCategories).where(eq(wpCategories.name, CAT_NAME));
});

async function colorInDb(): Promise<string | null> {
  const [row] = await db.select({ color: wpCategories.color }).from(wpCategories).where(eq(wpCategories.id, categoryId));
  return row.color;
}

describe("setCategoryColor", () => {
  it("accepts a strict #RRGGBB hex and persists it (read back from the DB)", async () => {
    const res = await setCategoryColor(categoryId, "#1B7F4A");
    expect(res.ok).toBe(true);
    expect(await colorInDb()).toBe("#1B7F4A"); // proves the WRITE happened, not just the return value
  });

  it("refuses a named colour (rouge), in French, and leaves the stored colour unchanged", async () => {
    const res = await setCategoryColor(categoryId, "rouge");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message.length).toBeGreaterThan(0);
    expect(await colorInDb()).toBe("#1B7F4A"); // unchanged from the previous accepted write
  });

  it("refuses a 3-digit shorthand (#FFF) — strict 6-digit hex only", async () => {
    const res = await setCategoryColor(categoryId, "#FFF");
    expect(res.ok).toBe(false);
    expect(await colorInDb()).toBe("#1B7F4A");
  });

  it("refuses an invalid 6-digit value with a non-hex character (#GGGGGG)", async () => {
    const res = await setCategoryColor(categoryId, "#GGGGGG");
    expect(res.ok).toBe(false);
    expect(await colorInDb()).toBe("#1B7F4A");
  });

  it("null clears the colour back to null", async () => {
    const res = await setCategoryColor(categoryId, null);
    expect(res.ok).toBe(true);
    expect(await colorInDb()).toBeNull();
  });

  it("an empty string also clears the colour back to null", async () => {
    await setCategoryColor(categoryId, "#1B7F4A"); // set it again first
    expect(await colorInDb()).toBe("#1B7F4A");

    const res = await setCategoryColor(categoryId, "");
    expect(res.ok).toBe(true);
    expect(await colorInDb()).toBeNull();
  });
});

describe("setCategoryColor RBAC", () => {
  it("refuses a journalist, without writing", async () => {
    await db.update(wpCategories).set({ color: "#1B7F4A" }).where(eq(wpCategories.id, categoryId));

    mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: async () => FAKE_JOURNALIST }));
    try {
      await expect(setCategoryColor(categoryId, "#000000")).rejects.toThrow();
    } finally {
      mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: async () => FAKE_EDITOR }));
    }

    expect(await colorInDb()).toBe("#1B7F4A"); // unchanged — the write never happened
  });
});
