import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MontageExportBar } from "@/components/video/montage-export-bar";

describe("MontageExportBar", () => {
  it("rend trois liens de téléchargement habillés en bouton, avec les bons hrefs", () => {
    const html = renderToStaticMarkup(
      React.createElement(MontageExportBar, { variantId: "v-1" }),
    );
    expect(html).toContain('href="/api/montage/export?variantId=v-1&amp;format=csv"');
    expect(html).toContain('href="/api/montage/export?variantId=v-1&amp;format=json"');
    expect(html).toContain('href="/api/montage/export?variantId=v-1&amp;format=manifest"');
    expect(html).toContain("Export CSV");
    expect(html).toContain("Export JSON");
    expect(html).toContain("Manifeste médias");
    // Habillés en bouton (buttonVariants), pas de simples liens soulignés : la classe du helper
    // bouton contient toujours "inline-flex".
    expect(html).toContain("inline-flex");
  });
});
