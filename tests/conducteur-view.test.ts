import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ConducteurView } from "@/components/video/conducteur-view";
import type { Conducteur } from "@/lib/video/rundown";

const conducteur: Conducteur = {
  beats: [{
    position: 0, kind: "narration", kindLabel: "Narration", spokenText: "Bonjour",
    directionNote: "Plan large", screenText: null, transitionIn: null, transitionOut: null,
    durationSec: 12, breathRisk: false, speakerName: null, checked: false,
    inserts: [{ id: "i1", kind: "image", kindLabel: "Image", mediaUrl: "http://x/a.jpg",
      tcIn: "00:00:01", tcOut: "00:00:05", displayDurationSec: 4, credit: "AFP", rightsNote: null,
      linkStatus: "mort", linkLabel: "Mort" }],
  }],
  totals: { beatCount: 1, totalDurationSec: 12, insertCount: 1, deadLinkCount: 1 },
};

test("affiche totaux, beat, insert et badge de lien", () => {
  const html = renderToStaticMarkup(createElement(ConducteurView, { conducteur }));
  expect(html).toContain("Narration");
  expect(html).toContain("Plan large");
  expect(html).toContain("Mort");
  expect(html).toContain("AFP");
});

test("état vide", () => {
  const empty: Conducteur = { beats: [], totals: { beatCount: 0, totalDurationSec: 0, insertCount: 0, deadLinkCount: 0 } };
  const html = renderToStaticMarkup(createElement(ConducteurView, { conducteur: empty }));
  expect(html).toContain("Aucun beat");
});
