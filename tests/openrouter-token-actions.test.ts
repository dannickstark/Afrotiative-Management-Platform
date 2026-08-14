// tests/openrouter-token-actions.test.ts — Task 6 (DB lane, deliberately NOT added to
// scripts/test-fast.ts's PURE_FILES: real Neon dev DB + a real seeded editor/journalist user).
// Covers RBAC on lib/rbac.ts's new "llmTokens" resource, the guarded writes in
// lib/actions/openrouter-token-actions.ts, and the masked read in
// lib/queries/openrouter-tokens.ts. Every seeded row is deleted in try/finally so the shared dev DB
// is never left polluted — same convention as tests/openrouter-token-pool.test.ts and
// tests/openrouter-tokens-schema.test.ts.
import { describe, it, expect, beforeAll, afterAll, mock } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, openrouterTokens, user } from "@/db";
import { can } from "@/lib/rbac";

// This suite exercises a real encrypt/decrypt round trip (addOpenRouterToken calls encryptSecret),
// so it needs its own valid CREDENTIALS_ENCRYPTION_KEY — set/restored HERE, file-scoped, same
// per-file convention as tests/openrouter-token-pool.test.ts, tests/diffusion-crypto.test.ts, etc.
const SAVED_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY;
beforeAll(() => {
  process.env.CREDENTIALS_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});
afterAll(() => {
  if (SAVED_KEY === undefined) delete process.env.CREDENTIALS_ENCRYPTION_KEY;
  else process.env.CREDENTIALS_ENCRYPTION_KEY = SAVED_KEY;
});

describe("RBAC — llmTokens resource (lib/rbac.ts)", () => {
  it("editor and admin may manage; journalist may not", () => {
    expect(can("editor", "llmTokens", "manage")).toBe(true);
    expect(can("admin", "llmTokens", "manage")).toBe(true);
    expect(can("journalist", "llmTokens", "manage")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The guarded actions start with requireUser() → next/headers(), which does not work outside a
// real Next.js request/render scope under plain `bun test` (same constraint documented at length
// in tests/queue-actions.test.ts and reused verbatim by tests/article-actions.test.ts,
// tests/studio-manual.test.ts). Same recipe: capture the REAL exports as plain values first,
// register mock.module() stubs per-role, dynamically `import()` the action module so its own
// static imports resolve against the mock, and restore the real exports in afterAll.
const { requireUser: realRequireUser, getSession: realGetSession } = await import("@/lib/session");
const { revalidatePath: realRevalidatePath } = await import("next/cache");

const [seededEditor] = await db.select({ id: user.id, role: user.role })
  .from(user).where(eq(user.email, "editor@afrotiative.com"));
if (!seededEditor) throw new Error("Seed manquant : editor@afrotiative.com introuvable (bun run db:seed).");
const FAKE_EDITOR = {
  id: seededEditor.id, name: "Test Éditeur", email: "editor@afrotiative.com",
  role: seededEditor.role, banned: false, image: null,
};

const [seededJournalist] = await db.select({ id: user.id, role: user.role })
  .from(user).where(eq(user.email, "journaliste@afrotiative.com"));
if (!seededJournalist) throw new Error("Seed manquant : journaliste@afrotiative.com introuvable (bun run db:seed).");
const FAKE_JOURNALIST = {
  id: seededJournalist.id, name: "Test Journaliste", email: "journaliste@afrotiative.com",
  role: seededJournalist.role, banned: false, image: null,
};

mock.module("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

afterAll(() => {
  mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: realRequireUser }));
  mock.module("next/cache", () => ({ revalidatePath: realRevalidatePath, revalidateTag: () => {} }));
});

const createdIds: string[] = [];
async function cleanup() {
  if (createdIds.length) {
    for (const id of createdIds.splice(0)) {
      await db.delete(openrouterTokens).where(eq(openrouterTokens.id, id));
    }
  }
}
afterAll(cleanup);

describe("addOpenRouterToken — RBAC + encryption", () => {
  it("denies a journalist", async () => {
    mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: async () => FAKE_JOURNALIST }));
    const { addOpenRouterToken } = await import("@/lib/actions/openrouter-token-actions");
    await expect(
      addOpenRouterToken({ label: "should-not-insert", token: "sk-should-not-insert" }),
    ).rejects.toThrow();

    // Belt-and-braces: the denied call must not have reached the DB at all.
    const [row] = await db.select().from(openrouterTokens).where(eq(openrouterTokens.label, "should-not-insert"));
    expect(row).toBeUndefined();
  });

  it("allows an editor, encrypts the token, and records createdBy", async () => {
    mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: async () => FAKE_EDITOR }));
    const { addOpenRouterToken } = await import("@/lib/actions/openrouter-token-actions");

    const plaintext = "sk-or-v1-test-secret-token";
    const res = await addOpenRouterToken({ label: "editor-token", token: plaintext });
    expect(res.ok).toBe(true);

    const [row] = await db.select().from(openrouterTokens).where(eq(openrouterTokens.label, "editor-token"));
    expect(row).toBeTruthy();
    createdIds.push(row.id);

    expect(row.tokenCiphertext).not.toBe(plaintext);
    expect(row.tokenCiphertext.includes(plaintext)).toBe(false);
    expect(row.createdBy).toBe(FAKE_EDITOR.id);
  });

  it("refuses (does not throw) when label or token is blank", async () => {
    mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: async () => FAKE_EDITOR }));
    const { addOpenRouterToken } = await import("@/lib/actions/openrouter-token-actions");

    const noLabel = await addOpenRouterToken({ label: "   ", token: "sk-x" });
    expect(noLabel.ok).toBe(false);

    const noToken = await addOpenRouterToken({ label: "x", token: "   " });
    expect(noToken.ok).toBe(false);
  });
});

