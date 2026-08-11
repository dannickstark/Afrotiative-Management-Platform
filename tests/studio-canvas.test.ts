import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Scene } from "@/lib/studio/scene";
import { Canvas } from "@/components/studio/canvas";
import { CanvasChrome, safeAreaDefaultFor } from "@/components/studio/canvas-chrome";
import { DEFAULT_PREFS, type EditorPrefs } from "@/lib/studio/editor-prefs";
import { FORMAT_KEYS, type FormatKey } from "@/lib/studio/formats";

// Pas de DOM dans `bun test` (voir tests/use-persisted-filters.test.ts) : on rend le composant en
// chaîne HTML via react-dom/server, ce qui ne nécessite ni `document` ni `window`, et on inspecte
// la sortie. Suffisant pour tout ce que ce fichier vérifie : structure, ordre, et attributs style
// sérialisés — react-dom sérialise bel et bien `style={{...}}` en `style="prop:val;..."` côté
// serveur, y compris pour des propriétés « unitless » comme lineClamp (vérifié empiriquement).

function render(scene: Scene, selectedIds: string[] = []) {
  const noop = () => {};
  return renderToStaticMarkup(
    React.createElement(Canvas, { scene, selectedIds, dispatch: noop, scale: 1 }),
  );
}

// Isole le HTML d'UN calque (de son `data-layer-id="…"` jusqu'au prochain, ou la fin) — un slice à
// largeur fixe déborderait sur le nœud suivant pour un calque au balisage court.
function layerNode(html: string, id: string): string {
  const start = html.indexOf(`data-layer-id="${id}"`);
  if (start === -1) throw new Error(`calque « ${id} » absent du HTML rendu`);
  const openStart = html.lastIndexOf("<div", start);
  const next = html.indexOf("data-layer-id=", start + 1);
  const end = next === -1 ? html.length : html.lastIndexOf("<div", next);
  return html.slice(openStart, end);
}

function makeScene(): Scene {
  return {
    schemaVersion: 1,
    canvas: { width: 800, height: 600, background: "#000000" },
    layers: [
      {
        id: "bg", name: "Fond", visible: true, locked: false,
        frame: { x: 0, y: 0, w: 800, h: 600 },
        type: "shape", shape: "rect", fill: "#111111",
      },
      {
        id: "title", name: "Titre", visible: true, locked: false,
        frame: { x: 40, y: 40, w: 400, h: 120 },
        type: "text", content: "Un long titre d'article",
        font: { family: "Noto Sans", size: 48, weight: 700 },
        color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
        maxLines: 3, letterSpacing: 2,
      },
      {
        id: "hidden", name: "Masqué", visible: false, locked: false,
        frame: { x: 10, y: 10, w: 50, h: 50 },
        type: "shape", shape: "rect", fill: "#FF00FF",
      },
      {
        id: "qr1", name: "QR", visible: true, locked: false,
        frame: { x: 600, y: 400, w: 120, h: 120 },
        type: "qr", slot: "article.url", fg: "#000000", bg: "#FFFFFF", margin: 4,
      },
    ],
  };
}

describe("Canvas — rendu de la scène", () => {
  it("rend un nœud par calque VISIBLE, dans l'ordre de peinture ; un calque invisible ne rend rien", () => {
    const html = render(makeScene());

    // Les trois calques visibles sont présents…
    for (const id of ["bg", "title", "qr1"]) {
      expect(html).toContain(`data-layer-id="${id}"`);
    }
    // …le calque invisible n'a laissé AUCUNE trace (ni son id, ni son fill distinctif).
    expect(html).not.toContain(`data-layer-id="hidden"`);
    expect(html).not.toContain("#FF00FF");

    // Ordre de peinture = ordre de scene.layers (bg d'abord, qr1 en dernier).
    const iBg = html.indexOf('data-layer-id="bg"');
    const iTitle = html.indexOf('data-layer-id="title"');
    const iQr = html.indexOf('data-layer-id="qr1"');
    expect(iBg).toBeGreaterThan(-1);
    expect(iTitle).toBeGreaterThan(iBg);
    expect(iQr).toBeGreaterThan(iTitle);
  });

  it("un calque masqué ne produit aucun nœud même seul dans la scène", () => {
    const scene = makeScene();
    scene.layers = [scene.layers[2]]; // uniquement le calque "hidden"
    const html = render(scene);
    expect(html).not.toContain("data-layer-id");
  });

  it("la scène vide rend un canevas sans aucun calque", () => {
    const scene = makeScene();
    scene.layers = [];
    const html = render(scene);
    expect(html).not.toContain("data-layer-id");
  });
});

