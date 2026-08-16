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

  // Adresse dérivée de la configuration d'exécution (hôte de la requête), pas d'une variable
  // d'environnement dédiée — ce dépôt n'en déclare aucune pour l'origine publique de l'app
  // (.env.example), et cette adresse doit rester exacte quel que soit l'environnement (local,
  // preview, production) sans réglage supplémentaire à tenir à jour.
  const host = h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  const serverUrl = `${proto}://${host}/api/mcp`;

  return (
    <div className="space-y-6">
      <PageHeader
        title="MCP"
        description="Connecte un agent au module vidéo : gestion des jetons, catalogue d'outils et surveillance des écritures."
      />
      <ConnectionPanel serverUrl={serverUrl} enabled={settings.mcpEnabled} seesAll={seesAll} />
      <TokenList tokens={tokens} currentUserId={user.id} seesAll={seesAll} />
      <ToolCatalog />
      <AgentActivity activity={activity} />
    </div>
  );
}
