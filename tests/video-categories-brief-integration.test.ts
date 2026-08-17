import { describe, it, expect, afterAll } from "bun:test";
import { db, videoCategories, videoProjects } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { createVideoCategoryCore } from "@/lib/video/categories-persist";
import { createVideoProjectCore } from "@/lib/video/persist";
import { getBriefCategory } from "@/lib/queries/video-categories";
import { briefVarsFor } from "@/lib/queries/video";
import { getVideoSettings } from "@/lib/queries/video-settings";
import { buildBrief } from "@/lib/video/brief";

const cats: string[] = [];
const projs: string[] = [];

afterAll(async () => {
  if (projs.length) await db.delete(videoProjects).where(inArray(videoProjects.id, projs));
  if (cats.length) await db.delete(videoCategories).where(inArray(videoCategories.id, cats));
});

describe("brief d'un projet catégorisé", () => {
  it("le brief construit depuis la base porte les instructions de l'expert", async () => {
    const catId = await createVideoCategoryCore({
      name: `Test-Intégration-${Date.now()}`, description: null,
      instructions: "Croiser deux sources indépendantes pour chaque chiffre.",
      position: 0, userId: null,
    });
    cats.push(catId);
    const projectId = await createVideoProjectCore({
      title: "Test — brief catégorisé", subject: null, platform: "youtube_long",
      targetDurationSec: null, aspectRatio: "16:9", articleId: null, categoryId: catId, userId: null,
    });
    projs.push(projectId);

    const [project] = await db.select().from(videoProjects).where(eq(videoProjects.id, projectId));
    const settings = await getVideoSettings();
    const vars = await briefVarsFor(project, null);
    const category = await getBriefCategory(project.categoryId);
    const brief = buildBrief(settings.briefTemplate, vars, category).text;

    expect(brief).toContain("## Instructions de la catégorie —");
    expect(brief).toContain("Croiser deux sources indépendantes pour chaque chiffre.");
    // Le contrat reste le dernier mot du brief.
    expect(brief.indexOf("## Format de réponse")).toBeGreaterThan(brief.indexOf("## Instructions de la catégorie"));
  });
});
