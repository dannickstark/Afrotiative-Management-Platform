// lib/queries/mcp.ts — Task 6: le cœur brut des réglages MCP. Délibérément SANS "use server" — même
// motif que lib/actions/openrouter-token-actions.ts : chaque export d'un module "use server" est un
// point d'entrée réseau SANS authentification propre, donc ce fichier ne fait que lire/écrire la
// base sur des paramètres déjà résolus (userId, seesAll…), et lib/actions/mcp-actions.ts est le
// SEUL endroit qui appelle requireUser() + requirePermission() avant de les invoquer. Les tests
// (tests/mcp-actions.test.ts) appellent ces fonctions *Core directement, sans passer par une
// session — c'est ce qui rend le test possible sans mock de next/headers.
import { and, desc, eq } from "drizzle-orm";
import { db, apiTokens, videoProjects, videoSettings, scriptJournal, user as userTable } from "@/db";
import { generateToken } from "@/lib/mcp/token";
import { DEFAULT_BRIEF_TEMPLATE } from "@/lib/video/brief";
import { DEFAULT_WPM } from "@/lib/video/duration";

export type TokenRow = {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

// Le SEUL endroit où le jeton en clair existe — la valeur de retour de la création elle-même. Il
// n'est ni journalisé (aucun `console.log`, aucune écriture qui le contiendrait), ni relu : la
// table `api_tokens` ne stocke que `tokenHash` (lib/mcp/token.ts), donc même une relecture complète
// de la ligne ne pourrait pas le faire réapparaître.
export async function createApiTokenCore(
  { userId, name }: { userId: string; name: string },
): Promise<{ tokenId: string; token: string }> {
  const t = generateToken();
  const [row] = await db.insert(apiTokens)
    .values({ userId, name, prefix: t.prefix, tokenHash: t.tokenHash })
    .returning({ id: apiTokens.id });
  return { tokenId: row.id, token: t.token };
}

// `tokenHash` n'est JAMAIS nommée dans cette projection — donc physiquement absente de TokenRow,
// pas seulement omise par discipline d'appelant (même idiome que
// lib/queries/openrouter-tokens.ts's MaskedToken).
export async function listTokensCore(
  { userId, seesAll }: { userId: string; seesAll: boolean },
): Promise<TokenRow[]> {
  return db.select({
    id: apiTokens.id,
    userId: apiTokens.userId,
    name: apiTokens.name,
    prefix: apiTokens.prefix,
    lastUsedAt: apiTokens.lastUsedAt,
    revokedAt: apiTokens.revokedAt,
    createdAt: apiTokens.createdAt,
  })
    .from(apiTokens)
    .where(seesAll ? undefined : eq(apiTokens.userId, userId))
    .orderBy(desc(apiTokens.createdAt));
}

// Révocation DOUCE (`revokedAt`), jamais une suppression — voir le commentaire de la table
// `api_tokens` dans db/schema.ts : l'historique du journal doit continuer de nommer la personne qui
// a écrit, ce qu'une ligne supprimée ne permettrait plus.
export async function revokeApiTokenCore(
  { tokenId, userId, seesAll }: { tokenId: string; userId: string; seesAll: boolean },
): Promise<{ ok: boolean; message?: string }> {
  const [row] = await db.select({ userId: apiTokens.userId })
    .from(apiTokens).where(eq(apiTokens.id, tokenId));
  if (!row) return { ok: false, message: "Jeton introuvable." };
  if (!seesAll && row.userId !== userId) {
    return { ok: false, message: "Vous ne pouvez révoquer que vos propres jetons." };
  }
  await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, tokenId));
  return { ok: true };
}

// L'interrupteur d'urgence : couper tous les agents d'un geste sans révoquer, puis recréer, les
// jetons un par un (db/schema.ts's videoSettings.mcpEnabled). Même schéma « lire, ou créer la ligne
// unique » que saveVideoSettings (lib/actions/video-settings-actions.ts) — journalise QUI a
// basculé et QUAND via `updatedBy`/`updatedAt`, les mêmes colonnes que toute autre modification des
// réglages vidéo.
export async function setMcpEnabledCore(
  { enabled, userId }: { enabled: boolean; userId: string },
): Promise<void> {
  const [row] = await db.select({ id: videoSettings.id }).from(videoSettings).limit(1);
  if (row) {
    await db.update(videoSettings)
      .set({ mcpEnabled: enabled, updatedAt: new Date(), updatedBy: userId })
      .where(eq(videoSettings.id, row.id));
  } else {
    await db.insert(videoSettings).values({
      briefTemplate: DEFAULT_BRIEF_TEMPLATE,
      wordsPerMinute: DEFAULT_WPM,
      mcpEnabled: enabled,
      updatedBy: userId,
    });
  }
}

export type ActivityRow = {
  id: string;
  projectId: string;
  projectTitle: string;
  variantId: string | null;
  toolName: string | null;
  outcome: string;
  actorUserId: string | null;
  actorName: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
};

// Journal filtré `source: "mcp"` — les écritures d'agent uniquement, jamais le collé humain
// (`copier_coller`) ni les corrections manuelles (`manuel`). `reviewedAt: null` est le marqueur
// « non relue » que le panneau d'activité affiche ; ce module ne l'écrit ni ne le change — voir le
// commentaire de la colonne dans db/schema.ts.
export async function recentAgentActivityCore(limit: number): Promise<ActivityRow[]> {
  return db.select({
    id: scriptJournal.id,
    projectId: scriptJournal.projectId,
    projectTitle: videoProjects.title,
    variantId: scriptJournal.variantId,
    toolName: scriptJournal.toolName,
    outcome: scriptJournal.outcome,
    actorUserId: scriptJournal.actorUserId,
    actorName: userTable.name,
    reviewedAt: scriptJournal.reviewedAt,
    createdAt: scriptJournal.createdAt,
  })
    .from(scriptJournal)
    .innerJoin(videoProjects, eq(scriptJournal.projectId, videoProjects.id))
    .leftJoin(userTable, eq(scriptJournal.actorUserId, userTable.id))
    .where(and(eq(scriptJournal.source, "mcp")))
    .orderBy(desc(scriptJournal.createdAt))
    .limit(limit);
}
