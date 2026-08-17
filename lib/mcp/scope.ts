import type { ToolSpec } from "@/lib/mcp/registry";

// La portée d'un jeton d'API : ce que CE jeton peut faire, indépendamment de ce que son propriétaire
// pourrait faire dans l'interface web. Le rôle reste le plancher (lib/mcp/tools.ts vérifie
// toujours "video"/"manage" avant les écritures) ; la portée est le plafond. Une portée n'accorde
// donc jamais rien — elle ne fait que retirer.
export type McpScope = { canWrite: boolean; canReadArticles: boolean };

// Le pouvoir d'un jeton d'avant les portées, et le défaut des colonnes en base : c'est ce qui rend
// la migration rétro-compatible sans réécrire une seule ligne.
export const FULL_SCOPE: McpScope = { canWrite: true, canReadArticles: true };

const REFUS_ECRITURE = "Ce jeton est en lecture seule. Créez un jeton avec l'écriture pour cette action.";
const REFUS_ARTICLES = "Ce jeton n'a pas accès aux articles.";

/**
 * Le message de refus, ou `null` si l'appel passe. Fonction PURE et isolée du serveur : la règle se
 * lit en un seul endroit et se teste sans base ni SDK MCP — dispersée dans le corps de
 * `registerTools`, elle n'aurait été vérifiable que de bout en bout.
 *
 * L'axe articles est évalué en PREMIER : pour un outil de lecture du domaine article, c'est le seul
 * axe qui puisse s'appliquer, et pour un outil d'écriture de ce domaine, « pas accès aux articles »
 * est plus précis que « lecture seule ». Un agent reçoit ainsi une cause actionnable, jamais deux
 * messages concaténés.
 */
export function refusPourPortee(
  spec: Pick<ToolSpec, "kind" | "domain">, scope: McpScope,
): string | null {
  if (spec.domain === "article" && !scope.canReadArticles) return REFUS_ARTICLES;
  if (spec.kind === "ecriture" && !scope.canWrite) return REFUS_ECRITURE;
  return null;
}
