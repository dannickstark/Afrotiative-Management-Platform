import { describe, it, expect } from "bun:test";
import {
  checkCompleteness, sortMissingFields, blockingGapsForArticle,
  excerptFromHtml, sourceForImage, repairDraft, type RepairDeps,
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

// SOURCES (déclaré plus haut) n'a pas de champ `origin` : ces sources sont donc traitées comme non
// fiables et repairDraft doit toujours passer par `extractExternal`, jamais par `extract`.
const noExtract: RepairDeps = {
  extract: async () => {
    throw new Error("extract ne doit pas être appelé dans ce test");
  },
  extractExternal: async () => {
    throw new Error("extractExternal ne doit pas être appelé dans ce test");
  },
};

function bareDraft(): CompletenessDraft {
  return {
    category: "Économie",
    bodyHtml: `<p>${"Un paragraphe de contenu réel et vérifié. ".repeat(12)}</p>`,
    excerpt: "",
    tags: ["bceao"],
    featuredImageUrl: null,
    imageCredit: null,
    imageSourceUrl: null,
    confidence: { categoryUncertain: false, imageMissing: true, clusterUncertain: false },
  };
}

describe("repairDraft", () => {
  it("répare l'image depuis les candidates déjà connues, sans ré-extraire", async () => {
    const r = await repairDraft(
      bareDraft(), SOURCES, CATEGORIES,
      ["https://www.agenceecofin.com/img/photo.jpg"], noExtract,
    );
    expect(r.draft.featuredImageUrl).toBe("https://www.agenceecofin.com/img/photo.jpg");
    expect(r.repaired).toContain("featuredImageUrl");
    expect(r.draft.confidence.imageMissing).toBe(false);
    expect(r.missing).not.toContain("featuredImageUrl");
  });

  it("ré-extrait les sources quand aucune image candidate n'a été fournie", async () => {
    // SOURCES n'a pas de champ `origin` → traitées comme non fiables → c'est extractExternal qui
    // doit porter le comportement attendu ; extract ne doit jamais être appelé.
    const seen: string[] = [];
    const deps: RepairDeps = {
      extract: async () => { throw new Error("extract ne doit pas être appelé pour une source sans origine"); },
      extractExternal: async (url) => {
        seen.push(url);
        return url.includes("jeuneafrique")
          ? { images: ["https://www.jeuneafrique.com/media/p.jpg"] }
          : { images: [] };
      },
    };
    const r = await repairDraft(bareDraft(), SOURCES, CATEGORIES, [], deps);
    expect(seen).toEqual(SOURCES.map((s) => s.url));
    expect(r.draft.featuredImageUrl).toBe("https://www.jeuneafrique.com/media/p.jpg");
    expect(r.repaired).toContain("featuredImageUrl");
  });

  it("écarte une image que le garde-fou SSRF refuse", async () => {
    const deps: RepairDeps = {
      extract: async () => { throw new Error("extract ne doit pas être appelé pour une source sans origine"); },
      extractExternal: async () => ({ images: ["http://localhost/secret.png", "file:///etc/passwd"] }),
    };
    const r = await repairDraft(bareDraft(), SOURCES, CATEGORIES, [], deps);
    expect(r.draft.featuredImageUrl).toBeNull();
    expect(r.missing).toContain("featuredImageUrl");
    expect(r.repaired).not.toContain("featuredImageUrl");
  });

  it("une source qui échoue à l'extraction n'empêche pas d'essayer les suivantes", async () => {
    const deps: RepairDeps = {
      extract: async () => { throw new Error("extract ne doit pas être appelé pour une source sans origine"); },
      extractExternal: async (url) => {
        if (url.includes("agenceecofin")) throw new Error("502");
        return { images: ["https://www.jeuneafrique.com/media/p.jpg"] };
      },
    };
    const r = await repairDraft(bareDraft(), SOURCES, CATEGORIES, [], deps);
    expect(r.draft.featuredImageUrl).toBe("https://www.jeuneafrique.com/media/p.jpg");
  });

  it("ne lève jamais, même si toutes les extractions échouent", async () => {
    const deps: RepairDeps = {
      extract: async () => { throw new Error("extract ne doit pas être appelé pour une source sans origine"); },
      extractExternal: async () => { throw new Error("réseau coupé"); },
    };
    const r = await repairDraft(bareDraft(), SOURCES, CATEGORIES, [], deps);
    expect(r.draft.featuredImageUrl).toBeNull();
    expect(r.missing).toContain("featuredImageUrl");
  });

  it("dérive le crédit et la source d'image du média correspondant", async () => {
    const r = await repairDraft(
      bareDraft(), SOURCES, CATEGORIES,
      ["https://www.jeuneafrique.com/media/p.jpg"], noExtract,
    );
    expect(r.draft.imageCredit).toBe("Jeune Afrique");
    expect(r.draft.imageSourceUrl).toBe("https://www.jeuneafrique.com/xyz");
    expect(r.repaired).toEqual(
      expect.arrayContaining(["featuredImageUrl", "imageCredit", "imageSourceUrl"]),
    );
  });

  it("retombe sur la première source quand l'hôte de l'image ne correspond à rien", async () => {
    const r = await repairDraft(
      bareDraft(), SOURCES, CATEGORIES, ["https://cdn.imgur.com/p.jpg"], noExtract,
    );
    expect(r.draft.imageCredit).toBe("Ecofin");
  });

  it("dérive le chapô du corps", async () => {
    // SOURCES n'a pas d'origine → extractExternal ; extract ne doit jamais être appelé.
    const r = await repairDraft(bareDraft(), SOURCES, CATEGORIES, [], {
      extract: async () => { throw new Error("extract ne doit pas être appelé pour une source sans origine"); },
      extractExternal: async () => ({ images: [] }),
    });
    expect(r.draft.excerpt.length).toBeGreaterThan(0);
    expect(r.draft.excerpt).not.toContain("<");
    expect(r.repaired).toContain("excerpt");
  });

  it("ne devine JAMAIS la catégorie", async () => {
    const d = { ...bareDraft(), category: "Sport" };
    const r = await repairDraft(d, SOURCES, CATEGORIES, [], {
      extract: async () => { throw new Error("extract ne doit pas être appelé pour une source sans origine"); },
      extractExternal: async () => ({ images: [] }),
    });
    expect(r.draft.category).toBe("Sport");
    expect(r.repaired).not.toContain("categoryId");
    expect(r.missing).toContain("categoryId");
  });

  it("ne mute pas le brouillon d'entrée", async () => {
    const original = bareDraft();
    await repairDraft(original, SOURCES, CATEGORIES, ["https://ex.com/a.jpg"], noExtract);
    expect(original.featuredImageUrl).toBeNull();
    expect(original.confidence.imageMissing).toBe(true);
  });

  it("n'appelle pas extract quand l'image est déjà présente", async () => {
    const d = { ...bareDraft(), featuredImageUrl: "https://ex.com/a.jpg" };
    const r = await repairDraft(d, SOURCES, CATEGORIES, [], noExtract);
    expect(r.draft.featuredImageUrl).toBe("https://ex.com/a.jpg");
  });

  it("utilise extract (avec backfill) pour une source issue d'un flux RSS", async () => {
    const calls: { fn: string; url: string }[] = [];
    const deps = {
      extract: async (url: string) => { calls.push({ fn: "extract", url }); return { images: ["https://www.agenceecofin.com/img/p.jpg"] }; },
      extractExternal: async (url: string) => { calls.push({ fn: "extractExternal", url }); return { images: [] }; },
    };
    const feedSources = [{ mediaName: "Ecofin", url: "https://www.agenceecofin.com/a/1", origin: "feed" as const }];
    const r = await repairDraft(bareDraft(), feedSources, CATEGORIES, [], deps);
    expect(calls).toEqual([{ fn: "extract", url: "https://www.agenceecofin.com/a/1" }]);
    expect(r.draft.featuredImageUrl).toBe("https://www.agenceecofin.com/img/p.jpg");
  });

  it("utilise extractExternal pour une source issue de la recherche web", async () => {
    const calls: { fn: string; url: string }[] = [];
    const deps = {
      extract: async (url: string) => { calls.push({ fn: "extract", url }); return { images: ["https://mechant.example/p.jpg"] }; },
      extractExternal: async (url: string) => { calls.push({ fn: "extractExternal", url }); return { images: [] }; },
    };
    const webSources = [{ mediaName: "example.com", url: "https://example.com/hit", origin: "web" as const }];
    const r = await repairDraft(bareDraft(), webSources, CATEGORIES, [], deps);
    expect(calls).toEqual([{ fn: "extractExternal", url: "https://example.com/hit" }]);
    expect(r.draft.featuredImageUrl).toBeNull();
  });

  it("traite une source SANS origine comme non fiable (défaut sûr)", async () => {
    const calls: string[] = [];
    const deps = {
      extract: async () => { calls.push("extract"); return { images: ["https://ex.com/p.jpg"] }; },
      extractExternal: async () => { calls.push("extractExternal"); return { images: [] }; },
    };
    // SOURCES n'a pas de champ `origin` — le défaut doit être extractExternal, jamais extract.
    await repairDraft(bareDraft(), SOURCES, CATEGORIES, [], deps);
    // Sans cette assertion, une régression qui ne relancerait AUCUNE extraction (repairDraft
    // court-circuité, ou une image déjà présente) ferait passer ce test vacuously : [].every(...)
    // est true et expect([]).not.toContain("extract") aussi. Vérifier qu'un appel a bien eu lieu
    // par source prouve que le chemin "non fiable par défaut" a réellement été exercé.
    expect(calls.length).toBe(SOURCES.length);
    expect(calls.every((c) => c === "extractExternal")).toBe(true);
    expect(calls).not.toContain("extract");
  });

  it("choisit l'extracteur source par source dans une liste mixte", async () => {
    const calls: { fn: string; url: string }[] = [];
    const deps = {
      extract: async (url: string) => { calls.push({ fn: "extract", url }); return { images: ["https://www.agenceecofin.com/img/p.jpg"] }; },
      extractExternal: async (url: string) => { calls.push({ fn: "extractExternal", url }); return { images: [] }; },
    };
    const mixed = [
      { mediaName: "example.com", url: "https://example.com/hit", origin: "web" as const },
      { mediaName: "Ecofin", url: "https://www.agenceecofin.com/a/1", origin: "feed" as const },
    ];
    const r = await repairDraft(bareDraft(), mixed, CATEGORIES, [], deps);
    expect(calls).toEqual([
      { fn: "extractExternal", url: "https://example.com/hit" },
      { fn: "extract", url: "https://www.agenceecofin.com/a/1" },
    ]);
    expect(r.draft.featuredImageUrl).toBe("https://www.agenceecofin.com/img/p.jpg");
  });
});