describe("Canvas — style de texte via textStyleFor", () => {
  it("le style du calque texte vient de textStyleFor (lineClamp dérivé de maxLines)", () => {
    const html = render(makeScene());
    // `maxLines: 3` sur le calque "title" ; SEULE textStyleFor produit `lineClamp` (voir
    // lib/studio/element.ts). Si le composant redérivait son propre style au lieu d'appeler
    // textStyleFor, rien dans son code ne produirait cette chaîne précise.
    expect(html).toContain("line-clamp:3");
    // `letterSpacing: 2` — également une propriété propre à textStyleFor, avec unité px cette fois
    // (contrairement à lineClamp) : re-vérifie qu'on ne l'a pas oubliée, exactement le bug V1 que
    // l'extraction de textStyleFor a corrigé (voir le commentaire en tête de element.ts).
    expect(html).toContain("letter-spacing:2px");
  });

  it("un calque texte sans maxLines/letterSpacing ne produit ni lineClamp ni letterSpacing", () => {
    const scene = makeScene();
    scene.layers = [scene.layers[1]];
    (scene.layers[0] as { maxLines?: number }).maxLines = undefined;
    (scene.layers[0] as { letterSpacing?: number }).letterSpacing = undefined;
    const html = render(scene);
    expect(html).not.toContain("line-clamp");
    expect(html).not.toContain("letter-spacing");
  });
});

describe("Canvas — sélection et verrouillage", () => {
  it("marque le calque sélectionné et lui seul", () => {
    const html = render(makeScene(), ["title"]);
    expect(layerNode(html, "title")).toContain('data-selected="true"');
    expect(layerNode(html, "bg")).not.toContain('data-selected="true"');
  });

  // ── Tâche 3 (U2, spec §3) — sélection MULTIPLE ────────────────────────────
  it("marque TOUS les calques d'une sélection multiple, et eux seuls", () => {
    const html = render(makeScene(), ["bg", "title"]);
    expect(layerNode(html, "bg")).toContain('data-selected="true"');
    expect(layerNode(html, "title")).toContain('data-selected="true"');
    // `qr1` est le troisième calque VISIBLE de makeScene() et n'est PAS sélectionné : sans lui, un
    // composant qui marquerait TOUT passerait les deux lignes ci-dessus.
    expect(layerNode(html, "qr1")).not.toContain('data-selected="true"');
  });

  it("les poignées n'apparaissent QUE pour une sélection simple — jamais pour une sélection multiple", () => {
    // Poignées + rotation manipulent UN cadre : les afficher sur une sélection multiple laisserait
    // croire qu'elles agissent sur l'ensemble. Ce qui rendrait ce test ROUGE : dériver le calque à
    // outiller de `selectedIds[0]` au lieu de `singleSelectedId(selectedIds)`.
    expect(render(makeScene(), ["title"])).toContain('data-testid="handles-overlay"');
    expect(render(makeScene(), ["bg", "title"])).not.toContain('data-testid="handles-overlay"');
    expect(render(makeScene(), [])).not.toContain('data-testid="handles-overlay"');
  });

  it("le contour de sélection, lui, reste bien présent sur chaque calque d'une sélection multiple", () => {
    // Corollaire du test précédent : « pas de poignées » ne doit PAS vouloir dire « sélection
    // invisible » — les deux calques gardent leur contour bleu.
    const html = render(makeScene(), ["bg", "title"]);
    expect(layerNode(html, "bg")).toContain("outline:2px solid #2563eb");
    expect(layerNode(html, "title")).toContain("outline:2px solid #2563eb");
  });

  it("un calque verrouillé est marqué visuellement ET non-interactif (pointer-events: none)", () => {
    const scene = makeScene();
    scene.layers[0] = { ...scene.layers[0], locked: true } as typeof scene.layers[0];
    const html = render(scene);
    const bgNode = layerNode(html, "bg");
    expect(bgNode).toContain('data-locked="true"');
    expect(bgNode).toContain("pointer-events:none");
  });

  it("un calque non verrouillé ne porte pas pointer-events:none", () => {
    const html = render(makeScene());
    const bgNode = layerNode(html, "bg");
    expect(bgNode).not.toContain('data-locked="true"');
    expect(bgNode).not.toContain("pointer-events:none");
  });
});

