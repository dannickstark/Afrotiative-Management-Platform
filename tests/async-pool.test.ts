import { expect, test } from "bun:test";
import { mapWithConcurrency } from "@/lib/async-pool";

test("traite tous les éléments, jamais plus de `limit` en vol", async () => {
  let inFlight = 0, maxSeen = 0;
  const items = Array.from({ length: 10 }, (_, i) => i);
  const out = await mapWithConcurrency(items, 3, async (n) => {
    inFlight++; maxSeen = Math.max(maxSeen, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--; return n * 2;
  });
  expect(out).toEqual(items.map((n) => n * 2));
  expect(maxSeen).toBeLessThanOrEqual(3);
});

test("liste vide → []", async () => {
  expect(await mapWithConcurrency([], 3, async () => 1)).toEqual([]);
});
