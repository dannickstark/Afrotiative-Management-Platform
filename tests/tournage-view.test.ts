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
const { TournageProgressHeader, filterBeats, beatNeedsReview, beatHasNoTake, resolveExpandedId } = await import(
  "@/components/video/tournage-progress"
);

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

// Beat sans prise retenue et sans aucune prise — sera le premier « unresolved », donc celui rendu
// en carte pleine par défaut.
const beatNoTake: TournageBeat = {
  id: "b-2",
  position: 1,
  kind: "question",
  kindLabel: "Question",
  spokenText: "Comment avez-vous commence ce projet ?",
  directionNote: null,
  selectedTakeId: null,
  takes: [],
};

// Beat avec des prises mais aucune « bonne » — doit tomber dans le filtre « à revoir ».
const beatToReview: TournageBeat = {
  id: "b-3",
  position: 2,
  kind: "reponse",
  kindLabel: "Réponse",
  spokenText: "La réponse enregistrée pour l'instant.",
  directionNote: null,
  selectedTakeId: null,
  takes: [
    { id: "t-3", number: 1, status: "mauvaise", note: null, startedAt: new Date("2026-08-20T10:05:00Z") },
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

  it("mode Journal : le premier beat sans prise retenue reste en carte pleine, les autres sont compacts", () => {
    const html = renderToStaticMarkup(
      React.createElement(TournageView, { beats: [beat, beatNoTake, beatToReview] }),
    );
    // beatNoTake (b-2) est le premier avec selectedTakeId === null : carte pleine — son texte
    // parlé complet et ses boutons de log sont rendus.
    expect(html).toContain("Comment avez-vous commence ce projet ?");
    // beat (b-1, déjà résolu) et beatToReview (b-3) restent en lignes compactes : compteur de
    // prises et bouton « Déplier », pas les boutons Bonne/Mauvaise/À revoir pour eux.
    expect(html).toContain("Déplier");
    expect(html).toContain("1 prise");
  });

  it("boutons plateau (Bonne/Mauvaise/À revoir) : hauteur 44px minimum", () => {
    const html = renderToStaticMarkup(
      React.createElement(TournageView, { beats: [beatNoTake] }),
    );
    // beatNoTake est en carte pleine par défaut (seul beat, sans prise retenue) : ses boutons de
    // log portent la classe h-11 (44px), au-dessus du plancher normal 32px des contrôles chrome.
    expect(html).toContain("h-11");
  });
});

describe("TournageProgressHeader", () => {
  it("compte 0/0 sans diviser par zéro quand il n'y a aucun beat", () => {
    const html = renderToStaticMarkup(
      React.createElement(TournageProgressHeader, { beats: [], filter: "tous", onFilterChange: () => {} }),
    );
    expect(html).toContain("Prises retenues : 0 / 0 beats");
    expect(html).not.toContain("NaN");
  });

  it("compte toutes les prises retenues quand chaque beat en a une", () => {
    const html = renderToStaticMarkup(
      React.createElement(TournageProgressHeader, { beats: [beat], filter: "tous", onFilterChange: () => {} }),
    );
    expect(html).toContain("Prises retenues : 1 / 1 beats");
  });

  it("affiche le badge des beats sans prise quand il y en a", () => {
    const html = renderToStaticMarkup(
      React.createElement(TournageProgressHeader, {
        beats: [beat, beatNoTake], filter: "tous", onFilterChange: () => {},
      }),
    );
    expect(html).toContain("1 beats sans prise");
  });
});

describe("filterBeats / beatNeedsReview / beatHasNoTake", () => {
  const beats = [beat, beatNoTake, beatToReview];

  it("« Tous les beats » retourne tous les beats", () => {
    expect(filterBeats(beats, "tous")).toEqual(beats);
  });

  it("« Sans prise » ne retourne que les beats sans aucune prise", () => {
    expect(filterBeats(beats, "sans_prise")).toEqual([beatNoTake]);
  });

  it("« À revoir » ne retourne que les beats avec des prises mais aucune bonne", () => {
    expect(filterBeats(beats, "a_revoir")).toEqual([beatToReview]);
  });

  it("beatHasNoTake / beatNeedsReview reflètent bien les cas ci-dessus", () => {
    expect(beatHasNoTake(beatNoTake)).toBe(true);
    expect(beatHasNoTake(beatToReview)).toBe(false);
    expect(beatNeedsReview(beatToReview)).toBe(true);
    expect(beatNeedsReview(beat)).toBe(false);
  });
});

// Revue Task 6, ronde 2 — finding important : `expandedId` était figé au montage sur la liste non
// filtrée ; un filtre qui l'excluait de `visible` faisait disparaître toute carte pleine (donc les
// boutons plateau 44px) tant que l'utilisateur ne cliquait pas "Déplier". `resolveExpandedId` est
// la fonction pure qui répare ça — testée directement ici plutôt que par simulation de clic
// (renderToStaticMarkup ne peut pas déclencher onClick : il n'y a pas d'hydratation).
describe("resolveExpandedId", () => {
  it("garde le beat déplié courant s'il est toujours visible", () => {
    expect(resolveExpandedId([beat, beatToReview], beat.id)).toBe(beat.id);
  });

  it("retombe sur le premier beat visible sans prise retenue si le beat déplié n'est plus visible", () => {
    // Scénario du finding : beatNoTake est déplié par défaut (premier beat sans prise retenue sur
    // la liste complète), mais le filtre « à revoir » ne montre que beatToReview.
    const visibleAfterFilter = filterBeats([beat, beatNoTake, beatToReview], "a_revoir");
    expect(visibleAfterFilter).toEqual([beatToReview]);
    expect(resolveExpandedId(visibleAfterFilter, beatNoTake.id)).toBe(beatToReview.id);
  });

  it("retombe sur le premier beat visible tout court si aucun n'est sans prise retenue", () => {
    // beat (b-1) est le seul visible, et il a déjà une prise retenue : pas de candidat "sans
    // prise", donc repli sur visible[0].
    expect(resolveExpandedId([beat], "id-disparu")).toBe(beat.id);
  });

  it("gère une liste visible vide sans lever", () => {
    expect(resolveExpandedId([], "id-disparu")).toBeUndefined();
  });
});
