"use client";
import { useEffect, useRef, useState, useTransition, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Check, X, ExternalLink, Play, Pause, Square } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RoleGate } from "@/components/role-gate";
import { cn } from "@/lib/utils";
import { pipelineStatusLabel, relativeDate, type PipelineStatus } from "@/lib/format";
import { deriveStepperNodes, computeEta, deriveHeader, formatClock } from "@/lib/pipeline/live";
import { getActiveRunAction, startPipelineRun, pauseRun, resumeRun, cancelRun } from "@/lib/actions/pipeline-actions";
import type { ActiveRun } from "@/lib/queries/runs";
import type { RunRow } from "@/components/pipeline/runs-view";

const POLL_MS = 1500;

export function LiveRunPanel({ initialActive, lastRun }: { initialActive: ActiveRun | null; lastRun: RunRow | null }) {
  const router = useRouter();
  const [active, setActive] = useState<ActiveRun | null>(initialActive);
  const [polling, setPolling] = useState<boolean>(initialActive != null);
  const [isStarting, startTransition] = useTransition();
  const watchedRef = useRef<string | null>(initialActive?.run.id ?? null);
  // Re-render every second so elapsed/ETA tick even between polls.
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!polling) return;
    const clock = setInterval(() => setTick((n) => n + 1), 1000);
    const poll = setInterval(async () => {
      let res: ActiveRun | null = null;
      try { res = await getActiveRunAction(); } catch { return; } // transient — try again next tick
      if (res) { watchedRef.current = res.run.id; setActive(res); return; }
      // res == null → the run we were watching just finished.
      const finishedId = watchedRef.current;
      watchedRef.current = null;
      setActive(null);
      setPolling(false);
      if (finishedId) {
        try {
          const { getRunDetailAction } = await import("@/lib/actions/pipeline-actions");
          const detail = await getRunDetailAction(finishedId);
          const st = (detail?.run.status ?? "success") as PipelineStatus;
          if (st === "failed") toast.error("Exécution terminée — échec. Voir le détail.");
          else if (st === "partial") toast.warning("Exécution terminée — succès partiel.");
          // SP5 Task 5: a Stop finalizes to 'cancelled' — the panel's poll observes it here (the
          // active run becomes null) exactly like any other terminal status, regardless of whether
          // this browser session is the one that clicked Stop (handleStop below already toasts
          // "Exécution annulée." immediately on click — this is the async confirmation once the run
          // row has actually finalized, same relationship as the other terminal toasts here).
          else if (st === "cancelled") toast.warning("Exécution annulée.");
          else toast.success("Exécution terminée avec succès.");
        } catch { /* ignore */ }
      }
      router.refresh(); // resync the list below
    }, POLL_MS);
    return () => { clearInterval(poll); clearInterval(clock); };
  }, [polling, router]);

  const handleStart = useCallback(() => {
    // Async transition callback so React 19 tracks the in-flight action and keeps `isStarting`
    // true until it resolves — a sync callback that returns a floating promise flips the pending
    // flag back in the same tick, re-enabling the button before the first poll and defeating
    // double-submit protection.
    startTransition(async () => {
      try {
        const r = await startPipelineRun();
        if (!r.ok) { toast.error(r.message); return; }
        watchedRef.current = r.runId;
        setPolling(true); // effect will pick up the live state on the next poll
      } catch { toast.error("Une erreur inattendue est survenue."); }
    });
  }, []);

  if (active) return <RunningView active={active} />;
  return <IdleView lastRun={lastRun} onStart={handleStart} starting={isStarting} />;
}

function IdleView({ lastRun, onStart, starting }: { lastRun: RunRow | null; onStart: () => void; starting: boolean }) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
        <div className="text-sm text-muted-foreground">
          {lastRun ? (
            <>Dernière exécution : <span className={STATUS_TEXT[lastRun.status]}>{pipelineStatusLabel(lastRun.status)}</span>{" · "}{relativeDate(lastRun.startedAt)}</>
          ) : "Aucune exécution pour l'instant."}
        </div>
        <RoleGate allow={["admin"]}>
          <Button onClick={onStart} disabled={starting}>
            {starting ? <Loader2 className="animate-spin" aria-hidden /> : <Play aria-hidden />}
            {starting ? "Démarrage…" : "Lancer une exécution maintenant"}
          </Button>
        </RoleGate>
      </CardContent>
    </Card>
  );
}

