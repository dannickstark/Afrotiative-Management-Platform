import { describe, it, expect } from "bun:test";
import { deriveRegenHeader, summarizeRegenJob, STAGE_LABELS, type RegenJobView } from "@/lib/pipeline/regen-live";

function job(over: Partial<RegenJobView> = {}): RegenJobView {
  return { id: "j1", total: 3, done: 1, status: "running", imageMode: "auto", items: [], ...over };
}

describe("deriveRegenHeader", () => {
  it("montre l'étape en cours de l'article courant", () => {
    const h = deriveRegenHeader(job({
      items: [
        { id: "i1", articleId: "a1", title: "A", stage: "writing", status: "ok", message: null },
        { id: "i2", articleId: "a2", title: "B", stage: "extracting", status: "pending", message: null },
      ],
    }));
    expect(h.label).toBe("Extraction des sources — B");
    expect(h.done).toBe(1);
    expect(h.total).toBe(3);
  });

  it("sans article en cours, annonce la fin", () => {
    const h = deriveRegenHeader(job({ status: "done", done: 3, items: [] }));
    expect(h.label).toBe("Terminé");
    expect(h.percent).toBe(100);
  });

  it("un total à zéro ne divise pas par zéro", () => {
    expect(deriveRegenHeader(job({ total: 0, done: 0 })).percent).toBe(0);
  });

  it("arrondit le pourcentage", () => {
    expect(deriveRegenHeader(job({ total: 3, done: 1 })).percent).toBe(33);
  });

  it("un job annulé garde son avancement réel, il n'affiche pas 100 %", () => {
    const h = deriveRegenHeader(job({ status: "cancelled", total: 10, done: 3, items: [] }));
    expect(h.label).toBe("Annulé");
    expect(h.percent).toBe(30);
  });

  it("un job en échec s'annonce comme tel, pas « Terminé »", () => {
    const h = deriveRegenHeader(job({ status: "failed", total: 10, done: 3, items: [] }));
    expect(h.label).toBe("Échec");
    expect(h.percent).toBe(30);
  });

  it("un job qui tourne sans article encore démarré annonce la préparation", () => {
    const h = deriveRegenHeader(job({
      status: "running", total: 2, done: 0,
      items: [
        { id: "i1", articleId: "a1", title: "Alpha", stage: "queued", status: "pending", message: null },
        { id: "i2", articleId: "a2", title: "Bravo", stage: "queued", status: "pending", message: null },
      ],
    }));
    expect(h.label).toBe("Préparation…");
    expect(h.percent).toBe(0);
  });
});

describe("summarizeRegenJob", () => {
  it("compte succès, échecs et images en attente", () => {
    const s = summarizeRegenJob(job({
      items: [
        { id: "1", articleId: "a", title: "A", stage: "writing", status: "ok", message: null },
        { id: "2", articleId: "b", title: "B", stage: "writing", status: "failed", message: "boum" },
        { id: "3", articleId: "c", title: "C", stage: "extracting", status: "awaiting_image", message: null },
        { id: "4", articleId: "d", title: "D", stage: "queued", status: "pending", message: null },
      ],
    }));
    expect(s).toEqual({ ok: 1, failed: 1, awaitingImage: 1 });
  });
});

describe("STAGE_LABELS", () => {
  it("couvre les quatre étapes en français", () => {
    expect(STAGE_LABELS.queued).toBe("En attente");
    expect(STAGE_LABELS.extracting).toBe("Extraction des sources");
    expect(STAGE_LABELS.generating).toBe("Génération IA");
    expect(STAGE_LABELS.writing).toBe("Écriture");
  });
});
