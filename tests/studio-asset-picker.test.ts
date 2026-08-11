import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ImageAssetPicker, FontAssetPicker, pickImageAsset, pickFont, BUNDLED_FONT_PICK,
} from "@/components/studio/asset-picker";
import { PropertyPanel } from "@/components/studio/property-panel";
import { ImagesPanel, pickImageForSelection, filterAssetsBySearch } from "@/components/studio/panels/images-panel";
import { FALLBACK_FONT_FAMILY } from "@/lib/studio/fonts";
import { editorReducer, initEditorState, setLayerProp, type EditorAction } from "@/lib/studio/editor-state";
import type { AssetRow } from "@/lib/queries/assets";
import type { Scene, Layer, TextLayer, ImageLayer } from "@/lib/studio/scene";
import type { TemplateContext } from "@/lib/studio/tokens";

// tests/studio-asset-picker.test.ts — Tâche 13. Même convention que tests/studio-token-picker.test.ts
// et tests/studio-property-panel.test.ts : pas de DOM sous `bun test`, donc la STRUCTURE se vérifie
// en rendant en chaîne HTML (react-dom/server — un Popover Base UI fermé ne rend d'ailleurs pas son
// contenu par défaut côté serveur, exactement comme documenté par le fichier de test de TokenPicker),
// et le COMPORTEMENT (« sélectionner un asset produit CE patch ») en composant les fonctions PURES
// (pickImageAsset/pickFont) — exactement ce que property-panel.tsx branche sur onPick — avec le VRAI
// réducteur (Tâche 4), jamais en cliquant un élément qui n'existe pas dans le rendu SSR.

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

const IMAGE_ASSET: AssetRow = {
  id: "img-1", kind: "image", name: "Logo marque", url: "https://cdn.test/logo.png",
  mime: "image/png", bytes: 2048, width: 512, height: 512,
  fontFamily: null, fontWeight: null, fontStyle: null, uploadedByName: null, createdAt: new Date(),
};

const FONT_ASSET: AssetRow = {
  id: "font-1", kind: "font", name: "Ma police perso", url: "https://cdn.test/police.ttf",
  mime: "font/ttf", bytes: 40_000, width: null, height: null,
  fontFamily: "Police Perso", fontWeight: 600, fontStyle: "normal",
  uploadedByName: "Test", createdAt: new Date(),
};

const ASSETS: AssetRow[] = [IMAGE_ASSET, FONT_ASSET];

// ─────────────────────────────────────────────────────────────────────────────
describe("pickImageAsset — la fonction PURE que le picker appelle réellement (brief : \"selecting an asset sets { kind: \\\"asset\\\", assetId }\")", () => {
  it("produit exactement { kind: \"asset\", assetId }", () => {
    expect(pickImageAsset("img-1")).toEqual({ kind: "asset", assetId: "img-1" });
  });

  it("composé avec le VRAI réducteur : sélectionner une image dans la bibliothèque met à jour le calque et la scène reste valide", () => {
    const imageLayer: ImageLayer = {
      id: "i", name: "Image", visible: true, locked: false,
      frame: { x: 0, y: 0, w: 300, h: 200 },
      type: "image", source: { kind: "asset", assetId: "" }, fit: "cover",
    };
    const scene: Scene = { schemaVersion: 1, canvas: { width: 1200, height: 675, background: "#0B0B0B" }, layers: [imageLayer] };
    let state = initEditorState(scene);
    const dispatch = (action: EditorAction) => { state = editorReducer(state, action); };

    dispatch(setLayerProp("i", { source: pickImageAsset("img-1") }));

    const updated = state.scene.layers[0] as ImageLayer;
    expect(updated.source).toEqual({ kind: "asset", assetId: "img-1" });
  });
});

