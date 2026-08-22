import { expect, test } from "bun:test";
import { HIGHLIGHT_COLORS, classForColor, colorForClass } from "@/lib/highlight";

test("classForColor / colorForClass aller-retour", () => {
  for (const c of HIGHLIGHT_COLORS) {
    expect(classForColor(c)).toBe(`hl-${c}`);
    expect(colorForClass(`hl-${c}`)).toBe(c);
  }
});
test("colorForClass rejette l'invalide", () => {
  expect(colorForClass("hl-x")).toBeNull();
  expect(colorForClass("hl-jaune evil")).toBeNull(); // exact match seulement
  expect(colorForClass("evil")).toBeNull();
  expect(colorForClass("")).toBeNull();
});
