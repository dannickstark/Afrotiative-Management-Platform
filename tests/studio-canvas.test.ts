import { afterAll, beforeAll, describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Scene } from "@/lib/studio/scene";
import { Canvas } from "@/components/studio/canvas";
import { CanvasChrome, safeAreaDefaultFor } from "@/components/studio/canvas-chrome";
import { DEFAULT_PREFS, type EditorPrefs } from "@/lib/studio/editor-prefs";
import { FORMAT_KEYS, FORMAT_PRESETS, type FormatKey } from "@/lib/studio/formats";
import { safeAreaBandsFor, type SafeAreaBand } from "@/lib/studio/safe-areas";
// PAS "@/components/studio/token-picker" (correctif revue, U4 Tâche 6) : ce module ré-exporte bien
// TOKEN_LABELS, mais importe aussi Popover/PopoverContent/PopoverTrigger (base-ui) pour le
// sélecteur lui-même — importer DEPUIS lui, MÊME dans un fichier de test, charge tout l'arbre
// Popover statiquement. `studio-canvas.test.ts` trie ALPHABÉTIQUEMENT avant
// `studio-interactions.test.ts` : sous `bun test` sans `--isolate`, ce seul import gelait
// `useIsoLayoutEffect` avant que studio-interactions.test.ts n'ait la moindre chance d'installer son
// propre DOM, et faisait sauter SILENCIEUSEMENT 3 de ses tests comportementaux les plus forts
// (TokenPicker illégal inerte, SelectField illégal non sélectionnable, le seam Images onPick). La
// table est PURE — voir lib/studio/token-labels.ts — donc rien ici n'a besoin de token-picker.tsx.
import { TOKEN_LABELS } from "@/lib/studio/token-labels";
import { installDom, mount } from "./dom-harness";

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

