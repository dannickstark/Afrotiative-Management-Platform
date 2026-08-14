// PUR — aucune I/O, importable depuis bun test sans tirer le client DB (contrairement à
// lib/queries/queue.ts, qui instancie `db` au chargement du module). Colonnes cliquables des
// en-têtes du tableau /queue (task B2) → ce module fait la liste blanche qui protège l'ORDER BY
// d'une injection : un `?sort=` arbitraire ne DOIT jamais atteindre le SQL sans être filtré ici.
export type QueueSortCol = "title" | "category" | "score" | "date" | "source" | "status";

const VALID_COLUMNS: readonly QueueSortCol[] = [
  "title", "category", "score", "date", "source", "status",
];

function isQueueSortCol(v: string | undefined): v is QueueSortCol {
  return v !== undefined && (VALID_COLUMNS as readonly string[]).includes(v);
}

/**
 * `?sort=`/`?dir=` bruts → colonne + direction typées. Valeur inconnue ou absente retombe sur
 * le tri par défaut actuel de la file (le plus récent d'abord) plutôt que d'échouer.
 */
export function resolveQueueSort(
  sort?: string,
  dir?: string,
): { column: QueueSortCol; direction: "asc" | "desc" } {
  const column: QueueSortCol = isQueueSortCol(sort) ? sort : "date";
  const direction: "asc" | "desc" = dir === "asc" ? "asc" : "desc";
  return { column, direction };
}