describe("pickFont — la fonction PURE que le picker appelle réellement (brief : \"selecting a font sets font.assetId\")", () => {
  const baseFont: TextLayer["font"] = { family: "Noto Sans", size: 32, weight: 400 };

  it("écrit assetId ET family, sans toucher size/weight/italic", () => {
    const result = pickFont({ ...baseFont, italic: true }, { assetId: "font-1", family: "Police Perso" });
    expect(result).toEqual({ family: "Police Perso", size: 32, weight: 400, italic: true, assetId: "font-1" });
  });

  it("composé avec le VRAI réducteur : sélectionner une police d'asset met à jour font.assetId sur le calque", () => {
    const textLayer: TextLayer = {
      id: "t", name: "Titre", visible: true, locked: false,
      frame: { x: 10, y: 10, w: 400, h: 100 }, type: "text", content: "Bonjour",
      font: baseFont, color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
    };
    const scene: Scene = { schemaVersion: 1, canvas: { width: 1200, height: 675, background: "#0B0B0B" }, layers: [textLayer] };
    let state = initEditorState(scene);
    const dispatch = (action: EditorAction) => { state = editorReducer(state, action); };

    dispatch(setLayerProp("t", { font: pickFont(baseFont, { assetId: "font-1", family: "Police Perso" }) }));

    const updated = (state.scene.layers[0] as TextLayer).font;
    expect(updated.assetId).toBe("font-1");
    expect(updated.family).toBe("Police Perso");
  });

  // Exigé par le brief : "the bundled family remains selectable" — PAS un état spécial inatteignable
  // depuis l'UI, mais le MÊME chemin pickFont(), avec BUNDLED_FONT_PICK comme n'importe quelle autre
  // police (voir components/studio/asset-picker.tsx:FontAssetPicker, le bouton "police intégrée" en
  // tête de liste appelle onPick(BUNDLED_FONT_PICK) exactement comme les autres appellent
  // onPick({assetId, family})).
  it("BUNDLED_FONT_PICK reste sélectionnable via pickFont : assetId redevient undefined, family redevient Noto Sans", () => {
    const withAsset: TextLayer["font"] = { family: "Police Perso", size: 32, weight: 400, assetId: "font-1" };
    const result = pickFont(withAsset, BUNDLED_FONT_PICK);
    expect(result.assetId).toBeUndefined();
    expect(result.family).toBe(FALLBACK_FONT_FAMILY);
  });

  it("revenir à la police intégrée, composé avec le VRAI réducteur, produit une scène toujours valide", () => {
    const textLayer: TextLayer = {
      id: "t", name: "Titre", visible: true, locked: false,
      frame: { x: 10, y: 10, w: 400, h: 100 }, type: "text", content: "Bonjour",
      font: { family: "Police Perso", size: 32, weight: 400, assetId: "font-1" },
      color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
    };
    const scene: Scene = { schemaVersion: 1, canvas: { width: 1200, height: 675, background: "#0B0B0B" }, layers: [textLayer] };
    let state = initEditorState(scene);
    const dispatch = (action: EditorAction) => { state = editorReducer(state, action); };

    dispatch(setLayerProp("t", { font: pickFont(textLayer.font, BUNDLED_FONT_PICK) }));

    const updated = (state.scene.layers[0] as TextLayer).font;
    expect(updated.assetId).toBeUndefined();
    expect(updated.family).toBe(FALLBACK_FONT_FAMILY);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sabotage-check documenté : un pickFont() qui écrirait `family` mais PAS `assetId` (ou l'inverse)
// laisserait la scène dans un état incohérent (un label affichant "Police Perso" alors que
// font.assetId serait resté vide, ou l'inverse) sans qu'AUCUN test purement structurel (rendu SSR
// du picker) ne le détecte — c'est précisément le rôle de ce test explicite : les DEUX champs
// doivent changer ENSEMBLE, jamais un seul.
describe("pickFont — sabotage-check : les deux champs (assetId, family) changent TOUJOURS ensemble", () => {
  it("un pickFont qui n'écrirait que family (pas assetId) échouerait ici", () => {
    const result = pickFont({ family: "Noto Sans", size: 10, weight: 400 }, { assetId: "font-1", family: "Police Perso" });
    expect(result.assetId).toBe("font-1");
    expect(result.family).toBe("Police Perso");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("ImageAssetPicker — composant (rendu structurel réel)", () => {
  it("le déclencheur invite à choisir quand aucun asset n'est sélectionné", () => {
    const html = render(React.createElement(ImageAssetPicker, { assets: ASSETS, value: "", onPick: () => {} }));
    expect(html).toContain('data-action="asset-picker-image"');
    expect(html).toContain("Choisir dans la bibliothèque");
  });

  it("le déclencheur affiche le nom de l'asset actuellement sélectionné", () => {
    const html = render(React.createElement(ImageAssetPicker, { assets: ASSETS, value: "img-1", onPick: () => {} }));
    expect(html).toContain("Logo marque");
  });

  it("rend sans planter avec une bibliothèque vide", () => {
    const html = render(React.createElement(ImageAssetPicker, { assets: [], value: "", onPick: () => {} }));
    expect(html).toContain('data-action="asset-picker-image"');
  });
});

describe("FontAssetPicker — composant (rendu structurel réel)", () => {
  it("le déclencheur affiche la police intégrée quand aucune police d'asset n'est sélectionnée", () => {
    const html = render(React.createElement(FontAssetPicker, { assets: ASSETS, value: undefined, onPick: () => {} }));
    expect(html).toContain('data-action="asset-picker-font"');
    expect(html).toContain(FALLBACK_FONT_FAMILY);
  });

  it("le déclencheur affiche la famille de la police d'asset actuellement sélectionnée", () => {
    const html = render(React.createElement(FontAssetPicker, { assets: ASSETS, value: "font-1", onPick: () => {} }));
    expect(html).toContain("Police Perso");
  });

  it("rend sans planter avec une bibliothèque vide — la police intégrée reste, elle, toujours proposée par le déclencheur", () => {
    const html = render(React.createElement(FontAssetPicker, { assets: [], value: undefined, onPick: () => {} }));
    expect(html).toContain('data-action="asset-picker-font"');
    expect(html).toContain(FALLBACK_FONT_FAMILY);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PropertyPanel — vérifie que les DEUX sélecteurs sont bien BRANCHÉS pour le bon type de calque
// (pas seulement que les composants existent en isolation ci-dessus).
describe("PropertyPanel — les sélecteurs d'assets sont bien montés pour le calque courant (Tâche 13)", () => {
  function scene(layers: Layer[]): Scene {
    return { schemaVersion: 1, canvas: { width: 1200, height: 675, background: "#0B0B0B" }, layers };
  }

  const imageLayer: ImageLayer = {
    id: "i", name: "Image", visible: true, locked: false,
    frame: { x: 0, y: 0, w: 300, h: 200 }, type: "image",
    source: { kind: "asset", assetId: "img-1" }, fit: "cover",
  };

  const textLayer: TextLayer = {
    id: "t", name: "Titre", visible: true, locked: false,
    frame: { x: 10, y: 10, w: 400, h: 100 }, type: "text", content: "Bonjour",
    font: { family: "Police Perso", size: 32, weight: 400, assetId: "font-1" },
    color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
  };

  it("un calque image en source \"bibliothèque\" monte le sélecteur d'images, avec la vignette de l'asset choisi", () => {
    const html = render(
      React.createElement(PropertyPanel, {
        scene: scene([imageLayer]), selectedId: "i", context: "social_post", dispatch: () => {}, assets: ASSETS,
      }),
    );
    expect(html).toContain('data-action="asset-picker-image"');
    expect(html).toContain("Logo marque");
    // L'ancien champ texte libre (identifiant collé à la main) a bien disparu.
    expect(html).not.toContain("Identifiant d'asset");
  });

  it("un calque texte monte le sélecteur de polices, avec la famille de la police choisie", () => {
    const html = render(
      React.createElement(PropertyPanel, {
        scene: scene([textLayer]), selectedId: "t", context: "social_post", dispatch: () => {}, assets: ASSETS,
      }),
    );
    expect(html).toContain('data-action="asset-picker-font"');
    expect(html).toContain("Police Perso");
  });

  it("sans bibliothèque fournie (assets omis), le panneau rend quand même — la police intégrée reste proposée", () => {
    const html = render(
      React.createElement(PropertyPanel, {
        scene: scene([textLayer]), selectedId: "t", context: "social_post", dispatch: () => {},
      }),
    );
    expect(html).toContain('data-action="asset-picker-font"');
    expect(html).toContain(FALLBACK_FONT_FAMILY);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ImagesPanel — Tâche 2 (U1, spec §3) : le panneau « Images » du rail HÉBERGE `ImageAssetPicker`
// (ci-dessus) plutôt que de reconstruire une seconde grille de vignettes. Le testid affirmé
// (data-testid="asset-picker", posé Tâche 2 sur le déclencheur de ImageAssetPicker) n'existe QUE
// dans components/studio/asset-picker.tsx : une réimplémentation qui redessinerait sa propre grille
// échouerait ce test même si elle affichait visuellement la même chose — le sabotage-check demandé
// par le brief. La seconde assertion (le jeton "article.image") prouve que la liste des emplacements
// d'image vient bien de CONTEXT_TOKENS/TOKEN_KINDS (lib/studio/tokens.ts) pour le contexte demandé,
// pas d'une liste écrite en dur qui ignorerait le contexte.
function fixtureAsset(overrides: Partial<AssetRow> = {}): AssetRow {
  return {
    id: "fixture-image-asset", kind: "image", name: "Image fixture", url: "https://cdn.test/fixture.png",
    mime: "image/png", bytes: 1024, width: 400, height: 300,
    fontFamily: null, fontWeight: null, fontStyle: null, uploadedByName: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

const NOOP_DISPATCH = (() => {}) as unknown as React.Dispatch<EditorAction>;

function sceneWith(layer: Layer): Scene {
  return { schemaVersion: 1, canvas: { width: 1200, height: 675, background: "#0B0B0B" }, layers: [layer] };
}

const textLayerFixture: TextLayer = {
  id: "t", name: "Titre", visible: true, locked: false,
  frame: { x: 10, y: 10, w: 400, h: 100 }, type: "text", content: "Bonjour",
  font: { family: "Noto Sans", size: 32, weight: 400 },
  color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
};

const imageLayerFixture: ImageLayer = {
  id: "i", name: "Image", visible: true, locked: false,
  frame: { x: 0, y: 0, w: 300, h: 200 }, type: "image",
  source: { kind: "slot", slot: "article.image" }, fit: "cover",
};

function renderImagesPanel(
  { context, assets, scene, selectedId, dispatch = NOOP_DISPATCH }:
  { context: TemplateContext; assets: AssetRow[]; scene?: Scene; selectedId?: string | null; dispatch?: React.Dispatch<EditorAction> },
): string {
  return renderToStaticMarkup(
    React.createElement(ImagesPanel, {
      context, assets, dispatch,
      scene: scene ?? sceneWith(textLayerFixture),
      selectedId: selectedId === undefined ? null : selectedId,
    }),
  );
}

// Isole la balise OUVRANTE du déclencheur du sélecteur — même précaution que buttonTagFor ailleurs
// dans ce fichier de suite : la classe Tailwind statique du bouton contient elle-même la sous-chaîne
// "disabled:", présente que le calque sélectionné soit une image ou non.
function pickerTriggerTag(html: string): string {
  const m = /<button[^>]*data-action="asset-picker-image"[^>]*>/.exec(html);
  if (!m) throw new Error('bouton data-action="asset-picker-image" introuvable');
  return m[0];
}

describe("ImagesPanel — héberge asset-picker.tsx, ne réimplémente pas une grille d'assets (Tâche 2)", () => {
  it("the Images panel hosts the asset picker and lists the context's image slots", async () => {
    const html = renderImagesPanel({ context: "article_image", assets: [fixtureAsset()] });
    expect(html).toContain('data-testid="asset-picker"');
    expect(html).toContain("article.image");
  });
});

// Correctif revue finale — Important 3 : `ImageAssetPicker` était monté avec `value=""` et
// `onPick={() => {}}` — un clic sur n'importe quel asset était silencieusement avalé. Ce bloc
// verrouille le comportement réel : désactivé + expliqué quand rien d'assignable n'est sélectionné,
// actionnable et branché sur le VRAI réducteur sinon.
describe("ImagesPanel — la grille d'assets est désormais RÉELLEMENT branchée, jamais inerte (Important 3, revue finale)", () => {
  it("aucun calque image sélectionné (rien du tout) : le déclencheur est VRAIMENT désactivé (attribut HTML, pas une classe) et l'explique en français", () => {
    const html = renderImagesPanel({ context: "article_image", assets: [fixtureAsset()], selectedId: null });
    expect(pickerTriggerTag(html)).toContain('disabled=""');
    expect(html).toContain("Sélectionnez un calque image pour y placer un visuel.");
  });

  it("un calque TEXTE est sélectionné (pas une image) : toujours désactivé", () => {
    const html = renderImagesPanel({
      context: "article_image", assets: [fixtureAsset()],
      scene: sceneWith(textLayerFixture), selectedId: "t",
    });
    expect(pickerTriggerTag(html)).toContain('disabled=""');
  });

  it("un calque IMAGE est sélectionné : le déclencheur est actionnable, et le message change", () => {
    const html = renderImagesPanel({
      context: "article_image", assets: [fixtureAsset()],
      scene: sceneWith(imageLayerFixture), selectedId: "i",
    });
    expect(pickerTriggerTag(html)).not.toContain('disabled=""');
    expect(html).toContain("Cliquez un asset pour l’assigner au calque image sélectionné.");
    expect(html).not.toContain("Sélectionnez un calque image pour y placer un visuel.");
  });

  it("pickImageForSelection, composé avec le VRAI réducteur : assigne l'asset au calque image sélectionné", () => {
    let state = initEditorState(sceneWith(imageLayerFixture));
    const dispatch = (a: EditorAction) => { state = editorReducer(state, a); };
    pickImageForSelection(state.scene.layers[0], "fixture-image-asset", dispatch);
    const updated = state.scene.layers[0] as ImageLayer;
    expect(updated.source).toEqual({ kind: "asset", assetId: "fixture-image-asset" });
  });

  it("pickImageForSelection ne fait RIEN quand le calque sélectionné n'est pas une image — aucun dispatch", () => {
    const calls: EditorAction[] = [];
    pickImageForSelection(textLayerFixture, "fixture-image-asset", (a) => calls.push(a));
    expect(calls).toHaveLength(0);
  });

  it("pickImageForSelection ne fait RIEN quand rien n'est sélectionné (null) — aucun dispatch", () => {
    const calls: EditorAction[] = [];
    pickImageForSelection(null, "fixture-image-asset", (a) => calls.push(a));
    expect(calls).toHaveLength(0);
  });
});

// Correctif revue finale — Important 2 : le champ de recherche du panneau Images filtre CÔTÉ CLIENT
// sur les assets déjà reçus en prop (aucune requête réseau).
describe("filterAssetsBySearch — pure, client-side (Images a une recherche, spec révisée)", () => {
  it("requête vide : renvoie la liste complète", () => {
    const list = [fixtureAsset({ id: "1", name: "Logo" }), fixtureAsset({ id: "2", name: "Bannière" })];
    expect(filterAssetsBySearch(list, "")).toEqual(list);
  });

  it("filtre insensible à la casse sur le nom", () => {
    const list = [fixtureAsset({ id: "1", name: "Logo Marque" }), fixtureAsset({ id: "2", name: "Bannière" })];
    expect(filterAssetsBySearch(list, "logo").map((a) => a.id)).toEqual(["1"]);
  });

  it("aucune correspondance : liste vide", () => {
    expect(filterAssetsBySearch([fixtureAsset({ name: "Logo" })], "zzz")).toEqual([]);
  });
});

describe("ImagesPanel — search et primaryAction sont bien câblés dans les slots de PanelHost, pas ailleurs (Important 2, revue finale)", () => {
  it("le champ de recherche apparaît dans la zone dédiée de PanelHost", () => {
    const html = renderImagesPanel({ context: "article_image", assets: [fixtureAsset()] });
    const searchIdx = html.indexOf('data-testid="panel-search"');
    const inputIdx = html.indexOf('data-testid="images-search"');
    expect(searchIdx).toBeGreaterThan(-1);
    expect(inputIdx).toBeGreaterThan(searchIdx);
  });

  it("« Importer un fichier » apparaît dans la zone dédiée de PanelHost, avant le corps du panneau", () => {
    const html = renderImagesPanel({ context: "article_image", assets: [] });
    const actionIdx = html.indexOf('data-testid="panel-primary-action"');
    const bodyIdx = html.indexOf('data-testid="images-panel"');
    expect(actionIdx).toBeGreaterThan(-1);
    expect(actionIdx).toBeLessThan(bodyIdx);
    expect(html).toContain("Importer un fichier");
  });
});
