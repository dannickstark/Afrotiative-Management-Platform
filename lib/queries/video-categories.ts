import { db, videoCategories, videoProjects } from "@/db";
import { asc, count, eq } from "drizzle-orm";
import type { BriefCategory } from "@/lib/video/brief";

// Lectures des catégories de vidéo. Aucune écriture ici — le cœur d'écriture vit dans
// lib/video/categories-persist.ts (même séparation que lib/queries/video.ts ↔ lib/video/persist.ts).

export type VideoCategoryRow = {
  id: string; name: string; description: string | null;
  instructions: string; position: number; projectCount: number;
};

export type VideoCategoryOption = { id: string; name: string; description: string | null };

// `projectCount` est ce qui permet d'annoncer, AVANT une suppression, combien de projets
// retomberont sur « aucune catégorie ».
export async function listVideoCategories(): Promise<VideoCategoryRow[]> {
  const rows = await db
    .select({
      id: videoCategories.id, name: videoCategories.name, description: videoCategories.description,
      instructions: videoCategories.instructions, position: videoCategories.position,
      projectCount: count(videoProjects.id),
    })
    .from(videoCategories)
    .leftJoin(videoProjects, eq(videoProjects.categoryId, videoCategories.id))
    .groupBy(videoCategories.id)
    .orderBy(asc(videoCategories.position), asc(videoCategories.name));
  return rows.map((r) => ({ ...r, projectCount: Number(r.projectCount) }));
}

export async function listVideoCategoryOptions(): Promise<VideoCategoryOption[]> {
  return db
    .select({ id: videoCategories.id, name: videoCategories.name, description: videoCategories.description })
    .from(videoCategories)
    .orderBy(asc(videoCategories.position), asc(videoCategories.name));
}

/**
 * La projection EXACTE que consomme buildBrief — nom + instructions, rien d'autre. Producteur
 * unique pour ses deux appelants (la page projet et l'outil MCP) : construite ligne à ligne des
 * deux côtés, elle aurait divergé à la première retouche, et l'agent aurait écrit sous un brief que
 * l'humain ne voit pas (même raison d'être que briefVarsFor dans lib/queries/video.ts).
 */
export async function getBriefCategory(categoryId: string | null): Promise<BriefCategory | null> {
  if (!categoryId) return null;
  const [row] = await db
    .select({ name: videoCategories.name, instructions: videoCategories.instructions })
    .from(videoCategories)
    .where(eq(videoCategories.id, categoryId));
  return row ?? null;
}
