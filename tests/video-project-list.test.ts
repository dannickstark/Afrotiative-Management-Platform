import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectList, ProjectListFilters, type ProjectRow } from "@/components/video/project-list";
import { pickHeadVariant } from "@/lib/queries/video";

const rows: ProjectRow[] = [{
  id: "6f1c2f7e-0000-4000-8000-000000000000",
  title: "La success story de Babadampulu",
  status: "brouillon",
  platforms: ["youtube_long", "tiktok"],
  estimatedSec: 725,
  articleTitle: "Une PME ivoirienne à l'export",
  updatedAt: new Date("2026-08-16T10:00:00Z"),
  unreviewedCount: 0,
  targetSec: null,
  deadLinkCount: 0,
  missingConsentCount: 0,
}];

describe("ProjectList", () => {
  it("affiche le titre du projet", () => {
    const html = renderToStaticMarkup(React.createElement(ProjectList, { projects: rows }));
    expect(html).toContain("La success story de Babadampulu");
  });

  it("affiche la durée de la variante de tête au format m:ss", () => {
    const html = renderToStaticMarkup(React.createElement(ProjectList, { projects: rows }));
    expect(html).toContain("12:05");
  });

  it("affiche un tiret pour la cible quand aucune variante n'en porte une", () => {
    const html = renderToStaticMarkup(React.createElement(ProjectList, { projects: rows }));
    expect(html).toContain("/ —");
  });

  it("affiche la cible au format m:ss quand elle est renseignée", () => {
    const withTarget: ProjectRow[] = [{ ...rows[0], targetSec: 600 }];
    const html = renderToStaticMarkup(React.createElement(ProjectList, { projects: withTarget }));
    expect(html).toContain("12:05");
    expect(html).toContain("/ 10:00");
  });

  it("affiche les plateformes en français", () => {
    const html = renderToStaticMarkup(React.createElement(ProjectList, { projects: rows }));
    expect(html).toContain("YouTube long");
    expect(html).toContain("TikTok");
  });

  it("lie vers l'espace du projet", () => {
    const html = renderToStaticMarkup(React.createElement(ProjectList, { projects: rows }));
    expect(html).toContain("/video/6f1c2f7e-0000-4000-8000-000000000000");
  });

  it("montre un état vide explicite quand il n'y a aucun projet", () => {
    const html = renderToStaticMarkup(React.createElement(ProjectList, { projects: [] }));
    expect(html).toContain("Aucune vidéo");
  });

  it("montre un état « aucun résultat » distinct quand un filtre est actif", () => {
    const html = renderToStaticMarkup(React.createElement(ProjectList, { projects: [], filtered: true }));
    expect(html).toContain("Aucun résultat pour ces filtres");
    expect(html).not.toContain("Aucune vidéo pour l'instant");
  });

  it("rend le statut comme une pastille avec le libellé français", () => {
    const html = renderToStaticMarkup(React.createElement(ProjectList, { projects: rows }));
    expect(html).toContain("Brouillon");
    expect(html).not.toContain("brouillon<");
  });

  it("affiche un tiret dans la colonne « À traiter » quand rien ne réclame d'action", () => {
    const html = renderToStaticMarkup(React.createElement(ProjectList, { projects: rows }));
    expect(html).not.toContain("non relue");
    expect(html).not.toContain("lien(s) mort(s)");
    expect(html).not.toContain("consentement(s)");
  });

  it("affiche le compteur d'écritures d'agent non relues (Task 8) dans la colonne « À traiter »", () => {
    const withUnreviewed: ProjectRow[] = [{ ...rows[0], unreviewedCount: 2 }];
    const html = renderToStaticMarkup(React.createElement(ProjectList, { projects: withUnreviewed }));
    expect(html).toContain("2 non relues");
  });

  it("accorde « non relue » au singulier pour un seul projet concerné", () => {
    const withUnreviewed: ProjectRow[] = [{ ...rows[0], unreviewedCount: 1 }];
    const html = renderToStaticMarkup(React.createElement(ProjectList, { projects: withUnreviewed }));
    expect(html).toContain("1 non relue");
    expect(html).not.toContain("1 non relues");
  });

  it("affiche un badge « lien(s) mort(s) » quand des liens sont morts", () => {
    const withDeadLinks: ProjectRow[] = [{ ...rows[0], deadLinkCount: 3 }];
    const html = renderToStaticMarkup(React.createElement(ProjectList, { projects: withDeadLinks }));
    expect(html).toContain("3 lien(s) mort(s)");
  });

  it("affiche un badge « consentement(s) » quand des consentements manquent", () => {
    const withMissingConsent: ProjectRow[] = [{ ...rows[0], missingConsentCount: 1 }];
    const html = renderToStaticMarkup(React.createElement(ProjectList, { projects: withMissingConsent }));
    expect(html).toContain("1 consentement(s)");
  });
});

