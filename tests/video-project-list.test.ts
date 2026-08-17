import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectList, type ProjectRow } from "@/components/video/project-list";

const rows: ProjectRow[] = [{
  id: "6f1c2f7e-0000-4000-8000-000000000000",
  title: "La success story de Babadampulu",
  status: "brouillon",
  platforms: ["youtube_long", "tiktok"],
  estimatedSec: 725,
  articleTitle: "Une PME ivoirienne à l'export",
  updatedAt: new Date("2026-08-16T10:00:00Z"),
  unreviewedCount: 0,
}];

describe("ProjectList", () => {
  it("affiche le titre du projet", () => {
    const html = renderToStaticMarkup(React.createElement(ProjectList, { projects: rows }));
    expect(html).toContain("La success story de Babadampulu");
  });

  it("affiche la durée cumulée en minutes et secondes", () => {
    const html = renderToStaticMarkup(React.createElement(ProjectList, { projects: rows }));
    expect(html).toContain("12 min 05 s");
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

  it("n'affiche aucun badge « non relue » quand le compteur est à zéro", () => {
    const html = renderToStaticMarkup(React.createElement(ProjectList, { projects: rows }));
    expect(html).not.toContain("non relue");
  });

  it("affiche le compteur d'écritures d'agent non relues (Task 8)", () => {
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
});
