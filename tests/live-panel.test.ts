import { describe, it, expect } from "bun:test";
import { ITEM_STAGES, deriveStepperNodes, computeEta, deriveHeader, formatClock } from "@/lib/pipeline/live";

describe("deriveStepperNodes", () => {
  it("marks completed stages done, the current stage current, the rest pending", () => {
    const nodes = deriveStepperNodes(
      [{ name: "Extraction du contenu", status: "success" }, { name: "Calcul de l'embedding", status: "success" }],
      "Regroupement (clustering)",
    );
    expect(nodes.map((n) => n.state)).toEqual(["done", "done", "current", "pending", "pending"]);
    expect(nodes).toHaveLength(ITEM_STAGES.length);
    expect(nodes[3].label).toBe("Génération IA"); // short label preserved for the long stage too
  });

  it("marks a failed stage failed and freezes the rest as pending", () => {
    const nodes = deriveStepperNodes(
      [{ name: "Extraction du contenu", status: "success" }, { name: "Regroupement (clustering)", status: "failed" }],
      null,
    );
    expect(nodes.map((n) => n.state)).toEqual(["done", "pending", "failed", "pending", "pending"]);
  });

  it("keeps a stage AFTER a failure pending even when it is the currentStage (freeze wins)", () => {
    const nodes = deriveStepperNodes(
      [{ name: "Regroupement (clustering)", status: "failed" }],
      "Génération IA", // names a stage after the failed one — must NOT become "current"
    );
    expect(nodes.map((n) => n.state)).toEqual(["pending", "pending", "failed", "pending", "pending"]);
    expect(nodes[3].state).toBe("pending"); // "Génération IA" frozen, not "current"
  });
});

describe("computeEta", () => {
  it("returns null before 2 items or with unknown total", () => {
    expect(computeEta({ startedAtMs: 0, nowMs: 10_000, processedItems: 1, totalItems: 10 })).toBeNull();
    expect(computeEta({ startedAtMs: 0, nowMs: 10_000, processedItems: 5, totalItems: null })).toBeNull();
  });
  it("estimates remaining = avg-per-item × items left", () => {
    // 4 items in 40s → 10s/item; 6 remaining → 60_000 ms
    expect(computeEta({ startedAtMs: 0, nowMs: 40_000, processedItems: 4, totalItems: 10 })).toBe(60_000);
  });
});

describe("deriveHeader", () => {
  it("uses feed counts during reading_feeds", () => {
    expect(deriveHeader({ phase: "reading_feeds", feedsRead: 3, feedsTotal: 6, processedItems: 0, totalItems: null }))
      .toEqual({ phaseLabel: "Lecture des flux", numerator: 3, denominator: 6, percent: 50 });
  });
  it("uses item counts during processing_items", () => {
    expect(deriveHeader({ phase: "processing_items", feedsRead: 6, feedsTotal: 6, processedItems: 8, totalItems: 20 }))
      .toEqual({ phaseLabel: "Traitement des éléments", numerator: 8, denominator: 20, percent: 40 });
  });
  it("reports 100% while finalizing", () => {
    expect(deriveHeader({ phase: "finalizing", feedsRead: 6, feedsTotal: 6, processedItems: 20, totalItems: 20 }).percent).toBe(100);
  });
  it("clamps percent to 100 when the numerator exceeds the denominator", () => {
    // processedItems (21) > totalItems (20) — e.g. a stale/racy counter update — must never
    // read as >100% in the header progress bar.
    expect(deriveHeader({ phase: "processing_items", feedsRead: 6, feedsTotal: 6, processedItems: 21, totalItems: 20 }).percent).toBe(100);
    expect(deriveHeader({ phase: "reading_feeds", feedsRead: 7, feedsTotal: 6, processedItems: 0, totalItems: null }).percent).toBe(100);
  });
});

describe("formatClock", () => {
  it("formats mm:ss", () => {
    expect(formatClock(72_000)).toBe("01:12");
    expect(formatClock(5_000)).toBe("00:05");
  });
});
