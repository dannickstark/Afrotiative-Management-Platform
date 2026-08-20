// components/settings/mcp/connection-panel.tsx — Task 7: « Connexion », le premier des quatre
// panneaux de /settings/mcp (spec §6 : on branche, on comprend, on surveille, on coupe — dans cet
// ordre). L'interrupteur n'est PLUS rendu ici (round de correction) : il vit dans la page
// (app/(app)/settings/mcp/page.tsx), APRÈS les quatre panneaux — le geste d'urgence est le
// DERNIER de l'écran, pas le premier. Ce panneau n'affiche donc que du texte dérivé de ses props
// (adresse, état) et des extraits de configuration statiques, ce qui permet à
// tests/mcp-settings-ui.test.ts de faire un renderToStaticMarkup(<ConnectionPanel .../>) sans
// aucun contexte de routeur Next.
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

// Emplacement, jamais un vrai jeton : les extraits ci-dessous finissent copiés-collés dans des
// fichiers de configuration qui, eux, finissent parfois dans un dépôt. Un extrait qui contiendrait
// le jeton fraîchement créé serait un secret qui fuit au premier `git add .` de la personne qui l'a
// copié.
const PLACEHOLDER = "VOTRE_JETON";

export function ConnectionPanel({
  serverUrl,
  enabled,
  seesAll = false,
  addressGuessed = false,
}: {
  serverUrl: string;
  enabled: boolean;
  // Wording seulement (round de correction) : ce panneau ne rend plus l'interrupteur lui-même
  // (voir la page), mais doit rester exact sur où le trouver quand il dit qu'il existe — jamais
  // « ci-dessous » pour quelqu'un qui ne le voit pas du tout.
  seesAll?: boolean;
  // Vrai quand l'adresse a été DEVINÉE depuis l'en-tête `Host` de la requête plutôt que dérivée de
  // BETTER_AUTH_URL (round de correction) : un `Host` forgé (proxy mal configuré, absence de liste
  // d'hôtes autorisés) produirait sinon un extrait de configuration qui dirige le JETON PORTEUR
  // vers une origine tierce sans que quiconque ne le voie. Ce n'est pas une garde — juste rendre
  // visible ce que l'adresse affichée est, ou n'est pas.
  addressGuessed?: boolean;
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
            {addressGuessed && (
              <p className="text-xs text-[var(--status-pending)]">
                Adresse devinée depuis l&#39;en-tête Host de la requête, non configurée
                (BETTER_AUTH_URL absente) — vérifiez qu&#39;elle correspond bien à votre
                déploiement avant de partager cet extrait.
              </p>
            )}
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
            Le serveur MCP est désactivé : aucun jeton, même valide, ne fonctionne tant qu&#39;il
            n&#39;est pas réactivé{seesAll ? " — l'interrupteur se trouve en bas de cette page." : "."}
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
            création. claude.ai (web) se connecte via OAuth : ajoutez ce serveur comme connecteur
            MCP et autorisez l'accès depuis votre compte, sans coller de jeton. Claude Desktop et
            Claude Code utilisent le jeton porteur ci-dessus.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
