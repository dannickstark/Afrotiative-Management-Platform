import { expect, test } from "bun:test";
import { BEAT_KIND_LABEL, INSERT_KIND_LABEL, LINK_STATUS_LABEL, plural } from "@/lib/video/labels";

test("libellés d'insert couvrent l'enum insert_kind", () => {
  for (const k of ["image", "video", "extrait", "graphique", "fichier"]) {
    expect(INSERT_KIND_LABEL[k]).toBeTruthy();
  }
});

test("libellés de statut de lien, orientés monteur", () => {
  expect(LINK_STATUS_LABEL.non_verifie).toBe("À vérifier");
  expect(LINK_STATUS_LABEL.mort).toBe("Mort");
  expect(LINK_STATUS_LABEL.ok).toBe("OK");
  expect(LINK_STATUS_LABEL.interdit).toBe("Interdit");
});

test("libellés de beat couvrent l'enum beat_kind", () => {
  for (const k of ["narration", "question", "reponse", "insert", "broll", "transition", "texte_ecran", "son", "note"]) {
    expect(BEAT_KIND_LABEL[k]).toBeTruthy();
  }
});

test("plural accorde au-delà de 1 et garde le singulier à 0 et 1", () => {
  expect(plural(0, "beat")).toBe("beat");
  expect(plural(1, "beat")).toBe("beat");
  expect(plural(2, "beat")).toBe("beats");
  expect(plural(12, "prise")).toBe("prises");
});
