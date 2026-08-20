import { eq } from "drizzle-orm";
import { db, apiTokens, user as userTable } from "@/db";
import { prefixOf, tokenMatches } from "@/lib/mcp/token";
import { isSessionUsable } from "@/lib/session";
import { getVideoSettings } from "@/lib/queries/video-settings";
import { auth } from "@/lib/auth";
import { getOauthScopeCore, touchOauthScopeCore } from "@/lib/queries/mcp-oauth";
import { buildOauthActor } from "@/lib/mcp/oauth-actor";
import type { Role } from "@/lib/auth";
import type { McpScope } from "@/lib/mcp/scope";

export type McpActor = { userId: string; role: Role; tokenId: string; scope: McpScope };
export type AuthOutcome =
  | { ok: true; actor: McpActor }
  | { ok: false; status: 401 | 403 | 503; message: string };

// UN SEUL message pour tous les échecs d'authentification. Distinguer « jeton inconnu » de
// « jeton révoqué » dirait à un attaquant que son jeton a EXISTÉ — c'est un oracle, et il ne coûte
// rien à supprimer.
const REJECT = "Jeton d'API invalide ou révoqué.";

export async function authenticateMcp(authorizationHeader: string | null): Promise<AuthOutcome> {
  // L'interrupteur AVANT le jeton : inutile de faire travailler l'authentification quand la porte
  // est close, et l'agent reçoit une cause actionnable plutôt qu'un 401 trompeur.
  const settings = await getVideoSettings();
  if (!settings.mcpEnabled) {
    return { ok: false, status: 503, message: "Le serveur MCP est désactivé dans les réglages." };
  }

  const raw = authorizationHeader?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!raw) return { ok: false, status: 401, message: REJECT };

  // Un en-tête d'un autre espace de noms n'atteint jamais la table des jetons personnels : on
  // tente plutôt le jeton d'accès OAuth (claude.ai web) avant de renoncer.
  const prefix = prefixOf(raw);
  if (!prefix) {
    const headers = new Headers(authorizationHeader ? { authorization: authorizationHeader } : {});
    const oauthSession = await auth.api.getMcpSession({ headers });
    if (!oauthSession) return { ok: false, status: 401, message: REJECT };
    const [owner] = await db.select().from(userTable).where(eq(userTable.id, oauthSession.userId)).limit(1);
    const scope = await getOauthScopeCore({ userId: oauthSession.userId, clientId: oauthSession.clientId });
    const outcome = buildOauthActor({
      session: { userId: oauthSession.userId, clientId: oauthSession.clientId },
      owner: owner ? { role: owner.role, banned: owner.banned } : null,
      scope,
    });
    if (outcome.ok) {
      await touchOauthScopeCore({ userId: oauthSession.userId, clientId: oauthSession.clientId });
    }
    return outcome;
  }

  const [row] = await db.select().from(apiTokens).where(eq(apiTokens.prefix, prefix)).limit(1);
  if (!row) return { ok: false, status: 401, message: REJECT };
  if (row.revokedAt) return { ok: false, status: 401, message: REJECT };
  if (!tokenMatches(raw, row.tokenHash)) return { ok: false, status: 401, message: REJECT };

  const [owner] = await db.select().from(userTable).where(eq(userTable.id, row.userId)).limit(1);
  if (!owner || !isSessionUsable(owner)) {
    return { ok: false, status: 401, message: REJECT };
  }

  await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.id));

  return {
    ok: true,
    actor: {
      userId: row.userId, role: owner.role, tokenId: row.id,
      scope: { canWrite: row.canWrite, canReadArticles: row.canReadArticles },
    },
  };
}
