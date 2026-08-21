// Sérialiseurs purs du conducteur (Task 10). Comme lib/video/rundown.ts : aucune importation de
// @/db ici — la lecture DB reste dans lib/montage/persist.ts (readConducteurCore), qui produit le
// Conducteur que ces fonctions transforment ensuite en CSV/JSON/manifeste.
import type { Conducteur } from "@/lib/video/rundown";

const CSV_HEADER = [
  "beat_position", "beat_kind", "duration_sec", "insert_kind",
  "tc_in", "tc_out", "media_url", "credit", "rights", "link_status",
];

// Neutralise l'injection de formule CSV : si le premier caractère déclencherait l'exécution
// d'une formule à l'ouverture dans Excel/Sheets (= + - @ ou tabulation/retour chariot en tête),
// préfixer d'une apostrophe avant tout échappement RFC 4180.
const CSV_FORMULA_TRIGGER = /^[=+\-@\t\r]/;

function neutralizeCsvFormula(s: string): string {
  return CSV_FORMULA_TRIGGER.test(s) ? `'${s}` : s;
}

// RFC 4180 : entourer de guillemets si la valeur contient une virgule, un guillemet ou un retour
// à la ligne ; doubler tout guillemet interne.
function csvField(value: string | number | null): string {
  if (value === null || value === undefined) return "";
  const s = neutralizeCsvFormula(String(value));
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(fields: Array<string | number | null>): string {
  return fields.map(csvField).join(",");
}

export function toShotListCsv(conducteur: Conducteur): string {
  const rows: string[] = [csvRow(CSV_HEADER)];
  for (const beat of conducteur.beats) {
    if (beat.inserts.length === 0) {
      rows.push(csvRow([
        beat.position, beat.kind, beat.durationSec,
        null, null, null, null, null, null, null,
      ]));
      continue;
    }
    for (const ins of beat.inserts) {
      rows.push(csvRow([
        beat.position, beat.kind, beat.durationSec,
        ins.kind, ins.tcIn, ins.tcOut, ins.mediaUrl, ins.credit, ins.rightsNote, ins.linkStatus,
      ]));
    }
  }
  return rows.join("\r\n") + "\r\n";
}

export function toShotListJson(conducteur: Conducteur): unknown {
  return conducteur;
}

export function toMediaManifest(conducteur: Conducteur): {
  media: Array<{
    beatPosition: number; insertKind: string; mediaUrl: string;
    tcIn: string | null; tcOut: string | null; credit: string | null;
    rightsNote: string | null; linkStatus: string;
  }>;
} {
  const media: Array<{
    beatPosition: number; insertKind: string; mediaUrl: string;
    tcIn: string | null; tcOut: string | null; credit: string | null;
    rightsNote: string | null; linkStatus: string;
  }> = [];
  for (const beat of conducteur.beats) {
    for (const ins of beat.inserts) {
      if (!ins.mediaUrl) continue;
      media.push({
        beatPosition: beat.position, insertKind: ins.kind, mediaUrl: ins.mediaUrl,
        tcIn: ins.tcIn, tcOut: ins.tcOut, credit: ins.credit, rightsNote: ins.rightsNote,
        linkStatus: ins.linkStatus,
      });
    }
  }
  return { media };
}
