"use client";
import { useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { RoleGate } from "@/components/role-gate";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { quickApprove, quickReject } from "@/lib/actions/queue-actions";
import { PreviewSheet } from "@/components/queue/preview-sheet";
import type { QueueRow } from "@/lib/queries/queue";
import { cn } from "@/lib/utils";

export function RowActions({ row }: { row: QueueRow }) {
  const [isPending, startTransition] = useTransition();

  function handleApprove() {
    startTransition(async () => {
      try {
        await quickApprove(row.id);
        toast.success(`« ${row.title} » approuvé et publié.`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Échec de l'approbation.");
      }
    });
  }

  function handleReject(reason?: string) {
    startTransition(async () => {
      try {
        await quickReject({ id: row.id, reason: reason ?? "" });
        toast.success(`« ${row.title} » rejeté.`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Échec du rejet.");
      }
    });
  }

  return (
    <div className="flex items-center justify-end gap-1">
      <PreviewSheet row={row} />

      <Link href={`/article/${row.id}`} className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
        Ouvrir
      </Link>

      {/* Journalists see only "Ouvrir" above; approve/reject are editor+admin only. */}
      <RoleGate allow={["admin", "editor"]}>
        <Button variant="ghost" size="sm" disabled={isPending} onClick={handleApprove}>
          Approuver rapidement
        </Button>

        <ConfirmDialog
          trigger={
            <Button variant="ghost" size="sm" disabled={isPending} className="text-destructive hover:bg-destructive/10 hover:text-destructive">
              Rejeter
            </Button>
          }
          title="Rejeter cet article ?"
          description={`« ${row.title} » sera marqué comme rejeté et retiré de la file de publication.`}
          confirmLabel="Rejeter"
          destructive
          withReason
          onConfirm={handleReject}
        />
      </RoleGate>
    </div>
  );
}
