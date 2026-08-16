// components/settings/mcp/connection-panel.tsx — Task 7: « Connexion », le premier panneau de
// /settings/mcp (spec §6). PAS "use client" au niveau du panneau lui-même : il n'affiche que du
// texte dérivé de ses props (adresse, état) et des extraits de configuration statiques — la SEULE
// partie interactive (l'interrupteur) est déléguée à McpSwitch (mcp-switch.tsx), un sous-composant
// client monté UNIQUEMENT quand `seesAll` est vrai. C'est ce qui permet à
// tests/mcp-settings-ui.test.ts de faire un renderToStaticMarkup(<ConnectionPanel .../>) sans
// aucun contexte de routeur Next : ses props par défaut (pas de `seesAll`) ne montent jamais
// McpSwitch, donc son useRouter() n'est jamais appelé pendant le test.
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { McpSwitch } from "@/components/settings/mcp/mcp-switch";

// Emplacement, jamais un vrai jeton : les extraits ci-dessous finissent copiés-collés dans des
// fichiers de configuration qui, eux, finissent parfois dans un dépôt. Un extrait qui contiendrait
// le jeton fraîchement créé serait un secret qui fuit au premier `git add .` de la personne qui l'a
// copié.
const PLACEHOLDER = "VOTRE_JETON";

export function ConnectionPanel({
  serverUrl,
  enabled,
  seesAll = false,
}: {
  serverUrl: string;
  enabled: boolean;
  // N'affiche l'interrupteur que pour "video:configure" (admin/éditeur) — voir
  // lib/actions/mcp-actions.ts's setMcpEnabled, la garde qui compte réellement.
  seesAll?: boolean;
}) {
  const claudeDesktopConfig = `{
  "mcpServers": {
    "afrotiative-video": {
      "url": "${serverUrl}",
      "headers": { "Authorization": "Bearer ${PLACEHOLDER}" }
    }
  }
}`;
  const claudeCodeCommand = `claude mcp add --transport http afrotiative-video ${serverUrl} --header "Authorization: Bearer ${PLACEHOLDER}"`;
  const curlCommand = `curl ${serverUrl} -H "Authorization: Bearer ${PLACEHOLDER}" -H "Content-Type: application/json"`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connexion</CardTitle>
        <CardDescription>
          Adresse du serveur MCP du module vidéo, et comment y connecter un agent.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-sm text-muted-foreground">Adresse du serveur</p>
            <code className="block truncate rounded-md bg-muted px-2 py-1 text-sm">{serverUrl}</code>
          </div>
          <Badge
            variant="outline"
            className={
              enabled
                ? "bg-[var(--status-approved)]/15 text-[var(--status-approved)] border-[var(--status-approved)]/30"
                : "bg-[var(--status-error)]/15 text-[var(--status-error)] border-[var(--status-error)]/30"
            }
          >
            {enabled ? "Actif" : "Désactivé"}
          </Badge>
        </div>

        {!enabled && (
          <p className="rounded-md border border-[var(--status-error)]/30 bg-[var(--status-error)]/10 px-3 py-2 text-sm text-[var(--status-error)]">
            Le serveur MCP est désactivé : aucun jeton, même valide, ne fonctionne tant que
            l&#39;interrupteur ci-dessous n&#39;est pas rouvert.
          </p>
        )}

        <div className="space-y-3">
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Claude Desktop</p>
            <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">
              <code>{claudeDesktopConfig}</code>
            </pre>
          </div>
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Claude Code (CLI)</p>
            <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">
              <code>{claudeCodeCommand}</code>
            </pre>
          </div>
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Autre client MCP (HTTP)</p>
            <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">
              <code>{curlCommand}</code>
            </pre>
          </div>
          <p className="text-xs text-muted-foreground">
            Remplacez {PLACEHOLDER} par un jeton créé ci-dessous — affiché une seule fois à sa
            création. claude.ai (web) ne peut pas utiliser ces extraits : il attend une connexion
            via OAuth, pas un en-tête Authorization posé à la main ; utilisez Claude Desktop, Claude
            Code, ou un client MCP compatible avec un jeton porteur.
          </p>
        </div>

        {seesAll && <McpSwitch enabled={enabled} />}
      </CardContent>
    </Card>
  );
}
