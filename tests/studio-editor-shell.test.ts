import { describe, it, expect, mock, beforeAll, afterAll, afterEach } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installDom, mount, click, pressKey } from "./dom-harness";
import type { Scene } from "@/lib/studio/scene";
import type { EditorShellTemplate } from "@/components/studio/editor-shell";
import { RULER_SIZE } from "@/components/studio/canvas-chrome";

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

const { EditorShell, computeCanvasScale } = await import("@/components/studio/editor-shell");

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

// Chantier A Tâche 2 — la coque admin (SidebarProvider/AppSidebar/header, app/(app)/layout.tsx)
// a quitté l'arbre de l'éditeur dès la Tâche 1 (app/(studio-editor)/layout.tsx, plein écran, SANS
// Breadcrumbs ni SidebarTrigger) : l'en-tête d'EditorShell (editor-shell.tsx:339) DEVIENT donc la
// seule barre supérieure de l'éditeur. Ce test verrouille sa forme cible — retour `/studio` (PAS une
// simple flèche visuelle, spec Tâche 2 : « aujourd'hui la flèche peut n'être que visuelle ; la faire
// naviguer »), nom du gabarit, ModeSwitch désormais VISIBLE dans cette barre (avant cette tâche il
// vivait en position absolue au-dessus du canevas, jamais dans l'en-tête — voir editor-shell.tsx
// avant ce correctif) et le slot zoom (chantier B, inerte ici) — et l'ABSENCE de toute pièce de la
// coque admin, qu'EditorShell ne monte de toute façon jamais lui-même (aucun import de
// components/shell/breadcrumbs.tsx ni components/ui/sidebar.tsx dans ce fichier) : cette assertion
// est donc une preuve NÉGATIVE directe sur le HTML rendu, pas une simple déduction depuis les imports.
describe("EditorShell — barre supérieure d'éditeur (chantier A T2)", () => {
  it("le retour VISE /studio (pas une flèche sans destination), affiche le nom du gabarit, le sélecteur de mode et le slot zoom — sans Breadcrumbs ni SidebarTrigger", () => {
    const html = render();
    // Anti-vacuité : c'est bien la CIBLE de navigation qui est vérifiée, pas seulement la présence
    // d'une flèche. Un mutant qui pointerait ce lien ailleurs (ex. "/" ou "#") fait rougir ce test.
    expect(html).toContain('data-testid="editor-back-to-templates"');
    expect(html).toContain('href="/studio"');
    expect(html).toContain(template.name);
    expect(html).toContain('data-testid="mode-switch"');
    expect(html).toContain('data-testid="zoom-slot"');
    // La coque admin n'existe pas dans cet arbre — ni Breadcrumbs (components/shell/breadcrumbs.tsx,
    // data-slot="breadcrumb") ni SidebarTrigger (components/ui/sidebar.tsx, data-slot=
    // "sidebar-trigger").
    expect(html).not.toContain('data-slot="breadcrumb"');
    expect(html).not.toContain('data-slot="sidebar-trigger"');
  });
});

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

