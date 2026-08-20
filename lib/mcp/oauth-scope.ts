import type { McpScope } from "@/lib/mcp/scope";

/** Portée d'une connexion OAuth. Défaut conservateur : écriture oui, articles non. */
export function scopeFromRow(
  row: { canWrite: boolean; canReadArticles: boolean } | null,
): McpScope {
  if (!row) return { canWrite: true, canReadArticles: false };
  return { canWrite: row.canWrite, canReadArticles: row.canReadArticles };
}
