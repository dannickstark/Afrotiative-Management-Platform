import { describe, it, expect } from "bun:test";
import { mockEmbed, cosine } from "@/lib/embeddings";

describe("embeddings", () => {
  it("mockEmbed is deterministic, 1024-dim, unit-normalized", () => {
    const a = mockEmbed("La BRVM progresse", 1024), b = mockEmbed("La BRVM progresse", 1024);
    expect(a.length).toBe(1024);
    expect(a).toEqual(b);
    expect(cosine(a, b)).toBeCloseTo(1, 5);
  });
  it("cosine of orthogonal-ish differs from identical", () => {
    const a = mockEmbed("texte A", 1024), c = mockEmbed("texte totalement different", 1024);
    expect(cosine(a, c)).toBeLessThan(0.999);
  });
});