function RunningView({ active }: { active: ActiveRun }) {
  const { run, feedSteps, items } = active;
  // SP5 Task 5: getActiveRun (lib/queries/runs.ts) returns a run that's either "running" or
  // "paused" — RunningView handles both (the panel's idle/done states are untouched; a paused run
  // is neither).
  const isPaused = run.status === "paused";
  // While paused, `phase` is "finalizing" (set by executeRun's pause finalize path — see
  // lib/pipeline/run.ts) even though only SOME stories were processed — deriveHeader's finalizing
  // branch is calibrated for a run that's genuinely wrapping up (percent forced to 100), which
  // would wrongly render a paused run as if it were done. Override phase to "processing_items" for
  // the header calculation ONLY, so the label/percent reflect the run's real processed/total
  // progress instead — "don't treat paused as done".
  const header = deriveHeader(isPaused ? { ...run, phase: "processing_items" } : run);
  const startedMs = new Date(run.startedAt).getTime();
  const elapsed = Date.now() - startedMs;
  const etaMs = computeEta({ startedAtMs: startedMs, nowMs: Date.now(), processedItems: run.processedItems, totalItems: run.totalItems });
  // Processing is sequential and `items` is ordered by step arrival, so the in-flight item is the
  // LAST group. Select by position (collision-safe) — `run.currentItem` is used only for the
  // display title below, since titles can collide (two untitled items → same "(élément inconnu)").
  const currentGroup = items[items.length - 1];
  const failures = items.filter((i) => i.hasFailure).length + feedSteps.filter((s) => s.status === "failed").length;

  const [isControlPending, startControlTransition] = useTransition();

  // Async transition callbacks — same pattern as LiveRunPanel's handleStart above (see its comment):
  // a sync callback that returns a floating promise would flip `isControlPending` back to false in
  // the same tick, re-enabling the buttons before the action's result is known and defeating
  // double-submit protection.
  const handlePause = useCallback(() => {
    startControlTransition(async () => {
      try {
        const r = await pauseRun(run.id);
        if (!r.ok) { toast.error(r.message); return; }
        toast.success("Exécution mise en pause.");
      } catch { toast.error("Une erreur inattendue est survenue."); }
    });
  }, [run.id]);

  const handleResume = useCallback(() => {
    startControlTransition(async () => {
      try {
        const r = await resumeRun(run.id);
        if (!r.ok) { toast.error(r.message); return; }
        toast.success("Exécution reprise.");
      } catch { toast.error("Une erreur inattendue est survenue."); }
    });
  }, [run.id]);

  const handleStop = useCallback(() => {
    startControlTransition(async () => {
      try {
        const r = await cancelRun(run.id);
        if (!r.ok) { toast.error(r.message); return; }
        toast.success("Exécution annulée.");
      } catch { toast.error("Une erreur inattendue est survenue."); }
    });
  }, [run.id]);

  return (
    <Card>
      <CardContent className="space-y-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="font-semibold">{isPaused ? "Exécution en pause" : "Exécution en cours"}</div>
            <div className="text-xs text-muted-foreground">{TRIGGER_LABEL[run.triggeredBy] ?? run.triggeredBy} · démarrée {new Intl.DateTimeFormat("fr-FR", { timeStyle: "medium" }).format(startedMs)}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold",
              isPaused
                ? "border-[var(--status-draft)]/25 bg-[var(--status-draft)]/10 text-[var(--status-draft)]"
                : "border-[var(--status-in-review)]/25 bg-[var(--status-in-review)]/10 text-[var(--status-in-review)]",
            )}>
              <span className={cn("size-1.5 rounded-full bg-current", !isPaused && "animate-pulse")} />
              {pipelineStatusLabel(run.status)}
            </span>
            <RoleGate allow={["admin"]}>
              <div className="flex items-center gap-2">
                {isPaused ? (
                  <Button size="sm" variant="outline" onClick={handleResume} disabled={isControlPending}>
                    {isControlPending ? <Loader2 className="animate-spin" aria-hidden /> : <Play aria-hidden />}
                    Reprendre
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={handlePause} disabled={isControlPending}>
                    {isControlPending ? <Loader2 className="animate-spin" aria-hidden /> : <Pause aria-hidden />}
                    Pause
                  </Button>
                )}
                <Button size="sm" variant="destructive" onClick={handleStop} disabled={isControlPending}>
                  {isControlPending ? <Loader2 className="animate-spin" aria-hidden /> : <Square aria-hidden />}
                  Stop
                </Button>
              </div>
            </RoleGate>
          </div>
        </div>

        <div className="flex justify-between text-xs text-muted-foreground">
          <span>{header.phaseLabel}{header.denominator != null && <> — <b className="text-foreground">{header.numerator}/{header.denominator}</b></>}</span>
          <span>écoulé <b className="text-foreground">{formatClock(elapsed)}</b>{etaMs != null && !isPaused && <> · ~{formatClock(etaMs)} restant</>}{failures > 0 && <> · <span className="text-[var(--status-error)]">{failures} échec{failures > 1 ? "s" : ""}</span></>}</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div className={cn("h-full rounded-full transition-all", isPaused ? "bg-[var(--status-draft)]" : "bg-[var(--status-in-review)]")} style={{ width: `${header.percent ?? 8}%` }} />
        </div>

        {run.phase === "processing_items" && currentGroup && (
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <div className="mb-2 truncate text-xs text-muted-foreground">Élément en cours : <b className="text-foreground">{run.currentItem ?? currentGroup.title}</b></div>
            <Stepper nodes={deriveStepperNodes(currentGroup.steps, run.currentStage)} />
          </div>
        )}

        <LiveJournal feedSteps={feedSteps} items={items} currentRawItemId={currentGroup?.rawItemId} />
      </CardContent>
    </Card>
  );
}

