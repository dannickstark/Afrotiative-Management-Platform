import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, apiTokens, videoSettings } from "@/db";
import { eq } from "drizzle-orm";
import { createApiTokenCore, revokeApiTokenCore, setMcpEnabledCore, listTokensCore } from "@/lib/queries/mcp";
import { authenticateMcp } from "@/lib/mcp/auth";
import { makeUser } from "./mcp-harness";

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
    const r = await createApiTokenCore({ userId: editor.userId, name: "Portable" });
    created.push(r.tokenId);
    const auth = await authenticateMcp(`Bearer ${r.token}`);
    expect(auth.ok).toBe(true);
    if (auth.ok) expect(auth.actor.userId).toBe(editor.userId);
  });

  it("le jeton en clair n'apparaît JAMAIS dans la liste — seul le préfixe", async () => {
    const r = await createApiTokenCore({ userId: editor.userId, name: "Bureau" });
    created.push(r.tokenId);
    const rows = await listTokensCore({ userId: editor.userId, seesAll: false });
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(r.token);
    expect(serialized).toContain(r.token.slice(0, 15));
  });
});

describe("listTokensCore", () => {
  it("un membre ne voit que ses propres jetons", async () => {
    const mine = await createApiTokenCore({ userId: journalist.userId, name: "À moi" });
    created.push(mine.tokenId);
    const rows = await listTokensCore({ userId: journalist.userId, seesAll: false });
    expect(rows.every((r) => r.userId === journalist.userId)).toBe(true);
  });

  it("un porteur de video:configure voit ceux de toute l'équipe", async () => {
    const rows = await listTokensCore({ userId: editor.userId, seesAll: true });
    expect(rows.some((r) => r.userId === journalist.userId)).toBe(true);
  });
});

describe("revokeApiTokenCore", () => {
  it("un jeton révoqué cesse immédiatement de fonctionner", async () => {
    const r = await createApiTokenCore({ userId: editor.userId, name: "Jetable" });
    created.push(r.tokenId);
    await revokeApiTokenCore({ tokenId: r.tokenId, userId: editor.userId, seesAll: false });
    const auth = await authenticateMcp(`Bearer ${r.token}`);
    expect(auth.ok).toBe(false);
  });

  it("un membre ne peut pas révoquer le jeton d'un autre", async () => {
    const other = await createApiTokenCore({ userId: journalist.userId, name: "Pas à toi" });
    created.push(other.tokenId);
    const res = await revokeApiTokenCore({ tokenId: other.tokenId, userId: editor.userId, seesAll: false });
    expect(res.ok).toBe(false);
  });

  it("la révocation est douce : la ligne survit, l'attribution du journal garde son sens", async () => {
    const r = await createApiTokenCore({ userId: editor.userId, name: "Doux" });
    created.push(r.tokenId);
    await revokeApiTokenCore({ tokenId: r.tokenId, userId: editor.userId, seesAll: false });
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, r.tokenId));
    expect(row).toBeDefined();
    expect(row.revokedAt).not.toBeNull();
  });
});

describe("setMcpEnabledCore", () => {
  it("fermer l'interrupteur fait échouer un jeton parfaitement valide, en 503", async () => {
    const r = await createApiTokenCore({ userId: editor.userId, name: "Valide" });
    created.push(r.tokenId);
    await setMcpEnabledCore({ enabled: false, userId: editor.userId });
    const auth = await authenticateMcp(`Bearer ${r.token}`);
    await setMcpEnabledCore({ enabled: true, userId: editor.userId });

    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(auth.status).toBe(503);
  });

  it("rouvrir l'interrupteur remet le même jeton en service", async () => {
    const r = await createApiTokenCore({ userId: editor.userId, name: "Reprise" });
    created.push(r.tokenId);
    await setMcpEnabledCore({ enabled: false, userId: editor.userId });
    await setMcpEnabledCore({ enabled: true, userId: editor.userId });
    const auth = await authenticateMcp(`Bearer ${r.token}`);
    expect(auth.ok).toBe(true);
  });
});
