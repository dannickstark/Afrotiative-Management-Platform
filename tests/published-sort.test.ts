import { describe, it, expect } from "bun:test";
// Imported from the pure sibling module (published-sort.ts), not from lib/queries/published.ts,
// which instantiates the DB client at load time — this test must stay runnable without a DB.
import { resolvePublishedSort } from "@/lib/queries/published-sort";

describe("resolvePublishedSort", () => {
  it("maps known column+dir", () => {
    expect(resolvePublishedSort("title", "asc")).toEqual({ column: "title", direction: "asc" });
  });

  it("defaults unknown column to publishedAt, direction still honored independently", () => {
    // The column falls back to "publishedAt" (allowlist), but the direction is still computed
    // independently of the column's validity — same formula as resolveQueueSort:
    // `direction = dir === "asc" ? "asc" : "desc"`, with no condition on `column`.
    expect(resolvePublishedSort("evil;DROP", "asc")).toEqual({ column: "publishedAt", direction: "asc" });
  });

  it("unknown column with no dir falls back fully to publishedAt desc", () => {
    expect(resolvePublishedSort("evil;DROP")).toEqual({ column: "publishedAt", direction: "desc" });
  });

  it("defaults bad dir to desc", () => {
    expect(resolvePublishedSort("category", "sideways").direction).toBe("desc");
  });

  it("accepts every allowlisted column", () => {
    for (const c of ["title", "category", "publishedAt", "author"] as const) {
      expect(resolvePublishedSort(c, "asc")).toEqual({ column: c, direction: "asc" });
    }
  });

  it("defaults to publishedAt desc with no params — reproduces the previous fixed orderBy", () => {
    expect(resolvePublishedSort()).toEqual({ column: "publishedAt", direction: "desc" });
  });
});
