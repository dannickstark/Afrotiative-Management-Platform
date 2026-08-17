import { describe, it, expect, afterAll } from "bun:test";
import { db, videoCategories, videoProjects } from "@/db";
import { eq, inArray } from "drizzle-orm";
import {
  createVideoCategoryCore, updateVideoCategoryCore, deleteVideoCategoryCore, setProjectCategoryCore,
} from "@/lib/video/categories-persist";
import { createVideoProjectCore, RefusalError } from "@/lib/video/persist";
import { listVideoCategories, getBriefCategory } from "@/lib/queries/video-categories";

const created: string[] = [];
const projects: string[] = [];

async function newCategory(name: string, instructions = "Consignes de l'expert.") {
  const id = await createVideoCategoryCore({
    name, description: null, instructions, position: 0, userId: null,
  });
  created.push(id);
  return id;
}

async function newProject(title: string, categoryId: string | null) {
  const id = await createVideoProjectCore({
    title, subject: null, platform: "youtube_long", targetDurationSec: null,
    aspectRatio: "16:9", articleId: null, categoryId, userId: null,
  });
  projects.push(id);
  return id;
}

afterAll(async () => {
  if (projects.length) await db.delete(videoProjects).where(inArray(videoProjects.id, projects));
  if (created.length) await db.delete(videoCategories).where(inArray(videoCategories.id, created));
});

describe("CRUD des catégories", () => {
  it("crée, relit et édite une catégorie", async () => {
    const id = await newCategory(`Test-Storytelling-${Date.now()}`);
    await updateVideoCategoryCore({
      id, name: `Test-Récit-${Date.now()}`, description: "Récits longs",
      instructions: "Ouvrir sur une scène.", position: 3, userId: null,
    });
    const [row] = await db.select().from(videoCategories).where(eq(videoCategories.id, id));
    expect(row.instructions).toBe("Ouvrir sur une scène.");
    expect(row.position).toBe(3);
    expect(row.description).toBe("Récits longs");
  });

  it("refuse un nom déjà pris, quelle que soit la casse, avec un message français", async () => {
    const name = `Test-Interview-${Date.now()}`;
    await newCategory(name);
    // Le doublon doit être un refus métier lisible, pas une erreur Postgres brute remontée au client.
    await expect(newCategory(name.toUpperCase())).rejects.toBeInstanceOf(RefusalError);
  });

  it("compte les projets rattachés", async () => {
    const id = await newCategory(`Test-Compte-${Date.now()}`);
    await newProject("Test — projet catégorisé", id);
    const row = (await listVideoCategories()).find((c) => c.id === id);
    expect(row?.projectCount).toBe(1);
  });
});

describe("rattachement d'un projet", () => {
  it("persiste la catégorie à la création", async () => {
    const catId = await newCategory(`Test-Création-${Date.now()}`);
    const projectId = await newProject("Test — création avec catégorie", catId);
    const [p] = await db.select().from(videoProjects).where(eq(videoProjects.id, projectId));
    expect(p.categoryId).toBe(catId);
  });

  it("change puis retire la catégorie d'un projet", async () => {
    const catId = await newCategory(`Test-Changement-${Date.now()}`);
    const projectId = await newProject("Test — changement de catégorie", null);
    await setProjectCategoryCore({ projectId, categoryId: catId });
    expect((await db.select().from(videoProjects).where(eq(videoProjects.id, projectId)))[0].categoryId).toBe(catId);
    await setProjectCategoryCore({ projectId, categoryId: null });
    expect((await db.select().from(videoProjects).where(eq(videoProjects.id, projectId)))[0].categoryId).toBeNull();
  });

  it("supprimer une catégorie remet ses projets sur « aucune » sans les détruire", async () => {
    const catId = await newCategory(`Test-Suppression-${Date.now()}`);
    const projectId = await newProject("Test — survie à la suppression", catId);
    await deleteVideoCategoryCore(catId);
    const [p] = await db.select().from(videoProjects).where(eq(videoProjects.id, projectId));
    expect(p).toBeDefined();
    expect(p.categoryId).toBeNull();
  });
});

describe("getBriefCategory", () => {
  it("rend null sans catégorie", async () => {
    expect(await getBriefCategory(null)).toBeNull();
  });

  it("rend le nom et les instructions, rien d'autre", async () => {
    const id = await newCategory(`Test-Brief-${Date.now()}`, "Deux sources indépendantes.");
    expect(await getBriefCategory(id)).toEqual({
      name: expect.stringContaining("Test-Brief-"),
      instructions: "Deux sources indépendantes.",
    });
  });
});
