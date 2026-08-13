import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Scene, Layer } from "@/lib/studio/scene";
import { PropertyPanel } from "@/components/studio/property-panel";
import { DEFAULT_PREFS } from "@/lib/studio/editor-prefs";
const ROOT = join(import.meta.dir, "..");
const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");
const shell = readFileSync(join(ROOT, "components/studio/editor-shell.tsx"), "utf8");
const propertyPanelSource = readFileSync(join(ROOT, "components/studio/property-panel.tsx"), "utf8");

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

// ── Chantier E Tâche 3 (spec « états vides du studio via EmptyState ») ────────────────────────────
// Les DEUX surfaces vides du studio (inspecteur sans sélection, écran trop petit) doivent rendre la
// primitive PARTAGÉE `components/shell/empty-state.tsx` — même carte à bordure pointillée que le
// reste du produit (feeds/members/taxonomy/runs) — plutôt qu'une carte ad-hoc réinventée localement.
// `property-panel-empty`/`property-panel-empty-hint` sont VERROUILLÉS par tests/studio-editor-
// shell.test.ts et tests/studio-property-panel.test.ts : ce fichier vérifie que la migration vers
// EmptyState les préserve EXACTEMENT, en plus de la preuve structurelle (border-dashed) qu'aucun des
// deux fichiers verrouillés ne demandait avant cette tâche.
function scene(layers: Layer[]): Scene {
  return { schemaVersion: 1, canvas: { width: 1200, height: 675, background: "#0B0B0B" }, layers };
}

const textLayer: Layer = {
  id: "t", name: "Titre", visible: true, locked: false,
  frame: { x: 10, y: 10, w: 400, h: 100 }, rotation: 0, opacity: 1,
  type: "text", content: "Bonjour",
  font: { family: "Noto Sans", size: 40, weight: 700 },
  color: "#FFFFFF", align: "center", vAlign: "middle", lineHeight: 1.3,
};

// Calqué sur `render()`/`renderMulti()` de tests/studio-property-panel.test.ts : aucune sélection
// (`selectedIds: []`) est le cas qui produit l'état vide de l'inspecteur.
function renderPropertyPanelEmpty(): string {
  const noop = () => {};
  return renderToStaticMarkup(
    React.createElement(PropertyPanel, {
      scene: scene([textLayer]), selectedIds: [], context: "social_post", dispatch: noop, assets: [],
      sectionsOpen: DEFAULT_PREFS.sectionsOpen, onSectionsOpenChange: noop,
    }),
  );
}

describe("chantier E · états vides du studio via EmptyState (Tâche 3)", () => {
  it("l'inspecteur vide utilise EmptyState et garde ses data-testid verrouillés", () => {
    const html = renderPropertyPanelEmpty();
    expect(html).toContain('data-testid="property-panel-empty"');      // testid préservé (verrou de test)
    expect(html).toContain('data-testid="property-panel-empty-hint"');
    expect(html).toContain("border-dashed");                            // la primitive EmptyState partagée
    // Le COPY du hint reste inchangé mot pour mot (les tests verrouillés l'affirment déjà via ce
    // même testid, mais une preuve directe ici évite qu'un futur refactor ne le déplace ailleurs).
    expect(html).toContain("Sélectionnez un calque pour modifier ses propriétés.");
  });

  it("property-panel.tsx importe bien EmptyState (pas une carte ad-hoc réinventée)", () => {
    expect(propertyPanelSource).toContain('import { EmptyState } from "@/components/shell/empty-state"');
  });

  it("editor-shell.tsx (TooSmallState) importe bien EmptyState (pas une carte ad-hoc réinventée)", () => {
    expect(shell).toContain('import { EmptyState } from "@/components/shell/empty-state"');
  });
});
