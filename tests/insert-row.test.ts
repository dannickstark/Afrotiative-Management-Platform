import { describe, it, expect, mock } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { InsertView } from "@/components/video/beat-list";

// InsertRow appelle désormais useRouter() (next/navigation) pour router.refresh() après un upload
// (Task 6, SP3) — sans ce mock, renderToStaticMarkup échoue avec « invariant expected app router to
// be mounted ». Même recette que tests/montage-share-panel.test.ts : posée AVANT le premier import
// du composant, donc import dynamique et non statique (les imports statiques sont hissés).
const realNavigation = await import("next/navigation");
mock.module("next/navigation", () => ({
  ...realNavigation,
  useRouter: () => ({
    push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, forward: () => {}, prefetch: () => {},
  }),
}));
const { InsertRow } = await import("@/components/video/beat-inspector");

const insert: InsertView = {
  id: "6f1c2f7e-0000-4000-8000-000000000001",
  kind: "image",
  url: "https://example.com/photo.jpg",
  tcIn: "00:00:05",
  tcOut: "00:00:12",
  displayDurationSec: 4,
  credit: "Photo : Awa Koné",
  linkStatus: "ok",
  rightsNote: "Usage éditorial autorisé",
  r2Key: null,
  linkCheckedAt: new Date("2026-08-20T10:00:00Z"),
};

function render(ins: InsertView) {
  return renderToStaticMarkup(
    React.createElement(InsertRow, { insert: ins, disabled: false, onSaved: () => {} }),
  );
}

describe("InsertRow", () => {
  it("affiche le libellé Crédit et sa valeur", () => {
    const html = render(insert);
    expect(html).toContain("Crédit");
    expect(html).toContain("Photo : Awa Koné");
  });

  it("affiche le libellé Droits et sa valeur", () => {
    const html = render(insert);
    expect(html).toContain("Droits");
    expect(html).toContain("Usage éditorial autorisé");
  });

  it("affiche les libellés Entrée et Sortie avec les timecodes", () => {
    const html = render(insert);
    expect(html).toContain("Entrée");
    expect(html).toContain("00:00:05");
    expect(html).toContain("Sortie");
    expect(html).toContain("00:00:12");
  });

  it("affiche la portée calculée à partir des timecodes", () => {
    const html = render(insert);
    // insertSpanSeconds("00:00:05", "00:00:12") === 7
    expect(html).toContain("7");
  });

  it("affiche le badge du statut de lien", () => {
    const html = render(insert);
    expect(html).toContain("OK");
  });

  it("propose une option par nature d'insert dans le select", () => {
    const html = render(insert);
    expect(html).toContain("Image");
    expect(html).toContain("Vidéo");
    expect(html).toContain("Graphique");
  });
});
