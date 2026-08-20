import { and, desc, eq } from "drizzle-orm";
import {
  db,
  mcpOauthScope,
  oauthAccessToken,
  oauthApplication,
  oauthConsent,
  user,
} from "@/db";
import type { McpScope } from "@/lib/mcp/scope";
import { scopeFromRow } from "@/lib/mcp/oauth-scope";

export type OauthConnectionRow = {
  id: string;
  userId: string;
  ownerName: string | null;
  clientId: string;
  clientName: string | null;
  canWrite: boolean;
  canReadArticles: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
};

export async function upsertOauthScopeCore(
  { userId, clientId, scope }: { userId: string; clientId: string; scope: McpScope },
): Promise<void> {
  await db
    .insert(mcpOauthScope)
    .values({ userId, clientId, canWrite: scope.canWrite, canReadArticles: scope.canReadArticles })
    .onConflictDoUpdate({
      target: [mcpOauthScope.userId, mcpOauthScope.clientId],
      set: { canWrite: scope.canWrite, canReadArticles: scope.canReadArticles },
    });
}

export async function getOauthScopeCore(
  { userId, clientId }: { userId: string; clientId: string },
): Promise<McpScope> {
  const [row] = await db
    .select({ canWrite: mcpOauthScope.canWrite, canReadArticles: mcpOauthScope.canReadArticles })
    .from(mcpOauthScope)
    .where(and(eq(mcpOauthScope.userId, userId), eq(mcpOauthScope.clientId, clientId)))
    .limit(1);
  return scopeFromRow(row ?? null);
}

export async function touchOauthScopeCore(
  { userId, clientId }: { userId: string; clientId: string },
): Promise<void> {
  await db
    .update(mcpOauthScope)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(mcpOauthScope.userId, userId), eq(mcpOauthScope.clientId, clientId)));
}

export async function listOauthConnectionsCore(
  { userId, seesAll }: { userId: string; seesAll: boolean },
): Promise<OauthConnectionRow[]> {
  const rows = await db
    .select({
      id: mcpOauthScope.id,
      userId: mcpOauthScope.userId,
      ownerName: user.name,
      clientId: mcpOauthScope.clientId,
      clientName: oauthApplication.name,
      canWrite: mcpOauthScope.canWrite,
      canReadArticles: mcpOauthScope.canReadArticles,
      createdAt: mcpOauthScope.createdAt,
      lastUsedAt: mcpOauthScope.lastUsedAt,
    })
    .from(mcpOauthScope)
    .leftJoin(user, eq(user.id, mcpOauthScope.userId))
    .leftJoin(oauthApplication, eq(oauthApplication.clientId, mcpOauthScope.clientId))
    .where(seesAll ? undefined : eq(mcpOauthScope.userId, userId))
    .orderBy(desc(mcpOauthScope.createdAt));
  return rows;
}

export async function revokeOauthConnectionCore(
  { scopeId, userId, seesAll }: { scopeId: string; userId: string; seesAll: boolean },
): Promise<{ ok: boolean; message?: string }> {
  const [row] = await db.select().from(mcpOauthScope).where(eq(mcpOauthScope.id, scopeId)).limit(1);
  if (!row) return { ok: false, message: "Connexion introuvable." };
  if (!seesAll && row.userId !== userId) {
    return { ok: false, message: "Vous ne pouvez révoquer que vos propres connexions." };
  }
  // better-auth n'expose pas d'API de révocation : on supprime directement les jetons + le
  // consentement du plugin pour ce couple (utilisateur, client), puis notre ligne de portée.
  await db.delete(oauthAccessToken).where(
    and(eq(oauthAccessToken.userId, row.userId), eq(oauthAccessToken.clientId, row.clientId)),
  );
  await db.delete(oauthConsent).where(
    and(eq(oauthConsent.userId, row.userId), eq(oauthConsent.clientId, row.clientId)),
  );
  await db.delete(mcpOauthScope).where(eq(mcpOauthScope.id, scopeId));
  return { ok: true };
}
