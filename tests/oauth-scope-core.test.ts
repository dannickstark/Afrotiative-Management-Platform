import { afterAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db, user, oauthApplication, mcpOauthScope } from "@/db";
import {
  upsertOauthScopeCore, getOauthScopeCore, listOauthConnectionsCore, revokeOauthConnectionCore,
} from "@/lib/queries/mcp-oauth";

const uid = "test-oauth-user-1";
const cid = "test-oauth-client-1";

afterAll(async () => {
  await db.delete(mcpOauthScope).where(eq(mcpOauthScope.userId, uid));
  await db.delete(oauthApplication).where(eq(oauthApplication.clientId, cid));
  await db.delete(user).where(eq(user.id, uid));
});

test("upsert → get → list → revoke", async () => {
  await db.insert(user).values({ id: uid, name: "Testeur", email: "t-oauth@x.test" }).onConflictDoNothing();
  await db.insert(oauthApplication).values({
    id: "app-1", name: "Claude test", clientId: cid, redirectUrls: "https://claude.ai/cb", type: "web",
  }).onConflictDoNothing();

  await upsertOauthScopeCore({ userId: uid, clientId: cid, scope: { canWrite: true, canReadArticles: false } });
  expect(await getOauthScopeCore({ userId: uid, clientId: cid })).toEqual({ canWrite: true, canReadArticles: false });

  await upsertOauthScopeCore({ userId: uid, clientId: cid, scope: { canWrite: false, canReadArticles: true } });
  expect(await getOauthScopeCore({ userId: uid, clientId: cid })).toEqual({ canWrite: false, canReadArticles: true });

  const list = await listOauthConnectionsCore({ userId: uid, seesAll: false });
  expect(list.find((r) => r.clientId === cid)?.clientName).toBe("Claude test");

  const [row] = await db.select().from(mcpOauthScope).where(and(eq(mcpOauthScope.userId, uid), eq(mcpOauthScope.clientId, cid))).limit(1);
  const res = await revokeOauthConnectionCore({ scopeId: row.id, userId: uid, seesAll: false });
  expect(res.ok).toBe(true);
  expect(await getOauthScopeCore({ userId: uid, clientId: cid })).toEqual({ canWrite: true, canReadArticles: false }); // défaut après suppression
});