// Chantier A Tâche 3 (spec §2/§3) — corps trois zones : fond neutre du canevas, état vide compact de
// l'inspecteur, et les deux poignées de redimensionnement. Toutes vérifiables sur le HTML STATIQUE
// (renderToStaticMarkup) — aucune de ces trois preuves n'exige d'interactivité, seulement la
// STRUCTURE/les CLASSES rendues au premier rendu (`prefs` vaut DEFAULT_PREFS ici, useEffect de
// useEditorPrefs n'ayant jamais tourné sous ce mode de rendu — voir le commentaire d'en-tête).
describe("EditorShell — corps trois zones : fond neutre, état vide compact, poignées de glisser (chantier A Tâche 3)", () => {
  it("le conteneur du canevas porte un fond d'atelier NETTEMENT visible (jeton --canvas-backdrop, chantier E Tâche 1), pas l'ancien bg-muted/40 quasi blanc", () => {
    const html = render();
    const openTag = html.slice(
      html.indexOf('data-testid="canvas-backdrop"') - 400,
      html.indexOf('data-testid="canvas-backdrop"') + 200,
    );
    // Chantier E Tâche 1 : le neutre en dur (bg-neutral-100 / dark:bg-neutral-900) est remplacé par
    // le jeton --canvas-backdrop (globals.css), qui porte la même intention (fond nettement visible)
    // mais chaud plutôt que froid, et défini une seule fois pour clair+sombre au lieu de deux classes.
    expect(openTag).toContain("bg-[var(--canvas-backdrop)]");
    // Anti-vacuité : l'ANCIEN fond (bg-muted/40, ~1.4% d'écart du blanc pur — ne se distinguait pas
    // franchement des panneaux blancs, revue de branche) ne doit plus apparaître SUR CE conteneur précis.
    expect(openTag).not.toContain("bg-muted/40");
  });

  it("l'état vide de l'inspecteur est COMPACT — une petite carte ancrée en haut, pas le vide plein-écran d'avant cette tâche", () => {
    const html = render();
    expect(html).toContain('data-testid="property-panel-empty"');
    // La carte compacte elle-même, bornée en largeur : la preuve structurelle du changement, pas
    // seulement un espoir sur les classes du conteneur parent.
    expect(html).toContain('data-testid="property-panel-empty-hint"');
    expect(html).toContain("max-w-[220px]");
    // Anti-vacuité — LA preuve négative que le brief nomme explicitement : l'ancienne structure
    // centrait le message sur toute la hauteur (`items-center justify-center`, un `<div>` UNIQUE,
    // sans carte imbriquée). Un mutant qui reviendrait à `justify-center` sur ce conteneur — même en
    // gardant les deux `data-testid` — ferait rougir CETTE assertion.
    const emptyTag = html.slice(
      html.indexOf('data-testid="property-panel-empty"') - 200,
      html.indexOf('data-testid="property-panel-empty"') + 100,
    );
    expect(emptyTag).not.toContain("justify-center");
  });

  it("les deux poignées de redimensionnement sont rendues — rail-panel↔canevas (un panneau est ouvert par défaut, hasLayers=true -> aucun forçage, mais Calques reste `lastOpenPanel`… ici `openPanel` DEFAULT_PREFS vaut null) et canevas↔inspecteur (toujours montée)", () => {
    const html = render();
    // `prefs.openPanel` vaut `null` au tout premier rendu statique (DEFAULT_PREFS, useEffect jamais
    // exécuté) : la poignée rail-panel↔canevas n'a donc RIEN à redimensionner et ne doit pas
    // apparaître — exactement la même garde que celle vérifiée en JSX (`prefs.openPanel !== null`).
    expect(html).not.toContain('data-testid="rail-panel-resize-handle"');
    // La poignée canevas↔inspecteur, elle, n'est JAMAIS conditionnée par `openPanel` — l'inspecteur
    // est toujours affiché en mode Montage.
    expect(html).toContain('data-testid="inspector-resize-handle"');
  });

  it("l'inspecteur porte la largeur de EditorPrefs.inspectorWidth (300px par défaut) en style inline, pas la classe w-[300px] figée d'avant cette tâche", () => {
    const html = render();
    const idx = html.indexOf('data-testid="inspector-resize-handle"');
    const after = html.slice(idx, idx + 600);
    expect(after).toContain("width:300px");
    expect(after).not.toContain("w-[300px]");
  });
});

