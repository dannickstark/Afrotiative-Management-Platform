import { describe, expect, it } from "bun:test";
import { parseColor, hsvaToHex, hexToHsva, withAlpha, formatHex } from "@/lib/studio/color";

describe("parseColor", () => {
  it("lit #RRGGBB en HSVA opaque", () => {
    const c = parseColor("#ff0000")!;
    expect(c.h).toBeCloseTo(0, 5);
    expect(c.s).toBeCloseTo(1, 5);
    expect(c.v).toBeCloseTo(1, 5);
    expect(c.a).toBe(1);
  });
  it("lit #RGB (3 chiffres) comme sa forme longue", () => {
    expect(parseColor("#f00")).toEqual(parseColor("#ff0000"));
  });
  it("lit l'alpha #RRGGBBAA", () => {
    expect(parseColor("#ff000080")!.a).toBeCloseTo(0x80 / 255, 5);
  });
  it("transparent = alpha 0", () => { expect(parseColor("transparent")!.a).toBe(0); });
  it("renvoie null pour un jeton ou une saisie invalide", () => {
    expect(parseColor("{{brand.primary}}")).toBeNull();
    expect(parseColor("rouge")).toBeNull();
    expect(parseColor("#zzz")).toBeNull();
  });
});

describe("aller-retour hex↔hsva (la mutation est le juge)", () => {
  // BALAYAGE : un échantillon dense de hex doit revenir à lui-même via hsva à ±1/255.
  const samples = ["#000000", "#ffffff", "#3b82f6", "#e11d48", "#10b981", "#f59e0b", "#7c3aed", "#00000080"];
  for (const hex of samples) {
    it(`${hex} survit à l'aller-retour`, () => {
      expect(hsvaToHex(hexToHsva(hex)!)).toBe(hex.length === 7 ? hex : hex.toLowerCase());
    });
  }
  it("hsvaToHex omet l'alpha quand a===1", () => {
    expect(hsvaToHex({ h: 210, s: 0.5, v: 1, a: 1 })).toMatch(/^#[0-9a-f]{6}$/);
  });
  it("hsvaToHex inclut l'alpha quand a<1", () => {
    expect(hsvaToHex({ h: 210, s: 0.5, v: 1, a: 0.5 })).toMatch(/^#[0-9a-f]{8}$/);
  });
});

describe("withAlpha / formatHex", () => {
  it("withAlpha clampe à [0,1]", () => {
    expect(withAlpha({ h: 0, s: 0, v: 0, a: 1 }, 2).a).toBe(1);
    expect(withAlpha({ h: 0, s: 0, v: 0, a: 1 }, -1).a).toBe(0);
  });
  it("formatHex normalise la casse et la forme courte", () => {
    expect(formatHex("#F00")).toBe("#ff0000");
    expect(formatHex("#ABC123")).toBe("#abc123");
    expect(formatHex("pas une couleur")).toBeNull();
  });
});
