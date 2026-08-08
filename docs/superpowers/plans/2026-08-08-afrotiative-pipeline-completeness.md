# Pipeline — étape « Vérification & complétion » Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter une sixième étape par article qui répare automatiquement les informations manquantes (image, crédit, source de l'image, chapô), consigne ce qui reste manquant dans `articles.missing_fields`, et bloque la publication tant qu'un manque bloquant subsiste.

**Architecture:** Un module pur `lib/pipeline/completeness.ts` porte toutes les règles — quelles clés existent, lesquelles bloquent, comment les réparer, comment les libeller. `stages.ts` l'appelle entre `Génération IA` et `Calcul de l'embedding`, de sorte que le score reflète l'article réparé. `lib/wp/publish.ts` dérive l'ensemble bloquant du même module, ce qui rend impossible toute dérive entre ce que l'interface affiche et ce que la publication refuse.

**Tech Stack:** TypeScript, Drizzle ORM + Postgres/Neon, Vercel AI SDK, Bun pour les tests.

**Spec:** `docs/superpowers/specs/2026-08-08-afrotiative-pipeline-completeness-design.md`

## Global Constraints

- Toute chaîne visible par l'utilisateur est en **français**.
- Les tests tournent avec `bun test`, **sans réseau ni clé d'API** : `test-setup.ts` supprime activement toute variable `*_API_KEY`. Les dépendances réseau (`extract`) sont **injectées**, jamais appelées en dur depuis un test.
- `repairDraft` **ne lève jamais**. Chaque tentative de réparation a son propre `try/catch`.
- L'étape « Vérification & complétion » est la **seule** étape de `stageSources` dont l'échec n'avorte pas l'article.
- Le point d'application du blocage reste **unique** : `publishArticle` dans `lib/wp/publish.ts`. Aucun autre chemin ne refuse une publication.
- Ordre canonique des clés = ordre de `MISSING_FIELD_KEYS`. Toute liste persistée ou affichée respecte cet ordre.
- Le fichier `AGENTS.md` est réécrit par `next dev` ; s'il apparaît modifié, le committer avec le travail.

**Précision par rapport à la spec (Task 5) :** la spec disait « garde généralisée sur `missingFields ∩ BLOCKING_FIELDS` », c'est-à-dire lue depuis la colonne. Ce plan **dérive** l'ensemble bloquant des colonnes réelles de l'article au moment de la publication, via `blockingGapsForArticle()` du même module. Motif : les articles écrits **avant** la migration ont `missing_fields = '[]'` et échapperaient à une garde lue en base — la dérivation les couvre sans rétro-remplissage. La colonne reste la source d'affichage et de filtrage ; les deux viennent du même module, donc ne peuvent pas diverger.

---

### Task 1 : Règles de complétude (module pur)

**Files:**
- Create: `lib/pipeline/completeness.ts`
- Test: `tests/completeness.test.ts` (créer)

**Interfaces:**
- Consumes: `isSafePublicHttpUrl` depuis `@/lib/url-guard`
- Produces:
  - `MISSING_FIELD_KEYS: readonly MissingField[]` — ordre canonique
  - `type MissingField = "sources" | "categoryId" | "featuredImageUrl" | "imageCredit" | "imageSourceUrl" | "excerpt" | "tags"`
  - `BLOCKING_FIELDS: readonly MissingField[]`
  - `MISSING_LABEL: Record<MissingField, string>`
  - `type CompletenessDraft`, `type SourceRef = { mediaName: string; url: string }`
  - `checkCompleteness(draft, sources, categoryNames): MissingField[]`
  - `sortMissingFields(fields: MissingField[]): MissingField[]`
  - `blockingGapsForArticle(a): MissingField[]`
  - `excerptFromHtml(html, max?): string`
  - `sourceForImage(imageUrl, sources): SourceRef | null`

- [ ] **Step 1 : Écrire le test qui échoue**

Créer `tests/completeness.test.ts` :

```ts
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
```

- [ ] **Step 2 : Lancer le test pour vérifier qu'il échoue**

Run: `bun test tests/completeness.test.ts`
Expected: FAIL — `Cannot find module '@/lib/pipeline/completeness'`.

- [ ] **Step 3 : Créer `lib/pipeline/completeness.ts`**

```ts
import { isSafePublicHttpUrl } from "@/lib/url-guard";

