import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EmptyState } from "@/components/shell/empty-state";

// Plan 011 Part A — SSR render convention matches tests/stat-card.test.ts / tests/page-header.test.ts
// (no jsdom/RTL in this codebase).
describe("EmptyState", () => {
  it("renders the title", () => {
    const html = renderToStaticMarkup(React.createElement(EmptyState, { title: "Aucune source configurée" }));
    expect(html).toContain("Aucune source configurée");
  });

  it("renders the hint when given", () => {
    const html = renderToStaticMarkup(
      React.createElement(EmptyState, { title: "Rien à relire", hint: "Le pipeline n'a rien produit de nouveau." }),
    );
    expect(html).toContain("Le pipeline n&#x27;a rien produit de nouveau.");
  });

  it("omits the hint paragraph when not given", () => {
    const html = renderToStaticMarkup(React.createElement(EmptyState, { title: "Sans indice" }));
    expect(html).not.toContain("text-sm text-muted-foreground");
  });

  it("renders the action node when given", () => {
    const html = renderToStaticMarkup(
      React.createElement(EmptyState, {
        title: "Aucun membre",
        action: React.createElement("button", null, "Ajouter un membre"),
      }),
    );
    expect(html).toContain("Ajouter un membre");
  });

  it("renders the default Inbox icon when no icon is given", () => {
    const html = renderToStaticMarkup(React.createElement(EmptyState, { title: "Vide" }));
    expect(html).toContain("<svg");
  });

  it("renders a custom icon when given", () => {
    const html = renderToStaticMarkup(
      React.createElement(EmptyState, {
        title: "Vide",
        icon: React.createElement("span", { "data-testid": "custom-icon" }, "*"),
      }),
    );
    expect(html).toContain("data-testid=\"custom-icon\"");
  });
});
