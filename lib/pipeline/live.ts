// Pure, DB-free view helpers for the live run panel. Unit-tested in tests/live-panel.test.ts.

// The 5 per-item stages, by their EXACT pipeline_steps.name (must match lib/pipeline/stages.ts).
export const ITEM_STAGES = [
  "Extraction du contenu",
  "Calcul de l'embedding",
  "Regroupement (clustering)",
  "Génération IA",
  "Dépôt en revue",
] as const;

// Short labels for the stepper nodes (the long names don't fit under a 24px circle).
const STAGE_LABEL: Record<string, string> = {
  "Extraction du contenu": "Extraction",
  "Calcul de l'embedding": "Embedding",
  "Regroupement (clustering)": "Clustering",
  "Génération IA": "Génération IA",
  "Dépôt en revue": "Dépôt",
};

export type StepperNode = { name: string; label: string; state: "done" | "current" | "pending" | "failed" };

/**
 * Map an item's already-completed steps + the run's current_stage onto the 5 fixed nodes.
 * A failed stage stays failed and everything after it stays pending (the stepper freezes there).
 */
export function deriveStepperNodes(
  itemSteps: { name: string; status: string }[],
  currentStage: string | null,
): StepperNode[] {
  const byName = new Map(itemSteps.map((s) => [s.name, s.status]));
  let sawFailure = false;
  return ITEM_STAGES.map((name) => {
    const status = byName.get(name);
    let state: StepperNode["state"];
    if (sawFailure) {
      // Once any stage has failed, freeze everything after it as pending.
      state = "pending";
    } else if (status === "failed") {
      state = "failed";
      sawFailure = true;
    } else if (status === "success") {
      state = "done";
    } else if (name === currentStage) {
      state = "current";
    } else {
      state = "pending";
    }
    return { name, label: STAGE_LABEL[name] ?? name, state };
  });
}

/** Rough ETA in ms; null until ≥2 items are done or the total is unknown. Intentionally approximate. */
export function computeEta(input: {
  startedAtMs: number; nowMs: number; processedItems: number; totalItems: number | null;
}): number | null {
  const { startedAtMs, nowMs, processedItems, totalItems } = input;
  if (totalItems == null || processedItems < 2) return null;
  const avg = (nowMs - startedAtMs) / processedItems;
  const remaining = Math.max(0, totalItems - processedItems);
  return Math.round(avg * remaining);
}

export type HeaderModel = { phaseLabel: string; numerator: number; denominator: number | null; percent: number | null };

const pct = (num: number, den: number | null): number | null =>
  den && den > 0 ? Math.round((num / den) * 100) : null;

/** Which counter/label the header shows, per phase. */
export function deriveHeader(run: {
  phase: string | null; feedsRead: number; feedsTotal: number | null; processedItems: number; totalItems: number | null;
}): HeaderModel {
  if (run.phase === "reading_feeds") {
    return { phaseLabel: "Lecture des flux", numerator: run.feedsRead, denominator: run.feedsTotal, percent: pct(run.feedsRead, run.feedsTotal) };
  }
  if (run.phase === "finalizing") {
    return { phaseLabel: "Finalisation", numerator: run.processedItems, denominator: run.totalItems, percent: 100 };
  }
  // processing_items (and any fallback)
  return { phaseLabel: "Traitement des éléments", numerator: run.processedItems, denominator: run.totalItems, percent: pct(run.processedItems, run.totalItems) };
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60), s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