// Les sept informations dont l'absence est détectable sur un article. L'ORDRE de ce tableau est
// l'ordre canonique : toute liste persistée (articles.missing_fields) ou affichée le respecte,
// pour que deux articles présentant les mêmes manques soient toujours décrits à l'identique.
export const MISSING_FIELD_KEYS = [
  "sources",
  "categoryId",
  "featuredImageUrl",
  "imageCredit",
  "imageSourceUrl",
  "excerpt",
  "tags",
] as const;

export type MissingField = (typeof MISSING_FIELD_KEYS)[number];

// Les manques qui EMPÊCHENT la publication. `excerpt` et `tags` sont purement indicatifs : un
// article sans tags se publie parfaitement. Cette constante est la définition unique de
// « bloquant » — lib/wp/publish.ts et l'interface la consomment, personne ne la redéclare.
export const BLOCKING_FIELDS: readonly MissingField[] = [
  "sources",
  "categoryId",
  "featuredImageUrl",
  "imageCredit",
  "imageSourceUrl",
];

export const MISSING_LABEL: Record<MissingField, string> = {
  sources: "Sources",
  categoryId: "Catégorie",
  featuredImageUrl: "Image à la une",
  imageCredit: "Crédit image",
  imageSourceUrl: "Source de l'image",
  excerpt: "Chapô",
  tags: "Tags",
};

export type SourceRef = { mediaName: string; url: string };

// Le sous-ensemble d'un brouillon d'article que ces règles observent. Volontairement structurel
// (et non `ArticleDraft`) : les champs image sont `.nullish()` dans le schéma Zod, et ce module
// doit accepter aussi bien un brouillon fraîchement généré qu'une ligne relue en base.
export type CompletenessDraft = {
  category: string;
  bodyHtml: string;
  excerpt: string;
  tags: string[];
  featuredImageUrl?: string | null;
  imageCredit?: string | null;
  imageSourceUrl?: string | null;
  confidence: {
    categoryUncertain?: boolean;
    imageMissing?: boolean;
    clusterUncertain?: boolean;
    aiDegraded?: boolean;
  };
};

function filled(v: string | null | undefined): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

// Remet une liste de clés dans l'ordre canonique et la dédoublonne.
export function sortMissingFields(fields: MissingField[]): MissingField[] {
  return MISSING_FIELD_KEYS.filter((k) => fields.includes(k));
}

/**
 * PUR — aucune I/O. Les informations manquantes d'un brouillon, dans l'ordre canonique.
 *
 * `categoryId` mérite une note : à ce stade la catégorie n'est qu'un NOM. Sa résolution en
 * identifiant n'a lieu que dans persistArticle (resolveCategoryId) et peut échouer même sur un
 * nom plausible — persistArticle complète donc cette clé après coup. C'est la seule clé
 * réconciliée plus tard ; les six autres sont entièrement déterminées ici.
 */
export function checkCompleteness(
  draft: CompletenessDraft,
  sources: SourceRef[],
  categoryNames: string[],
): MissingField[] {
  const missing: MissingField[] = [];

  if (sources.length === 0) missing.push("sources");

  if (!categoryNames.includes(draft.category) || draft.confidence.categoryUncertain === true) {
    missing.push("categoryId");
  }

  if (!filled(draft.featuredImageUrl)) {
    missing.push("featuredImageUrl");
  } else {
    // Rien à créditer sans image : ces deux clés ne sont réclamées QUE lorsqu'une image existe.
    if (!filled(draft.imageCredit)) missing.push("imageCredit");
    if (!filled(draft.imageSourceUrl)) missing.push("imageSourceUrl");
  }

  if (!filled(draft.excerpt)) missing.push("excerpt");
  if (draft.tags.length === 0) missing.push("tags");

  return sortMissingFields(missing);
}

/**
 * PUR — les manques BLOQUANTS d'un article déjà persisté, dérivés de ses colonnes réelles.
 *
 * Utilisé par publishArticle plutôt qu'une lecture de articles.missing_fields, pour deux raisons :
 * les articles antérieurs à la migration ont une colonne vide et échapperaient à la garde ; et un
 * article corrigé à la main via l'éditeur voit ses colonnes changer immédiatement. Les deux
 * chemins partagent ce module, donc l'affichage et l'application ne peuvent pas diverger.
 */
