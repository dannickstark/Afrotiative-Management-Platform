import { describe, it, expect } from "bun:test";
import { runParamsSchema } from "@/lib/validation";

const past = "2026-08-01T00:00:00.000Z";
const future = "3000-01-01T00:00:00.000Z";

describe("runParamsSchema", () => {
  it("accepts an age recency with valid feeds and maxItems", () => {
    const r = runParamsSchema.safeParse({
      recency: { kind: "age", hours: 48 },
      feedIds: ["11111111-1111-1111-8111-111111111111"],
      maxItems: 20,
    });
    expect(r.success).toBe(true);
  });
  it("accepts an absolute 'since' in the past, and 'none', and an empty input", () => {
    expect(runParamsSchema.safeParse({ recency: { kind: "since", at: past } }).success).toBe(true);
    expect(runParamsSchema.safeParse({ recency: { kind: "none" } }).success).toBe(true);
    expect(runParamsSchema.safeParse({}).success).toBe(true);
  });
  it("rejects a non-positive or too-large age", () => {
    expect(runParamsSchema.safeParse({ recency: { kind: "age", hours: 0 } }).success).toBe(false);
    expect(runParamsSchema.safeParse({ recency: { kind: "age", hours: 721 } }).success).toBe(false);
  });
  it("rejects a 'since' date in the future", () => {
    expect(runParamsSchema.safeParse({ recency: { kind: "since", at: future } }).success).toBe(false);
  });
  it("rejects a malformed feed id and an out-of-range maxItems", () => {
    expect(runParamsSchema.safeParse({ feedIds: ["not-a-uuid"] }).success).toBe(false);
    expect(runParamsSchema.safeParse({ maxItems: 0 }).success).toBe(false);
    expect(runParamsSchema.safeParse({ maxItems: 501 }).success).toBe(false);
  });
});
