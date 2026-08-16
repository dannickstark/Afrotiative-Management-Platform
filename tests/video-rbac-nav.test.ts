import { describe, it, expect } from "bun:test";
import { can } from "@/lib/rbac";
import { visibleNavSections, ROUTE_LABELS, deriveCrumbs } from "@/components/shell/nav-items";

describe("droits vidéo", () => {
  it("les trois rôles peuvent lire et écrire des scripts", () => {
    for (const role of ["admin", "editor", "journalist"] as const) {
      expect(can(role, "video", "read")).toBe(true);
      expect(can(role, "video", "manage")).toBe(true);
    }
  });

  it("une action inconnue reste refusée", () => {
    expect(can("journalist", "video", "publish")).toBe(false);
  });
});

describe("navigation vidéo", () => {
  it("la section apparaît pour les trois rôles", () => {
    for (const role of ["admin", "editor", "journalist"] as const) {
      const ids = visibleNavSections(role).map((s) => s.id);
      expect(ids).toContain("video");
    }
  });

  it("le fil d'Ariane connaît /video", () => {
    expect(ROUTE_LABELS["/video"]).toBe("Vidéos");
    expect(deriveCrumbs("/video/6f1c2f7e-0000-4000-8000-000000000000")).toEqual([
      { href: "/video", label: "Vidéos" },
    ]);
  });
});
