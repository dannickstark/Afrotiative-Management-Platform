import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PageHeader } from "@/components/shell/page-header";

// Plan 008 — one shared PageHeader adopted across every non-studio page title row. SSR-render
// convention matches tests/diffusion-settings-ui.test.ts (no jsdom/RTL in this codebase).
describe("PageHeader", () => {
  it("renders the title as a serif h1 (font-heading)", () => {
    const html = renderToStaticMarkup(React.createElement(PageHeader, { title: "Tableau de bord" }));
    expect(html).toContain("Tableau de bord");
    expect(html).toMatch(/<h1[^>]*class="[^"]*font-heading[^"]*"[^>]*>Tableau de bord<\/h1>/);
  });

  it("renders the description when given", () => {
    const html = renderToStaticMarkup(
      React.createElement(PageHeader, { title: "Titre", description: "Une description." }),
    );
    expect(html).toContain("Une description.");
  });

  it("omits the description paragraph when not given", () => {
    const html = renderToStaticMarkup(React.createElement(PageHeader, { title: "Titre" }));
    expect(html).not.toContain("<p");
  });

  it("renders an actions node when given", () => {
    const html = renderToStaticMarkup(
      React.createElement(PageHeader, {
        title: "Titre",
        actions: React.createElement("button", null, "Ajouter"),
      }),
    );
    expect(html).toContain("<button>Ajouter</button>");
  });

  it("is safe with neither description nor actions", () => {
    const html = renderToStaticMarkup(React.createElement(PageHeader, { title: "Seulement le titre" }));
    expect(html).toContain("Seulement le titre");
  });
});