describe("Canvas — image, forme, QR", () => {
  it("une image {{slot}} non résolue affiche un espace réservé explicite, jamais une balise <img> cassée", () => {
    const scene = makeScene();
    scene.layers.push({
      id: "img1", name: "Image", visible: true, locked: false,
      frame: { x: 0, y: 0, w: 100, h: 100 },
      type: "image", source: { kind: "slot", slot: "article.image" }, fit: "cover",
    });
    const html = render(scene);
    expect(html).not.toContain("<img");
    expect(html).toContain("article.image");
  });

  it("une image avec une URL littérale s'affiche directement", () => {
    const scene = makeScene();
    scene.layers.push({
      id: "img2", name: "Image", visible: true, locked: false,
      frame: { x: 0, y: 0, w: 100, h: 100 },
      type: "image", source: { kind: "url", url: "https://example.com/x.png" }, fit: "cover",
    });
    const html = render(scene);
    expect(html).toContain('src="https://example.com/x.png"');
  });

  it("une forme peint sa couleur de remplissage", () => {
    const html = render(makeScene());
    expect(html).toContain("#111111");
  });

  it("un calque QR se rend de façon représentative (pas de <img> sans image fournie)", () => {
    const html = render(makeScene());
    expect(layerNode(html, "qr1")).not.toContain("<img");
  });
});

// Isole la valeur de l'attribut `style="…"` de la balise dont `marker` (ex. `data-handle="e"`) est un
// attribut — même stratégie de recherche que layerNode() ci-dessus, mais pour un seul attribut plutôt
// que tout le sous-arbre : `marker` précède directement `style=` dans le JSX source (data-handle puis
// style, dans cet ordre de déclaration), donc le PROCHAIN `style="` après `marker` appartient
// forcément à la MÊME balise.
function styleAttr(html: string, marker: string): string {
  const idx = html.indexOf(marker);
  if (idx === -1) throw new Error(`marqueur introuvable dans le HTML rendu : ${marker}`);
  const styleIdx = html.indexOf('style="', idx);
  const end = html.indexOf('"', styleIdx + 7);
  return html.slice(styleIdx + 7, end);
}

describe("Canvas — poignées et contour de sélection gardent une taille ÉCRAN constante quelle que soit l'échelle (Important 3, revue Lot 2)", () => {
  function renderSelected(scale: number) {
    const scene = makeScene();
    return renderToStaticMarkup(
      React.createElement(Canvas, { scene, selectedIds: ["title"], dispatch: () => {}, scale }),
    );
  }

  it("à l'échelle 1 (référence), poignées et contour gardent leur taille nominale", () => {
    const html = renderSelected(1);
    const eHandle = styleAttr(html, 'data-handle="e"');
    expect(eHandle).toContain("width:8px");
    expect(eHandle).toContain("height:8px");
    expect(eHandle).toContain("margin-left:-4px");
    expect(eHandle).toContain("margin-top:-4px");
    expect(styleAttr(html, 'data-handle="rotate"')).toContain("top:-24px");
    expect(styleAttr(html, 'data-layer-id="title"')).toContain("outline:2px solid #2563eb");
  });

  // La régression Lot 2 : ces longueurs sont en pixels GABARIT à l'intérieur du conteneur
  // `transform: scale(k)` de Canvas — non compensées, elles restaient FIGÉES quelle que soit `scale`
  // et rendaient donc à `Nk` px ÉCRAN (poignée de 2,5px pour `story`, k≈0,31). Ce test choisit
  // scale = 0,5 (une division exacte, sans piège de virgule flottante) : le correctif doit DOUBLER
  // chaque longueur en pixels gabarit pour compenser exactement — un code qui aurait gardé les
  // valeurs figées (8, -4, -24, 2, 1) échouerait ici.
  it("à l'échelle 0,5, chaque longueur DOUBLE en pixels gabarit pour compenser — poignées et contour restent visibles/saisissables à l'écran", () => {
    const html = renderSelected(0.5);

    const eHandle = styleAttr(html, 'data-handle="e"');
    expect(eHandle).toContain("width:16px"); // 8 / 0.5
    expect(eHandle).toContain("height:16px"); // 8 / 0.5
    expect(eHandle).toContain("margin-left:-8px"); // -4 / 0.5
    expect(eHandle).toContain("margin-top:-8px"); // -4 / 0.5

    const rotateHandle = styleAttr(html, 'data-handle="rotate"');
    // -24 / 0.5 : sans cette compensation, la poignée de rotation d'un calque proche du haut du
    // canevas passe entièrement sous `overflow: hidden` du conteneur racine — impossible à saisir.
    expect(rotateHandle).toContain("top:-48px");
    expect(rotateHandle).toContain("width:16px");
    expect(rotateHandle).toContain("margin-left:-8px");

    const titleLayer = styleAttr(html, 'data-layer-id="title"');
    expect(titleLayer).toContain("outline:4px solid #2563eb"); // 2 / 0.5
    expect(titleLayer).toContain("outline-offset:2px"); // 1 / 0.5
  });
});

