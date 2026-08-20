import { expect, test } from "bun:test";
import { scopeFromRow } from "@/lib/mcp/oauth-scope";

test("défaut conservateur quand aucune ligne", () => {
  expect(scopeFromRow(null)).toEqual({ canWrite: true, canReadArticles: false });
});

test("reflète les deux axes de la ligne", () => {
  expect(scopeFromRow({ canWrite: false, canReadArticles: true })).toEqual({
    canWrite: false,
    canReadArticles: true,
  });
});
