// SP7 — runs list client-side filter bar.
//
// Lives in its own DB-free module (NOT lib/queries/runs.ts) because it is the one runtime value the
// "use client" runs-view.tsx pulls in: importing it from runs.ts would drag that module's `@/db`
// (side-effectful `pg` Pool) into the browser bundle and break `next build`. Pure so it's
// unit-testable without a DOM/DB; runs.ts re-exports it so server code/tests can keep importing it
// from "@/lib/queries/runs". Generic over the minimal shape it needs so it isn't coupled to
// runs-view.tsx's full RunRow type.
export function filterRuns<T extends { status: string; triggeredBy: string }>(
  rows: readonly T[],
  filters: { status: string; trigger: string },
): T[] {
  return rows.filter((r) =>
    (filters.status === "all" || r.status === filters.status)
    && (filters.trigger === "all" || r.triggeredBy === filters.trigger));
}