describe("Canvas — l'artboard reste visuellement distinct de son entourage même sans fond opaque (Tâche 7, spec §7)", () => {
  // Avant cette tâche, un calque de fond `scene.canvas.background === "transparent"` ne posait AUCUN
  // fond ni sur le conteneur intérieur (déjà le cas) NI sur le conteneur EXTÉRIEUR
  // (`data-testid="studio-canvas"`) : la page (fond `bg-muted/20` posé par editor-shell.tsx) se
  // voyait alors directement à travers tout le canevas, rendant ses limites indiscernables de son
  // entourage — l'exact défaut que spec §7 demande de corriger (« l'artboard visuellement distinct de
  // son entourage »). Ce test verrouille un habillage TOUJOURS présent sur ce conteneur, qu'importe le
  // fond de la scène.
  it('le conteneur "studio-canvas" porte un box-shadow qui le distingue de son entourage', () => {
    const html = render(makeScene());
    expect(styleAttr(html, 'data-testid="studio-canvas"')).toContain("box-shadow");
  });

  it("reste vrai même pour un fond de scène transparent, où rien d'autre ne distinguerait le canevas", () => {
    const scene = makeScene();
    scene.canvas = { ...scene.canvas, background: "transparent" };
    const html = render(scene);
    expect(styleAttr(html, 'data-testid="studio-canvas"')).toContain("box-shadow");
  });
});

// Extrait la balise OUVRANTE (attributs seuls, jamais les descendants) du nœud dont `marker` est un
// attribut — même stratégie de repérage que styleAttr()/layerNode() plus haut, mais bornée à `>` au
// lieu de chercher un second `data-testid=`, pour ne capturer QUE les attributs de CETTE balise (pas
// son sous-arbre). Nécessaire ici car `overflow-hidden` (Tailwind) vit dans `class="…"`, jamais dans
// `style="…"` — styleAttr() ne l'aurait donc JAMAIS trouvé, quel que soit le vrai contenu de la
// classe : une assertion basée sur styleAttr() pour "overflow-hidden" serait passée pour de mauvaises
// raisons (trivialement, faute de jamais regarder le bon attribut), pas parce que le rognage était
// absent.
function openTag(html: string, marker: string): string {
  const idx = html.indexOf(marker);
  if (idx === -1) throw new Error(`marqueur introuvable dans le HTML rendu : ${marker}`);
  const start = html.lastIndexOf("<", idx);
  const end = html.indexOf(">", idx);
  if (start === -1 || end === -1) throw new Error(`balise ouvrante introuvable pour : ${marker}`);
  return html.slice(start, end + 1);
}

