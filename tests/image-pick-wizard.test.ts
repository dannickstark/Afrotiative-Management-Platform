import { describe, it, expect } from "bun:test";
import { nextPendingIndex, type PendingPick } from "@/components/queue/image-pick-wizard";

const picks: PendingPick[] = [
  { articleId: "a", title: "Alpha", currentImageUrl: null, candidates: [] },
  { articleId: "b", title: "Bravo", currentImageUrl: null, candidates: [] },
  { articleId: "c", title: "Charlie", currentImageUrl: null, candidates: [] },
];

describe("nextPendingIndex", () => {
  it("avance jusqu'au prochain non traité", () => {
    expect(nextPendingIndex(picks, new Set(["a"]), 0)).toBe(1);
  });
  it("saute plusieurs déjà traités", () => {
    expect(nextPendingIndex(picks, new Set(["a", "b"]), 0)).toBe(2);
  });
  it("renvoie null quand tout est traité", () => {
    expect(nextPendingIndex(picks, new Set(["a", "b", "c"]), 0)).toBeNull();
  });
  it("boucle sur le début pour rattraper un « Passer »", () => {
    expect(nextPendingIndex(picks, new Set(["c"]), 2)).toBe(0);
  });
});
