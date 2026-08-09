import { describe, it, expect } from "bun:test";
import { NAV_SECTIONS, NAV_ITEMS, visibleNavSections, deriveCrumbs, ROUTE_LABELS } from "@/components/shell/nav-items";

describe("NAV_SECTIONS", () => {
  it("expose des sections non vides avec des identifiants uniques", () => {
    expect(NAV_SECTIONS.length).toBeGreaterThan(1);
    const ids = NAV_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of NAV_SECTIONS) expect(s.items.length).toBeGreaterThan(0);
  });

  it("NAV_ITEMS reste l'aplatissement des sections", () => {
    expect(NAV_ITEMS).toEqual(NAV_SECTIONS.flatMap((s) => s.items));
  });

  it("chaque href de section a un libellé de fil d'Ariane", () => {
    for (const item of NAV_ITEMS) expect(ROUTE_LABELS[item.href]).toBeTruthy();
  });
});

describe("visibleNavSections", () => {
  it("un journaliste ne voit ni Exécutions ni Réglages", () => {
    const hrefs = visibleNavSections("journalist").flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).toContain("/queue");
    expect(hrefs).not.toContain("/runs");
    expect(hrefs).not.toContain("/settings");
  });

  it("un éditeur voit Réglages mais seulement ses sous-pages autorisées", () => {
    const settings = visibleNavSections("editor").flatMap((s) => s.items).find((i) => i.href === "/settings");
    expect(settings).toBeDefined();
    const childHrefs = settings!.items!.map((c) => c.href);
    expect(childHrefs).toContain("/settings/feeds");
    expect(childHrefs).not.toContain("/settings/team");
  });

  it("un admin voit tout", () => {
    const hrefs = visibleNavSections("admin").flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).toEqual(expect.arrayContaining(["/dashboard", "/queue", "/runs", "/settings"]));
  });

  it("ne renvoie jamais une section vide", () => {
    for (const role of ["admin", "editor", "journalist"] as const) {
      for (const s of visibleNavSections(role)) expect(s.items.length).toBeGreaterThan(0);
    }
  });

  it("ne mute pas NAV_SECTIONS", () => {
    const before = JSON.stringify(NAV_SECTIONS.map((s) => ({ id: s.id, n: s.items.length })));
    visibleNavSections("journalist");
    expect(JSON.stringify(NAV_SECTIONS.map((s) => ({ id: s.id, n: s.items.length })))).toBe(before);
  });
});

describe("deriveCrumbs", () => {
  it("reste inchangé après le passage aux sections", () => {
    expect(deriveCrumbs("/settings/feeds")).toEqual([
      { href: "/settings", label: "Réglages" },
      { href: "/settings/feeds", label: "Sources RSS" },
    ]);
  });
});
