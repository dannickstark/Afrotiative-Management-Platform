"use client";
import { useTransition } from "react";
import { toast } from "sonner";
import { Loader2, ExternalLink, ChevronRight } from "lucide-react";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { RoleGate } from "@/components/role-gate";
import { pipelineStatusLabel, formatDate, formatRunDuration, type PipelineStatus } from "@/lib/format";
import { startPipelineRun, reprocessRawItem } from "@/lib/actions/pipeline-actions";
import type { RunDetail, Step } from "@/lib/queries/runs";
import { cn } from "@/lib/utils";

type RunItem = RunDetail["items"][number];

// Palette aligned with the rest of the pipeline UI — the runs list (app/(app)/runs/page.tsx) and
// dashboard (components/dashboard/summary-cards.tsx) map pipeline `failed` to --status-error (NOT
// the article-status --status-rejected), so the same run's status can't show two different reds
// once Task 4 wires this Sheet off the list: success=approved/green, failed=error/red,
// running=in-review/indigo, partial=pending/amber.
const STATUS_PILL_STYLE: Record<PipelineStatus, string> = {
  success: "bg-[var(--status-approved)]/15 text-[var(--status-approved)] border-[var(--status-approved)]/30",
  failed: "bg-[var(--status-error)]/15 text-[var(--status-error)] border-[var(--status-error)]/30",
  running: "bg-[var(--status-in-review)]/15 text-[var(--status-in-review)] border-[var(--status-in-review)]/30",
  partial: "bg-[var(--status-pending)]/15 text-[var(--status-pending)] border-[var(--status-pending)]/30",
  // SP5: cancelled (Stop) / paused (Pause) — button wiring lives in live-run-panel.tsx (Task 5).
  cancelled: "bg-[var(--status-rejected)]/15 text-[var(--status-rejected)] border-[var(--status-rejected)]/30",
  paused: "bg-[var(--status-draft)]/15 text-[var(--status-draft)] border-[var(--status-draft)]/30",
};

// Step.status is typed as `string` (it's an unvalidated DB column read), so guard against an
// unrecognized value rather than indexing STATUS_PILL_STYLE with something that isn't a key —
// falling back to the "failed" (red) treatment surfaces the anomaly instead of hiding it.
function StatusPill({ status, className }: { status: string; className?: string }) {
  const key = (status in STATUS_PILL_STYLE ? status : "failed") as PipelineStatus;
  return (
    <Badge variant="outline" className={cn("shrink-0", STATUS_PILL_STYLE[key], className)}>
      {pipelineStatusLabel(key)}
    </Badge>
  );
}

