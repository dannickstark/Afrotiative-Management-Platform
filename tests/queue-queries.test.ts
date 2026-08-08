import { describe, it, expect } from "bun:test";
import { parseQueueSearchParams, QUEUE_PAGE_SIZE } from "@/lib/queries/queue";

describe("parseQueueSearchParams", () => {
  it("sans paramètre, le périmètre est « en attente »", () => {
    const f = parseQueueSearchParams({});
    expect(f.status).toBe("pending");
    expect(f.page).toBe(1);
    expect(f.pageSize).toBe(QUEUE_PAGE_SIZE);
    expect(f.sort).toBe("oldest");
    expect(f.search).toBeUndefined();
    expect(f.categoryId).toBeUndefined();
    expect(f.source).toBeUndefined();
  });

  it("status=all lève le filtre de statut", () => {
    expect(parseQueueSearchParams({ status: "all" }).status).toBe("all");
  });

  it("accepte chaque statut connu", () => {
    for (const s of ["draft", "pending", "in_review", "approved", "published", "rejected"] as const) {
      expect(parseQueueSearchParams({ status: s }).status).toBe(s);
    }
  });

  it("un statut inconnu retombe sur « en attente »", () => {
    expect(parseQueueSearchParams({ status: "zzz" }).status).toBe("pending");
  });

  it("ignore les chaînes vides", () => {
    const f = parseQueueSearchParams({ q: "   ", cat: "", src: "" });
    expect(f.search).toBeUndefined();
    expect(f.categoryId).toBeUndefined();
    expect(f.source).toBeUndefined();
  });

  it("ne retient que les valeurs de source connues", () => {
    expect(parseQueueSearchParams({ src: "single" }).source).toBe("single");
    expect(parseQueueSearchParams({ src: "multiple" }).source).toBe("multiple");
    expect(parseQueueSearchParams({ src: "beaucoup" }).source).toBeUndefined();
  });

  it("ne retient que les tris connus", () => {
    expect(parseQueueSearchParams({ sort: "newest" }).sort).toBe("newest");
    expect(parseQueueSearchParams({ sort: "score" }).sort).toBe("score");
    expect(parseQueueSearchParams({ sort: "n'importe quoi" }).sort).toBe("oldest");
  });

  it("borne la page à 1 minimum", () => {
    expect(parseQueueSearchParams({ page: "0" }).page).toBe(1);
    expect(parseQueueSearchParams({ page: "-4" }).page).toBe(1);
    expect(parseQueueSearchParams({ page: "abc" }).page).toBe(1);
    expect(parseQueueSearchParams({ page: "3" }).page).toBe(3);
  });

  it("prend la première valeur d'un paramètre répété", () => {
    expect(parseQueueSearchParams({ q: ["alpha", "beta"] }).search).toBe("alpha");
  });
});
