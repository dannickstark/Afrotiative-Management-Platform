import { describe, it, expect } from "bun:test";
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

describe("NullAssetLoader", () => {
  it("ne fournit ni police ni image", async () => {
    const loader = new NullAssetLoader();
    expect(await loader.font("whatever")).toBeNull();
    expect(await loader.imageUrl("whatever")).toBeNull();
  });
});