function formatStepDuration(ms: number | null): string {
  if (ms == null) return "—";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

const TRIGGERED_BY_LABEL: Record<string, string> = {
  scheduled: "Planification automatique",
  manual: "Déclenchement manuel",
  reprocess: "Retraitement d'un élément",
};

function triggeredByLabel(v: string): string {
  return TRIGGERED_BY_LABEL[v] ?? v;
}

/**
 * Run-detail drawer (SP4 Task 3). Purely presentational: the page/wrapper built in Task 4 fetches
 * `getRunDetail()` and owns the open/loading state; this component only renders it and wires the
 * two admin recovery actions (startPipelineRun / reprocessRawItem).
 */
export function RunDetailSheet({
  run,
  open,
  onOpenChange,
  loading,
}: {
  run: RunDetail | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loading: boolean;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-lg data-[side=right]:sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Détail de l&apos;exécution</SheetTitle>
          <SheetDescription>
            {run ? formatDate(run.run.startedAt) : "Trace complète d'une exécution du pipeline."}
          </SheetDescription>
        </SheetHeader>

        {loading ? (
          <RunDetailSkeleton />
        ) : run ? (
          <RunDetailBody run={run} />
        ) : (
          <p className="px-4 pb-4 text-sm text-muted-foreground">Aucune exécution sélectionnée.</p>
        )}
      </SheetContent>
    </Sheet>
  );
}

function RunDetailSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4">
      <Skeleton className="h-6 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-4 w-1/3" />
      <Separator className="my-1" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

function RunDetailBody({ run }: { run: RunDetail }) {
  const { run: r, feedSteps, items } = run;
  const noSteps = feedSteps.length === 0 && items.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status={r.status} />
        <span className="text-xs text-muted-foreground">{triggeredByLabel(r.triggeredBy)}</span>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">Démarrée</dt>
          <dd className="font-medium text-foreground">{formatDate(r.startedAt)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Durée</dt>
          <dd className="font-medium text-foreground">{formatRunDuration(r.startedAt, r.finishedAt, r.status)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Flux lus</dt>
          <dd className="font-medium text-foreground">{r.feedsRead}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Nouveaux éléments</dt>
          <dd className="font-medium text-foreground">{r.newItems}</dd>
        </div>
      </dl>

      {/* Recovery is scoped to admins to match startPipelineRun()'s server-side
          requirePermission(role, "pipeline", "configure"). */}
      <RoleGate allow={["admin"]}>
        <RerunRunButton />
      </RoleGate>

      <Separator />

      {noSteps ? (
        <p className="text-sm text-muted-foreground">Aucune étape enregistrée.</p>
      ) : (
        <>
          {feedSteps.length > 0 && (
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Étapes du flux
              </h3>
              <ul className="flex flex-col gap-1.5">
                {feedSteps.map((s) => (
                  <li
                    key={s.id}
                    className="flex flex-col gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate">{s.name}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        <StatusPill status={s.status} />
                        <span className="text-xs text-muted-foreground">{formatStepDuration(s.durationMs)}</span>
                      </span>
                    </div>
                    {s.status === "failed" && <FailedStepDetail step={s} />}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {items.length > 0 && (
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Éléments traités
              </h3>
              <ul className="flex flex-col gap-2">
                {items.map((item) => (
                  <ItemGroup key={item.rawItemId} item={item} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function RerunRunButton() {
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    // Async transition callback so React 19 tracks the in-flight action and keeps `isPending`
    // true until it resolves — a sync callback that returns a floating promise (startTransition(()
    // => promise.then(...))) flips the pending flag back in the same tick, re-enabling the button
    // before the request completes and defeating the disabled state. Mirrors LiveRunPanel's
    // handleStart (components/pipeline/live-run-panel.tsx).
    startTransition(async () => {
      try {
        const r = await startPipelineRun();
        if (r.ok) toast.success("Exécution lancée — suivez-la en direct sur la page des exécutions.");
        else toast.error(r.message);
      } catch {
        // Defense in depth: requirePermission()/requireUser() throw rather than return
        // {ok:false,...} — shouldn't happen given the RoleGate above, but never leave the
        // button silently stuck without feedback if it does.
        toast.error("Une erreur inattendue est survenue.");
      }
    });
  }

  return (
    <Button variant="outline" size="sm" onClick={handleClick} disabled={isPending} className="self-start">
      {isPending && <Loader2 className="animate-spin" aria-hidden />}
      {isPending ? "Démarrage…" : "Relancer l'exécution"}
    </Button>
  );
}

function ItemGroup({ item }: { item: RunItem }) {
  const [isPending, startTransition] = useTransition();

  function handleReprocess() {
    startTransition(() => {
      reprocessRawItem(item.rawItemId)
        .then((r) => {
          if (r.ok) toast.success(r.message);
          else toast.error(r.message);
        })
        .catch(() => toast.error("Une erreur inattendue est survenue."));
    });
  }

  return (
    <li className="rounded-md border border-border">
      <Collapsible>
        <div className="flex items-center gap-2 px-2.5 py-2">
          <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-1.5 rounded text-left text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            <ChevronRight
              className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-data-panel-open:rotate-90"
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate">{item.title}</span>
          </CollapsibleTrigger>
          {item.url && (
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Ouvrir « ${item.title} » sur le site source`}
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="size-3.5" />
            </a>
          )}
          <StatusPill status={item.hasFailure ? "failed" : "success"} />
        </div>

        <CollapsibleContent className="border-t border-border px-2.5 py-2">
          <ul className="flex flex-col gap-2">
            {item.steps.map((s) => (
              <li key={s.id} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <StatusPill status={s.status} />
                    <span className="text-xs text-muted-foreground">{formatStepDuration(s.durationMs)}</span>
                  </span>
                </div>
                {s.status === "failed" && <FailedStepDetail step={s} />}
              </li>
            ))}
          </ul>

          {item.hasFailure && (
            <RoleGate allow={["admin"]}>
              <Button
                variant="outline"
                size="sm"
                onClick={handleReprocess}
                disabled={isPending}
                className="mt-2"
              >
                {isPending && <Loader2 className="animate-spin" aria-hidden />}
                {isPending ? "Retraitement…" : "Relancer cet élément"}
              </Button>
            </RoleGate>
          )}
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

function FailedStepDetail({ step }: { step: Step }) {
  return (
    <div className="rounded-md border border-[var(--status-error)]/30 bg-[var(--status-error)]/10 px-2.5 py-2">
      <p className="text-xs font-medium text-[var(--status-error)]">
        {step.errorMessage ?? "Une erreur est survenue."}
      </p>
      {step.errorTechnical && (
        <Collapsible className="mt-1.5">
          <CollapsibleTrigger className="rounded text-xs font-medium text-muted-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50">
            Voir les détails techniques
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-1.5">
            <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">{step.errorTechnical}</pre>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
