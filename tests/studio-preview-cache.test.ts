import { describe, it, expect } from "bun:test";
import {
  previewCacheKey, previewKeyFor, createPreviewCache, PREVIEW_CACHE_MAX_BYTES, previewCache,
  type CachedPreview,
} from "@/lib/studio/preview-cache";
import { sceneForFormat } from "@/lib/studio/relayout";
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

  it("les limites de champs ne peuvent pas être décalées par le contenu — même avec `templateId` contenant le séparateur", () => {
    // Si la clé était naïvement `.join("|")`, ces deux appels produiraient la même clé :
    //   ["tpl", "ig_portrait", "story|x", len, hash].join("|")  →  "tpl|ig_portrait|story|x|len|hash"
    //   ["tpl|ig_portrait", "story", "x", len, hash].join("|")  →  "tpl|ig_portrait|story|x|len|hash"
    // Avec JSON.stringify, les limites de champs sont explicites et immuables, donc les deux clés diffèrent.
    const a = previewCacheKey("tpl", fixtureScene(), "ig_portrait", "story|x");
    const b = previewCacheKey("tpl|ig_portrait", fixtureScene(), "story", "x");
    expect(a).not.toBe(b);
  });
});

// previewKeyFor — correctif de revue finale, Important 2 : hooks/use-preview.ts (le chemin de
// PREVIEW, une tuile de la planche ou l'inspection d'un format) et
// components/studio/render/export.ts (le chemin d'EXPORT, « Tout télécharger ») construisaient
// chacun leur propre clé de cache — même recette (`sceneForFormat` puis `previewCacheKey`), mais
// réécrite deux fois. Rien ne garantissait que les deux copies restent identiques : une divergence
// future (par ex. un des deux chemins qui se remettrait à hacher la scène de BASE plutôt que sa
// variante relayoutée) aurait fait manquer silencieusement les huit entrées du mémo à l'export, sans
// qu'aucun test ne rougisse. Les deux chemins appellent maintenant CETTE fonction — les tests
// ci-dessous pinnent son comportement, ce qui pinne la parité des deux chemins PAR CONSTRUCTION :
// tant qu'ils lui passent les mêmes `templateId`/`scene`/`format`/`nativeFormat`/`articleId`, ils ne
// peuvent PAS obtenir de clés différentes.
describe("previewKeyFor (lib/studio/preview-cache.ts) — le point de passage UNIQUE des deux chemins (hook de preview ET export.ts)", () => {
  it("applique RÉELLEMENT sceneForFormat avant de hacher — la clé égale previewCacheKey(templateId, sceneForFormat(scene, format, native), format, articleId)", () => {
    const scene = fixtureScene();
    const { key, scene: variant } = previewKeyFor(TPL, scene, "story", "ig_portrait", null);
    const expectedVariant = sceneForFormat(scene, "story", "ig_portrait");
    expect(variant).toEqual(expectedVariant);
    expect(key).toBe(previewCacheKey(TPL, expectedVariant, "story", null));
    // Un format DIFFÉRENT de l'accueil relayoute réellement — la variante n'est donc pas la scène
    // de base inchangée (sans quoi ce test ne distinguerait pas « relayoute » de « passe telle quelle »).
    expect(variant).not.toEqual(scene);
  });

  it("au format d'accueil (format === nativeFormat) : identité EXACTE, même référence de scène — aucun relayout inutile", () => {
    const scene = fixtureScene();
    const { key, scene: variant } = previewKeyFor(TPL, scene, "ig_portrait", "ig_portrait", null);
    expect(variant).toBe(scene);
    expect(key).toBe(previewCacheKey(TPL, scene, "ig_portrait", null));
  });

  it("deux appels indépendants — un pour le chemin PREVIEW (une tuile), un pour le chemin EXPORT (« Tout télécharger ») — avec les MÊMES entrées produisent la MÊME clé, même à partir de deux objets scène distincts", () => {
    // Simule l'écart réel entre les deux appelants : le hook de preview reçoit la scène telle que
    // gardée en état React (référence stable), l'export en reçoit une copie fraîchement passée en
    // argument (JSON.parse(JSON.stringify(...))). previewCacheKey hache par CONTENU, jamais par
    // identité d'objet (voir sa description) — ce test le vérifie au niveau de previewKeyFor.
    const sceneFromHookState = fixtureScene();
    const sceneFromExportCall: Scene = JSON.parse(JSON.stringify(sceneFromHookState));
    const fromPreviewPath = previewKeyFor(TPL, sceneFromHookState, "story", "ig_portrait", "art-1");
    const fromExportPath = previewKeyFor(TPL, sceneFromExportCall, "story", "ig_portrait", "art-1");
    expect(fromExportPath.key).toBe(fromPreviewPath.key);
  });

  it("`format`/`nativeFormat` absents : la scène passe TELLE QUELLE, sans tenter de relayouter (sonde de test qui n'exerce pas la relève par format)", () => {
    const scene = fixtureScene();
    const { key, scene: variant } = previewKeyFor(TPL, scene, undefined, undefined, null);
    expect(variant).toBe(scene);
    expect(key).toBe(previewCacheKey(TPL, scene, undefined, null));
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

describe("createPreviewCache — deleteByTemplate (chantier D, Tâche 6, correctif de revue)", () => {
  it("supprime les entrées du gabarit A, laisse intactes celles du gabarit B", () => {
    const c = createPreviewCache(10_000);
    const keyA = previewCacheKey("tpl-a", fixtureScene(), "ig_portrait", null);
    const keyB = previewCacheKey("tpl-b", fixtureScene(), "ig_portrait", null);
    c.set(keyA, entry(100));
    c.set(keyB, entry(100));
    const dropped = c.deleteByTemplate("tpl-a");
    expect(dropped).toBe(1);
    expect(c.get(keyA)).toBeUndefined();
    expect(c.get(keyB)).toBeDefined();
  });

  // Le cas qui piège un `startsWith` naïf sur la clé BRUTE (non décodée) : "tpl" est un préfixe
  // littéral de "tpl-2", et la clé encodée de "tpl-2" (`["tpl-2", …]`) commence bien par la chaîne
  // `["tpl` — le même préfixe que celle de "tpl" (`["tpl",…]`) jusqu'à la virgule. Seule la
  // comparaison sur le PREMIER ÉLÉMENT DÉCODÉ (JSON.parse(key)[0] === templateId) distingue les deux.
  it("un templateId préfixe d'un autre (« tpl » vs « tpl-2 ») n'évince PAS l'autre gabarit", () => {
    const c = createPreviewCache(10_000);
    const keyShort = previewCacheKey("tpl", fixtureScene(), "ig_portrait", null);
    const keyLong = previewCacheKey("tpl-2", fixtureScene(), "ig_portrait", null);
    c.set(keyShort, entry(100));
    c.set(keyLong, entry(100));

    const droppedShort = c.deleteByTemplate("tpl");
    expect(droppedShort).toBe(1);
    expect(c.get(keyShort)).toBeUndefined();
    expect(c.get(keyLong)).toBeDefined(); // "tpl-2" doit survivre à l'éviction de "tpl"

    const droppedLong = c.deleteByTemplate("tpl-2");
    expect(droppedLong).toBe(1);
    expect(c.get(keyLong)).toBeUndefined();
  });

  it("templateId absent du cache : ne supprime rien, renvoie 0", () => {
    const c = createPreviewCache(10_000);
    const key = previewCacheKey("tpl-a", fixtureScene(), "ig_portrait", null);
    c.set(key, entry(100));
    expect(c.deleteByTemplate("tpl-inconnu")).toBe(0);
    expect(c.get(key)).toBeDefined();
  });
});

describe("l'instance partagée", () => {
  it("existe et porte le budget documenté", () => {
    expect(PREVIEW_CACHE_MAX_BYTES).toBe(48 * 1024 * 1024);
    expect(typeof previewCache.get).toBe("function");
  });
});
