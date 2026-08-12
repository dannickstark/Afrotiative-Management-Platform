import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatCard } from "@/components/ui/stat-card";

// Plan 010 — SSR render convention matches tests/page-header.test.ts (no jsdom/RTL in this codebase).
describe("StatCard", () => {
  it("renders the label and value", () => {
    const html = renderToStaticMarkup(React.createElement(StatCard, { label: "Publiés cette semaine", value: 42 }));
    expect(html).toContain("Publiés cette semaine");
    expect(html).toContain("42");
  });

  it("applies the alert tone class", () => {
    const html = renderToStaticMarkup(
      React.createElement(StatCard, { label: "Échecs", value: 3, tone: "alert" }),
    );
    expect(html).toContain("text-[var(--status-error)]");
  });

  it("applies the accent tone class", () => {
    const html = renderToStaticMarkup(
      React.createElement(StatCard, { label: "En attente", value: 5, tone: "accent" }),
    );
    expect(html).toContain("text-accent-brand");
  });

  it("renders the sub text when given", () => {
    const html = renderToStaticMarkup(
      React.createElement(StatCard, { label: "Publiés", value: 10, sub: "dont 2 aujourd'hui" }),
    );
    expect(html).toContain("dont 2 aujourd&#x27;hui");
  });

  it("omits the sub paragraph when not given", () => {
    const html = renderToStaticMarkup(React.createElement(StatCard, { label: "Seulement", value: 1 }));
    expect(html).not.toMatch(/text-xs text-muted-foreground">/);
  });

  it("adds the emphasis ring and larger value text", () => {
    const html = renderToStaticMarkup(
      React.createElement(StatCard, { label: "En attente de revue", value: 5, emphasis: true }),
    );
    expect(html).toContain("ring-1");
    expect(html).toContain("ring-accent-brand/30");
    expect(html).toContain("text-3xl");
  });

  it("does not add the ring without emphasis", () => {
    const html = renderToStaticMarkup(React.createElement(StatCard, { label: "Normal", value: 1 }));
    expect(html).not.toContain("ring-accent-brand/30");
  });
});
