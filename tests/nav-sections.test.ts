import { describe, it, expect } from "bun:test";
import {
  NAV_SECTIONS,
  NAV_ITEMS,
  visibleNavSections,
  filterSections,
  deriveCrumbs,
  ROUTE_LABELS,
  type NavSection,
} from "@/components/shell/nav-items";

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
  it("un journaliste ne voit pas Exécutions, mais voit Réglages réduit à MCP (round de correction Task 7)", () => {
    // video:manage (lib/rbac.ts) est accordé aux trois rôles — le journaliste gère donc ses
    // propres jetons MCP depuis /settings/mcp. La section "reglages" et son élément /settings
    // restent ouverts à journalist pour lui donner ce chemin ; les cinq autres sous-pages restent
    // fermées via leur propre `roles` sur SETTINGS_CHILDREN.
    const sections = visibleNavSections("journalist");
    const hrefs = sections.flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).toContain("/queue");
    expect(hrefs).not.toContain("/runs");
    expect(hrefs).toContain("/settings");

    const settings = sections.flatMap((s) => s.items).find((i) => i.href === "/settings");
    expect(settings!.items!.map((c) => c.href)).toEqual(["/settings/mcp"]);
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

describe("filterSections (fixtures synthétiques)", () => {
  // Les données réelles de NAV_SECTIONS ne peuvent pas exercer le 3e niveau du filtre (la
  // suppression d'une section devenue vide) : aujourd'hui, chaque section restreinte par rôle a
  // exactement les mêmes rôles que son unique élément, donc les deux niveaux se vident toujours
  // ensemble. Cette fixture construit le cas que les données réelles ne peuvent pas produire :
  // une section SANS restriction de rôle qui l'exposerait, dont TOUS les éléments sont admin-only.
  const fixture: NavSection[] = [
    {
      id: "vide-pour-editeur",
      label: "Section vidée",
      items: [
        { href: "/synthetic/a", label: "A", icon: NAV_ITEMS[0].icon, roles: ["admin"] },
        { href: "/synthetic/b", label: "B", icon: NAV_ITEMS[0].icon, roles: ["admin"] },
      ],
    },
    {
      id: "conservee",
      label: "Section conservée",
      items: [
        { href: "/synthetic/c", label: "C", icon: NAV_ITEMS[0].icon, roles: ["admin"] },
        { href: "/synthetic/d", label: "D", icon: NAV_ITEMS[0].icon },
      ],
    },
  ];

  it("supprime entièrement une section dont tous les éléments ont été filtrés, plutôt que de la renvoyer vide", () => {
    const result = filterSections(fixture, "editor");
    expect(result.find((s) => s.id === "vide-pour-editeur")).toBeUndefined();
    for (const s of result) expect(s.items.length).toBeGreaterThan(0);
  });

  it("conserve une section sœur qui garde au moins un élément visible — la purge ne touche que la section vidée", () => {
    const result = filterSections(fixture, "editor");
    const kept = result.find((s) => s.id === "conservee");
    expect(kept).toBeDefined();
    expect(kept!.items.map((i) => i.href)).toEqual(["/synthetic/d"]);
  });

  it("ne mute pas la fixture passée en paramètre", () => {
    const before = JSON.stringify(fixture);
    filterSections(fixture, "editor");
    expect(JSON.stringify(fixture)).toBe(before);
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
