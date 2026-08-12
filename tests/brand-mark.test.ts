import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BrandMark } from "@/components/shell/brand-mark";

// Plan 012 — SSR render convention matches tests/stat-card.test.ts (no jsdom/RTL in this codebase).
describe("BrandMark", () => {
  it("full variant renders the monogram, wordmark, and tagline", () => {
    const html = renderToStaticMarkup(React.createElement(BrandMark));
    expect(html).toContain(">A<");
    expect(html).toContain("Afrotiative");
    expect(html).toContain("Console éditoriale");
  });

  it("mark variant renders only the monogram, not the wordmark", () => {
    const html = renderToStaticMarkup(React.createElement(BrandMark, { variant: "mark" }));
    expect(html).toContain(">A<");
    expect(html).not.toContain("Afrotiative");
    expect(html).not.toContain("Console éditoriale");
  });

  it("applies the terracotta accent chip classes to the monogram", () => {
    const html = renderToStaticMarkup(React.createElement(BrandMark));
    expect(html).toContain("bg-accent-brand");
    expect(html).toContain("text-accent-brand-foreground");
  });

  it("forwards a custom className to the root element", () => {
    const html = renderToStaticMarkup(React.createElement(BrandMark, { className: "lg:hidden" }));
    expect(html).toContain("lg:hidden");
  });
});