describe("getOpenRouterTokensMasked — never leaks plaintext or ciphertext", () => {
  it("returns the row with no property equal to the plaintext or ciphertext", async () => {
    mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: async () => FAKE_EDITOR }));
    const { addOpenRouterToken } = await import("@/lib/actions/openrouter-token-actions");
    const { getOpenRouterTokensMasked } = await import("@/lib/queries/openrouter-tokens");

    const plaintext = "sk-or-v1-masked-read-secret";
    await addOpenRouterToken({ label: "masked-read-token", token: plaintext });
    const [row] = await db.select().from(openrouterTokens).where(eq(openrouterTokens.label, "masked-read-token"));
    createdIds.push(row.id);
    const ciphertext = row.tokenCiphertext;

    const masked = await getOpenRouterTokensMasked();
    const entry = masked.find((t) => t.id === row.id);
    expect(entry).toBeTruthy();

    for (const value of Object.values(entry!)) {
      expect(value).not.toBe(plaintext);
      expect(value).not.toBe(ciphertext);
    }
    // The shape itself has no key named after the ciphertext column — not just "the value differs".
    expect(Object.keys(entry!)).not.toContain("tokenCiphertext");

    expect(entry!.label).toBe("masked-read-token");
    expect(entry!.active).toBe(true);
    expect(entry!).toHaveProperty("lastStatus");
  });
});

describe("setOpenRouterTokenActive / deleteOpenRouterToken — editor", () => {
  it("toggles active, then deletes the row", async () => {
    mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: async () => FAKE_EDITOR }));
    const { addOpenRouterToken, setOpenRouterTokenActive, deleteOpenRouterToken } =
      await import("@/lib/actions/openrouter-token-actions");

    await addOpenRouterToken({ label: "toggle-delete-token", token: "sk-toggle-delete" });
    const [row] = await db.select().from(openrouterTokens).where(eq(openrouterTokens.label, "toggle-delete-token"));
    expect(row.active).toBe(true);

    const toggled = await setOpenRouterTokenActive(row.id, false);
    expect(toggled.ok).toBe(true);
    const [afterToggle] = await db.select().from(openrouterTokens).where(eq(openrouterTokens.id, row.id));
    expect(afterToggle.active).toBe(false);

    const deleted = await deleteOpenRouterToken(row.id);
    expect(deleted.ok).toBe(true);
    const [afterDelete] = await db.select().from(openrouterTokens).where(eq(openrouterTokens.id, row.id));
    expect(afterDelete).toBeUndefined();
    // Already gone — nothing left for the top-level afterAll(cleanup) to delete.
  });
});
