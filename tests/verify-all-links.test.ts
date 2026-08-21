import { describe, it, expect, mock } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// VerifyAllLinks appelle useRouter() (next/navigation), qui exige un arbre App Router monté —
// sans ce mock, renderToStaticMarkup échoue avec « invariant expected app router to be mounted ».
// Même recette que tests/montage-share-panel.test.ts : posée AVANT le premier import du composant,
// donc import dynamique et non statique (les imports statiques sont hissés).
const realNavigation = await import("next/navigation");
mock.module("next/navigation", () => ({
  ...realNavigation,
  useRouter: () => ({
    push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, forward: () => {}, prefetch: () => {},
  }),
}));
const { VerifyAllLinks } = await import("@/components/video/verify-all-links");

describe("VerifyAllLinks", () => {
  it("affiche le libellé du bouton", () => {
    const html = renderToStaticMarkup(
      React.createElement(VerifyAllLinks, { projectId: "p-1" }),
    );
    expect(html).toContain("Vérifier tous les liens");
  });
});
