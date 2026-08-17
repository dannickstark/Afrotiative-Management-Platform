import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, apiTokens, videoSettings } from "@/db";
import { eq } from "drizzle-orm";
import { createApiTokenCore, revokeApiTokenCore, setMcpEnabledCore, listTokensCore } from "@/lib/queries/mcp";
import { authenticateMcp } from "@/lib/mcp/auth";
import { makeUser } from "./mcp-harness";
import { FULL_SCOPE } from "@/lib/mcp/scope";
import { generateToken } from "@/lib/mcp/token";

let editor: Awaited<ReturnType<typeof makeUser>>;
let journalist: Awaited<ReturnType<typeof makeUser>>;
const created: string[] = [];

beforeAll(async () => {
  editor = await makeUser("editor");
  journalist = await makeUser("journalist");
});

afterAll(async () => {
  for (const id of created) await db.delete(apiTokens).where(eq(apiTokens.id, id));
  const [s] = await db.select().from(videoSettings).limit(1);
  if (s) await db.update(videoSettings).set({ mcpEnabled: true }).where(eq(videoSettings.id, s.id));
  await editor.cleanup();
  await journalist.cleanup();
});

describe("createApiTokenCore", () => {
  it("rend un jeton utilisable, une seule fois", async () => {
    const r = await createApiTokenCore({ userId: editor.userId, name: "Portable", scope: FULL_SCOPE });
    created.push(r.tokenId);
    const auth = await authenticateMcp(`Bearer ${r.token}`);
    expect(auth.ok).toBe(true);
    if (auth.ok) expect(auth.actor.userId).toBe(editor.userId);
  });

  it("le jeton en clair n'apparaît JAMAIS dans la liste — seul le préfixe", async () => {
    const r = await createApiTokenCore({ userId: editor.userId, name: "Bureau", scope: FULL_SCOPE });
    created.push(r.tokenId);
    const rows = await listTokensCore({ userId: editor.userId, seesAll: false });
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(r.token);
    expect(serialized).toContain(r.token.slice(0, 15));
  });
});

describe("listTokensCore", () => {
  it("un membre ne voit que ses propres jetons", async () => {
    const mine = await createApiTokenCore({ userId: journalist.userId, name: "À moi", scope: FULL_SCOPE });
    created.push(mine.tokenId);
    const rows = await listTokensCore({ userId: journalist.userId, seesAll: false });
    expect(rows.every((r) => r.userId === journalist.userId)).toBe(true);
  });

  it("un porteur de video:configure voit ceux de toute l'équipe", async () => {
    const rows = await listTokensCore({ userId: editor.userId, seesAll: true });
    expect(rows.some((r) => r.userId === journalist.userId)).toBe(true);
  });

  // Round de correction final, I2 : le spec §6.2 promet « nom, préfixe, PROPRIÉTAIRE, dernière
  // utilisation, date de création ». Sans cette jointure, la vue « toute l'équipe » — seul intérêt
  // du droit video:configure sur ce panneau — nommait les jetons sans jamais dire à qui ils sont.
  it("nomme le porteur de chaque jeton", async () => {
    const rows = await listTokensCore({ userId: editor.userId, seesAll: true });
    const sien = rows.find((r) => r.userId === journalist.userId);
    expect(sien?.ownerName).toBe("Porteur de test réglages MCP");
  });
});

describe("revokeApiTokenCore", () => {
  it("un jeton révoqué cesse immédiatement de fonctionner", async () => {
    const r = await createApiTokenCore({ userId: editor.userId, name: "Jetable", scope: FULL_SCOPE });
    created.push(r.tokenId);
    await revokeApiTokenCore({ tokenId: r.tokenId, userId: editor.userId, seesAll: false });
    const auth = await authenticateMcp(`Bearer ${r.token}`);
    expect(auth.ok).toBe(false);
  });

  it("un membre ne peut pas révoquer le jeton d'un autre", async () => {
    const other = await createApiTokenCore({ userId: journalist.userId, name: "Pas à toi", scope: FULL_SCOPE });
    created.push(other.tokenId);
    const res = await revokeApiTokenCore({ tokenId: other.tokenId, userId: editor.userId, seesAll: false });
    expect(res.ok).toBe(false);
  });

  it("la révocation est douce : la ligne survit, l'attribution du journal garde son sens", async () => {
    const r = await createApiTokenCore({ userId: editor.userId, name: "Doux", scope: FULL_SCOPE });
    created.push(r.tokenId);
    await revokeApiTokenCore({ tokenId: r.tokenId, userId: editor.userId, seesAll: false });
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, r.tokenId));
    expect(row).toBeDefined();
    expect(row.revokedAt).not.toBeNull();
  });
});

