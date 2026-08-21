import { describe, it, expect, mock } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ShareRow } from "@/lib/montage/access";

// MontageSharePanel appelle useRouter() (next/navigation), qui exige un arbre App Router monté —
// sans ce mock, renderToStaticMarkup échoue avec « invariant expected app router to be mounted ».
// Même recette que tests/mcp-settings-ui.test.ts : posée AVANT le premier import du composant,
// donc import dynamique et non statique (les imports statiques sont hissés).
const realNavigation = await import("next/navigation");
mock.module("next/navigation", () => ({
  ...realNavigation,
  useRouter: () => ({
    push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, forward: () => {}, prefetch: () => {},
  }),
}));
const { MontageSharePanel } = await import("@/components/video/montage-share-panel");

describe("MontageSharePanel", () => {
  const active: ShareRow = {
    id: "s-1", projectId: "p-1", createdByName: "Awa Diallo",
    expiresAt: null, revokedAt: null, lastAccessedAt: null, createdAt: new Date("2026-08-20T10:00:00Z"),
  };

  it("un lien actif montre Révoquer et son statut", () => {
    const html = renderToStaticMarkup(
      React.createElement(MontageSharePanel, { projectId: "p-1", shares: [active], canManage: true }),
    );
    expect(html).toContain("Révoquer");
    expect(html).toContain("Actif");
  });

  it("état vide", () => {
    const html = renderToStaticMarkup(
      React.createElement(MontageSharePanel, { projectId: "p-1", shares: [], canManage: true }),
    );
    expect(html).toContain("Aucun lien monteur");
  });
});
