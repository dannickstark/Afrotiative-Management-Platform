import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { getIntegrationStatus } from "@/lib/queries/settings";

export default async function Page() {
  const user = await requireUser();
  requirePermission(user.role, "pipeline", "configure");
  const status = await getIntegrationStatus();
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Intégrations</h1>
      {/* IntegrationsPanel arrive en Task 5 */}
      <ul className="text-sm text-muted-foreground">
        <li>WordPress — {status.wordpress.configured ? "configuré" : "non configuré"}</li>
        <li>OpenRouter — {status.openrouter.configured ? "configuré" : "non configuré"}</li>
        <li>OmniRoute — {status.omniroute.configured ? "configuré" : "non configuré"}</li>
        <li>Jina — {status.jina.configured ? "configuré" : "non configuré"}</li>
        <li>Firecrawl — {status.firecrawl.configured ? "configuré" : "non configuré"}</li>
      </ul>
      <pre className="text-xs text-muted-foreground">
        Dernière exécution : {status.lastRun ? status.lastRun.status : "aucune"}
      </pre>
    </div>
  );
}
