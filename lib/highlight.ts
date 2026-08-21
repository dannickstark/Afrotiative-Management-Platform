export const HIGHLIGHT_COLORS = ["jaune", "vert", "rouge", "bleu"] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];

const CLASS_RE = /^hl-(jaune|vert|rouge|bleu)$/;

export function classForColor(color: HighlightColor): string {
  return `hl-${color}`;
}
export function colorForClass(cls: string): HighlightColor | null {
  const m = CLASS_RE.exec(cls.trim());
  return m ? (m[1] as HighlightColor) : null;
}
