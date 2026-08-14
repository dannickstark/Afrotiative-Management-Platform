import { describe, it, expect } from "bun:test";
import { resolveCanvasImages } from "@/lib/studio/canvas-images";
import type { Layer } from "@/lib/studio/scene";
import type { AssetRow } from "@/lib/queries/assets";

// tests/studio-canvas-images.test.ts — le bug : dans le canevas « Montage », un calque image dont la
// SOURCE est un asset de la BIBLIOTHÈQUE ne s'affichait pas (placeholder), car editor-shell ne
// construisait/passait jamais la map `images` que <Canvas> consomme (`images?.get(layer.id)`,
// canvas.tsx). Les sources `url` marchaient (layer-view lit `layer.source.url` directement) ; les
// sources `slot` sont un placeholder volontaire (l'éditeur n'a pas de valeur de jeton). Ce module PUR
// résout, pour l'AFFICHAGE, l'URL de chaque calque image `source.kind === "asset"` — keyed par id de
// calque, exactement comme canvas.tsx la lit. L'AssetRow porte déjà `url` (lib/queries/assets), donc
// aucun réseau : pure map de correspondance.

function asset(id: string, url: string): AssetRow {
  return {
    id, url, kind: "image", name: id, mime: "image/png", bytes: 1,
    width: 10, height: 10, uploadedBy: null, uploadedByName: null, createdAt: new Date(0),
  } as unknown as AssetRow;
}

function imageLayer(id: string, source: Extract<Layer, { type: "image" }>["source"]): Layer {
  return {
    id, name: id, visible: true, locked: false,
    frame: { x: 0, y: 0, w: 100, h: 100 },
    type: "image", source, fit: "cover",
  } as Layer;
}

describe("resolveCanvasimages — map layer.id -> URL d'affichage (sources ASSET seulement)", () => {
  it("un calque image source ASSET résout l'URL de l'asset correspondant", () => {
    const layers = [imageLayer("L1", { kind: "asset", assetId: "a1" })];
    const map = resolveCanvasImages(layers, [asset("a1", "https://cdn.example/img.png")]);
    expect(map.get("L1")).toBe("https://cdn.example/img.png");
  });

  it("une source URL n'entre PAS dans la map (layer-view la peint en direct)", () => {
    const layers = [imageLayer("L1", { kind: "url", url: "https://exemple.com/x.jpg" })];
    const map = resolveCanvasImages(layers, [asset("a1", "https://cdn.example/img.png")]);
    expect(map.has("L1")).toBe(false);
  });

  it("une source SLOT n'entre PAS dans la map (placeholder volontaire dans l'éditeur)", () => {
    const layers = [imageLayer("L1", { kind: "slot", slot: "article.image" })];
    const map = resolveCanvasImages(layers, [asset("a1", "https://cdn.example/img.png")]);
    expect(map.has("L1")).toBe(false);
  });

  it("un asset RÉFÉRENCÉ mais INTROUVABLE dans la bibliothèque n'entre pas dans la map (pas d'URL inventée)", () => {
    const layers = [imageLayer("L1", { kind: "asset", assetId: "manquant" })];
    const map = resolveCanvasImages(layers, [asset("a1", "https://cdn.example/img.png")]);
    expect(map.has("L1")).toBe(false);
  });

  it("plusieurs calques : seuls les asset résolus sont dans la map, keyed par id de CALQUE", () => {
    const layers = [
      imageLayer("L1", { kind: "asset", assetId: "a1" }),
      imageLayer("L2", { kind: "asset", assetId: "a2" }),
      imageLayer("L3", { kind: "url", url: "https://exemple.com/x.jpg" }),
    ];
    const map = resolveCanvasImages(layers, [
      asset("a1", "https://cdn.example/1.png"),
      asset("a2", "https://cdn.example/2.png"),
    ]);
    expect(map.get("L1")).toBe("https://cdn.example/1.png");
    expect(map.get("L2")).toBe("https://cdn.example/2.png");
    expect(map.has("L3")).toBe(false);
    expect(map.size).toBe(2);
  });
});
