import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { RegenProgressView } from "@/components/queue/regen-progress";
import type { RegenJobView } from "@/lib/pipeline/regen-live";

const job: RegenJobView = {
  id: "j1", total: 3, done: 1, status: "running", imageMode: "auto",
  items: [
    { id: "i1", articleId: "a1", title: "Alpha", stage: "writing", status: "ok", message: null },
    { id: "i2", articleId: "a2", title: "Bravo", stage: "generating", status: "pending", message: null },
    { id: "i3", articleId: "a3", title: "Charlie", stage: "queued", status: "pending", message: null },
  ],
};

describe("RegenProgressView", () => {
  it("affiche l'étape en cours, le compteur et la barre", () => {
    const html = renderToStaticMarkup(createElement(RegenProgressView, { job, onCancel: () => {} }));
    expect(html).toContain("Génération IA — Bravo");
    expect(html).toContain("1/3");
    expect(html).toContain("33%");
  });

  it("affiche le rapport d'échecs partiels", () => {
    const failed: RegenJobView = {
      ...job, status: "done", done: 3,
      items: [
        { id: "i1", articleId: "a1", title: "Alpha", stage: "writing", status: "ok", message: null },
        { id: "i2", articleId: "a2", title: "Bravo", stage: "extracting", status: "failed", message: "Aucune source à régénérer." },
        { id: "i3", articleId: "a3", title: "Charlie", stage: "extracting", status: "awaiting_image", message: null },
      ],
    };
    const html = renderToStaticMarkup(createElement(RegenProgressView, { job: failed, onCancel: () => {} }));
    expect(html).toContain("Bravo");
    expect(html).toContain("Aucune source à régénérer.");
    expect(html).toContain("1 image à choisir");
  });
});
