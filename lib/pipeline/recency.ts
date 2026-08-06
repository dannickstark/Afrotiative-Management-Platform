// Pure recency helpers for phase-1 candidate handling (no DB/DOM, time injected).

// Cutoff filter — returns true when an item should be KEPT. Undated / unparseable-date items are
// kept (undated-include policy): the cutoff only excludes items we can prove are older than it.
export function isWithinRecency(isoDate: string | null, cutoffAt: Date | null): boolean {
  if (!cutoffAt) return true;         // no cutoff configured
  if (!isoDate) return true;          // no publish date → include
  const t = Date.parse(isoDate);
  if (Number.isNaN(t)) return true;   // unparseable date → treat as undated → include
  return t >= cutoffAt.getTime();
}

// Cap narrowing — applied AFTER all filtering. Keeps the `maxItems` most-recent items; undated (or
// unparseable) items rank as OLDEST (sort key -Infinity), so they're dropped first when over the
// cap but still kept when there's room. Array.sort is stable, so equal keys keep input order.
export function narrowByRecency<T>(
  items: readonly T[],
  isoDateOf: (t: T) => string | null,
  maxItems: number,
): { kept: T[]; dropped: T[] } {
  if (items.length <= maxItems) return { kept: [...items], dropped: [] };
  const key = (t: T) => { const d = Date.parse(isoDateOf(t) ?? ""); return Number.isNaN(d) ? -Infinity : d; };
  const sorted = [...items].sort((a, b) => key(b) - key(a));  // most-recent first
  return { kept: sorted.slice(0, maxItems), dropped: sorted.slice(maxItems) };
}
