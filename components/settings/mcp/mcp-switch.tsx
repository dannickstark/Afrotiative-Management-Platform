"use client";
// components/settings/mcp/mcp-switch.tsx — Task 7: l'interrupteur d'urgence, isolé dans son PROPRE
// petit composant client. Séparé de connection-panel.tsx pour deux raisons : (1) c'est la SEULE
// partie du panneau de connexion qui a besoin d'interactivité (useRouter/useTransition), donc
// tests/mcp-settings-ui.test.ts peut faire un renderToStaticMarkup(<ConnectionPanel .../>) sans
// contexte de routeur Next — ce sous-composant n'est monté (donc son useRouter() n'est appelé) que
// lorsque `seesAll` est vrai, ce que ce test ne demande jamais ; (2) « video:configure » est la
// SEULE garde qui compte ici — voir lib/actions/mcp-actions.ts's setMcpEnabled, qui refait le même
// contrôle côté serveur, ce composant n'étant qu'une commodité d'UI.
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { setMcpEnabled } from "@/lib/actions/mcp-actions";

export function McpSwitch({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleChange(next: boolean) {
    startTransition(async () => {
      try {
        const res = await setMcpEnabled(next);
        if (!res.ok) {
          toast.error(res.message ?? "Échec de la mise à jour.");
          return;
        }
        toast.success(next ? "Serveur MCP activé." : "Serveur MCP désactivé — tous les agents sont coupés.");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Échec de la mise à jour.");
      }
    });
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
      <Switch id="mcp-enabled" checked={enabled} disabled={isPending} onCheckedChange={handleChange} />
      <Label htmlFor="mcp-enabled" className="cursor-pointer">
        Serveur MCP {enabled ? "activé" : "désactivé"}
      </Label>
    </div>
  );
}
