import { describe, it, expect } from "bun:test";
import {
  NAV_ITEMS, SETTINGS_CHILDREN, ROUTE_LABELS, visibleNavItems, deriveCrumbs,
} from "@/components/shell/nav-items";

describe("visibleNavItems", () => {
  it("un journaliste ne voit ni Exécutions ni les cinq sous-pages de Réglages fermées à son rôle", () => {
    const hrefs = visibleNavItems("journalist").map((i) => i.href);
    expect(hrefs).not.toContain("/runs");
    expect(hrefs).toContain("/queue");
  });

  it("un journaliste voit Réglages réduit à sa seule entrée autorisée, MCP (round de correction Task 7)", () => {
    // video:manage est accordé aux TROIS rôles (lib/rbac.ts) — le journaliste gère donc ses
    // propres jetons MCP, c'est lui qui écrit les scripts vidéo. Sans ce chemin de navigation, le
    // droit existerait sans accès : filterSections retire les cinq autres sous-pages (chacune
    // fermée à journalist par son propre `roles` sur SETTINGS_CHILDREN), donc Réglages survit avec
    // exactement un enfant.
    const settings = visibleNavItems("journalist").find((i) => i.href === "/settings");
    expect(settings).toBeDefined();
    expect(settings!.items!.map((c) => c.href)).toEqual(["/settings/mcp"]);
  });

  it("un éditeur voit Réglages avec exactement ses cinq sous-pages autorisées", () => {
    // Task 9 (OpenRouter token pool) : l'éditeur gagne l'accès à /settings/integrations —
    // même droit llmTokens:manage que la page et les actions du bassin de jetons.
    // Task 8 (module Vidéo) : l'éditeur gagne aussi /settings/video — même droit video:manage.
    // Task 7 (SP1 bis, serveur MCP) : l'éditeur gagne aussi /settings/mcp — même droit
    // video:manage que la page (app/(app)/settings/mcp/page.tsx).
    const settings = visibleNavItems("editor").find((i) => i.href === "/settings");
    expect(settings).toBeDefined();
    expect(settings!.items!.map((c) => c.href)).toEqual([
      "/settings/feeds",
      "/settings/taxonomy",
      "/settings/integrations",
      "/settings/video",
      "/settings/mcp",
    ]);
  });

  it("un admin voit les huit sous-pages de Réglages (D1 §6 ajoute Réseaux sociaux, Task 8 ajoute Vidéo, Task 7 ajoute MCP)", () => {
    const settings = visibleNavItems("admin").find((i) => i.href === "/settings");
    expect(settings!.items).toHaveLength(8);
    expect(settings!.items!.map((c) => c.href)).toContain("/settings/social");
    expect(settings!.items!.map((c) => c.href)).toContain("/settings/video");
    expect(settings!.items!.map((c) => c.href)).toContain("/settings/mcp");
  });

  it("un parent dont tous les enfants sont refusés n'est pas rendu", () => {
    // Garde-fou structurel : aucun parent de NAV_ITEMS ne doit survivre avec items: [].
    for (const role of ["admin", "editor", "journalist"] as const) {
      for (const item of visibleNavItems(role)) {
        if (item.items) expect(item.items.length).toBeGreaterThan(0);
      }
    }
  });

  it("ne mute pas NAV_ITEMS", () => {
    const before = NAV_ITEMS.find((i) => i.href === "/settings")!.items!.length;
    visibleNavItems("editor");
    expect(NAV_ITEMS.find((i) => i.href === "/settings")!.items!.length).toBe(before);
    expect(before).toBe(SETTINGS_CHILDREN.length);
  });
});

describe("ROUTE_LABELS", () => {
  it("couvre toute route de NAV_ITEMS et de ses enfants", () => {
    for (const item of NAV_ITEMS) {
      expect(ROUTE_LABELS[item.href]).toBeTruthy();
      for (const child of item.items ?? []) expect(ROUTE_LABELS[child.href]).toBeTruthy();
    }
  });
});

describe("deriveCrumbs", () => {
  it("une sous-page de réglages donne deux éléments", () => {
    expect(deriveCrumbs("/settings/team")).toEqual([
      { href: "/settings", label: "Réglages" },
      { href: "/settings/team", label: "Équipe" },
    ]);
  });

  it("une page de premier niveau donne un élément", () => {
    expect(deriveCrumbs("/queue")).toEqual([{ href: "/queue", label: "File de revue" }]);
  });

  it("une route dynamique retombe sur le libellé de son préfixe", () => {
    expect(deriveCrumbs("/article/8f1c6f2e-0000-4000-8000-000000000000")).toEqual([
      { href: "/article", label: "Article" },
    ]);
  });

  it("une route inconnue ne produit aucun élément", () => {
    expect(deriveCrumbs("/inconnu/quelque-part")).toEqual([]);
  });

  it("la racine ne produit aucun élément", () => {
    expect(deriveCrumbs("/")).toEqual([]);
  });
});
