import { expect, test } from "bun:test";
import { buildConducteur, type RundownBeatInput } from "@/lib/video/rundown";

const resolve = (url: string | null, r2Key: string | null) =>
  r2Key ? `https://cdn.test/${r2Key}` : url;

function beat(over: Partial<RundownBeatInput> = {}): RundownBeatInput {
  return {
    position: 1, kind: "narration", spokenText: "Bonjour",
    directionNote: null, screenText: null, transitionIn: null, transitionOut: null,
    estimatedDurationSec: 5, durationOverrideSec: null, speakerName: null,
    montageCheckedAt: null, inserts: [], ...over,
  };
}

test("durée = override si présent, sinon estimation stockée (pas de recalcul)", () => {
  const c = buildConducteur([beat({ estimatedDurationSec: 5, durationOverrideSec: 12 })], resolve);
  expect(c.beats[0].durationSec).toBe(12);
  const c2 = buildConducteur([beat({ estimatedDurationSec: 7, durationOverrideSec: null })], resolve);
  expect(c2.beats[0].durationSec).toBe(7);
});

test("totaux : nb beats, durée totale, nb inserts, nb liens morts", () => {
  const c = buildConducteur([
    beat({ estimatedDurationSec: 3, inserts: [
      { id: "i1", kind: "image", url: "http://x", r2Key: null, tcIn: null, tcOut: null, displayDurationSec: null, credit: null, rightsNote: null, linkStatus: "ok" },
      { id: "i2", kind: "video", url: null, r2Key: "k2", tcIn: "00:00:01", tcOut: "00:00:05", displayDurationSec: 4, credit: "AFP", rightsNote: null, linkStatus: "mort" },
    ] }),
    beat({ position: 2, estimatedDurationSec: 4, inserts: [] }),
  ], resolve);
  expect(c.totals).toEqual({ beatCount: 2, totalDurationSec: 7, insertCount: 2, deadLinkCount: 1 });
  expect(c.beats[0].inserts[1].mediaUrl).toBe("https://cdn.test/k2");
  expect(c.beats[0].inserts[1].linkLabel).toBe("Mort");
  expect(c.beats[0].inserts[0].kindLabel).toBe("Image");
});

test("interdit compte aussi comme lien mort ; breathRisk et checked exposés", () => {
  const long = "mot ".repeat(40);
  const c = buildConducteur([beat({ spokenText: long, montageCheckedAt: new Date(), inserts: [
    { id: "i", kind: "extrait", url: "http://x", r2Key: null, tcIn: null, tcOut: null, displayDurationSec: null, credit: null, rightsNote: null, linkStatus: "interdit" },
  ] })], resolve);
  expect(c.totals.deadLinkCount).toBe(1);
  expect(c.beats[0].breathRisk).toBe(true);
  expect(c.beats[0].checked).toBe(true);
});
