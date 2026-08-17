"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RoleGate } from "@/components/role-gate";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { BulkRegenerateDialog } from "@/components/queue/bulk-regenerate-dialog";
import { bulkApprove, bulkReject, type BulkResult } from "@/lib/actions/queue-actions";
import { startRegenJob } from "@/lib/actions/regen-actions";
import { RegenProgress } from "@/components/queue/regen-progress";
import { summarizeRegenJob, type RegenJobView } from "@/lib/pipeline/regen-live";
import type { RegenerateFieldsInput } from "@/lib/validation";
import type { QueueRow } from "@/lib/queries/queue";

export function BulkActionBar({ rows, onDone, defaultImageMode }:
  { rows: QueueRow[]; onDone: () => void; defaultImageMode: "auto" | "manual" }) {
  const router = useRouter();
  // Un unique `pending` pilote les DEUX chemins (approuver/rejeter ET renvoi à l'IA). Le renvoi à
  // l'IA ne boucle plus côté client : il ouvre un job côté serveur et laisse RegenProgress sonder sa
  // progression (voir jobId ci-dessous).
  const [pending, setPending] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [failures, setFailures] = useState<BulkResult["failed"]>([]);

  if (rows.length === 0) return null;
  const ids = rows.map((r) => r.id);
  const n = rows.length;
  // Le renvoi en lot est bien plus coûteux qu'approuver/rejeter (extraction réseau + appel IA par
  // article) : plafonné à 10. C'est une garde d'UI côté client — startRegenJob la répète côté
  // serveur (validation). Approuver/Rejeter NE sont PAS concernés.
  const tooMany = n > 10;
  // Un job en vol verrouille TOUTE la barre, pas seulement le bouton qui l'a lancé : approuver ou
  // rejeter les lignes en cours de réécriture serait une course, et « Effacer la sélection »
  // démonterait la barre (garde rows.length === 0) en emportant le seul observateur du job.
  const busy = pending || jobId !== null;

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

  // Le lot n'est plus une boucle client : on ouvre UN job côté serveur et on sonde sa progression
  // (components/queue/regen-progress.tsx). La barre reste montée pendant tout le job — aucune
  // revalidation en cours de route ne peut plus effacer la sélection à mi-parcours.
  async function runRegenerate(fields: RegenerateFieldsInput, imageMode: "auto" | "manual") {
    setFailures([]);
    // startRegenJob JETTE sur un refus RBAC et rejette sur tout aléa DB/transport. BulkRegenerateDialog
    // appelle cette fonction sans l'attendre (onConfirm est synchrone côté enfant) : sans ce
    // try/catch, un rejet ici deviendrait une unhandled rejection ET l'éditeur ne verrait aucun toast.
    try {
      const res = await startRegenJob({ articleIds: rows.map((r) => r.id), fields, imageMode });
      if (!res.ok) { toast.error(res.message); return; }
      setJobId(res.jobId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Renvoi à l'IA impossible.");
    }
  }

  function handleJobFinished(job: RegenJobView) {
    setJobId(null);
    const { ok, failed, awaitingImage } = summarizeRegenJob(job);
    // finalizeRegenJob balaie les items non traités d'une annulation avec status "failed" (voir
    // lib/pipeline/regen-store.ts) — un artefact de fermeture, pas un échec réel. Le statut du JOB
    // porte le bon verdict : un job annulé se rapporte comme tel, jamais comme un lot d'échecs, et
    // ses items balayés ne polluent pas la liste des échecs affichée sous la barre.
    if (job.status === "cancelled") {
      setFailures([]);
      toast.warning(ok > 0
        ? `Renvoi à l'IA annulé — ${ok} article${ok > 1 ? "s" : ""} déjà traité${ok > 1 ? "s" : ""}.`
        : "Renvoi à l'IA annulé.");
      onDone();
      router.refresh();
      return;
    }
    setFailures(job.items.filter((i) => i.status === "failed").map((i) => ({ id: i.articleId, title: i.title, message: i.message ?? "Échec." })));
    if (failed === 0) {
      const extra = awaitingImage > 0 ? ` — ${awaitingImage} image${awaitingImage > 1 ? "s" : ""} à choisir` : "";
      toast.success(`${ok + awaitingImage} article${ok + awaitingImage > 1 ? "s" : ""} renvoyé${ok + awaitingImage > 1 ? "s" : ""} à l'IA${extra}.`);
      onDone();
      router.refresh();
    } else {
      // Succès partiel : PAS de refresh, pour garder la barre montée et la liste des échecs visible.
      toast.warning(`${ok} renvoyé${ok > 1 ? "s" : ""} à l'IA, ${failed} en échec.`);
    }
  }

  return (
    <div className="sticky bottom-4 z-20 mx-auto w-fit rounded-lg border bg-background/95 px-4 py-2 shadow-lg backdrop-blur">
      <div className="flex items-center gap-3">
        {jobId !== null
          ? <RegenProgress key={jobId} jobId={jobId} onFinished={handleJobFinished} />
          : <span className="flex items-center gap-2 text-sm font-medium">
              {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
              {n} sélectionné{n > 1 ? "s" : ""}
            </span>}

        <RoleGate allow={["admin", "editor"]}>
          <ConfirmDialog
            trigger={<Button size="sm" disabled={busy}>Approuver et publier</Button>}
            title={`Publier ${n} article${n > 1 ? "s" : ""} ?`}
            /* La phrase dit explicitement ce que fait l'action : approuver PUBLIE
               immédiatement sur WordPress — c'est déjà la sémantique de l'action unitaire. */
            description={`Ces ${n} article${n > 1 ? "s seront publiés" : " sera publié"} immédiatement sur WordPress. Les articles aux informations manquantes seront écartés et listés.`}
            confirmLabel="Approuver et publier"
            onConfirm={() => run(() => bulkApprove(ids), "publié(s)")}
          />

          <ConfirmDialog
            trigger={
              <Button size="sm" variant="ghost" disabled={busy}
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
            disabled={busy || tooMany}
            defaultImageMode={defaultImageMode}
            onConfirm={(fields, imageMode) => runRegenerate(fields, imageMode)}
          />
          {tooMany && <span className="text-xs text-muted-foreground">Maximum 10 par lot</span>}
        </RoleGate>

        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setFailures([]); onDone(); }}>
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
