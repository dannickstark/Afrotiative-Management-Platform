import { describe, it, expect, mock } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// VariantManager appelle useRouter() (next/navigation) pour router.push() après une dérivation ou
// la suppression de la variante active (SP6, Task 2) — sans ce mock, renderToStaticMarkup échoue
// avec « invariant expected app router to be mounted ». Même recette que tests/insert-row.test.ts :
// posée AVANT le premier import du composant, donc import dynamique et non statique (les imports
// statiques sont hissés).
const realNavigation = await import("next/navigation");
mock.module("next/navigation", () => ({
  ...realNavigation,
  useRouter: () => ({
    push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, forward: () => {}, prefetch: () => {},
  }),
}));
const { VariantManager } = await import("@/components/video/variant-manager");

type VariantRow = { id: string; platform: string; aspectRatio: string; derivedFromId: string | null; position: number };

const origin: VariantRow = {
  id: "6f1c2f7e-0000-4000-8000-000000000001",
  platform: "youtube_long",
  aspectRatio: "16:9",
  derivedFromId: null,
  position: 0,
};

const derived: VariantRow = {
  id: "6f1c2f7e-0000-4000-8000-000000000002",
  platform: "tiktok",
  aspectRatio: "9:16",
  derivedFromId: origin.id,
  position: 1,
};

function render(variants: VariantRow[], activeVariantId: string | null) {
  return renderToStaticMarkup(
    React.createElement(VariantManager, { projectId: "p-1", variants, activeVariantId }),
  );
}

describe("VariantManager", () => {
  it("affiche les libellés de plateforme des variantes", () => {
    const html = render([origin, derived], origin.id);
    expect(html).toContain("YouTube long");
    expect(html).toContain("TikTok");
  });

  it("marque la variante dérivée", () => {
    const html = render([origin, derived], origin.id);
    expect(html).toContain("dérivée");
  });

  it("affiche le bouton Dériver une variante", () => {
    const html = render([origin, derived], origin.id);
    expect(html).toContain("Dériver une variante");
  });

  it("affiche un bouton Supprimer uniquement pour la variante dérivée", () => {
    const html = render([origin, derived], origin.id);
    const supprimerCount = html.split("Supprimer").length - 1;
    expect(supprimerCount).toBeGreaterThan(0);
  });

  it("n'affiche pas de bouton Supprimer quand il n'y a qu'une variante d'origine", () => {
    const html = render([origin], origin.id);
    expect(html).not.toContain("Supprimer");
  });
});
