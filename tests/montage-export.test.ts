import { expect, test } from "bun:test";
import { buildConducteur, type RundownBeatInput } from "@/lib/video/rundown";
import { toShotListCsv, toShotListJson, toMediaManifest } from "@/lib/montage/export";

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

const HEADER = "beat_position,beat_kind,duration_sec,insert_kind,tc_in,tc_out,media_url,credit,rights,link_status";

test("toShotListCsv : en-tête + une ligne par insert", () => {
  const c = buildConducteur([
    beat({
      position: 0, kind: "narration", estimatedDurationSec: 5,
      inserts: [
        { id: "i1", kind: "image", url: "http://x", r2Key: null, tcIn: "00:00:01", tcOut: "00:00:03", displayDurationSec: 2, credit: "AFP", rightsNote: "libre", linkStatus: "ok" },
        { id: "i2", kind: "video", url: null, r2Key: "k2", tcIn: null, tcOut: null, displayDurationSec: null, credit: null, rightsNote: null, linkStatus: "mort" },
      ],
    }),
  ], resolve);
  const csv = toShotListCsv(c);
  const lines = csv.split("\r\n").filter((l) => l.length > 0);
  expect(lines[0]).toBe(HEADER);
  expect(lines.length).toBe(3); // header + 2 inserts
  expect(lines[1]).toBe("0,narration,5,image,00:00:01,00:00:03,http://x,AFP,libre,ok");
  expect(lines[2]).toBe("0,narration,5,video,,,https://cdn.test/k2,,,mort");
});

test("toShotListCsv : un beat sans insert → une ligne avec colonnes insert vides", () => {
  const c = buildConducteur([beat({ position: 0, kind: "interview", estimatedDurationSec: 8, inserts: [] })], resolve);
  const csv = toShotListCsv(c);
  const lines = csv.split("\r\n").filter((l) => l.length > 0);
  expect(lines.length).toBe(2);
  expect(lines[1]).toBe("0,interview,8,,,,,,,");
});

test("toShotListCsv : échappe virgule, guillemet et retour ligne (RFC 4180)", () => {
  const c = buildConducteur([
    beat({
      position: 0, kind: "narration", estimatedDurationSec: 5,
      inserts: [
        { id: "i1", kind: "image", url: "http://x", r2Key: null, tcIn: null, tcOut: null, displayDurationSec: null, credit: 'Studio "Le Monde", Paris', rightsNote: "ligne1\nligne2", linkStatus: "ok" },
      ],
    }),
  ], resolve);
  const csv = toShotListCsv(c);
  expect(csv).toContain('"Studio ""Le Monde"", Paris"');
  expect(csv).toContain('"ligne1\nligne2"');
});

test("toShotListJson : reflète le conducteur", () => {
  const c = buildConducteur([beat({ position: 0 })], resolve);
  const json = toShotListJson(c) as { beats: unknown[] };
  expect(json.beats.length).toBe(1);
});

test("toMediaManifest : ne liste que les inserts avec mediaUrl", () => {
  const c = buildConducteur([
    beat({
      position: 0, inserts: [
        { id: "i1", kind: "image", url: "http://x", r2Key: null, tcIn: null, tcOut: null, displayDurationSec: null, credit: "A", rightsNote: null, linkStatus: "ok" },
        { id: "i2", kind: "video", url: null, r2Key: null, tcIn: null, tcOut: null, displayDurationSec: null, credit: null, rightsNote: null, linkStatus: "ok" },
      ],
    }),
  ], resolve);
  const manifest = toMediaManifest(c);
  expect(manifest.media.length).toBe(1);
  expect(manifest.media[0].mediaUrl).toBe("http://x");
});