const filterRows: ProjectRow[] = [
  {
    id: "11111111-0000-4000-8000-000000000000",
    title: "Interview du fondateur",
    status: "brouillon",
    platforms: ["youtube_long"],
    estimatedSec: 600,
    articleTitle: null,
    updatedAt: new Date("2026-08-10T10:00:00Z"),
    unreviewedCount: 0,
    targetSec: null,
    deadLinkCount: 0,
    missingConsentCount: 0,
  },
  {
    id: "22222222-0000-4000-8000-000000000000",
    title: "Récap TikTok de la saison",
    status: "publie",
    platforms: ["tiktok"],
    estimatedSec: 60,
    articleTitle: null,
    updatedAt: new Date("2026-08-11T10:00:00Z"),
    unreviewedCount: 1,
    targetSec: 45,
    deadLinkCount: 2,
    missingConsentCount: 0,
  },
];

describe("ProjectListFilters", () => {
  it("affiche toutes les lignes et le compte total sans filtre actif", () => {
    const html = renderToStaticMarkup(React.createElement(ProjectListFilters, { projects: filterRows }));
    expect(html).toContain("Interview du fondateur");
    expect(html).toContain("Récap TikTok de la saison");
    expect(html).toContain("2 projets");
    expect(html).toContain("1 demande une action");
  });

  it("montre l'état vide d'origine sans barre de filtres quand il n'y a aucun projet", () => {
    const html = renderToStaticMarkup(React.createElement(ProjectListFilters, { projects: [] }));
    expect(html).toContain("Aucune vidéo");
    expect(html).not.toContain("Recherche");
  });
});

// Task 1 (SP 014 — UX pass), revue finale (F3) — la colonne « Durée / cible » de /video décrit la
// VARIANTE DE TÊTE, des deux côtés de la barre oblique : les variantes sont des rendus alternatifs
// d'une même histoire (un montage YouTube de 10 min, un TikTok de 60 s), les additionner produisait
// une cible de 11:00 qu'aucun écran ne confirmait. deadLinkCount et missingConsentCount restent, eux,
// comptés sur tout le projet et sont couverts par tests/mcp-review-marker.test.ts (voie DB).
describe("pickHeadVariant", () => {
  it("choisit la variante de position la plus basse, quel que soit l'ordre reçu", () => {
    const v = [
      { id: "b", position: 2, targetDurationSec: 60 },
      { id: "a", position: 0, targetDurationSec: 600 },
      { id: "c", position: 1, targetDurationSec: null },
    ];
    expect(pickHeadVariant(v)?.id).toBe("a");
    // Et c'est bien SA cible qui sert, pas la somme des trois (600 et non 660).
    expect(pickHeadVariant(v)?.targetDurationSec).toBe(600);
  });

  it("renvoie null pour un projet sans variante", () => {
    expect(pickHeadVariant([])).toBeNull();
  });

  it("renvoie l'unique variante d'un projet qui n'en a qu'une", () => {
    expect(pickHeadVariant([{ id: "a", position: 0 }])?.id).toBe("a");
  });

  it("départage deux positions égales par id, pour rester déterministe", () => {
    expect(pickHeadVariant([{ id: "z", position: 0 }, { id: "a", position: 0 }])?.id).toBe("a");
  });

  it("une cible nulle sur la variante de tête reste nulle, même si une autre variante en a une", () => {
    const head = pickHeadVariant([
      { id: "a", position: 0, targetDurationSec: null },
      { id: "b", position: 1, targetDurationSec: 45 },
    ]);
    expect(head?.targetDurationSec ?? null).toBeNull();
  });

  it("une cible explicitement à 0 s se distingue de « aucune cible »", () => {
    const head = pickHeadVariant([{ id: "a", position: 0, targetDurationSec: 0 }]);
    expect(head?.targetDurationSec).toBe(0);
  });
});
