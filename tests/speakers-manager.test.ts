import { describe, it, expect, mock } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SpeakerRow } from "@/lib/queries/video";

// SpeakersManager suit le motif de category-manager.tsx (Dialog + ConfirmDialog + useTransition +
// toast) — ces composants n'appellent pas useRouter (revalidate-only, pas de router.refresh), mais
// on mock quand même next/navigation par précaution/cohérence avec le motif des autres tests purs
// du dossier (tests/insert-row.test.ts, tests/montage-share-panel.test.ts) : posé AVANT le premier
// import du composant, donc import dynamique et non statique (les imports statiques sont hissés).
const realNavigation = await import("next/navigation");
mock.module("next/navigation", () => ({
  ...realNavigation,
  useRouter: () => ({
    push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, forward: () => {}, prefetch: () => {},
  }),
}));
const { SpeakersManager } = await import("@/components/video/speakers-manager");

const consented: SpeakerRow = {
  id: "6f1c2f7e-0000-4000-8000-000000000001",
  name: "Awa Koné",
  role: "Témoin",
  consentGiven: true,
  consentNote: null,
  createdAt: new Date("2026-08-20T10:00:00Z"),
};

const notConsented: SpeakerRow = {
  id: "6f1c2f7e-0000-4000-8000-000000000002",
  name: "Moussa Diarra",
  role: "Expert",
  consentGiven: false,
  consentNote: null,
  createdAt: new Date("2026-08-20T10:05:00Z"),
};

function render(speakers: SpeakerRow[]) {
  return renderToStaticMarkup(
    React.createElement(SpeakersManager, { projectId: "p-1", speakers }),
  );
}

describe("SpeakersManager", () => {
  it("affiche les noms des intervenants", () => {
    const html = render([consented, notConsented]);
    expect(html).toContain("Awa Koné");
    expect(html).toContain("Moussa Diarra");
  });

  it("affiche un badge de consentement par intervenant", () => {
    const html = render([consented, notConsented]);
    expect(html).toContain("Consentement OK");
    expect(html).toContain("Sans consentement");
  });

  it("affiche le bandeau d'avertissement quand un intervenant n'a pas consenti", () => {
    const html = render([consented, notConsented]);
    expect(html).toContain("1 intervenant(s) sans consentement — la mise en montage sera bloquée.");
  });

  it("n'affiche pas de bandeau d'avertissement quand tous ont consenti", () => {
    const html = render([consented]);
    expect(html).not.toContain("sans consentement — la mise en montage sera bloquée.");
  });

  it("état vide", () => {
    const html = render([]);
    expect(html).toContain("Aucun intervenant");
  });
});