// Composition RÉELLE, comme editor-shell.tsx (revue Tâche 7, puis revue finale pour la grille) :
// `<CanvasChrome format={template.format} zoom={scale}>…<Canvas … scale={scale} /></CanvasChrome>`,
// MÊME valeur pour `zoom` et `scale`. Hissée au niveau du module (elle vivait seulement dans le
// describe du box-shadow ci-dessous) pour que le describe de la grille, plus bas, la réutilise TELLE
// QUELLE plutôt que d'en écrire une seconde copie qui pourrait diverger — exactement la composition
// réelle que editor-shell.tsx utilise, jamais un espace réservé `<div data-testid="canvas-slot">`
// (voir le describe "pastilles flottantes" plus haut, qui EN a un, volontairement limité aux chips/
// règles/zones sûres qui ne composent rien avec le VRAI Canvas). `zoom === scale` et un format dont
// les dimensions égalent celles de `scene.canvas` (`ig_square`, 1080×1080 — `makeScene()` fait
// 800×600 par défaut, donc on l'écrase ici) : le format n'a pas besoin de correspondre pixel pour
// pixel à la scène pour que les bogues visés existent, puisque c'est la boîte de CanvasChrome
// (`preset.width*zoom`) et la boîte de Canvas (`scene.canvas.width*scale`) qui doivent coïncider —
// ici les deux valent 1080*1 = 1080 côté CanvasChrome.
function renderComposed(prefs: EditorPrefs = DEFAULT_PREFS) {
  const scene = makeScene();
  scene.canvas = { ...scene.canvas, width: 1080, height: 1080 };
  return renderToStaticMarkup(
    React.createElement(
      CanvasChrome,
      { format: "ig_square", zoom: 1, prefs },
      React.createElement(Canvas, { scene, selectedIds: [], dispatch: () => {}, scale: 1 }),
    ),
  );
}

describe("CanvasChrome ∘ Canvas — composition RÉELLE, comme editor-shell.tsx (revue Tâche 7) : le box-shadow de l'artboard ne doit pas être rogné par son propre enrobage", () => {
  it('l\'enrobage "artboard" (canvas-chrome.tsx) ne porte PAS sa propre classe overflow-hidden — un overflow:hidden ICI rognerait le box-shadow de "studio-canvas" qu\'il enrobe, pixel-identique à cette taille (zoom === scale, mêmes dimensions)', () => {
    const html = renderComposed();
    expect(openTag(html, 'data-testid="artboard"')).not.toMatch(/\boverflow-hidden\b/);
  });

  it("le box-shadow reste bien présent dans cette composition réelle (sanity — ne garantit PAS seul qu'il n'est pas rogné, voir le test précédent)", () => {
    const html = renderComposed();
    expect(styleAttr(html, 'data-testid="studio-canvas"')).toContain("box-shadow");
  });

  // CRITIQUE (revue finale) : la grille peint sous un artboard OPAQUE. `data-testid="grid"` et la
  // racine de <Canvas> (`data-testid="studio-canvas"`) sont tous deux `z-index: auto` — ils peignent
  // donc dans l'ordre de l'arbre, <Canvas> EN DERNIER (il vient après la grille dans le JSX de
  // canvas-chrome.tsx), donc AU-DESSUS. Le conteneur intérieur de <Canvas> couvre exactement la boîte
  // de l'artboard et peint `scene.canvas.background` (jamais transparent pour un gabarit "normal" —
  // les nouveaux gabarits partent de `#0B0B0B`, lib/studio/template-core.ts) : la grille est donc
  // invisible sur un gabarit ordinaire, alors que le bouton "Grille" bascule `aria-pressed` et
  // "réussit" sans le moindre effet visuel. Le test des chips/règles ci-dessus (describe précédent)
  // rend un `<div data-testid="canvas-slot">` VIDE à la place de <Canvas> — un calque totalement
  // transparent — donc il ne PEUT PAS détecter ce recouvrement : la même substitution que le bogue de
  // box-shadow déjà corrigé plus haut dans ce fichier (describe "composition RÉELLE" ci-dessus).
  // Preuve directe et suffisante en HTML sérialisé : l'ORDRE DE PEINTURE == l'ordre du DOM pour deux
  // éléments `position` par défaut/`z-index: auto` qui se chevauchent — un nœud "grid" qui apparaît
  // AVANT "studio-canvas" dans le HTML peint donc AVANT lui, et se fait recouvrir.
  //
  // Correctif revue finale (Minor, second passage) — Close 2 : l'assertion d'ordre ci-dessous verrouille
  // bien le RÉORDONNANCEMENT (le correctif de ce fichier), mais PAS sa PRÉCONDITION — un futur
  // `z-index` (même `0`) posé sur la racine de <Canvas> promouvrait cet élément dans SON PROPRE
  // contexte d'empilement et le ferait à nouveau peindre au-dessus de la grille, quel que soit
  // l'ordre du DOM, alors que ce test resterait VERT (l'ordre du DOM, seul, n'a pas changé). La
  // seconde assertion pin cette précondition directement : la balise ouvrante de "studio-canvas" ne
  // porte NI `z-index` en style inline (c'est ainsi que canvas.tsx pose ses styles, jamais via une
  // classe) NI aucune classe Tailwind `z-*`, pour rester robuste même si ce choix changeait. Pas de
  // DOM/navigateur nécessaire : une inspection directe de la balise sérialisée suffit — z-index/
  // z-* sont des propriétés STATIQUEMENT visibles dans le HTML, jamais dérivées d'un calcul de
  // layout qu'un rendu serveur ne pourrait pas reproduire.
  it("CRITIQUE : la grille peint APRÈS le vrai Canvas (ordre de peinture), jamais en dessous d'un artboard opaque", () => {
    const html = renderComposed({ ...DEFAULT_PREFS, grid: true });
    expect(html).toContain('data-testid="grid"');
    expect(html).toContain('data-testid="studio-canvas"');
    expect(html.indexOf('data-testid="grid"')).toBeGreaterThan(html.indexOf('data-testid="studio-canvas"'));

    // La PRÉCONDITION dont dépend l'ordre de peinture ci-dessus : sans stacking context propre sur
    // la racine de Canvas, l'ordre du DOM EST l'ordre de peinture. Un `z-index` (même faible) sur cet
    // élément romprait cette garantie tout en laissant l'assertion d'ordre ci-dessus verte.
    const canvasTag = openTag(html, 'data-testid="studio-canvas"');
    expect(canvasTag).not.toMatch(/z-index/);
    const classAttr = /\sclass="([^"]*)"/.exec(canvasTag);
    const classes = classAttr ? classAttr[1].split(/\s+/) : [];
    expect(classes.some((c) => /^z-/.test(c))).toBe(false);
  });
});

