import { describe, it, expect } from "bun:test";
import { regenerateFieldsSchema, improveInputSchema } from "@/lib/validation";
import { selectRegenerationColumns } from "@/lib/pipeline/regenerate";
import type { ArticleDraft } from "@/lib/ai/schema";

const draft: ArticleDraft = {
  title: "Nouveau titre", bodyHtml: "<p>Nouveau corps.</p>", excerpt: "Nouvel extrait",
  category: "Économie", tags: ["brvm", "bourse"],
  featuredImageUrl: "https://img/x.jpg", imageCredit: "Crédit", imageSourceUrl: "https://src/x",
  confidence: { categoryUncertain: false, imageMissing: false, clusterUncertain: false },
};
const ALL = { title: true, body: true, excerpt: true, category: true, tags: true, image: true };

describe("regenerateFieldsSchema / improveInputSchema", () => {
  it("requires at least one field", () => {
    expect(regenerateFieldsSchema.safeParse({ title: false, body: false, excerpt: false, category: false, tags: false, image: false }).success).toBe(false);
    expect(regenerateFieldsSchema.safeParse({ ...ALL, body: false }).success).toBe(true);
  });
  it("bounds the improve instruction length", () => {
    expect(improveInputSchema.safeParse({ instruction: "x".repeat(501) }).success).toBe(false);
    expect(improveInputSchema.safeParse({}).success).toBe(true);
  });
});

describe("selectRegenerationColumns", () => {
  it("with all fields checked, returns every column + body + category + tags", () => {
    const s = selectRegenerationColumns(draft, ALL);
    expect(s.columns.title).toBe("Nouveau titre");
    expect(s.columns.excerpt).toBe("Nouvel extrait");
    expect(s.columns.featuredImageUrl).toBe("https://img/x.jpg");
    expect(s.bodyHtml).toBe("<p>Nouveau corps.</p>");
    expect(s.bodyChanged).toBe(true);
    expect(s.categoryName).toBe("Économie");
    expect(s.tags).toEqual(["brvm", "bourse"]);
  });
  it("with only image checked, touches ONLY the image columns", () => {
    const s = selectRegenerationColumns(draft, { title: false, body: false, excerpt: false, category: false, tags: false, image: true });
    expect(s.columns).toEqual({ featuredImageUrl: "https://img/x.jpg", imageCredit: "Crédit", imageSourceUrl: "https://src/x" });
    expect(s.bodyHtml).toBeNull();
    expect(s.bodyChanged).toBe(false);
    expect(s.categoryName).toBeNull();
    expect(s.tags).toBeNull();
  });
});
