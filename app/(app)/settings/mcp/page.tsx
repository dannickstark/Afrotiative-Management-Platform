import { headers } from "next/headers";
import { requireUser } from "@/lib/session";
import { can, requirePermission } from "@/lib/rbac";
import { getVideoSettings } from "@/lib/queries/video-settings";
import { listTokensCore, recentAgentActivityCore } from "@/lib/queries/mcp";
import { PageHeader } from "@/components/shell/page-header";
import { ConnectionPanel } from "@/components/settings/mcp/connection-panel";
import { TokenList } from "@/components/settings/mcp/token-list";
import { ToolCatalog } from "@/components/settings/mcp/tool-catalog";
import { AgentActivity } from "@/components/settings/mcp/agent-activity";
import { McpSwitch } from "@/components/settings/mcp/mcp-switch";

const ACTIVITY_LIMIT = 20;

// Voir/gérer SES PROPRES jetons demande "video:manage" (les trois rôles, journaliste compris —
// c'est lui qui écrit les scripts vidéo). Voir les jetons de toute l'équipe et actionner
// l'interrupteur demande "video:configure" (admin/éditeur) — même paire de droits que
// lib/actions/mcp-actions.ts.
export default async function Page() {
  const user = await requireUser();
  requirePermission(user.role, "video", "manage");
  const seesAll = can(user.role, "video", "configure");

  const [settings, tokens, activity, h] = await Promise.all([
    getVideoSettings(),
    listTokensCore({ userId: user.id, seesAll }),
    recentAgentActivityCore(ACTIVITY_LIMIT),
    headers(),
  ]);

  // Adresse dérivée de BETTER_AUTH_URL en priorité — déjà la source canonique de l'URL publique de
  // l'app dans ce dépôt (lib/auth.ts, better-auth la lit lui-même depuis l'environnement — voir
  // .env.example). Retombée sur l'en-tête `Host` de la requête UNIQUEMENT à défaut : ce dépôt ne
  // valide `Host` contre aucune liste d'hôtes autorisés, donc un proxy mal configuré (ou son
  // absence) pourrait le forger — un extrait de configuration bâti dessus dirigerait alors le
  // JETON PORTEUR de la personne qui le copie vers une origine tierce. Dans ce cas de repli,
  // `addressGuessed` le dit explicitement à l'écran plutôt que de laisser croire à une adresse
  // configurée.
  const configuredBase = process.env.BETTER_AUTH_URL?.trim().replace(/\/+$/, "");
  let serverUrl: string;
  let addressGuessed: boolean;
  if (configuredBase) {
    serverUrl = `${configuredBase}/api/mcp`;
    addressGuessed = false;
  } else {
    const host = h.get("host") ?? "localhost:3000";
    const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
    serverUrl = `${proto}://${host}/api/mcp`;
    addressGuessed = true;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="MCP"
        description="Connecte un agent au module vidéo : gestion des jetons, catalogue d'outils et surveillance des écritures."
      />
      <ConnectionPanel
        serverUrl={serverUrl} enabled={settings.mcpEnabled}
        seesAll={seesAll} addressGuessed={addressGuessed}
      />
      <TokenList tokens={tokens} currentUserId={user.id} seesAll={seesAll} />
      <ToolCatalog />
      <AgentActivity activity={activity} />
      {/* Le geste d'urgence est le DERNIER de l'écran, pas le premier (round de correction) : on
          branche, on comprend, on surveille, PUIS on coupe. */}
      {seesAll && <McpSwitch enabled={settings.mcpEnabled} />}
    </div>
  );
}
