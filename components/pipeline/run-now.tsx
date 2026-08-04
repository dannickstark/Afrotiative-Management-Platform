"use client";
import { useTransition } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RoleGate } from "@/components/role-gate";
import { runPipelineNow } from "@/lib/actions/pipeline-actions";

// Gated to admin-only (not admin+editor) to match runPipelineNow()'s server-side
// requirePermission(role, "pipeline", "configure") exactly — editors have pipeline:read
// only, so showing them a button whose click would always fail server-side would be dishonest.
export function RunNow() {
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    startTransition(() => {
      runPipelineNow()
        .then((r) => {
          if (r.ok) toast.success(`Exécution terminée — ${r.produced} article(s) en attente.`);
          else toast.error(r.message);
        })
        // Defense in depth: requirePermission()/requireUser() throw rather than return
        // {ok:false,...} — shouldn't happen given the RoleGate above, but never leave the
        // button silently stuck without feedback if it does.
        .catch(() => toast.error("Une erreur inattendue est survenue."));
    });
  }

  return (
    <RoleGate allow={["admin"]}>
      <Button onClick={handleClick} disabled={isPending}>
        {isPending && <Loader2 className="animate-spin" aria-hidden />}
        {isPending ? "Exécution en cours…" : "Lancer une exécution maintenant"}
      </Button>
    </RoleGate>
  );
}
