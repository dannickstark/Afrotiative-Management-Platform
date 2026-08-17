import { describe, it, expect } from "bun:test";
import { parseQueueSearchParams, QUEUE_PAGE_SIZE } from "@/lib/queries/queue";

describe("parseQueueSearchParams", () => {
  it("sans paramètre, le périmètre est « en attente »", () => {
    const f = parseQueueSearchParams({});
    expect(f.status).toBe("pending");
    expect(f.page).toBe(1);
    expect(f.pageSize).toBe(QUEUE_PAGE_SIZE);
    // Arrivée nue : reproduit l'ancien tri par défaut (le plus ancien d'abord) — cf. le
    // traitement spécial du `?sort` absent dans parseQueueSearchParams (lib/queries/queue.ts).
    expect(f.sortColumn).toBe("date");
    expect(f.sortDirection).toBe("asc");
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

  it("ne retient que les colonnes de tri connues (task B2 — en-têtes cliquables)", () => {
    expect(parseQueueSearchParams({ sort: "score", dir: "asc" }).sortColumn).toBe("score");
    expect(parseQueueSearchParams({ sort: "score", dir: "asc" }).sortDirection).toBe("asc");
    // `?sort=` présent mais hors liste blanche retombe sur "date" — et, `?sort` étant présent,
    // sur la direction par défaut de resolveQueueSort ("desc"), pas sur le repli spécial de
    // l'arrivée nue (voir le test précédent).
    const f = parseQueueSearchParams({ sort: "n'importe quoi" });
    expect(f.sortColumn).toBe("date");
    expect(f.sortDirection).toBe("desc");
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

  it("?img=pending active le filtre du bac d'images", () => {
    expect(parseQueueSearchParams({ img: "pending" }).pendingImage).toBe(true);
  });
  it("une valeur img inconnue est ignorée", () => {
    expect(parseQueueSearchParams({ img: "nimporte" }).pendingImage).toBeUndefined();
    expect(parseQueueSearchParams({}).pendingImage).toBeUndefined();
  });
});
