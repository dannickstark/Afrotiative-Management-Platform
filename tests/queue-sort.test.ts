import { describe, it, expect } from "bun:test";
// Importé depuis le module pur sibling (queue-sort.ts), pas depuis lib/queries/queue.ts, qui
// instancie le client DB au chargement — ce test doit rester exécutable sans DB.
import { resolveQueueSort } from "@/lib/queries/queue-sort";

describe("resolveQueueSort", () => {
  it("maps known column+dir", () => {
    expect(resolveQueueSort("score", "asc")).toEqual({ column: "score", direction: "asc" });
  });

  it("defaults unknown column to date, direction still honored independently", () => {
    // La colonne retombe sur "date" (liste blanche), mais la direction reste calculée
    // indépendamment de la validité de la colonne — cf. la formule de l'IMPLEMENT du plan :
    // `direction = dir === "asc" ? "asc" : "desc"`, sans condition sur `column`.
    expect(resolveQueueSort("evil;DROP", "asc")).toEqual({ column: "date", direction: "asc" });
  });

  it("unknown column with no dir falls back fully to date desc", () => {
    expect(resolveQueueSort("evil;DROP")).toEqual({ column: "date", direction: "desc" });
  });

  it("defaults bad dir to desc", () => {
    expect(resolveQueueSort("title", "sideways").direction).toBe("desc");
  });

  it("accepts every allowlisted column", () => {
    for (const c of ["title", "category", "score", "date", "source", "status"] as const) {
      expect(resolveQueueSort(c, "asc")).toEqual({ column: c, direction: "asc" });
    }
  });

  it("defaults to date desc with no params", () => {
    expect(resolveQueueSort()).toEqual({ column: "date", direction: "desc" });
  });
});
