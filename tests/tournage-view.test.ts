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

// Task 3 (SP 014 — UX pass) : le bouton d'avancement de statut a quitté TournageView pour le
// bandeau de projet (components/video/project-header.tsx, cf. tests/project-header.test.ts) —
// TournageView ne prend donc plus `projectId`/`status` et ne rend plus StatusHeader. Ce fichier ne
// couvre plus que ce qui reste : le texte parlé, les boutons de log, et l'état vide.
describe("TournageView", () => {
  it("affiche le texte parlé, le libellé de statut de prise et les boutons de log", () => {
    const html = renderToStaticMarkup(
      React.createElement(TournageView, { beats: [beat] }),
    );
    expect(html).toContain("Bienvenue dans cette vidéo sur les fondations.");
    expect(html).toContain("Bonne");
    expect(html).toContain("Mauvaise");
    expect(html).toContain("À revoir");
  });

  it("ne rend plus de bouton de transition de statut (déplacé dans le bandeau de projet)", () => {
    const html = renderToStaticMarkup(
      React.createElement(TournageView, { beats: [beat] }),
    );
    expect(html).not.toContain("Démarrer le tournage");
    expect(html).not.toContain("Marquer prêt à tourner");
    expect(html).not.toContain("Tournage terminé");
  });

  it("état vide : aucun beat", () => {
    const html = renderToStaticMarkup(
      React.createElement(TournageView, { beats: [] }),
    );
    expect(html).toContain("Aucun beat");
  });
});