describe("CanvasChrome — pastilles flottantes, règles et grille optionnelles (Tâche 7, spec §7)", () => {
  // renderCanvasChrome — scaffolding de test LOCAL (comme `render()` plus haut dans ce fichier) :
  // `format`/`zoom` ont des valeurs par défaut ici pour que les tests qui ne les font pas varier
  // (ex. la présence des règles) restent courts, exactement comme `render(scene, selectedIds)` plus
  // haut par défaut `selectedIds` à `[]`.
  function renderCanvasChrome(opts: { format?: FormatKey; zoom?: number; prefs: EditorPrefs }) {
    return renderToStaticMarkup(
      React.createElement(
        CanvasChrome,
        { format: opts.format ?? "ig_square", zoom: opts.zoom ?? 1, prefs: opts.prefs },
        React.createElement("div", { "data-testid": "canvas-slot" }),
      ),
    );
  }

  it("chips state the format name, its pixel size, and the zoom", () => {
    const html = renderCanvasChrome({ format: "ig_portrait", zoom: 0.72, prefs: DEFAULT_PREFS });
    expect(html).toContain("1080");
    expect(html).toContain("1350");
    expect(html).toMatch(/72\s?%/);
  });

  it("rulers and grid are OFF by default and render when enabled", () => {
    expect(renderCanvasChrome({ prefs: DEFAULT_PREFS })).not.toContain('data-testid="rulers"');
    expect(renderCanvasChrome({ prefs: { ...DEFAULT_PREFS, rulers: true } })).toContain('data-testid="rulers"');
  });

  // Défaut du brief corrigé (voir le rapport de la Tâche 7) : le plan ne testait QUE les règles, pas
  // la grille — alors que spec §7 les traite comme une paire symétrique (« rulers and grid rendered,
  // available but off by default »). Un correctif qui n'implémenterait que les règles serait passé à
  // travers les mailles du test du brief ; celui-ci comble le trou côté "rendu ou non", mais UTILISE
  // le placeholder `<div data-testid="canvas-slot">` plutôt qu'un vrai `<Canvas>` — voir le describe
  // "peinture réelle" plus bas (revue finale) pour la raison pour laquelle ce n'était pas suffisant.
  it("la grille suit la MÊME règle « off par défaut, rendue quand activée » que les règles", () => {
    expect(renderCanvasChrome({ prefs: DEFAULT_PREFS })).not.toContain('data-testid="grid"');
    expect(renderCanvasChrome({ prefs: { ...DEFAULT_PREFS, grid: true } })).toContain('data-testid="grid"');
  });

  it("le contenu passé en enfant (le vrai Canvas, en composition réelle) est bien rendu à l'intérieur", () => {
    expect(renderCanvasChrome({ prefs: DEFAULT_PREFS })).toContain('data-testid="canvas-slot"');
  });

  it('expose un bouton data-action="toggle-safe-areas" qui reflète prefs.safeAreas — le TOGGLE est de U1, les bandes elles-mêmes sont de U2 (spec §7)', () => {
    const on = renderCanvasChrome({ prefs: { ...DEFAULT_PREFS, safeAreas: true } });
    const off = renderCanvasChrome({ prefs: { ...DEFAULT_PREFS, safeAreas: false } });
    expect(on).toContain('data-action="toggle-safe-areas"');
    expect(off).toContain('data-action="toggle-safe-areas"');
    // Témoin de sabotage (leçon de la Tâche 1 : une classe utilitaire dans `className` peut faire un
    // faux positif en recherche de sous-chaîne naïve) — on isole le fragment du bouton précis plutôt
    // que de chercher "aria-pressed" dans tout le HTML, qui pourrait apparaître ailleurs.
    function buttonFragment(html: string): string {
      const re = /<button[^>]*data-action="toggle-safe-areas"[^>]*>/;
      const m = re.exec(html);
      if (!m) throw new Error('bouton data-action="toggle-safe-areas" introuvable');
      return m[0];
    }
    expect(buttonFragment(on)).toContain('aria-pressed="true"');
    expect(buttonFragment(off)).toContain('aria-pressed="false"');
  });
});

