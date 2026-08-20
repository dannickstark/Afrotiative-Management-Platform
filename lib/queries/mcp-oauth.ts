import { and, desc, eq } from "drizzle-orm";
import {
  db,
  mcpOauthScope,
  oauthAccessToken,
  oauthApplication,
  oauthConsent,
  user,
  verification,
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

export type OauthConsentGrant = { userId: string; clientId: string };

// Fix — Task 6 review, "Important correctness issue": lit la ligne `verification` posée par le
// plugin OIDC de better-auth pour ce `consent_code` — la MÊME table que celle interrogée par son
// `internalAdapter.findVerificationValue` (node_modules/better-auth/dist/plugins/oidc-provider/
// index.mjs's oAuthConsent handler : `WHERE identifier = consentCode ORDER BY createdAt DESC
// LIMIT 1`, JSON { userId, clientId, ... }). Lue ici directement via drizzle plutôt qu'appelée via
// `auth.$context.internalAdapter` — un point d'entrée `$`-préfixé non documenté, jamais réutilisé
// ailleurs dans la librairie elle-même, qui pourrait changer de forme sans préavis de version.
// Le schéma de la table `verification` (identifier/value/expiresAt), lui, est un socle de
// better-auth déjà exploité par CE dépôt (drizzleAdapter dans lib/auth.ts) — bien plus stable, et
// cohérent avec revokeOauthConnectionCore ci-dessous, qui manipule déjà directement les tables
// oauth_access_token/oauth_consent faute d'API de révocation exposée.
//
// Pourquoi ce détour est nécessaire : `approveOauthConsent` doit clouer la ligne de portée
// (mcp_oauth_scope) sur le userId/clientId AUTORITAIRES du consent_code — ceux que
// `auth.api.oAuthConsent` liera réellement à l'octroi — jamais sur la session en cours ni sur le
// clientId soumis par le POST (tous deux falsifiables/désynchronisables : un clientId trafiqué
// écrirait une portée pour le mauvais client ; un onglet resté ouvert après changement de session
// l'écrirait pour le mauvais utilisateur, qui retomberait alors silencieusement sur le scope par
// défaut). `null` — jamais une valeur partielle — dès que la ligne est absente, expirée, ou que
// son JSON ne contient pas les deux champs attendus : l'appelant doit refuser d'enregistrer une
// portée plutôt que de la lier au mauvais compte.
export async function findOauthConsentGrant(consentCode: string): Promise<OauthConsentGrant | null> {
  if (!consentCode) return null;
  const [row] = await db
    .select({ value: verification.value, expiresAt: verification.expiresAt })
    .from(verification)
    .where(eq(verification.identifier, consentCode))
    .orderBy(desc(verification.createdAt))
    .limit(1);
  if (!row || row.expiresAt.getTime() < Date.now()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { userId, clientId } = parsed as { userId?: unknown; clientId?: unknown };
  if (typeof userId !== "string" || !userId) return null;
  if (typeof clientId !== "string" || !clientId) return null;
  return { userId, clientId };
}

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
