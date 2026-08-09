import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { friendlyPreviewMessage, PreviewTabContent } from "@/components/article/image-panel";

// tests/article-preview-incomplete.test.ts — V3 Tâche 4 (V1 §3 dette assignée à V3) : « un article
// sans image à la une ou sans catégorie fait échouer le rendu (échec dur, conforme au spec V1 §6).
// L'interface doit le dire intelligiblement : le message du moteur nomme déjà les jetons manquants ;
// l'onglet les présente comme une liste d'informations à compléter, pas comme une erreur
// technique. » Couvre à la fois la fonction PURE (friendlyPreviewMessage) et le composant qui
// l'utilise (PreviewTabContent), même répartition que tests/article-preview.test.ts.
describe("friendlyPreviewMessage — traduit les jetons manquants en champs reconnaissables", () => {
  it("« article.image » manquant produit un texte nommant « image à la une », pas le jeton technique", () => {
    const msg = friendlyPreviewMessage("Génération de l'image échouée — Valeurs manquantes pour : article.image.");
    expect(msg.toLowerCase()).toContain("image à la une");
    expect(msg).not.toContain("article.image");
  });

  it("« category.name » manquant produit un texte nommant « catégorie », pas le jeton technique", () => {
    const msg = friendlyPreviewMessage("Génération de l'image échouée — Valeurs manquantes pour : category.name.");
    expect(msg.toLowerCase()).toContain("catégorie");
    expect(msg).not.toContain("category.name");
  });

  it("les deux manques ensemble sont traduits, dans l'ordre renvoyé par le moteur", () => {
    const msg = friendlyPreviewMessage(
      "Génération de l'image échouée — Valeurs manquantes pour : article.image, category.name.",
    );
    expect(msg).toBe("Informations manquantes : Image à la une, Catégorie.");
  });

  it("un message qui ne nomme aucun jeton manquant (stockage, article introuvable…) ressort inchangé", () => {
    expect(friendlyPreviewMessage("Stockage R2 non configuré.")).toBe("Stockage R2 non configuré.");
    expect(friendlyPreviewMessage("Article introuvable.")).toBe("Article introuvable.");
    expect(friendlyPreviewMessage("Aperçu indisponible pour le moment.")).toBe("Aperçu indisponible pour le moment.");
  });

  it("un jeton manquant SANS traduction connue (hors V1 §6) reste affiché sous sa forme brute plutôt qu'avalé", () => {
    // brand.logo peut manquer (STUDIO_BRAND_LOGO_URL non configuré) sans que ce soit l'un des deux
    // cas que V1 §6 fait échouer par construction — RENDER_TOKEN_LABEL ne le couvre délibérément
    // pas ; le nom technique doit rester visible plutôt que de disparaître silencieusement.
    const msg = friendlyPreviewMessage("Génération de l'image échouée — Valeurs manquantes pour : brand.logo.");
    expect(msg).toContain("brand.logo");
  });
});

function renderPreviewFailure(message: string): string {
  return renderToStaticMarkup(
    React.createElement(PreviewTabContent, {
      state: { status: "done", result: { ok: false, reason: "render_failed", message } },
    }),
  );
}

describe("PreviewTabContent — checklist lisible pour un article incomplet (intégration)", () => {
  it("image à la une manquante : le checklist affiché nomme le champ, jamais le jeton technique", () => {
    const html = renderPreviewFailure("Génération de l'image échouée — Valeurs manquantes pour : article.image.");
    expect(html.toLowerCase()).toContain("image à la une");
    expect(html).not.toContain("article.image");
  });

  it("catégorie manquante : le checklist affiché nomme le champ, jamais le jeton technique", () => {
    const html = renderPreviewFailure("Génération de l'image échouée — Valeurs manquantes pour : category.name.");
    expect(html.toLowerCase()).toContain("catégorie");
    expect(html).not.toContain("category.name");
  });

  it("les deux manques ensemble : le checklist les nomme tous les deux dans le même message", () => {
    const html = renderPreviewFailure(
      "Génération de l'image échouée — Valeurs manquantes pour : article.image, category.name.",
    );
    expect(html.toLowerCase()).toContain("image à la une");
    expect(html).toContain("Catégorie");
    expect(html).toContain("Informations manquantes");
  });
});
