import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const ROOT = join(import.meta.dir, "..");
const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");
const shell = readFileSync(join(ROOT, "components/studio/editor-shell.tsx"), "utf8");

describe("chantier E · --canvas-backdrop", () => {
  it("le jeton est défini en clair ET en sombre", () => {
    // défini au moins deux fois (bloc :root clair + bloc .dark)
    const hits = css.match(/--canvas-backdrop\s*:/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });
  it("le canvas-backdrop consomme le jeton, plus de fond neutre EN DUR", () => {
    // le div data-testid="canvas-backdrop" utilise var(--canvas-backdrop)
    expect(shell).toContain("var(--canvas-backdrop)");
    // le couple neutral-100 / dark:bg-neutral-900 en dur a disparu de ce fichier
    expect(shell).not.toContain("bg-neutral-100");
    expect(shell).not.toContain("dark:bg-neutral-900");
  });
});

describe("chantier E · overlay-theme (source unique des couleurs de surcouches)", () => {
  it("aucune couleur de surcouche EN DUR ne subsiste dans canvas/canvas-chrome (source unique)", () => {
    const canvas = readFileSync(join(ROOT, "components/studio/canvas.tsx"), "utf8");
    const chrome = readFileSync(join(ROOT, "components/studio/canvas-chrome.tsx"), "utf8");
    // les hexes historiques ne doivent plus apparaître comme LITTÉRAUX de code (les commentaires citant
    // l'historique sont tolérés : on vérifie l'absence dans un contexte de valeur CSS "…: '#…'" ou `${…}`).
    for (const hex of ["#2563eb", "#e11d48", "#7c3aed"]) {
      expect(canvas.includes(`"${hex}"`) || canvas.includes(`'${hex}'`)).toBe(false);
    }
    expect(chrome.includes("rgba(245,158,11")).toBe(false); // migré vers overlay-theme
  });
});