export function blockingGapsForArticle(a: {
  categoryId: string | null;
  categoryName: string | null;
  featuredImageUrl: string | null;
  imageCredit: string | null;
  imageSourceUrl: string | null;
  sourceCount: number;
}): MissingField[] {
  const missing: MissingField[] = [];
  if (a.sourceCount === 0) missing.push("sources");
  if (!a.categoryId || !filled(a.categoryName)) missing.push("categoryId");
  if (!filled(a.featuredImageUrl)) {
    missing.push("featuredImageUrl");
  } else {
    if (!filled(a.imageCredit)) missing.push("imageCredit");
    if (!filled(a.imageSourceUrl)) missing.push("imageSourceUrl");
  }
  return sortMissingFields(missing);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * PUR — la source à créditer pour une image : celle dont le domaine correspond à l'hôte de
 * l'image (le crédit revient au média qui l'a publiée), à défaut la première source de l'article.
 * La correspondance tolère les sous-domaines dans les deux sens (`cdn.ecofin.com` ↔ `ecofin.com`).
 */
export function sourceForImage(imageUrl: string, sources: SourceRef[]): SourceRef | null {
  if (sources.length === 0) return null;
  const imgHost = hostOf(imageUrl);
  if (imgHost) {
    const match = sources.find((s) => {
      const h = hostOf(s.url);
      return h !== null && (h === imgHost || imgHost.endsWith(`.${h}`) || h.endsWith(`.${imgHost}`));
    });
    if (match) return match;
  }
  return sources[0];
}

/**
 * PUR — chapô de repli : texte brut du corps, tronqué sur une frontière de mot. Suffisant pour
 * qu'un article ne parte jamais sans chapô ; un éditeur peut toujours le réécrire.
 */
