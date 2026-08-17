import { describe, it, expect } from "bun:test";
import { videoCategories, videoProjects } from "@/db/schema";

describe("schéma des catégories de vidéo", () => {
  it("porte le nom, la description, les instructions et la position", () => {
    const cols = Object.keys(videoCategories);
    expect(cols).toContain("name");
    expect(cols).toContain("description");
    expect(cols).toContain("instructions");
    expect(cols).toContain("position");
    expect(cols).toContain("updatedBy");
  });

  it("le nom et les instructions sont obligatoires, la description non", () => {
    expect(videoCategories.name.notNull).toBe(true);
    expect(videoCategories.instructions.notNull).toBe(true);
    expect(videoCategories.description.notNull).toBe(false);
  });

  it("un projet peut n'avoir aucune catégorie", () => {
    // La catégorie est optionnelle (décision 4 de la spec) : les projets créés avant cette
    // fonctionnalité restent valides sans migration de données.
    expect(videoProjects.categoryId.notNull).toBe(false);
  });
});
