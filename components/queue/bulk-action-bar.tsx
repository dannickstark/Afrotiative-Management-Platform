"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RoleGate } from "@/components/role-gate";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { BulkRegenerateDialog } from "@/components/queue/bulk-regenerate-dialog";
import { bulkApprove, bulkReject, regenerateInQueue, type BulkResult } from "@/lib/actions/queue-actions";
import type { RegenerateFieldsInput } from "@/lib/validation";
import type { QueueRow } from "@/lib/queries/queue";

export function BulkActionBar({ rows, onDone }: { rows: QueueRow[]; onDone: () => void }) {
  const router = useRouter();
  // Un unique `pending` pilote les DEUX chemins (approuver/rejeter ET renvoi à l'IA). On abandonne
  // useTransition pour le renvoi : la boucle client doit rendre la progression X/N entre chaque
  // itération, or useTransition regrouperait ces mises à jour et n'afficherait aucun état
  // intermédiaire. Un booléen manuel garde les deux chemins cohérents (boutons désactivés, spinner).
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failures, setFailures] = useState<BulkResult["failed"]>([]);

  if (rows.length === 0) return null;
  const ids = rows.map((r) => r.id);
  const n = rows.length;
  // Le renvoi en lot est bien plus coûteux qu'approuver/rejeter (extraction réseau + appel IA par
  // article) : plafonné à 10. C'est désormais une pure garde d'UI — la boucle client appelle
  // regenerateInQueue un article à la fois. Approuver/Rejeter NE sont PAS concernés.
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

  async function run(fn: () => Promise<BulkResult>, verb: string) {
    setPending(true);
    try {
      report(await fn(), verb);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action impossible.");
    } finally {
      setPending(false);
    }
  }

  // Renvoi à l'IA piloté par le client : on boucle sur regenerateInQueue (un article par appel) en
  // mettant à jour la progression entre chaque itération pour afficher « Renvoi à l'IA… 3/10 ».
  async function runRegenerate(fields: RegenerateFieldsInput) {
    // SNAPSHOT des ids+titres : la boucle ne doit PAS dépendre du prop `rows` en cours de route (il
    // peut changer sous nos pieds si la page se rafraîchit).
    const items = rows.map((r) => ({ id: r.id, title: r.title }));
    setFailures([]);
    setPending(true);
    setProgress({ done: 0, total: items.length });
    const okIds: string[] = [];
    const failed: BulkResult["failed"] = [];
    for (let i = 0; i < items.length; i++) {
      try {
        const res = await regenerateInQueue(items[i].id, fields);
        if (res.ok) okIds.push(items[i].id);
        else failed.push({ id: items[i].id, title: items[i].title, message: res.message });
      } catch (err) {
        failed.push({ id: items[i].id, title: items[i].title, message: err instanceof Error ? err.message : "Échec du renvoi à l'IA." });
      }
      setProgress({ done: i + 1, total: items.length });
    }
    setProgress(null);
    setPending(false);
    setFailures(failed);
    if (failed.length === 0) {
      toast.success(`${okIds.length} article${okIds.length > 1 ? "s" : ""} renvoyé${okIds.length > 1 ? "s" : ""} à l'IA.`);
      onDone();
      // Unique rafraîchissement de fin de boucle : met à jour le contenu régénéré, et la sélection
      // se vide proprement (aucune revalidation en cours d'itération n'a démonté la barre).
      router.refresh();
    } else {
      // Succès partiel : PAS de refresh, pour garder la barre montée et la liste des échecs visible.
      toast.warning(`${okIds.length} renvoyé${okIds.length > 1 ? "s" : ""} à l'IA, ${failed.length} en échec.`);
    }
  }

  return (
    <div className="sticky bottom-4 z-20 mx-auto w-fit rounded-lg border bg-background/95 px-4 py-2 shadow-lg backdrop-blur">
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-2 text-sm font-medium">
          {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
          {progress
            ? `Renvoi à l'IA… ${progress.done}/${progress.total}`
            : `${n} sélectionné${n > 1 ? "s" : ""}`}
        </span>

        <RoleGate allow={["admin", "editor"]}>
          <ConfirmDialog
            trigger={<Button size="sm" disabled={pending}>Approuver et publier</Button>}
            title={`Publier ${n} article${n > 1 ? "s" : ""} ?`}
            /* La phrase dit explicitement ce que fait l'action : approuver PUBLIE
               immédiatement sur WordPress — c'est déjà la sémantique de l'action unitaire. */
            description={`Ces ${n} article${n > 1 ? "s seront publiés" : " sera publié"} immédiatement sur WordPress. Les articles aux informations manquantes seront écartés et listés.`}
            confirmLabel="Approuver et publier"
            onConfirm={() => run(() => bulkApprove(ids), "publié(s)")}
          />

          <ConfirmDialog
            trigger={
              <Button size="sm" variant="ghost" disabled={pending}
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
            disabled={pending || tooMany}
            onConfirm={(fields) => runRegenerate(fields)}
          />
          {tooMany && <span className="text-xs text-muted-foreground">Maximum 10 par lot</span>}
        </RoleGate>

        <Button size="sm" variant="ghost" disabled={pending} onClick={() => { setFailures([]); onDone(); }}>
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
