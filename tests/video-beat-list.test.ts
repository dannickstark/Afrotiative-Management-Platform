import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BeatList, type BeatView } from "@/components/video/beat-list";

function beat(over: Partial<BeatView> = {}): BeatView {
  return {
    id: "u1", externalId: "b-01-accroche", position: 0, kind: "narration",
    spokenText: "<p>En 2019, cette PME vendait dans deux marchés.</p>",
    directionNote: "Plan serré", screenText: null, transitionIn: null, transitionOut: "cut sec",
    estimatedDurationSec: 4, durationOverrideSec: null, locallyEdited: false, inserts: [],
    // Task 5 (SP5, mode interview) : BeatView gagne speakerId/answersBeatId — null par défaut, un
    // beat narratif hors mode interview n'a ni l'un ni l'autre.
    speakerId: null, answersBeatId: null,
    ...over,
  };
}

describe("BeatList", () => {
  it("affiche l'identifiant externe du beat", () => {
    const html = renderToStaticMarkup(React.createElement(BeatList, { beats: [beat()] }));
    expect(html).toContain("b-01-accroche");
  });

  it("affiche le texte parlé", () => {
    const html = renderToStaticMarkup(React.createElement(BeatList, { beats: [beat()] }));
    expect(html).toContain("cette PME vendait");
  });

  it("marque un beat modifié localement", () => {
    const html = renderToStaticMarkup(React.createElement(BeatList, { beats: [beat({ locallyEdited: true })] }));
    expect(html).toContain("Modifié localement");
  });

  it("avertit sur un beat trop long à dire d'un souffle", () => {
    const long = `<p>${Array(40).fill("mot").join(" ")}</p>`;
    const html = renderToStaticMarkup(React.createElement(BeatList, { beats: [beat({ spokenText: long })] }));
    expect(html).toContain("souffle");
  });

  it("n'avertit pas sur un beat court", () => {
    const html = renderToStaticMarkup(React.createElement(BeatList, { beats: [beat()] }));
    expect(html).not.toContain("souffle");
  });

  it("affiche l'état vide avant tout import", () => {
    const html = renderToStaticMarkup(React.createElement(BeatList, { beats: [] }));
    expect(html).toContain("Aucun beat");
  });

  // Round de correction 2 (Task 12, T) : la fixture par défaut ci-dessus (`estimatedDurationSec: 4`)
  // coïncide EXACTEMENT avec ce qu'un recalcul client à 155 mots/min produirait pour son
  // `spokenText` (8 mots → ceil(8/155*60) = 4) — un recalcul contre la valeur stockée est donc
  // indétectable dessus. Cette fixture diverge délibérément : même texte, mais
  // `estimatedDurationSec: 9`, différent de l'estimation à 155 mots/min. La colonne Durée doit
  // afficher la valeur STOCKÉE (9 s), jamais la valeur recalculée (4 s) — cf.
  // lib/video/duration.ts#beatSeconds (`??`) et components/video/beat-list.tsx#storedSeconds.
  it("affiche la durée stockée, pas une durée recalculée côté client", () => {
    const html = renderToStaticMarkup(
      React.createElement(BeatList, { beats: [beat({ estimatedDurationSec: 9 })] }),
    );
    expect(html).toContain("9 s");
  });

  // Task 4 (SP 014 — UX pass) : la bande de cumul/cible est retirée de BeatList — le cumul et la
  // cible vivent désormais dans le bandeau de projet (components/video/project-header.tsx, Task 3).
  // Le composant DurationMeter qui la rendait n'avait plus aucun appelant de production et a été
  // supprimé à la revue finale, avec le bloc de tests qui le maintenait seul en vie.
  it("n'affiche plus la bande de cumul/cible retirée au profit du bandeau de projet", () => {
    const html = renderToStaticMarkup(
      React.createElement(BeatList, { beats: [beat()] }),
    );
    expect(html).not.toContain("Cumul :");
    expect(html).not.toContain("Cible :");
  });

  it("affiche le nombre d'inserts par nature dans la colonne Médias", () => {
    const html = renderToStaticMarkup(
      React.createElement(BeatList, {
        beats: [beat({
          inserts: [
            { id: "i1", kind: "graphique", url: null, tcIn: null, tcOut: null, displayDurationSec: null, credit: null, linkStatus: "ok", rightsNote: null, r2Key: null, linkCheckedAt: null },
          ],
        })],
      }),
    );
    expect(html).toContain("1 graphique");
  });

  it("regroupe plusieurs inserts de la même nature en un seul compte", () => {
    const html = renderToStaticMarkup(
      React.createElement(BeatList, {
        beats: [beat({
          inserts: [
            { id: "i1", kind: "image", url: null, tcIn: null, tcOut: null, displayDurationSec: null, credit: null, linkStatus: "ok", rightsNote: null, r2Key: null, linkCheckedAt: null },
            { id: "i2", kind: "image", url: null, tcIn: null, tcOut: null, displayDurationSec: null, credit: null, linkStatus: "ok", rightsNote: null, r2Key: null, linkCheckedAt: null },
          ],
        })],
      }),
    );
    expect(html).toContain("2 images");
  });

  it("montre la pastille rouge (pire statut) quand un insert est mort, devant un insert OK", () => {
    const html = renderToStaticMarkup(
      React.createElement(BeatList, {
        beats: [beat({
          inserts: [
            { id: "i1", kind: "image", url: null, tcIn: null, tcOut: null, displayDurationSec: null, credit: null, linkStatus: "ok", rightsNote: null, r2Key: null, linkCheckedAt: null },
            { id: "i2", kind: "video", url: null, tcIn: null, tcOut: null, displayDurationSec: null, credit: null, linkStatus: "mort", rightsNote: null, r2Key: null, linkCheckedAt: null },
          ],
        })],
      }),
    );
    expect(html).toContain('aria-label="Mort"');
    expect(html).not.toContain('aria-label="OK"');
  });

  it("montre la pastille ambre quand le pire statut est non_verifie", () => {
    const html = renderToStaticMarkup(
      React.createElement(BeatList, {
        beats: [beat({
          inserts: [
            { id: "i1", kind: "image", url: null, tcIn: null, tcOut: null, displayDurationSec: null, credit: null, linkStatus: "non_verifie", rightsNote: null, r2Key: null, linkCheckedAt: null },
          ],
        })],
      }),
    );
    expect(html).toContain('aria-label="À vérifier"');
  });

  it("n'affiche aucune pastille pour un beat sans insert", () => {
    const html = renderToStaticMarkup(
      React.createElement(BeatList, { beats: [beat({ inserts: [] })] }),
    );
    expect(html).not.toContain('aria-label="OK"');
    expect(html).not.toContain('aria-label="Mort"');
    expect(html).not.toContain('aria-label="À vérifier"');
  });

  it("affiche un badge destructive 0 pour un beat narration sans source", () => {
    const html = renderToStaticMarkup(
      React.createElement(BeatList, { beats: [beat({ kind: "narration", sources: undefined })] }),
    );
    // La pastille destructive, pas seulement le chiffre : un beat qui n'exige pas de source et n'en
    // a aucune rend lui aussi « 0 », dans un simple <span> (revue finale, mineur).
    expect(html).toMatch(/bg-destructive[^>]*>0</);
  });

  it("affiche un badge destructive 0 pour un beat reponse sans source", () => {
    const html = renderToStaticMarkup(
      React.createElement(BeatList, { beats: [beat({ kind: "reponse", sources: [] })] }),
    );
    expect(html).toMatch(/bg-destructive[^>]*>0</);
  });

  it("n'affiche pas de badge destructive pour un B-roll sans source", () => {
    const html = renderToStaticMarkup(
      React.createElement(BeatList, { beats: [beat({ kind: "broll", sources: undefined })] }),
    );
    expect(html).not.toContain("bg-destructive");
  });

  it("affiche le nombre de sources sans badge destructive quand le beat en a", () => {
    const html = renderToStaticMarkup(
      React.createElement(BeatList, { beats: [beat({ kind: "narration", sources: ["https://exemple.fr"] })] }),
    );
    expect(html).toContain(">1<");
    expect(html).not.toContain("bg-destructive");
  });

  it("affiche une légende expliquant les trois pastilles", () => {
    const html = renderToStaticMarkup(
      React.createElement(BeatList, { beats: [beat()] }),
    );
    expect(html).toContain("OK");
    expect(html).toContain("À vérifier");
    expect(html).toContain("Mort");
  });
});
