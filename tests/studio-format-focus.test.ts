import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FormatFocus, type FormatFocusProps } from "@/components/studio/render/format-focus";
import { parseScene, type Scene } from "@/lib/studio/scene";
import { FORMAT_KEYS, FORMAT_PRESETS } from "@/lib/studio/formats";
import type { PreservedView } from "@/lib/studio/studio-mode";

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

function props(overrides?: Partial<FormatFocusProps>): FormatFocusProps {
  const view: PreservedView = { selectedId: "story", zoom: "fit", scrollX: 0, scrollY: 0 };
  return {
    templateId: "11111111-1111-1111-1111-111111111111",
    scene: fixtureScene(), nativeFormat: "ig_portrait", format: "story", articleId: null,
    view, onViewChange: () => {}, onExit: () => {}, onFormatChange: () => {},
    outcomes: {},
    ...overrides,
  };
}

const render = (p: FormatFocusProps) => renderToStaticMarkup(React.createElement(FormatFocus, p));

describe("FormatFocus — l'inspection d'un format", () => {
  it("annonce le format inspecté et ses dimensions", () => {
    const html = render(props());
    expect(html).toContain('data-testid="format-focus"');
    expect(html).toMatch(/data-testid="format-focus"[^>]*data-format="story"/);
    expect(html).toContain(FORMAT_PRESETS.story.label);
    expect(html).toContain("1080×1920");
  });

  it("la bande de formats propose les HUIT — on doit pouvoir en changer sans repasser par la planche", () => {
    const html = render(props());
    const pills = [...html.matchAll(/data-testid="format-focus-pill"[^>]*data-format="([^"]+)"/g)].map((m) => m[1]!);
    expect(new Set(pills)).toEqual(new Set(FORMAT_KEYS));
  });

  it("marque d'une puce les formats signalés, et eux seuls", () => {
    const html = render(props({ outcomes: { fb_link: { ready: true, overflow: true, lowRes: false } } }));
    const dotted = [...html.matchAll(/data-testid="format-focus-pill-dot"[^>]*data-format="([^"]+)"/g)].map((m) => m[1]!);
    expect(dotted).toEqual(["fb_link"]);
  });

  it("en mode « fit », la surface n'impose AUCUNE largeur en pixels — c'est le bug d'origine qu'on ne réintroduit pas", () => {
    const html = render(props());
    const surface = html.match(/<[^>]*data-testid="format-focus-surface"[^>]*>/)![0];
    expect(surface).not.toMatch(/aspect-ratio/);
    expect(surface).not.toMatch(/width:\s*\d/);
  });

  it("en zoom explicite, la surface porte bien une largeur en pixels dérivée du format", () => {
    const view: PreservedView = { selectedId: "story", zoom: 0.5, scrollX: 0, scrollY: 0 };
    const html = render(props({ view }));
    // 1080 × 0.5 = 540
    expect(html).toMatch(/data-testid="format-focus-surface"[\s\S]{0,400}?540/);
  });

  it("affiche les alertes en PHRASES complètes, pas en étiquettes tronquées — c'est ici qu'il y a la place", () => {
    const html = render(props({
      initialState: { status: "ready", dataUri: "data:image/png;base64,AA", degraded: false, overflow: true, lowRes: true },
    }));
    expect(html).toContain('data-testid="format-focus-overflow"');
    expect(html).toContain('data-testid="format-focus-lowres"');
    expect(html).toMatch(/police de repli/);      // la réserve d'approximation, VISIBLE et non plus enfouie dans un title=
    expect(html).toMatch(/plus petite que/);
  });

  it("n'affiche aucune alerte quand le rendu n'en signale pas — la légende suit la donnée", () => {
    const html = render(props({
      initialState: { status: "ready", dataUri: "data:image/png;base64,AA", degraded: false, overflow: false, lowRes: false },
    }));
    expect(html).not.toContain('data-testid="format-focus-overflow"');
    expect(html).not.toContain('data-testid="format-focus-lowres"');
    expect(html).not.toContain('data-testid="format-focus-degraded"');
  });

  it("propose le retour à la planche et le téléchargement du format inspecté", () => {
    const html = render(props({
      initialState: { status: "ready", dataUri: "data:image/png;base64,AA", degraded: false, overflow: false, lowRes: false },
    }));
    expect(html).toContain('data-testid="format-focus-back"');
    expect(html).toMatch(/data-testid="format-focus-download"[^>]*download="[^"]*story-1080x1920\.png"/);
  });
});
