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

  // Round de correction 1 (Task 8) : "configure" gate /settings/video (modèle de brief,
  // cadence) et doit rester distinct de "manage" — le journaliste garde "manage" (édition des
  // projets/beats vidéo) mais pas "configure" (réglages du module, réservés à admin/éditeur,
  // comme SETTINGS_CHILDREN le prévoit pour l'entrée de nav correspondante).
  it("« configure » est refusé au journaliste, accordé à l'éditeur et à l'admin", () => {
    expect(can("journalist", "video", "configure")).toBe(false);
    expect(can("editor", "video", "configure")).toBe(true);
    expect(can("admin", "video", "configure")).toBe(true);
  });

  it("les trois rôles conservent « read » et « manage » malgré l'ajout de « configure »", () => {
    for (const role of ["admin", "editor", "journalist"] as const) {
      expect(can(role, "video", "read")).toBe(true);
      expect(can(role, "video", "manage")).toBe(true);
    }
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
