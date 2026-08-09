import { describe, it, expect } from "bun:test";
import { tmpdir } from "node:os";
import { loadFallbackFonts, FALLBACK_FONT_FAMILY, NullAssetLoader } from "@/lib/studio/fonts";

describe("loadFallbackFonts", () => {
  it("charge trois graisses de la police de repli", async () => {
    const fonts = await loadFallbackFonts();
    expect(fonts.map((f) => f.weight).sort((a, b) => a - b)).toEqual([400, 600, 700]);
    for (const f of fonts) {
      expect(f.name).toBe(FALLBACK_FONT_FAMILY);
      expect(f.data.byteLength).toBeGreaterThan(10_000);
      expect(f.style).toBe("normal");

      // Vérifie que les données sont un vrai TTF en commençant par la signature TrueType « 00 01 00 00 »
      const header = new Uint8Array(f.data, 0, 4);
      expect(Array.from(header)).toEqual([0x00, 0x01, 0x00, 0x00]);
    }
  });

  it("mémoïse : deux appels renvoient les mêmes tampons", async () => {
    const a = await loadFallbackFonts();
    const b = await loadFallbackFonts();
    expect(a[0].data).toBe(b[0].data);
  });
});

// Important 2 (revue de branche) : `fallbackPromise ??= …` ne remplace jamais une promesse REJETÉE
// (elle n'est pas `null`), donc un seul échec transitoire (EMFILE, process.cwd() pas à la racine du
// dépôt…) empoisonnait TOUS les appels suivants du process pour toujours avec la même rejection.
//
// Isolé dans une instance FRAÎCHE du module (import dynamique avec un paramètre de requête qui
// contourne le cache de modules de Bun) : le module réel importé en haut de ce fichier est partagé
// par tout le reste de la suite (studio-render.test.ts en dépend aussi), donc forcer volontairement
// un rejet dessus empoisonnerait des tests sans rapport si l'assertion ci-dessous échouait avant
// d'avoir restauré process.cwd(). Une instance dédiée rend ce test sans risque pour le reste de la
// suite, sans toucher à la forme du module fonts.ts pour autant (aucun hook de test ajouté au
// module lui-même).
describe("loadFallbackFonts — réarmement après un échec (Important 2)", () => {
  it("un rejet ne condamne pas les appels suivants : le prochain retente une lecture fraîche et réussit", async () => {
    const projectRoot = process.cwd();
    const fresh: typeof import("@/lib/studio/fonts") =
      await import(`../lib/studio/fonts.ts?studio-fonts-retry-test=${Date.now()}`);

    // Force un ENOENT : process.cwd() ne contient plus lib/studio/fonts/*.ttf le temps de cet appel.
    process.chdir(tmpdir());
    try {
      await expect(fresh.loadFallbackFonts()).rejects.toThrow();
    } finally {
      process.chdir(projectRoot); // TOUJOURS restauré, même si l'assertion ci-dessus échoue
    }

    // Même instance de module, AUCUNE autre action : avec le bug (`??=` sur une promesse rejetée),
    // cet appel renverrait encore la même rejection indéfiniment. Avec le correctif
    // (fallbackPromise remis à null au rejet), il retente une lecture fraîche et réussit.
    const fonts = await fresh.loadFallbackFonts();
    expect(fonts).toHaveLength(3);
    expect(fonts.every((f) => f.name === fresh.FALLBACK_FONT_FAMILY)).toBe(true);
  });
});

describe("NullAssetLoader", () => {
  it("ne fournit ni police ni image", async () => {
    const loader = new NullAssetLoader();
    expect(await loader.font("whatever")).toBeNull();
    expect(await loader.imageUrl("whatever")).toBeNull();
  });
});
