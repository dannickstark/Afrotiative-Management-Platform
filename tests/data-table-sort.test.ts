import { describe, it, expect } from "bun:test";
import { nextSortDir } from "@/components/ui/data-table-sort";

describe("nextSortDir cycle", () => {
  it("false → asc", () => expect(nextSortDir(false)).toBe("asc"));
  it("asc → desc", () => expect(nextSortDir("asc")).toBe("desc"));
  it("desc → false", () => expect(nextSortDir("desc")).toBe(false));
});
