"use client";
import { useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getRegenJobAction, cancelRegenJob } from "@/lib/actions/regen-actions";
import { deriveRegenHeader, summarizeRegenJob, type RegenJobView } from "@/lib/pipeline/regen-live";

const POLL_MS = 1500; // même cadence que le panneau d'exécution du pipeline

// PRÉSENTATIONNEL PUR, exporté séparément pour être rendu sous react-dom/server dans les tests
// (voie test:pure) : aucun état, aucun effet, aucun accès réseau — seulement une vue du job.
export function RegenProgressView({ job, onCancel }: { job: RegenJobView; onCancel: () => void }) {
  const header = deriveRegenHeader(job);
  const summary = summarizeRegenJob(job);
  const running = job.status === "running";
  const failures = job.items.filter((i) => i.status === "failed");

  return (
    <div className="space-y-2" aria-live="polite">
      <div className="flex items-center gap-3">
        {running && <Loader2 className="size-4 animate-spin" aria-hidden />}
        <span className="text-sm font-medium">{header.label}</span>
        <span className="text-sm text-muted-foreground">{header.done}/{header.total}</span>
        <span className="text-sm text-muted-foreground">{header.percent}%</span>
        {running && (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            <X aria-hidden /> Annuler
          </Button>
        )}
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
        <div className="h-full bg-primary transition-all" style={{ width: `${header.percent}%` }} />
      </div>
      {summary.awaitingImage > 0 && (
        <p className="text-sm text-muted-foreground">
          {summary.awaitingImage} image{summary.awaitingImage > 1 ? "s" : ""} à choisir
        </p>
      )}
      {failures.length > 0 && (
        <ul className="space-y-1 text-sm text-destructive">
          {failures.map((f) => <li key={f.id}>{f.title} — {f.message}</li>)}
        </ul>
      )}
    </div>
  );
}

/**
 * Sonde getRegenJobAction toutes les 1,5 s jusqu'à ce que le job soit terminal, puis appelle
 * onFinished UNE seule fois. Un throw du sondage est traité comme transitoire (on réessaie au tic
 * suivant), exactement comme components/pipeline/live-run-panel.tsx.
 */
export function RegenProgress({ jobId, onFinished }: { jobId: string; onFinished: (job: RegenJobView) => void }) {
  const [job, setJob] = useState<RegenJobView | null>(null);
  const finishedRef = useRef(false);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  useEffect(() => {
    finishedRef.current = false;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await getRegenJobAction(jobId);
        if (cancelled || res === null) return;
        setJob(res);
        if (res.status !== "running" && !finishedRef.current) {
          finishedRef.current = true;
          onFinishedRef.current(res);
        }
      } catch { /* transitoire — on réessaie au tic suivant */ }
    };
    void tick();
    const id = setInterval(() => { if (!finishedRef.current) void tick(); }, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [jobId]);

  if (job === null) return null;
  return <RegenProgressView job={job} onCancel={() => { void cancelRegenJob(jobId); }} />;
}
