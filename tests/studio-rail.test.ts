// tests/studio-rail.test.ts — the rail's behaviour, not its pixels
import { describe, expect, it } from "bun:test";
import { nextOpenPanel } from "@/lib/studio/editor-prefs";

describe("rail selection semantics", () => {
  it("clicking a closed category opens it", () => {
    expect(nextOpenPanel(null, "texte")).toBe("texte");
  });
  it("clicking a different category switches without collapsing", () => {
    expect(nextOpenPanel("calques", "texte")).toBe("texte");
  });
  it("clicking the OPEN category collapses the panel", () => {
    expect(nextOpenPanel("texte", "texte")).toBe(null);
  });
});
