import { eq } from "drizzle-orm";
import { db, apiTokens, user as userTable } from "@/db";
import { prefixOf, tokenMatches } from "@/lib/mcp/token";
import { isSessionUsable } from "@/lib/session";
import { getVideoSettings } from "@/lib/queries/video-settings";
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

  // Un en-tête d'un autre espace de noms n'atteint jamais la base : on économise une requête sur
  // chaque sonde automatisée qui passe.
  const prefix = prefixOf(raw);
  if (!prefix) return { ok: false, status: 401, message: REJECT };

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
