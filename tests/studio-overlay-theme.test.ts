import { describe, expect, it } from "bun:test";
import { OVERLAY } from "@/lib/studio/overlay-theme";

describe("overlay-theme (palette de surcouches)", () => {
  it("les quatre RÔLES restent visuellement distincts (anti-régression d'usage)", () => {
    const roles = [OVERLAY.selection, OVERLAY.snapGuide, OVERLAY.binding, OVERLAY.safeTint];
    // aucune paire identique — un designer doit pouvoir les différencier
    expect(new Set(roles).size).toBe(roles.length);
  });
  it("les valeurs sont des chaînes CSS non vides", () => {
    for (const v of Object.values(OVERLAY)) { expect(typeof v).toBe("string"); expect(v.length).toBeGreaterThan(0); }
  });
});
