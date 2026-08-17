// components/settings/mcp/tool-catalog.tsx — Task 7: « Ce qu'un agent peut faire », le troisième
// panneau de /settings/mcp (spec §6). PAS "use client" : ce composant n'a besoin d'aucune
// interactivité, seulement d'ITÉRER TOOL_REGISTRY (lib/mcp/registry.ts) — jamais de redéclarer un
// nom d'outil à la main. Un outil ajouté au registre sans apparaître ici serait un pouvoir accordé
// en silence : c'est exactement ce que tests/mcp-settings-ui.test.ts vérifie en comparant le rendu
// à TOOL_REGISTRY lui-même, pas à une liste figée dans le test.
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TOOL_REGISTRY, type ToolKind } from "@/lib/mcp/registry";

const KIND_LABEL: Record<ToolKind, string> = { lecture: "Lecture", ecriture: "Écriture" };

const KIND_BADGE_STYLE: Record<ToolKind, string> = {
  lecture: "bg-[var(--status-approved)]/15 text-[var(--status-approved)] border-[var(--status-approved)]/30",
  ecriture: "bg-[var(--status-pending)]/15 text-[var(--status-pending)] border-[var(--status-pending)]/30",
};

export function ToolCatalog() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Ce qu&#39;un agent peut faire</CardTitle>
        <CardDescription>
          Chaque outil que le serveur MCP expose — ni plus, ni moins. Un agent connecté ne peut agir
          que par ces outils, et jamais annuler une écriture depuis ce serveur : une correction se
          fait dans le projet, avec son contexte.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {TOOL_REGISTRY.map((tool) => (
          <div
            key={tool.name}
            className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border px-3 py-2"
          >
            <div className="min-w-0 space-y-0.5">
              <code className="text-sm font-medium">{tool.name}</code>
              <p className="text-sm text-muted-foreground">{tool.description}</p>
            </div>
            <Badge variant="outline" className={`shrink-0 ${KIND_BADGE_STYLE[tool.kind]}`}>
              {KIND_LABEL[tool.kind]}
            </Badge>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
