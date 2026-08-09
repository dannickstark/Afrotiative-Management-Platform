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