describe("setMcpEnabledCore", () => {
  it("fermer l'interrupteur fait échouer un jeton parfaitement valide, en 503", async () => {
    const r = await createApiTokenCore({ userId: editor.userId, name: "Valide", scope: FULL_SCOPE });
    created.push(r.tokenId);
    await setMcpEnabledCore({ enabled: false, userId: editor.userId });
    const auth = await authenticateMcp(`Bearer ${r.token}`);
    await setMcpEnabledCore({ enabled: true, userId: editor.userId });

    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(auth.status).toBe(503);
  });

  it("rouvrir l'interrupteur remet le même jeton en service", async () => {
    const r = await createApiTokenCore({ userId: editor.userId, name: "Reprise", scope: FULL_SCOPE });
    created.push(r.tokenId);
    await setMcpEnabledCore({ enabled: false, userId: editor.userId });
    await setMcpEnabledCore({ enabled: true, userId: editor.userId });
    const auth = await authenticateMcp(`Bearer ${r.token}`);
    expect(auth.ok).toBe(true);
  });
});

describe("portée d'un jeton", () => {
  it("persiste la portée demandée et la remonte dans la liste", async () => {
    const { tokenId } = await createApiTokenCore({
      userId: editor.userId, name: `Test-Portée-${Date.now()}`,
      scope: { canWrite: false, canReadArticles: false },
    });
    created.push(tokenId);
    const row = (await listTokensCore({ userId: editor.userId, seesAll: false })).find((t) => t.id === tokenId);
    expect(row?.canWrite).toBe(false);
    expect(row?.canReadArticles).toBe(false);
  });

  it("un jeton créé avec la portée complète a les pouvoirs d'avant les portées", async () => {
    const { tokenId } = await createApiTokenCore({
      userId: editor.userId, name: `Test-Complète-${Date.now()}`, scope: FULL_SCOPE,
    });
    created.push(tokenId);
    const row = (await listTokensCore({ userId: editor.userId, seesAll: false })).find((t) => t.id === tokenId);
    expect(row?.canWrite).toBe(true);
    expect(row?.canReadArticles).toBe(true);
  });

  it("une ligne écrite sans portée explicite est complète — rétro-compatibilité des jetons déjà émis", async () => {
    // Insertion DIRECTE, sans passer par createApiTokenCore : c'est l'exacte forme des lignes qui
    // existaient avant la migration. Le défaut de colonne est ce qui garantit qu'aucun agent ne casse.
    const t = generateToken();
    const [row] = await db.insert(apiTokens)
      .values({ userId: editor.userId, name: `Test-Ancien-${Date.now()}`, prefix: t.prefix, tokenHash: t.tokenHash })
      .returning();
    created.push(row.id);
    expect(row.canWrite).toBe(true);
    expect(row.canReadArticles).toBe(true);
  });

  // Round de correction finale, constat 2 : aucun test ne fermait la boucle base → acteur. Les
  // tests d'outils MCP (tests/mcp-tools.test.ts) INJECTENT la portée par `makeActor({ scope })`
  // sans jamais repasser par `authenticateMcp`, et le harnais insère même la ligne de jeton SANS
  // les colonnes de portée (tests/mcp-harness.ts) : ligne et acteur peuvent diverger sans qu'aucun
  // test ne s'en aperçoive. Si `lib/mcp/auth.ts` renvoyait `FULL_SCOPE` en dur au lieu de
  // `{ canWrite: row.canWrite, canReadArticles: row.canReadArticles }`, toute la suite resterait
  // verte. Celui-ci crée un jeton restreint par le vrai chemin d'écriture (createApiTokenCore) et
  // authentifie par le vrai chemin de lecture (authenticateMcp) — la seule façon d'éprouver le
  // câblage réel entre les deux.
  it("authenticateMcp câble la portée de la ligne dans l'acteur, pas seulement `listTokensCore`", async () => {
    const { tokenId, token } = await createApiTokenCore({
      userId: editor.userId, name: `Test-Cablage-${Date.now()}`,
      scope: { canWrite: false, canReadArticles: false },
    });
    created.push(tokenId);

    const auth = await authenticateMcp(`Bearer ${token}`);
    expect(auth.ok).toBe(true);
    if (auth.ok) {
      expect(auth.actor.scope).toEqual({ canWrite: false, canReadArticles: false });
    }
  });
});
