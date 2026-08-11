import { describe, it, expect, mock } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Scene } from "@/lib/studio/scene";
import type { EditorShellTemplate } from "@/components/studio/editor-shell";

// tests/studio-editor-shell.test.ts — revue de la Tâche 6 (U1, spec §2/§5). Ce fichier n'existait
// pas avant cette revue : le panneau de propriétés et l'aperçu (PreviewPane) partageaient la même
// colonne de 300px du mode Montage — spec §2 nomme EXPLICITEMENT cette colonne comme LE défaut que
// U1 corrige (« 674 lignes de contrôles et un aperçu en direct se disputant 300px de largeur ET le
// même espace vertical »), et spec §5 fait de Rendu réel le SEUL foyer de l'aperçu désormais. La
// Tâche 5 a construit Rendu réel sans jamais retirer l'aperçu empilé de Montage — tombé entre les
// deux tâches. Ce test verrouille le retrait fait dans la revue de la Tâche 6 : PreviewPane ne doit
// plus jamais réapparaître dans la branche Montage.
//
// components/studio/editor-shell.tsx appelle useRouter() (next/navigation), qui exige un arbre App
// Router monté — sans mock, renderToStaticMarkup échoue avec « invariant expected app router to be
// mounted » (déjà repéré et documenté dans tests/studio-no-r2.test.ts, qui listait alors
// editor-shell.tsx comme "ne peut pas être rendu sous bun test"). La recette de mock ci-dessous est
// EXACTEMENT celle de tests/studio-templates-table.test.ts (Tâche 2), posée AVANT le premier import
// de editor-shell.tsx (import dynamique `await import`, pas un import statique hissé) — vérifiée ici
// empiriquement : elle débloque bien le rendu structurel de la coque entière, pas seulement d'un
// panneau isolé comme dans son usage d'origine. Aucune autre dépendance de la branche Montage
// (Rail/PanelHost/Canvas/PropertyPanel/PreviewPane/VersionHistory/ModeSwitch) n'appelle useRouter(),
// useSession() ni RoleGate — vérifié par lecture avant d'écrire ce fichier — donc aucun autre mock
// n'est nécessaire : `prefs.openPanel` vaut `null` au tout premier rendu (DEFAULT_PREFS, useEffect
// de useEditorPrefs non exécuté sous renderToStaticMarkup), donc PanelHost/ModelesPanel (les seuls à
// utiliser RoleGate/useSession) ne sont même pas montés dans ce rendu.
const realNavigation = await import("next/navigation");
mock.module("next/navigation", () => ({
  ...realNavigation,
  useRouter: () => ({
    push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, forward: () => {}, prefetch: () => {},
  }),
}));

const { EditorShell } = await import("@/components/studio/editor-shell");

function scene(): Scene {
  return {
    schemaVersion: 1,
    canvas: { width: 1080, height: 1080, background: "#111111" },
    layers: [{
      id: "t", name: "Texte", visible: true, locked: false,
      frame: { x: 10, y: 10, w: 200, h: 80 },
      type: "text", content: "Contenu",
      font: { family: "Noto Sans", size: 24, weight: 400 },
      color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
    }],
  };
}

const template: EditorShellTemplate = {
  id: "00000000-0000-0000-0000-000000000000", name: "Gabarit test", context: "social_post",
  channel: null, categoryId: null, format: "ig_square", width: 1080, height: 1080,
  archived: false, publishedVersion: null,
};

function render() {
  return renderToStaticMarkup(
    React.createElement(EditorShell, {
      template, initialScene: scene(), publishedScene: null, versions: [], previewArticles: [],
    }),
  );
}

describe("EditorShell — mode Montage (revue Tâche 6, spec §2/§5)", () => {
  it("ne rend PLUS PreviewPane — l'aperçu vit désormais UNIQUEMENT dans Rendu réel", () => {
    const html = render();
    // La coque et ses pièces attendues sont bien là (pas un échec silencieux plus haut dans l'arbre) :
    expect(html).toContain('data-testid="editor-shell"');
    expect(html).toContain('data-testid="studio-canvas"');
    // Aucun calque sélectionné au premier rendu (initEditorState) : le panneau de propriétés affiche
    // son état vide — c'est malgré tout la preuve que la colonne propriétés a bien été rendue.
    expect(html).toContain('data-testid="property-panel-empty"');
    // La preuve du retrait : ni le composant PreviewPane...
    expect(html).not.toContain('data-testid="preview-pane"');
    // ...ni le mode Rendu réel (non actif par défaut, mais vérifié pour éviter tout faux positif si
    // le mode par défaut changeait un jour sans que ce test s'en aperçoive autrement).
    expect(html).not.toContain('data-testid="render-large"');
  });
});