function Stepper({ nodes }: { nodes: ReturnType<typeof deriveStepperNodes> }) {
  return (
    <ol className="flex items-start">
      {nodes.map((n, i) => (
        <li key={n.name} className="flex flex-1 flex-col items-center">
          <div className="flex w-full items-center">
            <span className={cn("mx-auto grid size-6 place-items-center rounded-full border text-[11px] font-bold",
              n.state === "done" && "border-[var(--status-approved)] bg-[var(--status-approved)] text-white",
              n.state === "current" && "border-[var(--status-in-review)] text-[var(--status-in-review)] ring-4 ring-[var(--status-in-review)]/15",
              n.state === "failed" && "border-[var(--status-error)] bg-[var(--status-error)] text-white",
              n.state === "pending" && "border-border text-muted-foreground")}>
              {n.state === "done" ? <Check className="size-3.5" /> : n.state === "failed" ? <X className="size-3.5" /> : n.state === "current" ? <Loader2 className="size-3 animate-spin" /> : i + 1}
            </span>
          </div>
          <span className={cn("mt-1.5 text-center text-[10px] leading-tight", n.state === "current" ? "font-semibold text-foreground" : "text-muted-foreground")}>{n.label}</span>
        </li>
      ))}
    </ol>
  );
}

function LiveJournal({ feedSteps, items, currentRawItemId }: { feedSteps: ActiveRun["feedSteps"]; items: ActiveRun["items"]; currentRawItemId: string | undefined }) {
  // Completed item groups (exclude the one still in flight) + feed steps, newest-ish first.
  // Exclude by stable rawItemId, not title — titles collide (untitled items share a placeholder).
  const done = items.filter((i) => i.rawItemId !== currentRawItemId);
  return (
    <div>
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Journal en direct · {done.length} terminé{done.length > 1 ? "s" : ""}</div>
      <ul className="space-y-1">
        {done.slice().reverse().map((i) => (
          <li key={i.rawItemId} className="flex items-center gap-2 border-t border-border/60 py-1.5 text-sm first:border-t-0">
            <span className={cn("grid size-4 place-items-center rounded-full text-[10px] font-bold text-white", i.hasFailure ? "bg-[var(--status-error)]" : "bg-[var(--status-approved)]")}>{i.hasFailure ? "✕" : "✓"}</span>
            <span className="min-w-0 flex-1 truncate">{i.title}</span>
            {i.url && <a href={i.url} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground"><ExternalLink className="size-3.5" /></a>}
          </li>
        ))}
        {feedSteps.slice().reverse().map((s) => (
          <li key={s.id} className="flex items-center gap-2 border-t border-border/60 py-1.5 text-sm text-muted-foreground first:border-t-0">
            <span className={cn("grid size-4 place-items-center rounded-full text-[10px] font-bold text-white", s.status === "failed" ? "bg-[var(--status-error)]" : "bg-slate-400")}>≡</span>
            <span className="min-w-0 flex-1 truncate">{s.name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Used by IdleView's "Dernière exécution" line — a terminal run only, so `running`/`paused` never
// actually render here in practice, but the map stays exhaustive against PipelineStatus.
const STATUS_TEXT: Record<PipelineStatus, string> = {
  running: "text-[var(--status-in-review)]", success: "text-[var(--status-approved)]",
  partial: "text-[var(--status-pending)]", failed: "text-[var(--status-error)]",
  // SP5: cancelled (Stop) / paused (Pause) — RunningView (Task 5) renders its own pill for the
  // live "running"/"paused" cases; this map only needs to stay exhaustive here.
  cancelled: "text-[var(--status-rejected)]", paused: "text-[var(--status-draft)]",
};

const TRIGGER_LABEL: Record<string, string> = {
  manual: "Déclenchement manuel",
  scheduled: "Planification automatique",
  reprocess: "Retraitement d'un élément",
};