export function excerptFromHtml(html: string, max = 200): string {
  const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

// Réexporté pour que repairDraft (Task 2) et les tests partagent le même garde-fou d'URL.
export { isSafePublicHttpUrl };
```

- [ ] **Step 4 : Lancer le test pour vérifier qu'il passe**

Run: `bun test tests/completeness.test.ts`
Expected: PASS — 24 tests.

- [ ] **Step 5 : Commit**

```bash
git add lib/pipeline/completeness.ts tests/completeness.test.ts
git commit -m "feat(pipeline): completeness rules module — keys, blocking set, labels (pure, tested)"
```

---

### Task 2 : `repairDraft` — réparation automatique

**Files:**
- Modify: `lib/pipeline/completeness.ts`
- Test: `tests/completeness.test.ts` (étendre)

**Interfaces:**
- Consumes: `checkCompleteness`, `sourceForImage`, `excerptFromHtml`, `isSafePublicHttpUrl` (Task 1)
- Produces:
  - `type RepairDeps = { extract: (url: string) => Promise<{ images?: string[] }> }`
  - `repairDraft<T extends CompletenessDraft>(draft: T, sources: SourceRef[], categoryNames: string[], candidateImages: string[], deps: RepairDeps): Promise<{ draft: T; repaired: MissingField[]; missing: MissingField[] }>`

- [ ] **Step 1 : Écrire les tests qui échouent**

Ajouter à la fin de `tests/completeness.test.ts` :

```ts
import { repairDraft, type RepairDeps } from "@/lib/pipeline/completeness";

const noExtract: RepairDeps = {
  extract: async () => {
    throw new Error("extract ne doit pas être appelé dans ce test");
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
    const seen: string[] = [];
    const deps: RepairDeps = {
      extract: async (url) => {
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
      extract: async () => ({ images: ["http://localhost/secret.png", "file:///etc/passwd"] }),
    };
    const r = await repairDraft(bareDraft(), SOURCES, CATEGORIES, [], deps);
    expect(r.draft.featuredImageUrl).toBeNull();
    expect(r.missing).toContain("featuredImageUrl");
    expect(r.repaired).not.toContain("featuredImageUrl");
  });

  it("une source qui échoue à l'extraction n'empêche pas d'essayer les suivantes", async () => {
    const deps: RepairDeps = {
      extract: async (url) => {
        if (url.includes("agenceecofin")) throw new Error("502");
        return { images: ["https://www.jeuneafrique.com/media/p.jpg"] };
      },
    };
    const r = await repairDraft(bareDraft(), SOURCES, CATEGORIES, [], deps);
    expect(r.draft.featuredImageUrl).toBe("https://www.jeuneafrique.com/media/p.jpg");
  });

  it("ne lève jamais, même si toutes les extractions échouent", async () => {
    const deps: RepairDeps = { extract: async () => { throw new Error("réseau coupé"); } };
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
    const r = await repairDraft(bareDraft(), SOURCES, CATEGORIES, [], {
      extract: async () => ({ images: [] }),
    });
    expect(r.draft.excerpt.length).toBeGreaterThan(0);
    expect(r.draft.excerpt).not.toContain("<");
    expect(r.repaired).toContain("excerpt");
  });

  it("ne devine JAMAIS la catégorie", async () => {
    const d = { ...bareDraft(), category: "Sport" };
    const r = await repairDraft(d, SOURCES, CATEGORIES, [], { extract: async () => ({ images: [] }) });
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
});
```

- [ ] **Step 2 : Lancer le test pour vérifier qu'il échoue**

Run: `bun test tests/completeness.test.ts`
Expected: FAIL — `repairDraft` n'est pas exporté.

- [ ] **Step 3 : Implémenter `repairDraft` dans `lib/pipeline/completeness.ts`**

Ajouter en fin de fichier :

```ts
// L'unique dépendance à effets de ce module, injectée : les tests n'ont donc jamais besoin du
// réseau (test-setup.ts supprime activement toute clé d'API, une extraction réelle échouerait).
export type RepairDeps = {
  extract: (url: string) => Promise<{ images?: string[] }>;
};

export type RepairResult<T extends CompletenessDraft> = {
  draft: T;
  repaired: MissingField[];
  missing: MissingField[];
};

/**
 * Tente de combler les manques réparables d'un brouillon, puis recalcule ce qui reste.
 *
 * NE LÈVE JAMAIS : chaque tentative a son propre try/catch, et un échec laisse simplement la clé
 * dans `missing`. C'est ce qui permet à stageSources de traiter cette étape comme non bloquante
 * (perdre une réparation ne doit jamais coûter un article).
 *
 * Générique sur T pour préserver le type concret de l'appelant (ArticleDraft dans stages.ts) :
 * un retour typé CompletenessDraft obligerait à ré-élargir le brouillon avant persistArticle.
 */
export async function repairDraft<T extends CompletenessDraft>(
  draft: T,
  sources: SourceRef[],
  categoryNames: string[],
  candidateImages: string[],
  deps: RepairDeps,
): Promise<RepairResult<T>> {
  const next = { ...draft, confidence: { ...draft.confidence } } as T;
  const repaired: MissingField[] = [];

  // 1. Image à la une.
  if (!filled(next.featuredImageUrl)) {
    let pool = candidateImages;
    if (pool.length === 0 && sources.length > 0) {
      // Le cas signalé en production : la génération n'a reçu AUCUNE image candidate (ni lien,
      // ni source). On relance l'extraction sur chaque source pour retrouver des images que la
      // première passe n'avait pas remontées — fournisseur différent, page entre-temps modifiée,
      // ou simple échec réseau au moment de l'ingestion.
      const recovered: string[] = [];
      for (const s of sources) {
        try {
          const r = await deps.extract(s.url);
          recovered.push(...(r.images ?? []));
        } catch {
          // Une source inaccessible ne doit pas empêcher d'essayer les suivantes.
        }
      }
      pool = recovered;
    }
    // Même garde-fou SSRF que la publication : inutile de retenir une URL que
    // lib/wp/publish.ts refusera de télécharger ensuite.
    const picked = pool.find((u) => isSafePublicHttpUrl(u));
    if (picked) {
      next.featuredImageUrl = picked;
      next.confidence.imageMissing = false;
      repaired.push("featuredImageUrl");
    }
  }

  // 2. Crédit et source de l'image — uniquement s'il y a désormais une image à créditer.
  if (filled(next.featuredImageUrl)) {
    const owner = sourceForImage(next.featuredImageUrl!, sources);
    if (owner) {
      if (!filled(next.imageCredit)) {
        next.imageCredit = owner.mediaName;
        repaired.push("imageCredit");
      }
      if (!filled(next.imageSourceUrl)) {
        next.imageSourceUrl = owner.url;
        repaired.push("imageSourceUrl");
      }
    }
  }

  // 3. Chapô.
  if (!filled(next.excerpt)) {
    const derived = excerptFromHtml(next.bodyHtml);
    if (derived) {
      next.excerpt = derived;
      repaired.push("excerpt");
    }
  }

  // La catégorie n'est JAMAIS devinée : choisir une rubrique est une décision éditoriale.
  // `tags` non plus — c'est purement indicatif.

  return {
    draft: next,
    repaired: sortMissingFields(repaired),
    missing: checkCompleteness(next, sources, categoryNames),
  };
}
```

- [ ] **Step 4 : Lancer le test pour vérifier qu'il passe**

Run: `bun test tests/completeness.test.ts`
Expected: PASS — 35 tests.

- [ ] **Step 5 : Commit**

```bash
git add lib/pipeline/completeness.ts tests/completeness.test.ts
git commit -m "feat(pipeline): repairDraft — recover image/credit/source/excerpt, never throws"
```

---

### Task 3 : Colonne `missing_fields`

**Files:**
- Modify: `db/schema.ts` (table `articles`, après `confidenceFlags`)
- Create: `db/migrations/0012_*.sql` (généré)
- Modify: `lib/queries/queue.ts`

**Interfaces:**
- Produces: `articles.missingFields: string[]` ; `QueueRow.missingFields: MissingField[]`

- [ ] **Step 1 : Ajouter la colonne au schéma Drizzle**

Dans `db/schema.ts`, table `articles`, juste après le bloc `confidenceFlags` :

```ts
  // SP « complétion » — la liste de travail des informations manquantes, calculée par
  // lib/pipeline/completeness.ts à la génération puis recalculée à chaque correction manuelle.
  // Volontairement DISTINCTE de confidenceFlags : celle-ci exprime un doute de l'IA sur la
  // qualité, celle-là énumère ce qui manque factuellement — les mélanger empêcherait de
  // distinguer « l'IA n'était pas sûre de la catégorie » de « il n'y a pas de catégorie ».
  // Ordre canonique garanti (MISSING_FIELD_KEYS).
  missingFields: jsonb("missing_fields").$type<string[]>().notNull().default([]),
```

`jsonb` est déjà importé dans ce fichier (utilisé par `confidenceFlags`).

- [ ] **Step 2 : Générer la migration**

Run: `bun run db:generate`
Expected: un nouveau fichier `db/migrations/0012_*.sql` contenant
`ALTER TABLE "articles" ADD COLUMN "missing_fields" jsonb DEFAULT '[]'::jsonb NOT NULL;`

Le vérifier avant d'aller plus loin :

Run: `cat db/migrations/0012_*.sql`
Expected: **uniquement** cet `ALTER TABLE`. Si Drizzle a généré autre chose (une différence
non voulue avec la base de dev), s'arrêter et le signaler plutôt que d'appliquer.

- [ ] **Step 3 : Appliquer la migration**

Run: `bun run db:migrate`
Expected: migration appliquée sans erreur.

- [ ] **Step 4 : Exposer le champ dans la requête de file**

Dans `lib/queries/queue.ts` : ajouter `missingFields: MissingField[]` au type `QueueRow`,
`missingFields: articles.missingFields` au `select`, et dans le `map` final :

```ts
    missingFields: sortMissingFields((r.missingFields ?? []) as MissingField[]),
```

avec `import { sortMissingFields, type MissingField } from "@/lib/pipeline/completeness";`.

Le `sortMissingFields` en lecture est délibéré : il normalise aussi les lignes écrites avant
ce sous-projet ou modifiées à la main en base.

- [ ] **Step 5 : Vérifier**

Run: `bun run typecheck && bun test tests/schema.test.ts`
Expected: aucune erreur ; les tests de schéma passent.

- [ ] **Step 6 : Commit**

```bash
git add db/schema.ts db/migrations lib/queries/queue.ts
git commit -m "feat(db): articles.missing_fields column + expose it on QueueRow"
```

---

### Task 4 : Câbler l'étape dans le pipeline

**Files:**
- Modify: `lib/pipeline/stages.ts` (`stageSources`, `persistArticle`)
- Modify: `lib/pipeline/live.ts:10-25`
- Test: `tests/live-panel.test.ts` (étendre)

**Interfaces:**
- Consumes: `repairDraft`, `checkCompleteness`, `sortMissingFields`, `MissingField` (Tasks 1-2)
- Produces: `persistArticle` accepte `missingFields: MissingField[]` dans son input

- [ ] **Step 1 : Mettre à jour la liste des étapes**

Dans `lib/pipeline/live.ts`, insérer la nouvelle étape en 3ᵉ position et son libellé court :

```ts
export const ITEM_STAGES = [
  "Extraction du contenu",
  "Génération IA",
  "Vérification & complétion",
  "Calcul de l'embedding",
  "Regroupement (clustering)",
  "Dépôt en revue",
] as const;

const STAGE_LABEL: Record<string, string> = {
  "Extraction du contenu": "Extraction",
  "Génération IA": "Génération IA",
  "Vérification & complétion": "Complétion",
  "Calcul de l'embedding": "Embedding",
  "Regroupement (clustering)": "Clustering",
  "Dépôt en revue": "Dépôt",
};
```

Compléter le commentaire d'en-tête : « Les **6** étapes par article ».

- [ ] **Step 2 : Écrire le test qui échoue pour le stepper**

Ajouter à `tests/live-panel.test.ts` :

```ts
it("une exécution antérieure à l'étape de complétion rend ce nœud en attente sans casser le gel", () => {
  // Effet connu et assumé : les lignes pipeline_steps écrites avant l'ajout de l'étape n'ont
  // pas ce nom, le nœud reste donc « pending » à perpétuité sur les exécutions passées.
  const legacySteps = [
    { name: "Extraction du contenu", status: "success" },
    { name: "Génération IA", status: "success" },
    { name: "Calcul de l'embedding", status: "success" },
    { name: "Regroupement (clustering)", status: "success" },
    { name: "Dépôt en revue", status: "success" },
  ];
  const nodes = deriveStepperNodes(legacySteps, null);
  expect(nodes).toHaveLength(6);
  expect(nodes.find((n) => n.name === "Vérification & complétion")!.state).toBe("pending");
  expect(nodes.find((n) => n.name === "Dépôt en revue")!.state).toBe("done");
});
```

- [ ] **Step 3 : Lancer les tests du stepper**

Run: `bun test tests/live-panel.test.ts`
Expected: PASS — la modification de `ITEM_STAGES` de l'étape 1 suffit. Si un test existant
attendait exactement 5 nœuds, l'ajuster à 6 (c'est le changement voulu).

- [ ] **Step 4 : Insérer l'étape dans `stageSources`**

Dans `lib/pipeline/stages.ts` :

a) imports à ajouter :

```ts
import {
  repairDraft, checkCompleteness, sortMissingFields, type MissingField,
} from "./completeness";
```

b) `const draft = gen.draft;` devient `let draft = gen.draft;`

c) juste **après** la ligne `const sanitized = sanitizeArticleHtml(draft.bodyHtml);`, insérer :

```ts
    // Étape « Vérification & complétion ». SEULE étape de cette fonction dont l'échec n'avorte
    // PAS l'article : les cinq autres relèvent leur erreur, ce qui fait sortir stageSources par
    // son catch (articleId: null). Ici, perdre une réparation ne doit jamais coûter un article —
    // on enregistre l'étape en échec (timedStep l'a déjà fait avant de relever) et on poursuit
    // avec le brouillon non réparé, dont les manques sont alors calculés sans réparation.
    //
    // Placée AVANT l'embedding pour que computeArticleScore (plus bas) voie l'article RÉPARÉ :
    // une image récupérée ici améliore réellement le score au lieu d'être pénalisée.
    let missingFields: MissingField[];
    try {
      const repair = await timedStep(steps, hooks, "Vérification & complétion", ms, () =>
        repairDraft(draft, uniqueSources, categoryNames, candidateImages, { extract }),
      );
      draft = repair.draft;
      missingFields = repair.missing;
    } catch {
      missingFields = checkCompleteness(draft, uniqueSources, categoryNames);
    }
```

`candidateImages` est déjà calculé au-dessus (l. 147) — **déplacer** sa déclaration avant l'appel
à `generateArticle` si ce n'est pas déjà le cas (elle l'est), rien à changer.

d) passer la liste à `persistArticle` :

```ts
    const depot = await timedStep(steps, hooks, "Dépôt en revue", ms, () => persistArticle({
      draft, sanitizedBody: sanitized, vector, clusterId: cluster.clusterId, score, confidence,
      sources: uniqueSources, categoryNames, autoPublish: apCfg, missingFields,
    }));
```

- [ ] **Step 5 : Réconcilier `categoryId` dans `persistArticle`**

Ajouter `missingFields: MissingField[]` au type d'input, puis juste après
`const catId = await resolveCategoryId(draft.category, categoryNames);` :

```ts
  // Réconciliation de la clé `categoryId` : checkCompleteness a travaillé sur un NOM de
  // catégorie ; sa résolution en identifiant n'a lieu qu'ici et peut échouer même sur un nom
  // plausible (aucune ligne wp_categories correspondante). C'est la SEULE clé complétée après
  // l'étape — les six autres sont figées. La liste écrite en base fait ensuite foi pour
  // l'affichage et le filtrage.
  const missingFields = catId === null
    ? sortMissingFields([...input.missingFields, "categoryId"])
    : input.missingFields;
```

Puis, dans le `tx.insert(articles).values({...})`, ajouter `missingFields,` à côté de
`confidenceFlags`.

- [ ] **Step 6 : Vérifier**

Run: `bun run typecheck && bun test`
Expected: aucune erreur de types ; suite complète verte. Les tests de pipeline qui comptent les
étapes (`tests/pipeline-run.test.ts`, `tests/reprocess.test.ts`) peuvent attendre un nombre
d'étapes précis — les mettre à jour pour 6 étapes si c'est le cas.

- [ ] **Step 7 : Commit**

```bash
git add lib/pipeline/stages.ts lib/pipeline/live.ts tests/live-panel.test.ts tests/
git commit -m "feat(pipeline): wire Vérification & complétion stage; persist missing_fields"
```

---

### Task 5 : Blocage à la publication et à l'auto-publication

**Files:**
- Modify: `lib/pipeline/auto-publish.ts`
- Modify: `lib/wp/publish.ts:130-165` (chargement) et `:256-265` (gardes)
- Test: `tests/auto-publish.test.ts` (étendre), `tests/wp-publish.test.ts` (étendre)

**Interfaces:**
- Consumes: `blockingGapsForArticle`, `MISSING_LABEL`, `BLOCKING_FIELDS` (Task 1)
- Produces: `shouldAutoPublish` accepte `hasBlockingGaps: boolean`

⚠️ **Changement de comportement volontaire :** un article **sans image à la une** ne peut plus être
publié (`featuredImageUrl` est bloquant). Avant ce sous-projet il se publiait sans image. La
correction se fait via l'éditeur d'article ou, après le sous-projet B, en ligne depuis `/queue`.

- [ ] **Step 1 : Écrire les tests qui échouent**

Ajouter à `tests/auto-publish.test.ts` :

```ts
it("un manque bloquant interdit l'auto-publication malgré un score et des sources suffisants", () => {
  expect(shouldAutoPublish({
    enabled: true, score: 95, scoreThreshold: 70,
    sourceCount: 4, minSources: 2, hasImage: true,
    confidence: {}, hasBlockingGaps: true,
  })).toBe(false);
});

it("sans manque bloquant, le comportement d'origine est conservé", () => {
  expect(shouldAutoPublish({
    enabled: true, score: 95, scoreThreshold: 70,
    sourceCount: 4, minSources: 2, hasImage: true,
    confidence: {}, hasBlockingGaps: false,
  })).toBe(true);
});
```

Ajouter à `tests/wp-publish.test.ts` :

```ts
import { blockingGapsForArticle, MISSING_LABEL } from "@/lib/pipeline/completeness";

describe("garde de complétude à la publication", () => {
  const base = {
    categoryId: "c1", categoryName: "Économie",
    featuredImageUrl: "https://ex.com/a.jpg", imageCredit: "Ecofin",
    imageSourceUrl: "https://ex.com/a", sourceCount: 2,
  };

  it("le message énumère les manques en français", () => {
    const gaps = blockingGapsForArticle({ ...base, categoryId: null, categoryName: null, imageCredit: null });
    const message = `Informations manquantes : ${gaps.map((g) => MISSING_LABEL[g]).join(", ")}.`;
    expect(message).toBe("Informations manquantes : Catégorie, Crédit image.");
  });

  it("les deux refus historiques restent couverts", () => {
    expect(blockingGapsForArticle({ ...base, categoryId: null, categoryName: null })).toContain("categoryId");
    expect(blockingGapsForArticle({ ...base, imageCredit: null })).toContain("imageCredit");
  });
});
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

Run: `bun test tests/auto-publish.test.ts tests/wp-publish.test.ts`
Expected: FAIL — `hasBlockingGaps` n'existe pas dans l'input de `shouldAutoPublish`.

- [ ] **Step 3 : Étendre `shouldAutoPublish`**

Dans `lib/pipeline/auto-publish.ts`, ajouter `hasBlockingGaps: boolean` au type d'input et, en
tête des conditions de refus (avant même la lecture des drapeaux de confiance) :

```ts
  // Un article incomplet ne peut jamais franchir l'exception d'auto-publication : la barrière de
  // revue humaine existe justement pour ces cas-là.
  if (input.hasBlockingGaps) return false;
```

Documenter la condition dans le commentaire numéroté de la fonction (elle devient la règle 1).

- [ ] **Step 4 : Alimenter l'appel dans `persistArticle`**

Dans `lib/pipeline/stages.ts`, l'appel à `shouldAutoPublish` reçoit :

```ts
      hasBlockingGaps: missingFields.some((f) => BLOCKING_FIELDS.includes(f)),
```

Ajouter `BLOCKING_FIELDS` à l'import de `./completeness`. Utiliser la variable `missingFields`
réconciliée à l'étape 5 de la **Task 4**, pas `input.missingFields` — sans quoi une catégorie
non résolue laisserait passer une auto-publication.

- [ ] **Step 5 : Généraliser la garde de `publishArticle`**

a) Le chargeur de l'article (`loadArticle`, ~l. 133-165) expose déjà `categoryId`,
`categoryName`, `featuredImageUrl`, `imageCredit` et `sources`. Ajouter `imageSourceUrl` au
`select` s'il n'y est pas.

b) Remplacer les deux gardes (l. 260-264) par :

