import { describe, it, expect } from "bun:test";
import {
  previewCacheKey, createPreviewCache, PREVIEW_CACHE_MAX_BYTES, previewCache,
  type CachedPreview,
} from "@/lib/studio/preview-cache";
import { parseScene, type Scene } from "@/lib/studio/scene";

// tests/studio-preview-cache.test.ts — le mémo client de l'aperçu (refonte Rendu réel, §4 de la
// spec). PUR : aucun DOM, aucune base, aucun réseau — ce fichier appartient à la voie parallèle
// (scripts/test-fast.ts:PURE_FILES).

function fixtureScene(titleX = 40): Scene {
  return parseScene({
    schemaVersion: 1,
    canvas: { width: 1080, height: 1350, background: "#101010" },
    layers: [
      {
        id: "title", name: "Titre", visible: true, locked: false,
        frame: { x: titleX, y: 40, w: 1000, h: 100 },
        type: "text", content: "Titre de test",
        font: { family: "Noto Sans", size: 48, weight: 700 },
        color: "#FFFFFF", align: "left", vAlign: "top", lineHeight: 1.2,
      },
    ],
  });
}

const TPL = "11111111-1111-1111-1111-111111111111";

function entry(dataUriLength: number): CachedPreview {
  return {
    dataUri: "d".repeat(dataUriLength),
    degraded: false, overflowingLayerIds: [], lowResLayerIds: [],
  };
}

describe("previewCacheKey", () => {
  it("deux scènes au contenu identique donnent la MÊME clé, même si ce sont deux objets distincts", () => {
    const a = previewCacheKey(TPL, fixtureScene(), "ig_portrait", null);
    const b = previewCacheKey(TPL, fixtureScene(), "ig_portrait", null);
    expect(a).toBe(b);
  });

  it("un calque déplacé d'un seul pixel donne une clé DIFFÉRENTE", () => {
    const a = previewCacheKey(TPL, fixtureScene(40), "ig_portrait", null);
    const b = previewCacheKey(TPL, fixtureScene(41), "ig_portrait", null);
    expect(a).not.toBe(b);
  });

  it("le format, l'article et le gabarit font tous partie de la clé", () => {
    const base = previewCacheKey(TPL, fixtureScene(), "ig_portrait", null);
    expect(previewCacheKey(TPL, fixtureScene(), "story", null)).not.toBe(base);
    expect(previewCacheKey(TPL, fixtureScene(), "ig_portrait", "art-1")).not.toBe(base);
    expect(previewCacheKey("22222222-2222-2222-2222-222222222222", fixtureScene(), "ig_portrait", null)).not.toBe(base);
  });

  it("`format` absent et `articleId` absent/null sont traités de façon stable", () => {
    expect(previewCacheKey(TPL, fixtureScene(), undefined, null))
      .toBe(previewCacheKey(TPL, fixtureScene(), undefined, undefined));
    expect(previewCacheKey(TPL, fixtureScene(), undefined, null))
      .not.toBe(previewCacheKey(TPL, fixtureScene(), "ig_portrait", null));
  });

  it("les champs séparés par des caractères de contrôle ne créent pas d'ambiguïté — e.g. `articleId` contenant `|` ne peut pas se confondre avec un réassignement aux mauvais champs", () => {
    // Si la clé était naïvement `.join("|")`, ces deux appels produiraient la même clé :
    //   ["tpl", "a|b", "c", ...].join("|")  →  "tpl|a|b|c|..."
    //   ["tpl", "a", "b|c", ...].join("|")  →  "tpl|a|b|c|..."
    // Avec JSON.stringify, les limites de champs sont explicites et immuables.
    const a = previewCacheKey(TPL, fixtureScene(), "a|b" as any, "c");
    const b = previewCacheKey(TPL, fixtureScene(), "a", "b|c");
    expect(a).not.toBe(b);
  });
});

describe("createPreviewCache — éviction bornée en OCTETS", () => {
  it("relit ce qu'il a écrit", () => {
    const c = createPreviewCache(10_000);
    c.set("a", entry(100));
    expect(c.get("a")?.dataUri).toHaveLength(100);
  });

  it("évince le plus ancien jusqu'à repasser sous le budget", () => {
    // bytes ≈ length * 0.75 → une entrée de 1000 caractères pèse 750 octets.
    const c = createPreviewCache(2_000); // tient 2 entrées de 750, pas 3.
    c.set("a", entry(1000));
    c.set("b", entry(1000));
    c.set("c", entry(1000));
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBeDefined();
    expect(c.get("c")).toBeDefined();
    expect(c.bytes()).toBeLessThanOrEqual(2_000);
  });

  it("un `get` rafraîchit la récence : c'est bien une LRU, pas une FIFO", () => {
    const c = createPreviewCache(2_000);
    c.set("a", entry(1000));
    c.set("b", entry(1000));
    c.get("a");            // "a" redevient la plus récente
    c.set("c", entry(1000)); // doit donc évincer "b", pas "a"
    expect(c.get("a")).toBeDefined();
    expect(c.get("b")).toBeUndefined();
  });

  it("une entrée plus grosse à elle seule que le budget n'est PAS mise en cache (et n'en vide pas le contenu)", () => {
    const c = createPreviewCache(2_000);
    c.set("a", entry(1000));
    c.set("enorme", entry(100_000));
    expect(c.get("enorme")).toBeUndefined();
    expect(c.get("a")).toBeDefined();
  });

  it("réécrire une clé existante remplace son poids au lieu de le cumuler", () => {
    const c = createPreviewCache(10_000);
    c.set("a", entry(1000));
    const after1 = c.bytes();
    c.set("a", entry(1000));
    expect(c.bytes()).toBe(after1);
    expect(c.keys()).toEqual(["a"]);
  });

  it("`delete` et `clear` libèrent les octets", () => {
    const c = createPreviewCache(10_000);
    c.set("a", entry(1000));
    c.delete("a");
    expect(c.bytes()).toBe(0);
    c.set("b", entry(1000));
    c.clear();
    expect(c.bytes()).toBe(0);
    expect(c.keys()).toEqual([]);
  });
});

describe("l'instance partagée", () => {
  it("existe et porte le budget documenté", () => {
    expect(PREVIEW_CACHE_MAX_BYTES).toBe(48 * 1024 * 1024);
    expect(typeof previewCache.get).toBe("function");
  });
});
