import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarquePanel } from "@/components/studio/panels/marque-panel";
import { fontFaceFamily, fontProxyUrl } from "@/lib/studio/font-face";
import { DEFAULT_CATEGORY_COLOR } from "@/lib/studio/default-category-color";
import type { AssetRow } from "@/lib/queries/assets";

// tests/studio-marque-panel.test.ts — Tâche 2 (U1, spec §3), correctif de revue (Important 1) :
// MarquePanel (components/studio/panels/marque-panel.tsx) n'avait, au départ, aucune couverture
// automatisée — l'argument initial (« pas de composant hébergé à cibler ») confondait « rien
// d'hébergé » avec « rien de vérifiable » : le panneau reste bâti sur des fonctions PURES partagées
// (fontFaceFamily/fontProxyUrl, lib/studio/font-face.ts ; DEFAULT_CATEGORY_COLOR,
// lib/studio/default-category-color.ts), directement assertables en chaîne HTML — même convention
// que tests/studio-templates-table.test.ts/tests/studio-asset-picker.test.ts (react-dom/server, pas
// de DOM sous `bun test`). Aucun mock nécessaire ici : ni next/navigation (MarquePanel n'utilise que
// next/link, vérifié empiriquement sans throw) ni @/lib/auth-client (pas de RoleGate — le panneau
// est intégralement lecture seule).
const FONT_ASSET: AssetRow = {
  id: "font-1", kind: "font", name: "Ma police perso", url: "https://cdn.test/police.ttf",
  mime: "font/ttf", bytes: 40_000, width: null, height: null,
  fontFamily: "Police Perso", fontWeight: 600, fontStyle: "normal",
  uploadedByName: "Test", createdAt: new Date("2026-01-01T00:00:00Z"),
};

function render(
  assets: AssetRow[],
  brandLogoUrl: string,
  categories: { id: string; name: string; color: string | null }[],
): string {
  return renderToStaticMarkup(React.createElement(MarquePanel, { assets, brandLogoUrl, categories }));
}

describe("MarquePanel — échantillon de police, MÊME convention que asset-library.tsx (pas une réinvention locale)", () => {
  it("rend l'échantillon avec l'EXACTE @font-face que fontFaceFamily/fontProxyUrl calculent", () => {
    const html = render([FONT_ASSET], "", []);
    // Sabotage-check : une convention réinventée localement (un autre préfixe de famille, une autre
    // URL de proxy) échouerait ces deux assertions même si un échantillon "quelconque" s'affichait.
    expect(html).toContain(`font-family: "${fontFaceFamily(FONT_ASSET.id)}"`);
    expect(html).toContain(`url("${fontProxyUrl(FONT_ASSET.id)}")`);
    expect(html).toContain("Police Perso");
  });
});

describe("MarquePanel — états vides, copie française explicite (spec : lecture seule, honnête)", () => {
  it("affiche un message français quand aucune police n'est téléversée", () => {
    const html = render([], "", []);
    expect(html).toContain("Aucune police téléversée");
  });

  it("affiche un message français quand aucune catégorie n'existe", () => {
    const html = render([], "", []);
    expect(html).toContain("Aucune catégorie");
  });

  it("affiche un message français nommant la variable d'environnement quand aucun logo n'est configuré", () => {
    const html = render([], "", []);
    expect(html).toContain("Aucun logo configuré");
    expect(html).toContain("STUDIO_BRAND_LOGO_URL");
  });

  it("affiche l'image du logo quand brandLogoUrl est renseignée", () => {
    const html = render([], "https://cdn.test/logo.png", []);
    expect(html).toContain('src="https://cdn.test/logo.png"');
    expect(html).not.toContain("Aucun logo configuré");
  });
});

describe("MarquePanel — renvoie vers les pages de gestion existantes, ne duplique aucun chemin d'écriture", () => {
  it('le lien "Gérer" des polices pointe vers /studio/assets', () => {
    const html = render([FONT_ASSET], "", []);
    expect(html).toContain('href="/studio/assets"');
  });

  it('le lien "Gérer" des couleurs de catégorie pointe vers /settings/taxonomy', () => {
    const html = render([], "", [{ id: "c1", name: "Politique", color: "#FF0000" }]);
    expect(html).toContain('href="/settings/taxonomy"');
  });
});

describe("MarquePanel — couleurs de catégorie : repli sur DEFAULT_CATEGORY_COLOR, pas une couleur inventée localement", () => {
  it("utilise la couleur propre de la catégorie quand elle existe", () => {
    const html = render([], "", [{ id: "c1", name: "Politique", color: "#ABCDEF" }]);
    expect(html).toContain("background-color:#ABCDEF");
    expect(html).toContain("Politique");
  });

  it("retombe sur DEFAULT_CATEGORY_COLOR quand color est null", () => {
    const html = render([], "", [{ id: "c2", name: "Sport", color: null }]);
    expect(html).toContain(`background-color:${DEFAULT_CATEGORY_COLOR}`);
    expect(html).toContain("Sport");
  });
});
