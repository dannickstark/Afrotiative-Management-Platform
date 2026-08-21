import { TC_RE } from "@/lib/video/schema";

/** `HH:MM:SS(.mmm)` → secondes (ms incluses). `null` si non conforme à TC_RE. */
export function parseTimecode(tc: string | null): number | null {
  if (!tc || !TC_RE.test(tc)) return null;
  const [hms, ms] = tc.split(".");
  const [h, m, s] = hms.split(":").map(Number);
  const millis = ms ? Number(ms.padEnd(3, "0")) : 0;
  return h * 3600 + m * 60 + s + millis / 1000;
}

/** Durée en secondes si les deux timecodes sont valides et `out > in`, sinon `null`. */
export function insertSpanSeconds(tcIn: string | null, tcOut: string | null): number | null {
  const a = parseTimecode(tcIn);
  const b = parseTimecode(tcOut);
  if (a === null || b === null) return null;
  const span = b - a;
  return span > 0 ? span : null;
}