```ts
  // Garde de complétude unique — l'ensemble bloquant est DÉRIVÉ des colonnes réelles de
  // l'article (et non lu dans articles.missing_fields) pour deux raisons : les articles
  // antérieurs à la migration ont une colonne vide et y échapperaient ; et un article corrigé
  // à la main voit ses colonnes changer immédiatement, sans attendre un recalcul. Les deux
  // chemins partagent lib/pipeline/completeness.ts, donc l'affichage dans /queue et le refus
  // ici ne peuvent pas diverger.
  const gaps = blockingGapsForArticle({
    categoryId: article.categoryId,
    categoryName: article.categoryName,
    featuredImageUrl: article.featuredImageUrl,
    imageCredit: article.imageCredit,
    imageSourceUrl: article.imageSourceUrl,
    sourceCount: article.sources.length,
  });
  if (gaps.length > 0) {
    return {
      ok: false,
      message: `Informations manquantes : ${gaps.map((g) => MISSING_LABEL[g]).join(", ")}.`,
    };
  }
```

avec `import { blockingGapsForArticle, MISSING_LABEL } from "@/lib/pipeline/completeness";`.

- [ ] **Step 6 : Lancer les tests pour vérifier qu'ils passent**

Run: `bun test tests/auto-publish.test.ts tests/wp-publish.test.ts tests/auto-publish-run.test.ts`
Expected: PASS. `tests/auto-publish-run.test.ts` pilote `persistArticle` directement — lui
ajouter `missingFields: []` dans son input, et vérifier que le cas positif d'auto-approbation
passe toujours.

- [ ] **Step 7 : Suite complète**

Run: `bun run typecheck && bun test`
Expected: tout vert. `tests/queue-actions.test.ts` et `tests/published.test.ts` peuvent asserter
les anciens messages français (« Choisissez une catégorie avant de publier », « Le crédit de
l'image est obligatoire ») — les mettre à jour vers le nouveau message énuméré.

- [ ] **Step 8 : Commit**

```bash
git add lib/pipeline/auto-publish.ts lib/pipeline/stages.ts lib/wp/publish.ts tests/
git commit -m "feat(publish): block on derived completeness gaps; auto-publish requires none"
```

---

## Vérification finale du sous-projet

- [ ] `bun run typecheck` — aucune erreur
- [ ] `bun test` — suite complète verte
- [ ] `bun run build` — build de production réussi
- [ ] Lancer une exécution du pipeline depuis `/runs` : le stepper affiche bien **6** nœuds et
      « Complétion » passe au vert
- [ ] Un article produit sans image candidate ressort avec une image récupérée **ou** avec
      « Image à la une » dans `missing_fields` — vérifiable en base :
      `select title, missing_fields from articles order by generated_at desc limit 5;`