// Correctif revue finale — Important 6 (spec §7) : « la mise à l'échelle du canevas ignore les
// bandes de règles ». `computeCanvasScale` est PURE (aucun DOM, aucun ResizeObserver) : testable
// directement, sans avoir besoin de monter le composant ni de simuler une mesure de conteneur.
describe("computeCanvasScale — l'échelle tient compte des bandes de règles (Important 6, revue finale)", () => {
  it("AVANT le correctif conceptuel : sans les règles, le calcul historique (pad=32 fixe)", () => {
    // Conteneur large, gabarit carré : l'échelle est bornée à 1 (jamais un agrandissement au-delà
    // de la taille native), exactement le comportement d'avant ce correctif pour ce cas.
    expect(computeCanvasScale({ width: 2000, height: 2000 }, { width: 936, height: 936 }, false)).toBe(1);
  });

  it("activer les règles RÉDUIT l'échelle obtenue pour un même conteneur — le bogue corrigé : avant, l'échelle ne changeait JAMAIS", () => {
    const available = { width: 500, height: 500 };
    const template = { width: 1000, height: 1000 };
    const withoutRulers = computeCanvasScale(available, template, false)!;
    const withRulers = computeCanvasScale(available, template, true)!;
    expect(withRulers).toBeLessThan(withoutRulers);
  });

  it("le montant exact retranché est 2×RULER_SIZE par axe, en plus du pad de 32 existant", () => {
    const available = { width: 500, height: 500 };
    const template = { width: 1000, height: 1000 };
    const withoutRulers = computeCanvasScale(available, template, false)!;
    const withRulers = computeCanvasScale(available, template, true)!;
    expect(withoutRulers).toBeCloseTo((500 - 32) / 1000, 10);
    expect(withRulers).toBeCloseTo((500 - 32 - 2 * RULER_SIZE) / 1000, 10);
  });

  it("conteneur trop petit une fois le pad (avec règles) retranché : renvoie null — ne réinitialise JAMAIS à 1, comme le `return;` d'origine qui laissait l'échelle inchangée", () => {
    // 60px de large tient dans le pad SANS les règles (60 - 32 = 28 > 0) mais plus une fois le pad
    // des règles ajouté (60 - 32 - 2×20 = -12 <= 0) — précisément le cas que ce correctif introduit.
    expect(computeCanvasScale({ width: 60, height: 200 }, { width: 1000, height: 1000 }, false)).not.toBeNull();
    expect(computeCanvasScale({ width: 60, height: 200 }, { width: 1000, height: 1000 }, true)).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Chantier A Tâche 4 (spec §2/§9, responsive) — U0 harnais DOM : `EditorShell` MONTÉ (pas
// `renderToStaticMarkup`, qui ne fait jamais tourner `useEffect` donc jamais
// hooks/use-editor-layout.ts) à une largeur SIMULÉE, pour vérifier la COMPOSITION que produit
// chaque palier — pas sa visibilité (leçon U1 : « present ≠ visible », brief). Ce fichier importe
// déjà `EditorShell` de façon STATIQUE en tête de fichier (ligne ~38, AVANT tout `installDom()`) —
// exactement le schéma documenté dans tests/studio-interactions.test.ts qui gèle
// `@base-ui/utils/useIsoLayoutEffect.mjs` sur un no-op pour le composant `Sheet` (Dialog base-ui,
// components/ui/sheet.tsx) importé transitivement par editor-shell.tsx : un VRAI clic qui ouvrirait
// un `Sheet` échouerait donc ici à porter son contenu jusqu'à `document.body` (vérifié empiriquement
// en écrivant la même sonde). Les trois assertions ci-dessous n'en ont pas besoin : chacune se lit
// sur le DOM FERMÉ (le déclencheur `data-testid="inspector-drawer-trigger"` est un `<button>` natif,
// aucune machinerie base-ui) — la preuve de composition que le brief demande (« the inspector is a
// drawer… NOT an inline column ») ne réclame jamais d'ouvrir ce tiroir.
function installLayoutTestGlobals(): () => void {
  const g = globalThis as unknown as Record<string, unknown> & { window: Record<string, unknown> };
  const snapshot = new Map<string, { had: boolean; value: unknown }>();
  const set = (key: string, value: unknown) => {
    snapshot.set(key, { had: Object.prototype.hasOwnProperty.call(g, key), value: g[key] });
    g[key] = value;
  };
  // Même liste, même raison que tests/studio-interactions.test.ts (jsdom 30 sans
  // `pretendToBeVisual` ne fournit ni l'un ni l'autre) : monter EditorShell — même en `too-small`,
  // qui rend encore <Canvas> en aperçu — exige un `ResizeObserver` réel dès le premier rendu.
  set("Element", g.window.Element);
  set("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number);
  set("cancelAnimationFrame", (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>));
  set("getComputedStyle", (g.window.getComputedStyle as (...a: unknown[]) => unknown).bind(g.window));
  set(
    "ResizeObserver",
    class {
      constructor(_cb: ResizeObserverCallback) {}
      observe(_target: Element): void {}
      unobserve(_target: Element): void {}
      disconnect(): void {}
    },
  );
  return () => {
    for (const [key, prior] of snapshot) {
      if (prior.had) g[key] = prior.value;
      else delete g[key];
    }
  };
}

describe("EditorShell — réactif : editorLayoutMode pilote la composition réellement montée (Chantier A Tâche 4)", () => {
  let teardownDom: () => void;
  let teardownGlobals: () => void;

  beforeAll(() => {
    teardownDom = installDom();
    teardownGlobals = installLayoutTestGlobals();
  });
  afterAll(() => {
    teardownGlobals();
    teardownDom();
  });

  // `window.innerWidth` est une propriété de données ORDINAIRE sous jsdom (vérifié : `writable`,
  // `configurable`, pas un accesseur) — une simple réaffectation suffit. Restaurée SEULEMENT une fois
  // `EditorShell` entièrement monté (donc l'effet de hooks/use-editor-layout.ts déjà exécuté, `mount()`
  // de tests/dom-harness.ts attend `act()` jusque-là) — jamais avant : `window.innerWidth` reste lu de
  // façon PARESSEUSE par cet effet (planifié, pas exécuté au moment où on l'affecte), donc la restaurer
  // avant que `mount()` ne se résolve ferait lire la valeur restaurée, pas la largeur simulée. C'est le
  // bogue d'une première version de ce test — mesuré : sans ce séquencement, `mount()` voyait la
  // largeur *restaurée* (celle du test précédent, ou celle par défaut de jsdom, 1024) au lieu de celle
  // demandée ici, quel que soit l'argument passé.
  async function mountAtWidth(px: number) {
    const original = Object.getOwnPropertyDescriptor(window, "innerWidth");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: px });
    const { container, unmount } = await mount(React.createElement(EditorShell, {
      template, initialScene: scene(), publishedScene: null, versions: [], previewArticles: [],
    }));
    if (original) Object.defineProperty(window, "innerWidth", original);
    return { container, unmount };
  }

  it("1100px (inspector-drawer) : l'inspecteur est un TIROIR (déclencheur + Sheet), pas la colonne fixe — le canevas garde sa place", async () => {
    const { container, unmount } = await mountAtWidth(1100);

    expect(container.querySelector('[data-testid="editor-shell"]')).not.toBeNull();
    // Le canevas est bien monté, PAS remplacé par l'état trop-petit.
    expect(container.querySelector('[data-testid="canvas-backdrop"]')).not.toBeNull();
    // LA preuve négative : ni la poignée de redimensionnement de l'inspecteur…
    expect(container.querySelector('[data-testid="inspector-resize-handle"]')).toBeNull();
    // …ni la colonne fixe elle-même n'apparaissent QUELQUE PART dans l'arbre.
    expect(container.querySelector('[data-testid="inspector-column"]')).toBeNull();
    // LA preuve positive : le déclencheur du tiroir est bien monté — « present », même si son
    // contenu (le `Sheet`) ne l'est pas tant qu'on ne clique pas (« ≠ visible »).
    expect(container.querySelector('[data-testid="inspector-drawer-trigger"]')).not.toBeNull();

    unmount();
  });

  it("700px (too-small) : l'état lecture seule remplace TOUTE la coque d'édition — Rail, panneau et canevas d'édition disparaissent", async () => {
    const { container, unmount } = await mountAtWidth(700);

    expect(container.querySelector('[data-testid="editor-shell"]')).not.toBeNull();
    const tooSmall = container.querySelector('[data-testid="editor-too-small"]');
    expect(tooSmall).not.toBeNull();
    // Le libellé EXACT du brief — un mutant qui reformulerait ce message sans y toucher structurellement
    // (ex. en retirant « aperçu seulement ») ferait rougir cette assertion précise.
    expect(tooSmall!.textContent).toContain("Écran trop petit pour l’édition — aperçu seulement");
    // Chantier E Tâche 3 : cette carte de titre/hint est désormais la primitive PARTAGÉE EmptyState
    // (components/shell/empty-state.tsx) — même bordure pointillée que les autres états vides du
    // produit — au lieu d'une carte ad-hoc locale (`border` plein + `shadow-sm`, sans le motif
    // pointillé commun). Preuve structurelle ajoutée SANS toucher aux assertions verrouillées ci-dessus.
    expect(tooSmall!.innerHTML).toContain("border-dashed");
    // Anti-vacuité — LA preuve que ce n'est pas un simple bandeau AJOUTÉ par-dessus la coque
    // d'édition habituelle : Rail/canevas d'édition/panneau accosté n'existent PLUS du tout dans cet
    // arbre, quel que soit `mode` (Montage par défaut ici).
    expect(container.querySelector('[data-testid="editor-rail"]')).toBeNull();
    expect(container.querySelector('[data-testid="canvas-backdrop"]')).toBeNull();
    expect(container.querySelector('[data-testid="inspector-drawer-trigger"]')).toBeNull();
    // Correctif revue (Chantier A Tâche 4, Important) : « aperçu seulement » n'était pas honnête —
    // annuler/rétablir (dispatch(undo())/dispatch(redo()), un VRAI HistoryEntry du réducteur),
    // Historique (VersionHistory.onRestore remonte l'éditeur avec une AUTRE scène) et Publier restaient
    // des actions RÉELLES rendues par l'en-tête, monté sans condition de `layout` — et undo/redo/
    // restaurer sont ensuite autosauvegardés (l'effet qui compare `state.scene` à sa valeur d'origine
    // ne distingue pas la PROVENANCE d'un changement), donc persistés en base malgré l'étiquette
    // lecture seule. Les quatre doivent être ABSENTS ici (repliés, pas seulement `disabled` — un
    // affordance visible resterait malhonnête sur un écran qui prétend n'en avoir aucune).
    expect(container.querySelector('[title="Annuler"]')).toBeNull();
    expect(container.querySelector('[title="Rétablir"]')).toBeNull();
    expect(container.querySelector('[data-action="version-history"]')).toBeNull();
    expect(container.querySelector('[data-action="publish"]')).toBeNull();

    unmount();
  });

  it("1400px (full) : les trois colonnes historiques — inspecteur en colonne fixe, PAS de tiroir", async () => {
    const { container, unmount } = await mountAtWidth(1400);

    expect(container.querySelector('[data-testid="editor-shell"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="editor-rail"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="canvas-backdrop"]')).not.toBeNull();
    // La colonne fixe et sa poignée sont bien là…
    expect(container.querySelector('[data-testid="inspector-resize-handle"]')).not.toBeNull();
    const inspectorColumn = container.querySelector('[data-testid="inspector-column"]') as HTMLElement | null;
    expect(inspectorColumn).not.toBeNull();
    expect(inspectorColumn!.style.width).toBe("300px");
    // …et AUCUN mécanisme de tiroir ne coexiste avec elle — un mutant qui rendrait les DEUX à la
    // fois (colonne ET déclencheur) laisserait les deux tests précédents indifférents à ce défaut
    // précis, puisqu'aucun des deux ne vérifie l'ABSENCE du tiroir en `full`.
    expect(container.querySelector('[data-testid="inspector-drawer-trigger"]')).toBeNull();
    expect(container.querySelector('[data-testid="editor-too-small"]')).toBeNull();
    // Anti-vacuité, appariée au test 700px ci-dessus : les quatre contrôles d'édition de l'en-tête
    // SONT bien là en `full` — un mutant qui les replierait à TOUTES les largeurs (au lieu de
    // seulement `too-small`) ferait rougir CETTE assertion précise, jamais couverte par le test 700px
    // seul.
    expect(container.querySelector('[title="Annuler"]')).not.toBeNull();
    expect(container.querySelector('[title="Rétablir"]')).not.toBeNull();
    expect(container.querySelector('[data-action="version-history"]')).not.toBeNull();
    expect(container.querySelector('[data-action="publish"]')).not.toBeNull();

    unmount();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Chantier B, Tâche 3 (spec task-3-brief.md, Étape 4) — le VRAI zoom : `scale = fitScale × factor`,
// prouvé sur le VRAI EditorShell monté (installDom, comme le bloc ci-dessus) plutôt que sur
// lib/studio/zoom.ts isolé (tests/studio-zoom.test.ts, déjà PUR) — LE point de cette tâche est que
// editor-shell.tsx applique réellement ce facteur au `transform: scale()` de canvas.tsx et à la
// pastille zoom-chip de canvas-chrome.tsx, pas seulement que zoom.ts calcule juste tout seul.
//
// Le conteneur mesuré (canvasWrapRef) a `clientWidth`/`clientHeight` à 0 sous jsdom (aucune vraie mise
// en page) : `computeCanvasScale` (editor-shell.tsx) y renvoie donc `null` (conteneur « trop petit »
// une fois son pad retranché) et `fitScale` reste bloqué à son défaut `useState(1)` — CE QUI EST
// EXPLOITÉ ICI, pas contourné : `fitScale = 1` rend `scale = factor` directement lisible, sans
// dépendre d'aucune mesure simulée de conteneur.
describe("EditorShell — le VRAI zoom : scale = fitScale × factor, slot ET pastille D'ACCORD (Chantier B, Tâche 3)", () => {
  let teardownDom: () => void;
  let teardownGlobals: () => void;

  beforeAll(() => {
    teardownDom = installDom();
    teardownGlobals = installLayoutTestGlobals();
  });
  afterAll(() => {
    teardownGlobals();
    teardownDom();
  });
  // Chaque test écrit `EditorPrefs.zoom` dans le MÊME `localStorage` jsdom (partagé par tout ce
  // `describe`, un seul `installDom()` pour les trois tests) — sans ce nettoyage, un facteur zoomé
  // laissé par un test contaminerait le montage initial du suivant (même précaution que la garde ⌘Z
  // de tests/studio-interactions.test.ts, describe "keymap central").
  afterEach(() => {
    window.localStorage.clear();
  });

  async function mountAttached() {
    const { container, unmount } = await mount(React.createElement(EditorShell, {
      template, initialScene: scene(), publishedScene: null, versions: [], previewArticles: [],
    }));
    // Attaché à `document.body` (pas seulement monté détaché) : `pressKey` sans cible explicite
    // dispatche sur `document` par défaut, et hooks/use-editor-keymap.ts écoute `window` — même
    // précaution que `mountShellAttached` (tests/studio-interactions.test.ts) pour les tests clavier
    // sur le VRAI EditorShell.
    document.body.appendChild(container);
    return { container, cleanup: () => { unmount(); container.remove(); } };
  }

  // Lit l'échelle RÉELLEMENT peinte — le `transform: scale(k)` du conteneur INTÉRIEUR de
  // components/studio/canvas.tsx (le seul et unique enfant de `[data-testid="studio-canvas"]`),
  // jamais un texte affiché : c'est CE nombre que la mutation du brief (« unbinding the factor from
  // scale ») doit faire cesser de bouger.
  function paintedScaleOf(container: HTMLElement): number {
    const canvasEl = container.querySelector('[data-testid="studio-canvas"]') as HTMLElement;
    const inner = canvasEl.firstElementChild as HTMLElement;
    const match = /scale\(([-\d.]+)\)/.exec(inner.style.transform);
    return match ? parseFloat(match[1]) : NaN;
  }

  it("cliquer + dans le slot fait CROÎTRE le scale RÉELLEMENT PEINT (transform: scale() de l'artboard) — LA mutation surveillée par le brief : découpler `factor` de `scale`", async () => {
    const { container, cleanup } = await mountAttached();
    try {
      const before = paintedScaleOf(container);
      expect(before).toBeCloseTo(1, 10); // fitScale=1 (non mesurable ici) × factor "fit"=1

      const zoomIn = container.querySelector('[data-testid="zoom-in"]') as HTMLButtonElement;
      expect(zoomIn).not.toBeNull();
      await click(zoomIn);

      expect(paintedScaleOf(container)).toBeGreaterThan(before);
    } finally {
      cleanup();
    }
  });

  it("le pourcentage affiché par le slot (zoom-current) ET par la pastille (zoom-chip, canvas-chrome.tsx) restent TOUJOURS d'accord — UNE SEULE source de vérité", async () => {
    const { container, cleanup } = await mountAttached();
    try {
      function percents() {
        const slot = container.querySelector('[data-testid="zoom-current"]') as HTMLElement;
        const chip = container.querySelector('[data-testid="zoom-chip"]') as HTMLElement;
        expect(slot).not.toBeNull();
        expect(chip).not.toBeNull();
        return { slot: slot.textContent, chip: chip.textContent };
      }

      const before = percents();
      expect(before.slot).toBe(before.chip);
      expect(before.slot).toBe("100%"); // fitScale=1 × factor "fit"=1

      const zoomIn = container.querySelector('[data-testid="zoom-in"]') as HTMLButtonElement;
      await click(zoomIn);
      await click(zoomIn);

      const after = percents();
      expect(after.slot).toBe(after.chip);
      // Anti-vacuité — un mutant qui laisserait `scale` figé à `fitScale` (ignorant `factor`) ferait
      // TOUJOURS passer l'égalité slot===chip (les deux liraient la même valeur figée) sans que cette
      // seule assertion s'en aperçoive : le pourcentage doit avoir RÉELLEMENT bougé.
      expect(after.slot).not.toBe(before.slot);
    } finally {
      cleanup();
    }
  });

  it("⇧1 (Ajuster) RÉINITIALISE le scale RÉELLEMENT PEINT à sa valeur d'avant tout zoom manuel", async () => {
    const { container, cleanup } = await mountAttached();
    try {
      const original = paintedScaleOf(container);

      const zoomIn = container.querySelector('[data-testid="zoom-in"]') as HTMLButtonElement;
      await click(zoomIn);
      await click(zoomIn);
      expect(paintedScaleOf(container)).not.toBe(original);

      await pressKey({ key: "1", shiftKey: true }); // ⇧1 = zoomFit (lib/studio/keymap.ts)

      expect(paintedScaleOf(container)).toBe(original);
    } finally {
      cleanup();
    }
  });
});
