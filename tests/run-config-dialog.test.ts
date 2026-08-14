import { describe, it, expect } from "bun:test";
import { toCategoryIds } from "@/components/pipeline/run-config-dialog";

describe("toCategoryIds", () => {
  it("returns null when no categories are checked (= all categories)", () => {
    expect(toCategoryIds([])).toBeNull();
  });

  it("returns the checked ids when at least one is checked", () => {
    expect(toCategoryIds(["a", "b"])).toEqual(["a", "b"]);
  });
});
