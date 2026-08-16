import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BriefPanel } from "@/components/video/brief-panel";

describe("BriefPanel", () => {
  it("affiche le brief", () => {
    const html = renderToStaticMarkup(React.createElement(BriefPanel, { brief: "Sujet : Babadampulu", unknownVars: [] }));
    expect(html).toContain("Sujet : Babadampulu");
  });

  it("signale les variables inconnues du modèle", () => {
    const html = renderToStaticMarkup(React.createElement(BriefPanel, { brief: "x", unknownVars: ["tonalite"] }));
    expect(html).toContain("tonalite");
    expect(html).toContain("Variable inconnue");
  });

  it("ne montre aucun avertissement quand le modèle est sain", () => {
    const html = renderToStaticMarkup(React.createElement(BriefPanel, { brief: "x", unknownVars: [] }));
    expect(html).not.toContain("Variable inconnue");
  });

  it("propose de copier le brief", () => {
    const html = renderToStaticMarkup(React.createElement(BriefPanel, { brief: "x", unknownVars: [] }));
    expect(html).toContain("Copier le brief");
  });
});
