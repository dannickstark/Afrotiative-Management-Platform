import { describe, it, expect } from "bun:test";
import {
  checkCompleteness, sortMissingFields, blockingGapsForArticle,
  excerptFromHtml, sourceForImage,
  BLOCKING_FIELDS, MISSING_FIELD_KEYS, MISSING_LABEL,
  type CompletenessDraft, type SourceRef,
} from "@/lib/pipeline/completeness";

const CATEGORIES = ["Économie", "Finance", "Tech"];
const SOURCES: SourceRef[] = [
  { mediaName: "Ecofin", url: "https://www.agenceecofin.com/article/123" },
  { mediaName: "Jeune Afrique", url: "https://www.jeuneafrique.com/xyz" },
];

function completeDraft(): CompletenessDraft {
  return {
    category: "Économie",
    bodyHtml: "<p>Un corps d'article suffisamment fourni pour un chapô.</p>",
    excerpt: "Un chapô existant.",
    tags: ["bceao", "inflation"],
    featuredImageUrl: "https://www.agenceecofin.com/img/photo.jpg",
    imageCredit: "Ecofin",
    imageSourceUrl: "https://www.agenceecofin.com/article/123",
    confidence: { categoryUncertain: false, imageMissing: false, clusterUncertain: false },
  };
}

describe("checkCompleteness", () => {
  it("un brouillon complet ne manque de rien", () => {
    expect(checkCompleteness(completeDraft(), SOURCES, CATEGORIES)).toEqual([]);
  });

  it("détecte l'absence de sources", () => {
    expect(checkCompleteness(completeDraft(), [], CATEGORIES)).toContain("sources");
  });

  it("détecte une catégorie hors liste", () => {
    const d = { ...completeDraft(), category: "Sport" };
    expect(checkCompleteness(d, SOURCES, CATEGORIES)).toContain("categoryId");
  });

  it("détecte une catégorie marquée incertaine par l'IA", () => {
    const d = completeDraft();
    d.confidence.categoryUncertain = true;
    expect(checkCompleteness(d, SOURCES, CATEGORIES)).toContain("categoryId");
  });

  it("détecte l'image absente", () => {
    const d = { ...completeDraft(), featuredImageUrl: null };
    expect(checkCompleteness(d, SOURCES, CATEGORIES)).toContain("featuredImageUrl");
  });

  it("ne réclame ni crédit ni source d'image quand il n'y a pas d'image", () => {
    const d = { ...completeDraft(), featuredImageUrl: null, imageCredit: null, imageSourceUrl: null };
    const missing = checkCompleteness(d, SOURCES, CATEGORIES);
    expect(missing).toContain("featuredImageUrl");
    expect(missing).not.toContain("imageCredit");
    expect(missing).not.toContain("imageSourceUrl");
  });

  it("réclame le crédit et la source quand une image est présente sans eux", () => {
    const d = { ...completeDraft(), imageCredit: "  ", imageSourceUrl: null };
    const missing = checkCompleteness(d, SOURCES, CATEGORIES);
    expect(missing).toContain("imageCredit");
    expect(missing).toContain("imageSourceUrl");
  });

  it("détecte chapô et tags vides", () => {
    const d = { ...completeDraft(), excerpt: "   ", tags: [] };
    const missing = checkCompleteness(d, SOURCES, CATEGORIES);
    expect(missing).toContain("excerpt");
    expect(missing).toContain("tags");
  });

  it("retourne les clés dans l'ordre canonique", () => {
    const d: CompletenessDraft = {
      category: "Sport", bodyHtml: "", excerpt: "", tags: [],
      featuredImageUrl: null, imageCredit: null, imageSourceUrl: null,
      confidence: {},
    };
    const missing = checkCompleteness(d, [], CATEGORIES);
    const indexes = missing.map((k) => MISSING_FIELD_KEYS.indexOf(k));
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });
});