describe("safeAreaDefaultFor — dérivé de l'orientation du format, jamais une paire codée en dur (Tâche 7, spec §7)", () => {
  // Défaut du brief corrigé (voir le rapport de la Tâche 7) : le plan ne donnait que QUATRE des huit
  // formats (story/ig_portrait à true, fb_link/li_link à false) — juste assez pour qu'une paire
  // codée en dur (`format === "story" || format === "ig_portrait"`) passe sans être dérivée de rien
  // de réel. Ce test couvre les HUIT, y compris les deux formats carrés (ig_square/wa_square) que le
  // brief ne mentionnait pas du tout : un futur format ajouté à FORMAT_PRESETS sans entrée explicite
  // ici ferait échouer `FORMAT_KEYS.length` ci-dessous plutôt que de silencieusement hériter d'un
  // défaut faux.
  it("ON pour les formats PORTRAIT (plus hauts que larges — plein écran mobile, chrome d'appli en haut/bas), OFF pour tout le reste", () => {
    const expected: Record<FormatKey, boolean> = {
      website_featured: false, // 1200×675 — paysage, image à la une du site
      fb_link: false, // 1200×630 — paysage, aperçu de lien
      ig_square: false, // 1080×1080 — carré, publication de flux
      ig_portrait: true, // 1080×1350 — portrait
      story: true, // 1080×1920 — portrait plein écran
      x_landscape: false, // 1600×900 — paysage
      wa_square: false, // 1080×1080 — carré
      li_link: false, // 1200×627 — paysage, aperçu de lien
    };
    expect(FORMAT_KEYS.length).toBe(8);
    expect(Object.keys(expected).length).toBe(8);
    for (const key of FORMAT_KEYS) {
      expect(safeAreaDefaultFor(key)).toBe(expected[key]);
    }
  });
});
