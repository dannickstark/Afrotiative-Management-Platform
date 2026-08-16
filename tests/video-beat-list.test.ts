import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BeatList, type BeatView } from "@/components/video/beat-list";
import { DurationMeter } from "@/components/video/duration-meter";

function beat(over: Partial<BeatView> = {}): BeatView {
  return {
    id: "u1", externalId: "b-01-accroche", position: 0, kind: "narration",
    spokenText: "<p>En 2019, cette PME vendait dans deux marchés.</p>",
    directionNote: "Plan serré", screenText: null, transitionIn: null, transitionOut: "cut sec",
    estimatedDurationSec: 4, durationOverrideSec: null, locallyEdited: false, inserts: [], ...over,
  };
}

describe("BeatList", () => {
  it("affiche l'identifiant externe du beat", () => {
    const html = renderToStaticMarkup(React.createElement(BeatList, { beats: [beat()], targetDurationSec: 720 }));
    expect(html).toContain("b-01-accroche");
  });

  it("affiche le texte parlé", () => {
    const html = renderToStaticMarkup(React.createElement(BeatList, { beats: [beat()], targetDurationSec: 720 }));
    expect(html).toContain("cette PME vendait");
  });

  it("marque un beat modifié localement", () => {
    const html = renderToStaticMarkup(React.createElement(BeatList, { beats: [beat({ locallyEdited: true })], targetDurationSec: 720 }));
    expect(html).toContain("Modifié localement");
  });

  it("avertit sur un beat trop long à dire d'un souffle", () => {
    const long = `<p>${Array(40).fill("mot").join(" ")}</p>`;
    const html = renderToStaticMarkup(React.createElement(BeatList, { beats: [beat({ spokenText: long })], targetDurationSec: 720 }));
    expect(html).toContain("souffle");
  });

  it("n'avertit pas sur un beat court", () => {
    const html = renderToStaticMarkup(React.createElement(BeatList, { beats: [beat()], targetDurationSec: 720 }));
    expect(html).not.toContain("souffle");
  });

  it("affiche l'état vide avant tout import", () => {
    const html = renderToStaticMarkup(React.createElement(BeatList, { beats: [], targetDurationSec: 720 }));
    expect(html).toContain("Aucun beat");
  });
});

describe("DurationMeter", () => {
  it("affiche le cumul face à la cible", () => {
    const html = renderToStaticMarkup(React.createElement(DurationMeter, { totalSec: 725, targetSec: 720 }));
    expect(html).toContain("12 min 05 s");
    expect(html).toContain("12 min 00 s");
  });

  it("affiche un écart signé au-dessus de la cible", () => {
    const html = renderToStaticMarkup(React.createElement(DurationMeter, { totalSec: 725, targetSec: 720 }));
    expect(html).toContain("+5 s");
  });

  it("affiche un écart signé en dessous de la cible", () => {
    const html = renderToStaticMarkup(React.createElement(DurationMeter, { totalSec: 700, targetSec: 720 }));
    expect(html).toContain("−20 s");
  });

  it("n'affiche aucun écart sans cible", () => {
    const html = renderToStaticMarkup(React.createElement(DurationMeter, { totalSec: 700, targetSec: null }));
    expect(html).not.toContain("+");
  });
});