describe("BLOCKING_FIELDS / MISSING_LABEL", () => {
  it("chaque clé a un libellé français", () => {
    for (const k of MISSING_FIELD_KEYS) expect(MISSING_LABEL[k]).toBeTruthy();
  });

  it("chapô et tags ne bloquent jamais", () => {
    expect(BLOCKING_FIELDS).not.toContain("excerpt");
    expect(BLOCKING_FIELDS).not.toContain("tags");
  });

  it("toute clé bloquante est une clé connue", () => {
    for (const k of BLOCKING_FIELDS) expect(MISSING_FIELD_KEYS).toContain(k);
  });
});

describe("sortMissingFields", () => {
  it("remet les clés dans l'ordre canonique et dédoublonne", () => {
    expect(sortMissingFields(["tags", "categoryId", "sources", "categoryId"]))
      .toEqual(["sources", "categoryId", "tags"]);
  });
});

describe("blockingGapsForArticle", () => {
  it("un article complet n'a aucun manque bloquant", () => {
    expect(blockingGapsForArticle({
      categoryId: "c1", categoryName: "Économie",
      featuredImageUrl: "https://ex.com/a.jpg", imageCredit: "Ecofin",
      imageSourceUrl: "https://ex.com/a", sourceCount: 2,
    })).toEqual([]);
  });

  it("catégorie non résolue → bloquant", () => {
    expect(blockingGapsForArticle({
      categoryId: null, categoryName: null,
      featuredImageUrl: "https://ex.com/a.jpg", imageCredit: "Ecofin",
      imageSourceUrl: "https://ex.com/a", sourceCount: 2,
    })).toContain("categoryId");
  });

  it("image absente → bloquant", () => {
    expect(blockingGapsForArticle({
      categoryId: "c1", categoryName: "Économie",
      featuredImageUrl: null, imageCredit: null, imageSourceUrl: null, sourceCount: 2,
    })).toEqual(["featuredImageUrl"]);
  });

  it("image sans crédit → bloquant (comportement historique préservé)", () => {
    expect(blockingGapsForArticle({
      categoryId: "c1", categoryName: "Économie",
      featuredImageUrl: "https://ex.com/a.jpg", imageCredit: null,
      imageSourceUrl: "https://ex.com/a", sourceCount: 2,
    })).toEqual(["imageCredit"]);
  });

  it("aucune source → bloquant", () => {
    expect(blockingGapsForArticle({
      categoryId: "c1", categoryName: "Économie",
      featuredImageUrl: "https://ex.com/a.jpg", imageCredit: "Ecofin",
      imageSourceUrl: "https://ex.com/a", sourceCount: 0,
    })).toContain("sources");
  });
});

describe("excerptFromHtml", () => {
  it("dépouille le HTML et coupe sur un mot", () => {
    const html = `<h2>Titre</h2><p>${"mot ".repeat(200)}</p>`;
    const out = excerptFromHtml(html);
    expect(out.length).toBeLessThanOrEqual(201);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("<");
  });

  it("retourne le texte tel quel s'il tient dans la limite", () => {
    expect(excerptFromHtml("<p>Court texte.</p>")).toBe("Court texte.");
  });

  it("un corps vide donne une chaîne vide", () => {
    expect(excerptFromHtml("<p></p>")).toBe("");
  });
});

describe("sourceForImage", () => {
  it("choisit la source dont le domaine correspond à l'hôte de l'image", () => {
    const s = sourceForImage("https://www.jeuneafrique.com/media/p.jpg", SOURCES);
    expect(s!.mediaName).toBe("Jeune Afrique");
  });

  it("retombe sur la première source quand aucun domaine ne correspond", () => {
    const s = sourceForImage("https://cdn.imgur.com/p.jpg", SOURCES);
    expect(s!.mediaName).toBe("Ecofin");
  });

  it("retourne null sans source", () => {
    expect(sourceForImage("https://cdn.imgur.com/p.jpg", [])).toBeNull();
  });
});
