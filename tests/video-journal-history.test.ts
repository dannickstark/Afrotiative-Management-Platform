import { describe, it, expect, mock } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { JournalEntryView } from "@/components/video/journal-history";

// JournalHistory appelle useRouter() (next/navigation), qui exige un arbre App Router monté — sans
// ce mock, renderToStaticMarkup échoue avec « invariant expected app router to be mounted ». Même
// recette que tests/studio-editor-shell.test.ts : posée AVANT le premier import du composant, donc
// import dynamique (les imports statiques sont hissés).
const realNavigation = await import("next/navigation");
mock.module("next/navigation", () => ({
  ...realNavigation,
  useRouter: () => ({
    push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, forward: () => {}, prefetch: () => {},
  }),
}));
const { JournalHistory } = await import("@/components/video/journal-history");

function entry(over: Partial<JournalEntryView> = {}): JournalEntryView {
  return {
    id: "j-1",
    createdAt: "2026-08-16T10:00:00.000Z",
    source: "mcp",
    outcome: "applique",
    errorReport: [],
    rawPayload: null,
    revertedAt: null,
    reviewedAt: null,
    revertable: true,
    ...over,
  };
}

function html(entries: JournalEntryView[]): string {
  return renderToStaticMarkup(React.createElement(JournalHistory, { entries }));
}

// ── Round de correction final, I3 ────────────────────────────────────────────
// « Annuler » s'affichait dès que `outcome === "applique"`, donc AUSSI pour les écritures directes
// d'agent (update_beat, reorder_beats, update_insert, create_video_project), dont `applied` est vide.
// revertJournalEntryCore les refusait alors avec « Cette entrée est antérieure à l'enregistrement de
// l'état d'avant » — une explication FAUSSE pour ces lignes-là, sur le chemin même que le spec
// présente comme le recours humain. Le recours humain ne doit pas mentir sur ses raisons.
describe("JournalHistory — bouton « Annuler »", () => {
  it("l'offre pour un import appliqué qui porte son état d'avant", () => {
    expect(html([entry()])).toContain("Annuler");
  });

  it("ne l'offre PAS pour une écriture directe d'agent, qui n'a aucun état d'avant", () => {
    expect(html([entry({ revertable: false })])).not.toContain("Annuler");
  });

  it("ne l'offre pas pour une entrée déjà annulée", () => {
    expect(html([entry({ revertedAt: "2026-08-16T11:00:00.000Z" })])).not.toContain("Annuler");
  });

  it("ne l'offre pas pour une entrée rejetée", () => {
    expect(html([entry({ outcome: "rejete", revertable: false })])).not.toContain("Annuler");
  });
});
