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
