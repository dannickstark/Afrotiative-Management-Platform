import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, apiTokens, videoSettings } from "@/db";
import { eq } from "drizzle-orm";
import { generateToken } from "@/lib/mcp/token";
import { authenticateMcp } from "@/lib/mcp/auth";

let tokenId: string;
let plain: string;
let userId: string;

beforeAll(async () => {
  const users = await db.query.user.findMany({ limit: 1 });
  userId = users[0].id;
  const t = generateToken();
  plain = t.token;
  const [row] = await db.insert(apiTokens)
    .values({ userId, name: "Test MCP", prefix: t.prefix, tokenHash: t.tokenHash })
    .returning();
  tokenId = row.id;
});

afterAll(async () => {
  await db.delete(apiTokens).where(eq(apiTokens.id, tokenId));
  const [s] = await db.select().from(videoSettings).limit(1);
  if (s) await db.update(videoSettings).set({ mcpEnabled: true }).where(eq(videoSettings.id, s.id));
});

describe("authenticateMcp", () => {
  it("accepte un jeton valide et rend son porteur", async () => {
    const r = await authenticateMcp(`Bearer ${plain}`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.actor.userId).toBe(userId);
      expect(r.actor.tokenId).toBe(tokenId);
    }
  });

  it("met à jour la date de dernière utilisation", async () => {
    await authenticateMcp(`Bearer ${plain}`);
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, tokenId));
    expect(row.lastUsedAt).not.toBeNull();
  });

  it("refuse un en-tête absent", async () => {
    const r = await authenticateMcp(null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it("refuse un jeton d'un autre espace de noms sans toucher la base", async () => {
    const r = await authenticateMcp("Bearer sk-quelque-chose-etranger-et-long");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it("donne le MÊME message pour un jeton inconnu et pour un jeton révoqué", async () => {
    const inconnu = await authenticateMcp(`Bearer ${generateToken().token}`);
    await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, tokenId));
    const revoque = await authenticateMcp(`Bearer ${plain}`);
    await db.update(apiTokens).set({ revokedAt: null }).where(eq(apiTokens.id, tokenId));

    expect(inconnu.ok).toBe(false);
    expect(revoque.ok).toBe(false);
    // Le point : distinguer les deux dirait à un attaquant que son jeton a EXISTÉ.
    if (!inconnu.ok && !revoque.ok) expect(revoque.message).toBe(inconnu.message);
  });

  it("refuse tout, avec 503, quand l'interrupteur est fermé — même un jeton parfaitement valide", async () => {
    const [s] = await db.select().from(videoSettings).limit(1);
    await db.update(videoSettings).set({ mcpEnabled: false }).where(eq(videoSettings.id, s.id));
    const r = await authenticateMcp(`Bearer ${plain}`);
    await db.update(videoSettings).set({ mcpEnabled: true }).where(eq(videoSettings.id, s.id));

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(503);
      expect(r.message).toContain("désactivé");
    }
  });
});
