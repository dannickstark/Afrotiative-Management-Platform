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
  it("keeps equal non-null timestamps in stable (input) order", () => {
    const a = { id: "a", isoDate: "2026-08-05T00:00:00.000Z" };
    const b = { id: "b", isoDate: "2026-08-05T00:00:00.000Z" }; // same instant as a
    const c = { id: "c", isoDate: "2026-08-04T00:00:00.000Z" }; // older — dropped by the cap
    const r = narrowByRecency([a, b, c], iso, 2);
    expect(r.kept.map((x) => x.id)).toEqual(["a", "b"]);        // a before b preserved, not reordered
    expect(r.dropped.map((x) => x.id)).toEqual(["c"]);
  });
});

import { resolveRunParams, cutoffDate } from "@/lib/pipeline/run-params";

describe("resolveRunParams", () => {
  const now = new Date("2026-08-06T00:00:00.000Z");
  const defaults = { defaultMaxItemAgeHours: 72, maxItemsPerRun: 20 };

  it("resolves an 'age' input to a cutoff relative to now", () => {
    const p = resolveRunParams({ recency: { kind: "age", hours: 48 } }, defaults, now);
    expect(p.recency).toEqual({ kind: "age", hours: 48, cutoffAt: "2026-08-04T00:00:00.000Z" });
  });
  it("passes an absolute 'since' through as the cutoff", () => {
    const p = resolveRunParams({ recency: { kind: "since", at: "2026-08-05T09:00:00.000Z" } }, defaults, now);
    expect(p.recency).toEqual({ kind: "since", cutoffAt: "2026-08-05T09:00:00.000Z" });
  });
  it("honors an explicit 'none' even when a default exists", () => {
    expect(resolveRunParams({ recency: { kind: "none" } }, defaults, now).recency).toEqual({ kind: "none" });
  });
  it("falls back to the settings default when recency is omitted", () => {
    const p = resolveRunParams(undefined, defaults, now);
    expect(p.recency).toEqual({ kind: "age", hours: 72, cutoffAt: "2026-08-03T00:00:00.000Z" });
  });
  it("yields no cutoff when omitted and the default is null", () => {
    const p = resolveRunParams(undefined, { defaultMaxItemAgeHours: null, maxItemsPerRun: 20 }, now);
    expect(p.recency).toEqual({ kind: "none" });
  });
  it("defaults feedIds to null and maxItems to the settings value, but honors overrides", () => {
    expect(resolveRunParams(undefined, defaults, now).feedIds).toBeNull();
    expect(resolveRunParams(undefined, defaults, now).maxItems).toBe(20);
    const p = resolveRunParams({ feedIds: ["a"], maxItems: 5 }, defaults, now);
    expect(p.feedIds).toEqual(["a"]);
    expect(p.maxItems).toBe(5);
  });
});

describe("cutoffDate", () => {
  it("returns a Date for age/since and null for none", () => {
    expect(cutoffDate({ recency: { kind: "age", hours: 1, cutoffAt: "2026-08-06T00:00:00.000Z" }, feedIds: null, maxItems: 1 }))
      .toEqual(new Date("2026-08-06T00:00:00.000Z"));
    expect(cutoffDate({ recency: { kind: "none" }, feedIds: null, maxItems: 1 })).toBeNull();
  });
});
