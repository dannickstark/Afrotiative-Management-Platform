import { describe, it, expect, mock } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TournageBeat } from "@/lib/video/takes-core";

// TournageView appelle useRouter() (next/navigation) via useTransition + router.refresh() —
// sans ce mock, renderToStaticMarkup échoue avec « invariant expected app router to be mounted ».
// Même recette que tests/insert-row.test.ts et tests/montage-share-panel.test.ts : posée AVANT le
// premier import du composant, donc import dynamique et non statique (les imports statiques sont
// hissés).
const realNavigation = await import("next/navigation");
mock.module("next/navigation", () => ({
  ...realNavigation,
  useRouter: () => ({
    push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, forward: () => {}, prefetch: () => {},
  }),
}));
const { TournageView } = await import("@/components/video/tournage-view");

const beat: TournageBeat = {
  id: "b-1",
  position: 0,
  kind: "narration",
  kindLabel: "Narration",
  spokenText: "Bienvenue dans cette vidéo sur les fondations.",
  directionNote: "Cadrage serré, ton posé.",
  selectedTakeId: "t-1",
  takes: [
    { id: "t-1", number: 1, status: "bonne", note: "Bonne énergie", startedAt: new Date("2026-08-20T10:00:00Z") },
  ],
};

describe("TournageView", () => {
  it("affiche le texte parlé, le libellé de statut de prise et les boutons de log", () => {
    const html = renderToStaticMarkup(
      React.createElement(TournageView, { projectId: "p-1", status: "pret_a_tourner", beats: [beat] }),
    );
    expect(html).toContain("Bienvenue dans cette vidéo sur les fondations.");
    expect(html).toContain("Bonne");
    expect(html).toContain("Mauvaise");
    expect(html).toContain("À revoir");
  });

  it("affiche le bouton de transition adapté au statut pret_a_tourner", () => {
    const html = renderToStaticMarkup(
      React.createElement(TournageView, { projectId: "p-1", status: "pret_a_tourner", beats: [beat] }),
    );
    expect(html).toContain("Démarrer le tournage");
  });

  it("affiche le bouton de transition adapté au statut en_ecriture", () => {
    const html = renderToStaticMarkup(
      React.createElement(TournageView, { projectId: "p-1", status: "en_ecriture", beats: [beat] }),
    );
    expect(html).toContain("Marquer prêt à tourner");
  });

  it("affiche le bouton de transition adapté au statut tourne", () => {
    const html = renderToStaticMarkup(
      React.createElement(TournageView, { projectId: "p-1", status: "tourne", beats: [beat] }),
    );
    expect(html).toContain("Tournage terminé");
  });

  it("état vide : aucun beat", () => {
    const html = renderToStaticMarkup(
      React.createElement(TournageView, { projectId: "p-1", status: "en_ecriture", beats: [] }),
    );
    expect(html).toContain("Aucun beat");
  });
});
