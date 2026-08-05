import { describe, it, expect } from "bun:test";
import { isWithinRecency, narrowByRecency } from "@/lib/pipeline/recency";

describe("isWithinRecency", () => {
  const cutoff = new Date("2026-08-05T00:00:00.000Z");

  it("keeps an item published at or after the cutoff", () => {
    expect(isWithinRecency("2026-08-05T00:00:00.000Z", cutoff)).toBe(true); // exact boundary
    expect(isWithinRecency("2026-08-06T12:00:00.000Z", cutoff)).toBe(true);
  });
  it("drops an item published before the cutoff", () => {
    expect(isWithinRecency("2026-08-01T00:00:00.000Z", cutoff)).toBe(false);
  });
  it("keeps an item with no date (undated-include policy)", () => {
    expect(isWithinRecency(null, cutoff)).toBe(true);
  });
  it("keeps an item with an unparseable date", () => {
    expect(isWithinRecency("not-a-date", cutoff)).toBe(true);
  });
  it("keeps everything when there is no cutoff", () => {
    expect(isWithinRecency("1999-01-01T00:00:00.000Z", null)).toBe(true);
  });
});

describe("narrowByRecency", () => {
  const iso = (t: { id?: string; isoDate: string | null }) => t.isoDate;
  it("returns all items when at or under the cap", () => {
    const items = [{ isoDate: "2026-08-05T00:00:00.000Z" }, { isoDate: null }];
    const r = narrowByRecency(items, iso, 2);
    expect(r.kept).toEqual(items);
    expect(r.dropped).toEqual([]);
  });
  it("keeps the most-recent maxItems and drops the older rest (input unsorted)", () => {
    const a = { id: "a", isoDate: "2026-08-06T00:00:00.000Z" };
    const b = { id: "b", isoDate: "2026-08-05T00:00:00.000Z" };
    const c = { id: "c", isoDate: "2026-08-04T00:00:00.000Z" };
    const r = narrowByRecency([b, a, c], iso, 2);
    expect(r.kept.map((x) => x.id)).toEqual(["a", "b"]);
    expect(r.dropped.map((x) => x.id)).toEqual(["c"]);
  });
  it("ranks undated items as oldest (dropped first), stable among themselves", () => {
    const a = { id: "a", isoDate: "2026-08-06T00:00:00.000Z" };
    const d1 = { id: "d1", isoDate: null };
    const d2 = { id: "d2", isoDate: null };
    const r = narrowByRecency([d1, a, d2], iso, 1);
    expect(r.kept.map((x) => x.id)).toEqual(["a"]);
    expect(r.dropped.map((x) => x.id)).toEqual(["d1", "d2"]);
  });
});
