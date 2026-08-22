import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AspectRatioGuide } from "@/components/video/aspect-ratio-guide";

// Composant server-safe (pas de "use client") — même convention SSR que tests/brand-mark.test.ts et
// tests/stat-card.test.ts (renderToStaticMarkup, pas de jsdom/RTL dans ce dépôt).
describe("AspectRatioGuide", () => {
  it("ratio 9:16 : affiche le libellé et un schéma SVG", () => {
    const html = renderToStaticMarkup(React.createElement(AspectRatioGuide, { ratio: "9:16" }));
    expect(html).toContain("9:16");
    expect(html).toContain("<svg");
  });

  it("ratio 16:9 : affiche le libellé", () => {
    const html = renderToStaticMarkup(React.createElement(AspectRatioGuide, { ratio: "16:9" }));
    expect(html).toContain("16:9");
  });

  it("ratio 1:1 : affiche le libellé", () => {
    const html = renderToStaticMarkup(React.createElement(AspectRatioGuide, { ratio: "1:1" }));
    expect(html).toContain("1:1");
  });

  it("ratio inconnu : rend le libellé brut sans planter", () => {
    const html = renderToStaticMarkup(React.createElement(AspectRatioGuide, { ratio: "4:3" }));
    expect(html).toContain("4:3");
  });
});