// Sous-arbre COMPLET de la <div> dont `marker` est un attribut, borné par SA balise fermante — pas un
// simple `slice` jusqu'à la fin du document (Tâche 6). Nécessaire parce que « les bandes peignent après
// le Canvas » (une comparaison d'INDEX) resterait vrai même si les bandes étaient rendues à côté de
// l'artboard plutôt que DEDANS : elles se dimensionneraient alors (`inset-0`) sur le cadre qui réserve
// la place des RÈGLES, décalé de RULER_SIZE, et ne recouvriraient plus la surface du canevas. Compte la
// profondeur sur `<div`/`</div>` uniquement — fiable ici, puisque tous les conteneurs de cet arbre sont
// des `div` et que les éléments vides (`<img>`) n'ont pas de fermante à compter.
function subtreeOf(html: string, marker: string): string {
  const idx = html.indexOf(marker);
  if (idx === -1) throw new Error(`marqueur introuvable dans le HTML rendu : ${marker}`);
  const start = html.lastIndexOf("<div", idx);
  if (start === -1) throw new Error(`le nœud portant ${marker} n'est pas une <div>`);
  let depth = 0;
  let i = start;
  while (i < html.length) {
    const open = html.indexOf("<div", i);
    const close = html.indexOf("</div>", i);
    if (close === -1) throw new Error(`sous-arbre non refermé pour : ${marker}`);
    if (open !== -1 && open < close) {
      depth += 1;
      i = open + 4;
      continue;
    }
    depth -= 1;
    i = close + 6;
    if (depth === 0) return html.slice(start, i);
  }
  throw new Error(`sous-arbre non refermé pour : ${marker}`);
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
//
// Tâche 6 (U2) : `format` et `zoom` sont devenus des PARAMÈTRES (défauts `ig_square` / 1 — donc les
// trois appels existants ci-dessous rendent EXACTEMENT le même HTML qu'avant : ig_square fait
// 1080×1080, la taille de scène auparavant écrite en dur ici). Les bandes de zones sûres ne
// concernent qu'un format PORTRAIT (`story`), et leur épaisseur est une fraction des dimensions du
// FORMAT multipliée par le zoom : il faut donc pouvoir faire varier les deux, sur la MÊME composition
// réelle (vrai <Canvas> enrobé), jamais sur un espace réservé transparent.
function renderComposed(
  prefs: EditorPrefs = DEFAULT_PREFS,
  format: FormatKey = "ig_square",
  zoom = 1,
) {
  const preset = FORMAT_PRESETS[format];
  const scene = makeScene();
  scene.canvas = { ...scene.canvas, width: preset.width, height: preset.height };
  return renderToStaticMarkup(
    React.createElement(
      CanvasChrome,
      { format, zoom, prefs },
      React.createElement(Canvas, { scene, selectedIds: [], dispatch: () => {}, scale: zoom }),
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

  // Tâche 6 (U4, spec §5) : « voir les liaisons » suit le MÊME idiome que règles/grille/zones sûres
  // juste au-dessus — un bouton data-action dont `aria-pressed` reflète `prefs.showBindings`, dans le
  // même groupe de bascules de chrome.
  it('expose un bouton data-action="toggle-bindings" qui reflète prefs.showBindings (Tâche 6, U4, spec §5)', () => {
    const on = renderCanvasChrome({ prefs: { ...DEFAULT_PREFS, showBindings: true } });
    const off = renderCanvasChrome({ prefs: { ...DEFAULT_PREFS, showBindings: false } });
    expect(on).toContain('data-action="toggle-bindings"');
    expect(off).toContain('data-action="toggle-bindings"');
    function buttonFragment(html: string): string {
      const re = /<button[^>]*data-action="toggle-bindings"[^>]*>/;
      const m = re.exec(html);
      if (!m) throw new Error('bouton data-action="toggle-bindings" introuvable');
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

// ─────────────────────────────────────────────────────────────────────────────
// Tâche 6 (U2, spec §7) — LES BANDES de zones sûres. Le TOGGLE et son défaut par format étaient de
// U1 (voir les deux describe ci-dessus) ; ce qui suit vérifie la TABLE de faits plateforme et son
// rendu RÉEL au-dessus de l'artboard.
describe("safeAreaBandsFor — table de faits plateforme, vérifiable entrée par entrée (Tâche 6, U2)", () => {
  // Les chiffres attendus ici sont recopiés depuis la source citée dans lib/studio/safe-areas.ts
  // (guide des publicités Meta, gabarit « story » image) et NON depuis la table du module : c'est
  // délibéré pour CE test-ci, dont le rôle est justement de figer les valeurs publiées — un
  // changement de la table sans changement de source échoue ici, ce qui est exactement le signal
  // voulu. Les tests de complétude plus bas, eux, lisent la VRAIE source (FORMAT_KEYS), jamais un
  // miroir recopié (leçon de la Tâche 4).
  it("`story` porte les QUATRE bandes publiées par Meta : 14 % en haut, 35 % en bas, 6 % de chaque côté", () => {
    const bands = safeAreaBandsFor("story");
    const byEdge = new Map(bands.map((b) => [b.edge, b] as const));
    expect(bands.length).toBe(4);
    expect(byEdge.get("top")?.fraction).toBe(0.14);
    expect(byEdge.get("bottom")?.fraction).toBe(0.35);
    expect(byEdge.get("left")?.fraction).toBe(0.06);
    expect(byEdge.get("right")?.fraction).toBe(0.06);
  });

  it("chaque bande porte une étiquette FRANÇAISE courte et non vide, et aucune apostrophe droite (elle serait échappée en &#x27; dans le HTML rendu)", () => {
    const labels = safeAreaBandsFor("story").map((b) => b.label);
    // Pin EXACT plutôt qu'un simple `length > 0` : « une étiquette non vide » est satisfait par la
    // chaîne "x", ce qui ne prouverait rien de l'exigence « étiquette française courte ».
    // « (pub) » sur la bande du bas : revue de la Tâche 6, point 2 — le 35 % est la borne
    // PUBLICITAIRE (elle réserve le bouton d'appel à l'action, absent d'une story organique, soit une
    // sur-réservation d'un facteur ≈2,7 mesuré par la revue). L'utilisateur voyait une bande « Bas —
    // action » sans rien qui indique laquelle des deux bornes il regarde ; le détail complet vit dans
    // l'infobulle du bouton (test dédié plus bas), le marqueur court vit ici.
    expect(labels.sort()).toEqual(["Bas — action (pub)", "Droite", "Gauche", "Haut — profil"]);
    for (const l of labels) {
      expect(l.length).toBeLessThanOrEqual(24);
      expect(l).not.toContain("'");
    }
  });

  it("les deux bandes horizontales laissent une zone utile : haut + bas < 1 pour CHAQUE format outillé", () => {
    // Ce qui ferait échouer ce test : une entrée dont les fractions haut+bas atteignent ou dépassent
    // 1, c.-à-d. une table qui recouvrirait tout le gabarit et ne laisserait aucune surface
    // exploitable. Vaut pour les formats OUTILLÉS uniquement — un format sans bandes n'a rien à
    // prouver ici (il est couvert par le test de complétude juste en dessous).
    let checked = 0;
    for (const key of FORMAT_KEYS) {
      const bands = safeAreaBandsFor(key);
      if (bands.length === 0) continue;
      checked += 1;
      const sum = bands
        .filter((b) => b.edge === "top" || b.edge === "bottom")
        .reduce((acc, b) => acc + b.fraction, 0);
      expect(sum).toBeGreaterThan(0);
      expect(sum).toBeLessThan(1);
    }
    // Garde anti-vacuité : sans au moins un format outillé, la boucle ci-dessus n'assertait RIEN.
    expect(checked).toBeGreaterThan(0);
  });

  it("EXACTEMENT les formats pour lesquels une source publiée existe portent des bandes ; les autres n'en portent AUCUNE", () => {
    // Lit la VRAIE source des formats (FORMAT_KEYS, lib/studio/formats.ts) et non une liste recopiée :
    // un neuvième format ajouté à FORMAT_PRESETS fait échouer `FORMAT_KEYS.length` ci-dessous plutôt
    // que d'hériter silencieusement de « pas de bandes ». `story` est le SEUL format outillé — voir
    // le commentaire de lib/studio/safe-areas.ts et le rapport de la Tâche 6 : aucune source publiée
    // n'a pu être établie pour `ig_portrait` (le guide Meta pour le fil Instagram 4:5 ne publie AUCUNE
    // zone de sécurité), et le brief le demandait explicitement — défaut de brief signalé plutôt que
    // comblé par un chiffre inventé.
    expect(FORMAT_KEYS.length).toBe(8);
    const withBands = FORMAT_KEYS.filter((k) => safeAreaBandsFor(k).length > 0);
    expect(withBands).toEqual(["story"]);
    for (const key of FORMAT_KEYS) {
      if (key === "story") continue;
      expect(safeAreaBandsFor(key)).toEqual([]);
    }
  });

  it("ne rend jamais la table interne mutable : muter le résultat n'altère pas l'appel suivant", () => {
    const first = safeAreaBandsFor("story") as SafeAreaBand[];
    const before = first.length;
    first.push({ edge: "top", fraction: 0.99, label: "sabotage" });
    expect(safeAreaBandsFor("story").length).toBe(before);
    expect(safeAreaBandsFor("story").some((b) => b.label === "sabotage")).toBe(false);
  });

  // Revue de la Tâche 6, nit 2 : canvas-chrome.tsx indexe les bandes par `key={band.edge}`, ce qui
  // INTERDIT silencieusement deux bandes sur la même arête (React ne rendrait que la dernière, sans
  // avertissement en production). Rien dans le type ne l'empêchait, et le fichier invite explicitement
  // de futurs contributeurs à ajouter des entrées : la contrainte est donc épinglée ICI plutôt que
  // laissée à la mémoire du prochain lecteur.
  it("les arêtes d'un format sont UNIQUES — deux bandes sur la même arête seraient silencieusement perdues par la clé de rendu", () => {
    let checked = 0;
    for (const key of FORMAT_KEYS) {
      const bands = safeAreaBandsFor(key);
      if (bands.length === 0) continue;
      checked += 1;
      expect(new Set(bands.map((b) => b.edge)).size).toBe(bands.length);
    }
    expect(checked).toBeGreaterThan(0); // garde anti-vacuité : la boucle a bel et bien tourné
  });

  it("implication À SENS UNIQUE : tout format outillé a safeAreaDefaultFor === true — mais PAS la réciproque (ig_portrait)", () => {
    // La garantie EXACTE, énoncée avec sa condition (leçon des Tâches 4 et 5, où une prose promettait
    // plus que le code) : « bandes ⇒ défaut ON ». La réciproque est FAUSSE et c'est assumé :
    // ig_portrait est portrait, donc le toggle y est ON par défaut, alors qu'aucune bande n'y est
    // définie faute de source. Épinglé ici pour que l'asymétrie soit documentée et non découverte.
    for (const key of FORMAT_KEYS) {
      if (safeAreaBandsFor(key).length > 0) expect(safeAreaDefaultFor(key)).toBe(true);
    }
    expect(safeAreaDefaultFor("ig_portrait")).toBe(true);
    expect(safeAreaBandsFor("ig_portrait")).toEqual([]);
  });
});

describe("CanvasChrome ∘ Canvas — les BANDES de zones sûres, en composition RÉELLE (Tâche 6, U2, spec §7)", () => {
  const ON: EditorPrefs = { ...DEFAULT_PREFS, safeAreas: true };
  const OFF: EditorPrefs = { ...DEFAULT_PREFS, safeAreas: false };

  it("rendues UNIQUEMENT quand la préférence est active", () => {
    expect(renderComposed(OFF, "story")).not.toContain('data-testid="safe-areas"');
    expect(renderComposed(OFF, "story")).not.toContain("data-safe-band=");
    expect(renderComposed(ON, "story")).toContain('data-testid="safe-areas"');
  });

  // LE pin POSITIF de géométrie, celui sans lequel toutes les propriétés négatives de ce describe
  // seraient satisfaites par un composant qui ne rend RIEN (leçon n°1 du brief). Valeurs calculées à
  // la main depuis le préréglage `story` (1080×1920) et les fractions publiées :
  //   haut   1920 × 0,14 = 268,8   bas 1920 × 0,35 = 672
  //   côtés  1080 × 0,06 = 64,8
  // Les quatre produits sont exacts en flottant IEEE-754 (vérifié), donc comparables en chaîne.
  it("géométrie EXACTE au zoom 1 pour `story` — chaque bande fait la bonne fraction de la bonne dimension", () => {
    const html = renderComposed(ON, "story", 1);

    const top = styleAttr(html, 'data-safe-band="top"');
    expect(top).toContain("height:268.8px");
    expect(top).toContain("width:1080px");
    expect(top).toContain("top:0");

    const bottom = styleAttr(html, 'data-safe-band="bottom"');
    expect(bottom).toContain("height:672px");
    expect(bottom).toContain("width:1080px");
    expect(bottom).toContain("bottom:0");

    const left = styleAttr(html, 'data-safe-band="left"');
    expect(left).toContain("width:64.8px");
    expect(left).toContain("height:1920px");
    expect(left).toContain("left:0");

    const right = styleAttr(html, 'data-safe-band="right"');
    expect(right).toContain("width:64.8px");
    expect(right).toContain("height:1920px");
    expect(right).toContain("right:0");

    // L'étiquette française est bel et bien RENDUE, pas seulement présente dans la table.
    expect(html).toContain("Haut — profil");
    expect(html).toContain("Bas — action");
  });

  it("les bandes suivent le zoom : à 0,5, chaque épaisseur est exactement la moitié", () => {
    // Ce qui ferait échouer ce test : une épaisseur en pixels ÉCRAN constants (« 250px » codé en
    // dur), ou une fraction appliquée aux dimensions de la SCÈNE sans le facteur de zoom — dans les
    // deux cas les bandes cesseraient de coïncider avec la zone réellement recouverte à l'écran, le
    // même défaut de compensation que les poignées de la revue du Lot 2.
    const html = renderComposed(ON, "story", 0.5);
    expect(styleAttr(html, 'data-safe-band="top"')).toContain("height:134.4px"); // 1920 × 0,14 × 0,5
    expect(styleAttr(html, 'data-safe-band="top"')).toContain("width:540px"); // 1080 × 0,5
    expect(styleAttr(html, 'data-safe-band="bottom"')).toContain("height:336px"); // 1920 × 0,35 × 0,5
    expect(styleAttr(html, 'data-safe-band="left"')).toContain("width:32.4px"); // 1080 × 0,06 × 0,5
  });

  // MOTIF de bande dégénérée : une longueur NULLE posée par React. `(?<![-\w])` écarte
  // `border-width:0` / `stroke-width:0`, qui contiennent bien la sous-chaîne « width:0 » sans être une
  // dimension de bande ; `(?![\d.])` écarte `height:0.5px` et `height:0px` — non, justement : `0px`
  // matche (le caractère qui suit le zéro est `p`), et c'est voulu, le motif couvre les DEUX
  // sérialisations possibles pour que le test ne dépende pas de la façon dont React écrit un zéro.
  const DIMENSION_NULLE = /(?<![-\w])(?:height|width):0(?![\d.])/;

  it("un format SANS bandes n'en rend AUCUNE — ni conteneur, ni bande de dimension nulle — alors que le toggle est ON", () => {
    // Le contrôle POSITIF vit DANS ce test (leçon n°1 du brief) : sans lui, un composant qui ne
    // rendrait jamais rien passerait les trois assertions négatives.
    expect(renderComposed(ON, "story")).toContain("data-safe-band=");
    // …et le format OUTILLÉ n'a lui non plus aucune bande dégénérée : c'est ce qui fait mordre le motif
    // sur un vrai rendu de bandes, et pas seulement sur des rendus qui n'en contiennent aucune.
    expect(renderComposed(ON, "story")).not.toMatch(DIMENSION_NULLE);

    // SECOND contrôle, sur le MOTIF cette fois (revue finale U0+U2). L'assertion d'origine était
    // `not.toContain("height:0px")`, et elle NE POUVAIT PAS ÉCHOUER : React sérialise `height: 0` en
    // `height:0`, jamais en `height:0px` (les deux lignes ci-dessous le prouvent plutôt que de
    // l'affirmer), si bien qu'une vraie bande dégénérée serait passée tout droit. Le motif retenu, lui,
    // attrape les deux écritures — et on le vérifie ici, pour que l'assertion négative plus bas ne
    // redevienne pas vacuité au premier changement de sérialisation de React.
    const zéro = renderToStaticMarkup(React.createElement("div", { style: { height: 0, width: 0 } }));
    expect(zéro).toContain("height:0");
    expect(zéro).not.toContain("height:0px"); // <- pourquoi l'ancien motif était mort
    expect(zéro).toMatch(DIMENSION_NULLE);
    expect(DIMENSION_NULLE.test('style="border-width:0"')).toBe(false); // et pas de faux positif

    for (const key of ["ig_square", "ig_portrait", "fb_link"] as FormatKey[]) {
      const html = renderComposed(ON, key);
      expect(html).not.toContain("data-safe-band=");
      expect(html).not.toContain('data-testid="safe-areas"');
      // « Pas d'artefact de dimension nulle » : aucune bande dégénérée n'a été rendue, ni en hauteur
      // (bandes haut/bas) ni en largeur (bandes gauche/droite).
      expect(html).not.toMatch(DIMENSION_NULLE);
    }
  });

  // CRITIQUE — LE test de cette tâche (leçon de la grille de U1) : « présent dans le balisage » n'est
  // pas « visible à l'écran ». <Canvas> pose un rectangle plein-cadre opaque pour
  // `scene.canvas.background` ; des bandes rendues AVANT lui dans l'arbre passeraient DESSOUS et le
  // toggle « Zones sûres » basculerait `aria-pressed` sans le moindre effet visuel — exactement le
  // défaut que la grille a livré « fonctionnel ». Preuve suffisante en HTML sérialisé, avec ses trois
  // PRÉCONDITIONS explicitées plutôt que supposées (leçon n°3 du brief) :
  //   (a) l'ordre de peinture == l'ordre du DOM pour deux éléments qui se chevauchent et n'ouvrent
  //       aucun contexte d'empilement → il faut vérifier qu'aucun des deux ne porte de z-index ;
  //   (b) les bandes doivent être ABSOLUES et `inset-0` DANS l'artboard, dont la boîte coïncide
  //       pixel pour pixel avec celle de <Canvas> — sinon « au-dessus » ne recouvrirait pas la même
  //       surface ;
  //   (c) l'artboard doit être `relative`, sinon `inset-0` se résoudrait contre un autre ancêtre.
  it("CRITIQUE : les bandes peignent APRÈS le vrai Canvas, donc AU-DESSUS de l'artboard opaque, et couvrent exactement sa boîte", () => {
    const html = renderComposed(ON, "story");

    const iCanvas = html.indexOf('data-testid="studio-canvas"');
    const iBands = html.indexOf('data-testid="safe-areas"');
    expect(iCanvas).toBeGreaterThan(-1);
    expect(iBands).toBeGreaterThan(-1);
    expect(iBands).toBeGreaterThan(iCanvas);

    // (a) aucune des deux balises n'ouvre de contexte d'empilement — ni z-index en style inline, ni
    // classe Tailwind `z-*`. Un `z-index: 0` sur la racine de <Canvas> la ferait repeindre au-dessus
    // des bandes tout en laissant l'assertion d'ordre ci-dessus verte ; un `-z-10` sur les bandes les
    // renverrait derrière l'artboard, idem.
    for (const marker of ['data-testid="studio-canvas"', 'data-testid="safe-areas"']) {
      const tag = openTag(html, marker);
      expect(tag).not.toMatch(/z-index/);
      const classAttr = /\sclass="([^"]*)"/.exec(tag);
      const classes = classAttr ? classAttr[1].split(/\s+/) : [];
      expect(classes.some((c) => /^-?z-/.test(c))).toBe(false);
    }

    // (b) + (c) : bandes `absolute inset-0`, artboard `relative`.
    const bandsTag = openTag(html, 'data-testid="safe-areas"');
    expect(bandsTag).toMatch(/\babsolute\b/);
    expect(bandsTag).toMatch(/\binset-0\b/);
    expect(openTag(html, 'data-testid="artboard"')).toMatch(/\brelative\b/);

    // (b bis) — et surtout : `inset-0` ne veut « la boîte de l'artboard » que si les bandes sont bien
    // DANS l'artboard. Sans cette paire d'assertions, des bandes rendues À CÔTÉ de l'artboard (dans le
    // cadre qui réserve la place des règles, décalé de RULER_SIZE et plus grand de 2×RULER_SIZE)
    // passeraient TOUT ce qui précède : l'ordre du document et les classes seraient inchangés. Les deux
    // sens sont épinglés — dans l'artboard, mais FRÈRES de <Canvas>, jamais descendants (auquel cas
    // elles vivraient dans son conteneur `transform: scale(k)` et leurs dimensions, déjà multipliées par
    // le zoom, seraient mises à l'échelle une seconde fois).
    expect(subtreeOf(html, 'data-testid="artboard"')).toContain('data-testid="safe-areas"');
    expect(subtreeOf(html, 'data-testid="studio-canvas"')).not.toContain('data-testid="safe-areas"');
  });

  it("les bandes sont décoratives : pointer-events-none, et rien de cliquable dans leur sous-arbre", () => {
    const html = renderComposed(ON, "story");
    expect(openTag(html, 'data-testid="safe-areas"')).toMatch(/\bpointer-events-none\b/);
    // Le sous-arbre des bandes est le DERNIER contenu de l'artboard : tout ce qui suit son marqueur
    // dans le HTML est soit une bande, soit une balise de fermeture. Aucune réactivation locale
    // (`pointer-events-auto`, comme en portent les pastilles et les boutons de bascule PLUS HAUT dans
    // l'arbre) ne doit y apparaître — sinon une bande volerait les clics/glissers du canevas, qu'elle
    // recouvre entièrement.
    const subtree = html.slice(html.indexOf('data-testid="safe-areas"'));
    expect(subtree).not.toContain("pointer-events-auto");
    expect(subtree).not.toContain("pointer-events:auto");
  });
});

// Revue de la Tâche 6, points 1 et 2 — LA CONFIANCE MAL PLACÉE, plutôt que le simple manque de retour.
// Sur `ig_portrait`, `safeAreaDefaultFor` renvoie `true` par ORIENTATION : le bouton se rend donc
// enfoncé (`aria-pressed="true"`, `variant="secondary"`) au-dessus d'un artboard où RIEN n'est dessiné.
// Ce que l'utilisateur en déduit n'est pas « aucune donnée disponible » mais « les zones sûres sont
// actives, donc ma maquette les respecte » — strictement pire que de ne rien faire du tout (le cas de
// la Tâche 5, où la fonctionnalité mourait en silence sans rien affirmer).
//
// La correction est une NOTE, pas un contrôle désactivé, et la raison est structurelle : la préférence
// est GLOBALE à l'utilisateur (lib/studio/editor-prefs.ts), pas par format. La désactiver sur un
// gabarit ferait passer un réglage global pour un réglage propre au format, et laisserait le `true`
// déjà persisté orphelin — le bouton mentirait dans l'autre sens.
describe("CanvasChrome — un format SANS zones sûres établies le DIT, au lieu de laisser le bouton enfoncé affirmer le contraire (revue Tâche 6)", () => {
  const ON: EditorPrefs = { ...DEFAULT_PREFS, safeAreas: true };
  const OFF: EditorPrefs = { ...DEFAULT_PREFS, safeAreas: false };
  const NOTE = "Zones sûres : aucune donnée publiée pour ce format.";

  it("la note apparaît pour un format sans bandes, dans l'artboard, décorative — et le bouton reste bien enfoncé (la préférence globale n'est PAS niée)", () => {
    const html = renderComposed(ON, "ig_portrait");
    expect(html).toContain('data-testid="safe-areas-none"');
    expect(html).toContain(NOTE);
    // Décorative, comme les bandes : elle recouvre une partie de l'artboard.
    expect(openTag(html, 'data-testid="safe-areas-none"')).toMatch(/\bpointer-events-none\b/);
    // DANS l'artboard (même exigence de contenance que les bandes : posée à côté, elle se placerait
    // contre le cadre qui réserve les règles, décalé de RULER_SIZE) et hors du sous-arbre de <Canvas>.
    expect(subtreeOf(html, 'data-testid="artboard"')).toContain('data-testid="safe-areas-none"');
    expect(subtreeOf(html, 'data-testid="studio-canvas"')).not.toContain('data-testid="safe-areas-none"');
    // Elle peint APRÈS le Canvas opaque — même leçon que les bandes, sinon elle serait invisible.
    expect(html.indexOf('data-testid="safe-areas-none"')).toBeGreaterThan(html.indexOf('data-testid="studio-canvas"'));
    // Et le bouton n'est NI désactivé NI relâché : la préférence globale reste vraie et modifiable.
    const button = openTag(html, 'data-action="toggle-safe-areas"');
    expect(button).toContain('aria-pressed="true"');
    // L'ATTRIBUT `disabled`, pas la sous-chaîne (leçon de la Tâche 1, re-rencontrée ici) : la classe du
    // bouton contient `disabled:pointer-events-none` et `disabled:opacity-50`, donc un
    // `not.toContain("disabled")` échouait pour une raison qui n'avait rien à voir avec l'état du
    // contrôle. On exige donc un `disabled` suivi de `=`, `>` ou d'une espace — jamais de `:`.
    expect(button).not.toMatch(/\sdisabled(?:=|>|\s)/);
  });

  it("elle n'apparaît NI quand la préférence est éteinte, NI pour un format qui a de vraies bandes", () => {
    // Contrôle POSITIF dans le test négatif (leçon n°1 du brief) : sans lui, une note jamais rendue
    // passerait les deux assertions suivantes.
    expect(renderComposed(ON, "ig_portrait")).toContain('data-testid="safe-areas-none"');

    expect(renderComposed(OFF, "ig_portrait")).not.toContain('data-testid="safe-areas-none"');
    expect(renderComposed(OFF, "ig_portrait")).not.toContain(NOTE);
    // `story` a des bandes : la note serait redondante et fausse (les données existent).
    expect(renderComposed(ON, "story")).not.toContain('data-testid="safe-areas-none"');
    expect(renderComposed(ON, "story")).not.toContain(NOTE);
  });

  // Point 2 de la revue : la réserve « ces pourcentages sont ceux des PLACEMENTS PUBLICITAIRES » ne
  // vivait que dans le commentaire du module, alors que l'utilisateur voit 49 % de la hauteur (55 % de
  // la surface) recouverts sans rien qui indique de quelle borne il s'agit. L'infobulle du bouton la
  // porte désormais, et elle est FONCTION DU FORMAT — donc jamais une phrase générique.
  it("l'infobulle du bouton porte la réserve « borne publicitaire » quand des bandes existent, et l'absence de donnée quand il n'y en a pas", () => {
    const withBands = openTag(renderComposed(ON, "story"), 'data-action="toggle-safe-areas"');
    expect(withBands).toContain("publicitaires");
    expect(withBands).toContain("conservatrice");
    expect(withBands).not.toContain("aucune donnée");

    const withoutBands = openTag(renderComposed(ON, "ig_portrait"), 'data-action="toggle-safe-areas"');
    expect(withoutBands).toContain("aucune donnée");
    expect(withoutBands).not.toContain("publicitaires");

    // L'infobulle ne dépend PAS de la préférence — seulement du format : un bouton relâché doit
    // expliquer la même chose, sinon la réserve disparaîtrait exactement quand l'utilisateur hésite à
    // activer les zones sûres.
    expect(openTag(renderComposed(OFF, "story"), 'data-action="toggle-safe-areas"')).toContain("publicitaires");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// U3 Tâche 3 (arbitrage A) — LA POIGNÉE DE ROTATION D'UNE FORME DÉCOUPÉE.
//
// Les deux chemins de rendu suppriment la `transform` de rotation pour une forme découpée
// (lib/studio/shapes.ts#layerRotation, prouvé en pixels dans tests/studio-shape-render.test.ts). Le
// canevas doit suivre, pour deux raisons distinctes :
//   — la poignée n'a plus rien à faire tourner : la garder, c'est offrir un geste qui n'a AUCUN effet
//     visible (le défaut « la fonctionnalité meurt en silence » que U2 a déjà tranché deux fois) ;
//   — le CONTOUR de sélection, lui, tournait bien : un cadre penché autour d'un triangle droit aurait
//     annoncé une rotation qui n'existe pas.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("Canvas — une forme découpée n'offre pas de rotation (U3 Tâche 3)", () => {
  function sceneWithShapes(): Scene {
    return {
      schemaVersion: 1,
      canvas: { width: 800, height: 400, background: "#000000" },
      layers: [
        { id: "tri", name: "Triangle", visible: true, locked: false, frame: { x: 0, y: 0, w: 400, h: 200 },
          rotation: 30, type: "shape", shape: "triangle", fill: "#FF0000" },
        { id: "rec", name: "Rect", visible: true, locked: false, frame: { x: 0, y: 200, w: 400, h: 200 },
          rotation: 30, type: "shape", shape: "rect", fill: "#00FF00" },
      ],
    };
  }
  function renderSel(id: string) {
    return renderToStaticMarkup(
      React.createElement(Canvas, { scene: sceneWithShapes(), selectedIds: [id], dispatch: () => {}, scale: 1 }),
    );
  }

  it("le triangle sélectionné garde ses poignées de redimensionnement mais PERD celle de rotation", () => {
    const html = renderSel("tri");
    expect(html).toContain('data-handle="se"');   // témoin : les autres poignées sont bien là
    expect(html).not.toContain('data-handle="rotate"');
  });

  it("TÉMOIN : le rectangle sélectionné, lui, garde la poignée de rotation", () => {
    // Sans ce témoin, l'assertion ci-dessus passerait aussi si la poignée avait disparu pour TOUT LE
    // MONDE — ce qui supprimerait la rotation de l'éditeur entier sans qu'aucun test ne le dise.
    expect(renderSel("rec")).toContain('data-handle="rotate"');
  });

  it("ni le calque ni son contour de sélection ne penchent pour une forme découpée", () => {
    // `rotation: 30` est POSÉ sur les deux calques : c'est le cas d'une scène écrite avant cette
    // tâche, ou convertie depuis un rectangle pivoté.
    expect(styleAttr(renderSel("tri"), 'data-layer-id="tri"')).not.toContain("rotate(");
    expect(styleAttr(renderSel("tri"), 'data-testid="handles-overlay"')).not.toContain("rotate(");
    // Les deux mêmes lectures sur le rectangle : la rotation y est bien PEINTE des deux côtés.
    expect(styleAttr(renderSel("rec"), 'data-layer-id="rec"')).toContain("rotate(30deg)");
    expect(styleAttr(renderSel("rec"), 'data-testid="handles-overlay"')).toContain("rotate(30deg)");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// « Voir les liaisons » (Tâche 6, U4, spec §5) — sous le harnais DOM de U0 (tests/dom-harness.ts) :
// ce bloc a besoin d'une containment/paint-order RÉELLE (parentElement, ordre des enfants), pas
// seulement d'une chaîne HTML sérialisée — la même raison que le test des guides d'accrochage de
// tests/studio-interactions.test.ts. `installDom()` est scopé à CE describe (pas au fichier entier)
// pour ne pas changer quel chemin les describes voisins de ce fichier exercent (ils restent tous en
// `renderToStaticMarkup`, sans DOM).
describe("Canvas — « voir les liaisons » : contour d'accent + étiquette de jeton (Tâche 6, U4, spec §5)", () => {
  let teardownDom: () => void;

  function boundAndPlainScene(): Scene {
    return {
      schemaVersion: 1,
      canvas: { width: 800, height: 600, background: "#000000" },
      layers: [
        {
          id: "bound", name: "Titre lié", visible: true, locked: false,
          frame: { x: 40, y: 40, w: 300, h: 80 },
          type: "text", content: "{{article.title}}",
          font: { family: "Noto Sans", size: 32, weight: 700 },
          color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
        },
        {
          id: "plain", name: "Texte libre", visible: true, locked: false,
          frame: { x: 40, y: 200, w: 300, h: 80 },
          type: "text", content: "Un texte tout à fait ordinaire",
          font: { family: "Noto Sans", size: 32, weight: 700 },
          color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
        },
      ],
    };
  }

  function layerEl(container: HTMLElement, id: string): HTMLElement {
    const el = container.querySelector(`[data-layer-id="${id}"]`) as HTMLElement | null;
    if (!el) throw new Error(`nœud du calque « ${id} » absent du DOM monté`);
    return el;
  }

  function outlineEls(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll('[data-testid="binding-outline"]')) as HTMLElement[];
  }

  beforeAll(() => { teardownDom = installDom(); });
  afterAll(() => { teardownDom(); });

  it("ÉTEINT (défaut) : aucun contour de liaison, même sur une scène qui en porte un (anti-vacuité)", async () => {
    const { container, unmount } = await mount(
      React.createElement(Canvas, { scene: boundAndPlainScene(), selectedIds: [], dispatch: () => {}, scale: 1 }),
    );
    expect(outlineEls(container)).toHaveLength(0);
    unmount();
  });

  it("ALLUMÉ : EXACTEMENT un contour + une étiquette, sur le calque LIÉ seulement — jamais sur le calque libre voisin", async () => {
    const { container, unmount } = await mount(
      React.createElement(Canvas, {
        scene: boundAndPlainScene(), selectedIds: [], dispatch: () => {}, scale: 1, showBindings: true,
      }),
    );

    const outlines = outlineEls(container);
    expect(outlines).toHaveLength(1);
    expect(outlines[0].getAttribute("data-layer-id")).toBe("bound");

    const label = outlines[0].querySelector('[data-testid="binding-label"]') as HTMLElement | null;
    expect(label).not.toBeNull();
    expect(label!.textContent).toBe(TOKEN_LABELS["article.title"]);

    // CONTAINMENT + ORDRE DE PEINTURE (leçon de la grille de U1 : présent dans le balisage ≠ visible
    // au bon endroit) : le contour est un ENFANT DIRECT du MÊME conteneur mis à l'échelle que les
    // calques et les guides — jamais un frère de l'artboard lui-même, jamais un conteneur séparé — et
    // il vient APRÈS le calque qu'il annote dans l'ordre du DOM (z-index: auto -> l'ordre du DOM EST
    // l'ordre de peinture), sans quoi le calque opaque le recouvrirait.
    const scaledContainer = layerEl(container, "bound").parentElement!;
    expect(outlines[0].parentElement).toBe(scaledContainer);
    const kids = Array.from(scaledContainer.children);
    expect(kids.indexOf(outlines[0])).toBeGreaterThan(kids.indexOf(layerEl(container, "bound")));
    expect(kids.indexOf(outlines[0])).toBeGreaterThan(kids.indexOf(layerEl(container, "plain")));

    unmount();
  });

  it("détermine PLUSIEURS calques liés en même temps, chacun sa propre étiquette, stable et non ambiguë", async () => {
    const scene = boundAndPlainScene();
    scene.layers.push({
      id: "swatch", name: "Pastille", visible: true, locked: false,
      frame: { x: 400, y: 40, w: 60, h: 60 },
      type: "shape", shape: "rect", fill: "{{category.color}}",
    });

    const { container, unmount } = await mount(
      React.createElement(Canvas, { scene, selectedIds: [], dispatch: () => {}, scale: 1, showBindings: true }),
    );

    const outlines = outlineEls(container);
    expect(outlines).toHaveLength(2); // "bound" (texte) + "swatch" (couleur) — "plain" en est absent
    const byLayer = new Map(outlines.map((el) => [el.getAttribute("data-layer-id"), el]));
    expect(byLayer.get("bound")!.querySelector('[data-testid="binding-label"]')!.textContent)
      .toBe(TOKEN_LABELS["article.title"]);
    expect(byLayer.get("swatch")!.querySelector('[data-testid="binding-label"]')!.textContent)
      .toBe(TOKEN_LABELS["category.color"]);

    unmount();
  });

  it("CONTINUITÉ : décaler légèrement le calque décale son étiquette d'AUTANT, sans le moindre saut", async () => {
    function sceneAt(x: number): Scene {
      const scene = boundAndPlainScene();
      scene.layers[0] = { ...scene.layers[0], frame: { ...scene.layers[0].frame, x } };
      return scene;
    }

    const a = await mount(
      React.createElement(Canvas, { scene: sceneAt(100), selectedIds: [], dispatch: () => {}, scale: 1, showBindings: true }),
    );
    const b = await mount(
      React.createElement(Canvas, { scene: sceneAt(104), selectedIds: [], dispatch: () => {}, scale: 1, showBindings: true }),
    );

    const outlineA = outlineEls(a.container)[0];
    const outlineB = outlineEls(b.container)[0];
    const dLeft = parseFloat(outlineB.style.left) - parseFloat(outlineA.style.left);
    expect(dLeft).toBe(4); // le contour suit le cadre EXACTEMENT — pas de seuil, pas d'arrondi surprise

    // L'étiquette elle-même reste ancrée au MÊME point relatif (0,0) du contour dans les deux cas :
    // c'est CE QUI GARANTIT l'absence de saut — un ancrage qui « choisirait un bord » selon la
    // position du calque romprait cette égalité au moment où le calque franchirait le seuil.
    const labelA = outlineA.querySelector('[data-testid="binding-label"]') as HTMLElement;
    const labelB = outlineB.querySelector('[data-testid="binding-label"]') as HTMLElement;
    expect(labelA.style.left).toBe(labelB.style.left);
    expect(labelA.style.top).toBe(labelB.style.top);

    a.unmount();
    b.unmount();
  });

  // MUTATION (écho du §0 de U3, « la mathématique du geste doit lire la même rotation que la
  // peinture ») : une forme DÉCOUPÉE (triangle) ne tourne dans AUCUN des deux moteurs de rendu
  // (lib/studio/shapes.ts#layerSupportsRotation) — son contour de sélection ne penche déjà pas pour
  // cette raison (describe précédent de ce fichier). Le contour de LIAISON doit suivre la MÊME
  // discipline : lire la rotation PEINTE (`rotationFor`, qui retombe sur 0 ici), jamais la rotation
  // BRUTE du calque (`layer.rotation`, non nulle). Un rectangle témoin — qui, lui, tourne bel et bien
  // dans les deux moteurs — prouve que l'absence de `rotate()` sur le triangle est bien parce que la
  // forme ne tourne pas, pas parce que le mécanisme entier serait muet.
  it("la rotation du contour est la rotation PEINTE, jamais la rotation BRUTE d'une forme découpée", async () => {
    const scene: Scene = {
      schemaVersion: 1,
      canvas: { width: 800, height: 400, background: "#000000" },
      layers: [
        {
          id: "tri", name: "Triangle lié", visible: true, locked: false,
          frame: { x: 0, y: 0, w: 200, h: 200 }, rotation: 45,
          type: "shape", shape: "triangle", fill: "{{category.color}}",
        },
        {
          id: "rec", name: "Rectangle lié", visible: true, locked: false,
          frame: { x: 300, y: 0, w: 200, h: 200 }, rotation: 30,
          type: "shape", shape: "rect", fill: "{{category.color}}",
        },
      ],
    };

    const { container, unmount } = await mount(
      React.createElement(Canvas, { scene, selectedIds: [], dispatch: () => {}, scale: 1, showBindings: true }),
    );

    const outlines = outlineEls(container);
    const tri = outlines.find((el) => el.getAttribute("data-layer-id") === "tri")!;
    const rec = outlines.find((el) => el.getAttribute("data-layer-id") === "rec")!;

    // La forme découpée : AUCUNE rotation peinte — pas même `rotate(0deg)` : un mutant qui lirait
    // `layer.rotation` brut (45°) au lieu de `rotationFor(layer)` ferait rougir CETTE assertion.
    expect(tri.style.transform).toBe("");
    // Le témoin : le rectangle, lui, tourne bel et bien — la même surcouche n'est donc pas
    // structurellement muette sur la rotation, seulement fidèle à ce qui est réellement peint.
    expect(rec.style.transform).toBe("rotate(30deg)");

    unmount();
  });
});
