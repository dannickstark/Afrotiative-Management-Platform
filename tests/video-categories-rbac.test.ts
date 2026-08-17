import { describe, it, expect } from "bun:test";
import { can } from "@/lib/rbac";

describe("permissions des catégories de vidéo", () => {
  it("seuls admin et éditeur configurent les catégories", () => {
    // Écrire les instructions d'un expert est un acte de configuration, pas de rédaction.
    expect(can("admin", "video", "configure")).toBe(true);
    expect(can("editor", "video", "configure")).toBe(true);
    expect(can("journalist", "video", "configure")).toBe(false);
  });

  it("le journaliste choisit la catégorie de sa vidéo", () => {
    expect(can("journalist", "video", "manage")).toBe(true);
  });
});
