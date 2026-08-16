import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProofSheet, type ProofSheetProps } from "@/components/studio/render/proof-sheet";
import { parseScene, type Scene } from "@/lib/studio/scene";
import { FORMAT_KEYS } from "@/lib/studio/formats";

// react-dom/server, PAS de DOM — même convention que tests/studio-render-mode.test.ts. Aucun effet
// ne s'exécute : ce fichier ne vérifie donc QUE ce qui est vrai au premier rendu, et les états
// post-réseau passent par l'amorce `initialOutcomes` (même convention que RenderModeProps.initialDegraded).

function fixtureScene(): Scene {
  return parseScene({
    schemaVersion: 1,
    canvas: { width: 1080, height: 1350, background: "#101010" },
    layers: [
      {
        id: "title", name: "Titre", visible: true, locked: false,
        frame: { x: 40, y: 40, w: 1000, h: 100 },
        type: "text", content: "Titre de test",
        font: { family: "Noto Sans", size: 48, weight: 700 },
        color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
      },
    ],
  });
}

function props(overrides?: Partial<ProofSheetProps>): ProofSheetProps {
  return {
    templateId: "11111111-1111-1111-1111-111111111111",
    scene: fixtureScene(),
    nativeFormat: "ig_portrait",
    articleId: null,
    onFocus: () => {},
    onTileOutcome: () => {},
    ...overrides,
  };
}

function render(p: ProofSheetProps): string {
  return renderToStaticMarkup(React.createElement(ProofSheet, p));
}

// Extraction ANCRÉE sur les vrais attributs — jamais une recherche de sous-chaîne naïve, qui
// ferait de faux positifs sur un className contenant le même mot.
function tileFormats(html: string): string[] {
  return [...html.matchAll(/data-testid="proof-tile"[^>]*data-format="([^"]+)"/g)].map((m) => m[1]!);
}

describe("ProofSheet — la planche des 8 formats", () => {
  it("rend UNE tuile par format, aucune omise, aucune en double", () => {
    const formats = tileFormats(render(props()));
    expect(formats).toHaveLength(FORMAT_KEYS.length);
    expect(new Set(formats)).toEqual(new Set(FORMAT_KEYS));
  });

  it("inclut le format NATIF — la planche montre les 8, pas « les autres »", () => {
    expect(tileFormats(render(props({ nativeFormat: "story" })))).toContain("story");
  });

  it("marque le format natif, et lui seul", () => {
    const html = render(props({ nativeFormat: "story" }));
    const marked = [...html.matchAll(/data-testid="proof-tile-native"[^>]*data-format="([^"]+)"/g)].map((m) => m[1]!);
    expect(marked).toEqual(["story"]);
  });

  it("le marqueur natif n'utilise PAS l'accent primaire (The Actions-Only Rule, DESIGN.md)", () => {
    const html = render(props({ nativeFormat: "story" }));
    const tag = html.match(/<[^>]*data-testid="proof-tile-native"[^>]*>/)![0];
    expect(tag).not.toMatch(/bg-primary|text-primary\b/);
  });

  it("le bouton de téléchargement n'est PAS imbriqué dans le bouton d'ouverture — un <button> dans un <button> est du HTML invalide", () => {
    const html = render(props());
    // Isole la première tuile, puis vérifie qu'aucun bouton n'en contient un autre.
    const tile = html.split('data-testid="proof-tile"')[1]!.split('data-testid="proof-tile"')[0]!;
    const opener = tile.indexOf('data-testid="proof-tile-open"');
    const closeOfOpener = tile.indexOf("</button>", opener);
    const download = tile.indexOf('data-testid="proof-tile-download"');
    expect(opener).toBeGreaterThanOrEqual(0);
    expect(download).toBeGreaterThanOrEqual(0);
    expect(download).toBeGreaterThan(closeOfOpener); // frère, pas enfant.
  });

  it("n'affiche une alerte de débordement QUE pour les formats réellement concernés", () => {
    const html = render(props({ initialOutcomes: { story: { ready: true, overflow: true, lowRes: false } } }));
    const flagged = [...html.matchAll(/data-testid="proof-tile-overflow"[^>]*data-format="([^"]+)"/g)].map((m) => m[1]!);
    expect(flagged).toEqual(["story"]);
  });

  it("n'affiche AUCUNE alerte quand aucun format n'est concerné — la légende suit la donnée, elle n'est pas figée dans le JSX", () => {
    const html = render(props());
    expect(html).not.toContain('data-testid="proof-tile-overflow"');
    expect(html).not.toContain('data-testid="proof-tile-lowres"');
  });

  it("affiche l'alerte « image agrandie » indépendamment de l'alerte de débordement", () => {
    const html = render(props({ initialOutcomes: { fb_link: { ready: true, overflow: false, lowRes: true } } }));
    const flagged = [...html.matchAll(/data-testid="proof-tile-lowres"[^>]*data-format="([^"]+)"/g)].map((m) => m[1]!);
    expect(flagged).toEqual(["fb_link"]);
    expect(html).not.toContain('data-testid="proof-tile-overflow"');
  });
});
