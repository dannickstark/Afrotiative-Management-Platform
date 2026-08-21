import { BEAT_KIND_LABEL, INSERT_KIND_LABEL, LINK_STATUS_LABEL } from "@/lib/video/labels";
import { isBreathRisk } from "@/lib/video/duration";

export type RundownInsertInput = {
  id: string; kind: string; url: string | null; r2Key: string | null;
  tcIn: string | null; tcOut: string | null; displayDurationSec: number | null;
  credit: string | null; rightsNote: string | null; linkStatus: string;
};

export type RundownBeatInput = {
  // Facultatif : `readConducteurCore` le renseigne (Task 9, annotations monteur) mais les tests
  // purs de buildConducteur n'ont pas besoin de le fournir.
  id?: string;
  position: number; kind: string; spokenText: string;
  directionNote: string | null; screenText: string | null;
  transitionIn: string | null; transitionOut: string | null;
  estimatedDurationSec: number; durationOverrideSec: number | null;
  speakerName: string | null; montageCheckedAt: Date | null;
  inserts: RundownInsertInput[];
};

export type ConducteurInsert = {
  id: string; kind: string; kindLabel: string; mediaUrl: string | null;
  tcIn: string | null; tcOut: string | null; displayDurationSec: number | null;
  credit: string | null; rightsNote: string | null; linkStatus: string; linkLabel: string;
};

export type ConducteurBeat = {
  id?: string;
  position: number; kind: string; kindLabel: string; spokenText: string;
  directionNote: string | null; screenText: string | null;
  transitionIn: string | null; transitionOut: string | null;
  durationSec: number; breathRisk: boolean; speakerName: string | null;
  checked: boolean; inserts: ConducteurInsert[];
};

export type Conducteur = {
  beats: ConducteurBeat[];
  totals: { beatCount: number; totalDurationSec: number; insertCount: number; deadLinkCount: number };
};

const DEAD = new Set(["mort", "interdit"]);

export function buildConducteur(
  beats: RundownBeatInput[],
  resolveMedia: (url: string | null, r2Key: string | null) => string | null,
): Conducteur {
  const outBeats: ConducteurBeat[] = beats.map((b) => ({
    id: b.id,
    position: b.position,
    kind: b.kind,
    kindLabel: BEAT_KIND_LABEL[b.kind] ?? b.kind,
    spokenText: b.spokenText,
    directionNote: b.directionNote,
    screenText: b.screenText,
    transitionIn: b.transitionIn,
    transitionOut: b.transitionOut,
    durationSec: b.durationOverrideSec ?? b.estimatedDurationSec,
    breathRisk: isBreathRisk(b.spokenText),
    speakerName: b.speakerName,
    checked: b.montageCheckedAt !== null,
    inserts: b.inserts.map((ins) => ({
      id: ins.id,
      kind: ins.kind,
      kindLabel: INSERT_KIND_LABEL[ins.kind] ?? ins.kind,
      mediaUrl: resolveMedia(ins.url, ins.r2Key),
      tcIn: ins.tcIn,
      tcOut: ins.tcOut,
      displayDurationSec: ins.displayDurationSec,
      credit: ins.credit,
      rightsNote: ins.rightsNote,
      linkStatus: ins.linkStatus,
      linkLabel: LINK_STATUS_LABEL[ins.linkStatus] ?? ins.linkStatus,
    })),
  }));

  return {
    beats: outBeats,
    totals: {
      beatCount: outBeats.length,
      totalDurationSec: outBeats.reduce((s, b) => s + b.durationSec, 0),
      insertCount: outBeats.reduce((n, b) => n + b.inserts.length, 0),
      deadLinkCount: outBeats.reduce((n, b) => n + b.inserts.filter((i) => DEAD.has(i.linkStatus)).length, 0),
    },
  };
}
