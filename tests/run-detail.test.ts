import { describe, it, expect } from "bun:test";
import { groupSteps } from "@/lib/queries/runs";

describe("groupSteps", () => {
  it("splits feed-level steps from per-item groups and flags failures", () => {
    const steps = [
      { id: "1", name: "Lecture du flux", status: "success", rawItemId: null, errorMessage: null, errorTechnical: null, durationMs: 10 },
      { id: "2", name: "Extraction du contenu", status: "success", rawItemId: "ri1", errorMessage: null, errorTechnical: null, durationMs: 20 },
      { id: "3", name: "Génération IA", status: "failed", rawItemId: "ri1", errorMessage: "La génération a échoué.", errorTechnical: "stack…", durationMs: 30 },
    ] as any;
    const meta = new Map([["ri1", { title: "La BRVM progresse", url: "https://x/a" }]]);
    const g = groupSteps(steps, meta);
    expect(g.feedSteps.map((s) => s.id)).toEqual(["1"]);
    expect(g.items).toHaveLength(1);
    expect(g.items[0]).toMatchObject({ rawItemId: "ri1", title: "La BRVM progresse", hasFailure: true });
    expect(g.items[0].steps.map((s) => s.id)).toEqual(["2", "3"]);
  });
});
