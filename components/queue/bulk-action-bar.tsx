"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { RoleGate } from "@/components/role-gate";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { BulkRegenerateDialog } from "@/components/queue/bulk-regenerate-dialog";
import { bulkApprove, bulkReject, bulkRegenerate, type BulkResult } from "@/lib/actions/queue-actions";
import type { QueueRow } from "@/lib/queries/queue";

export function BulkActionBar({ rows, onDone }: { rows: QueueRow[]; onDone: () => void }) {
  const [isPending, startTransition] = useTransition();
  const [failures, setFailures] = useState<BulkResult["failed"]>([]);

  if (rows.length === 0) return null;
  const ids = rows.map((r) => r.id);
  const n = rows.length;
  // Le renvoi en lot est bien plus coûteux qu'approuver/rejeter (extraction réseau + appel IA par
  // article) : plafonné à 10 (voir bulkRegenerate). Approuver/Rejeter NE sont PAS concernés.
  const tooMany = n > 10;

  function report(res: BulkResult, verb: string) {
    setFailures(res.failed);
    if (res.failed.length === 0) {
      toast.success(`${res.ok.length} article${res.ok.length > 1 ? "s" : ""} ${verb}.`);
      onDone();
    } else {
      // Succès partiel : le compte des deux côtés, et le détail reste affiché sous la barre.
      toast.warning(`${res.ok.length} ${verb}, ${res.failed.length} en échec.`);
    }
  }

  function run(fn: () => Promise<BulkResult>, verb: string) {
    startTransition(async () => {
      try {
        report(await fn(), verb);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Action impossible.");
      }
    });
  }

  return (
    <div className="sticky bottom-4 z-20 mx-auto w-fit rounded-lg border bg-background/95 px-4 py-2 shadow-lg backdrop-blur">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">
          {n} sélectionné{n > 1 ? "s" : ""}
        </span>

        <RoleGate allow={["admin", "editor"]}>
          <ConfirmDialog
            trigger={<Button size="sm" disabled={isPending}>Approuver et publier</Button>}
            title={`Publier ${n} article${n > 1 ? "s" : ""} ?`}
            /* La phrase dit explicitement ce que fait l'action : approuver PUBLIE
               immédiatement sur WordPress — c'est déjà la sémantique de l'action unitaire. */
            description={`Ces ${n} article${n > 1 ? "s seront publiés" : " sera publié"} immédiatement sur WordPress. Les articles aux informations manquantes seront écartés et listés.`}
            confirmLabel="Approuver et publier"
            onConfirm={() => run(() => bulkApprove(ids), "publié(s)")}
          />

          <ConfirmDialog
            trigger={
              <Button size="sm" variant="ghost" disabled={isPending}
                className="text-destructive hover:bg-destructive/10 hover:text-destructive">
                Rejeter
              </Button>
            }
            title={`Rejeter ${n} article${n > 1 ? "s" : ""} ?`}
            description="Ces articles seront marqués comme rejetés et retirés de la file de publication."
            confirmLabel="Rejeter"
            destructive
            withReason
            onConfirm={(reason) => run(() => bulkReject({ ids, reason: reason ?? "" }), "rejeté(s)")}
          />

          <BulkRegenerateDialog
            count={n}
            disabled={isPending || tooMany}
            onConfirm={(fields) => run(() => bulkRegenerate(ids, fields), "renvoyé(s) à l'IA")}
          />
          {tooMany && <span className="text-xs text-muted-foreground">Maximum 10 par lot</span>}
        </RoleGate>

        <Button size="sm" variant="ghost" onClick={() => { setFailures([]); onDone(); }}>
          Effacer la sélection
        </Button>
      </div>

      {failures.length > 0 && (
        <ul className="mt-2 max-h-40 space-y-1 overflow-auto border-t pt-2 text-xs">
          {failures.map((f) => (
            <li key={f.id}>
              <span className="font-medium">{f.title}</span>{" — "}
              <span className="text-destructive">{f.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
