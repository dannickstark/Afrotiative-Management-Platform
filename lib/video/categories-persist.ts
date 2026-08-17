import { db, videoCategories, videoProjects } from "@/db";
import { eq } from "drizzle-orm";
import { RefusalError } from "@/lib/video/persist";
import type { VideoCategoryInput } from "@/lib/validation";

// Cœur d'écriture des catégories. PAS de "use server" ici : tout export d'un module "use server"
// est un point d'entrée réseau sans authentification propre. Les actions gardées vivent dans
// lib/actions/video-category-actions.ts et sont le seul chemin d'appel depuis le client.

// Postgres refuse le doublon par l'index unique sur lower(name) — c'est la base qui arbitre, pas
// une pré-lecture applicative (laquelle laisserait une fenêtre de concurrence). On convertit le
// code 23505 en refus métier français ; toute autre erreur relance telle quelle.
const UNIQUE_VIOLATION = "23505";

function asRefusal(e: unknown): never {
  // Drizzle enveloppe l'erreur Postgres brute dans une DrizzleQueryError — le code SQLSTATE (23505)
  // vit sur `.cause`, pas directement sur l'erreur relancée (constaté en écrivant ce test : lire
  // `e.code` ici laissait passer le doublon en erreur technique brute plutôt qu'en refus métier).
  const code = (e as { code?: string } | null)?.code
    ?? (e as { cause?: { code?: string } } | null)?.cause?.code;
  if (code === UNIQUE_VIOLATION) {
    throw new RefusalError("Une catégorie porte déjà ce nom.");
  }
  throw e;
}

export async function createVideoCategoryCore(
  input: VideoCategoryInput & { userId: string | null },
): Promise<string> {
  try {
    const [row] = await db.insert(videoCategories).values({
      name: input.name.trim(),
      description: input.description?.trim() || null,
      instructions: input.instructions,
      position: input.position,
      updatedBy: input.userId,
    }).returning({ id: videoCategories.id });
    return row.id;
  } catch (e) { asRefusal(e); }
}

export async function updateVideoCategoryCore(
  input: VideoCategoryInput & { id: string; userId: string | null },
): Promise<void> {
  try {
    const updated = await db.update(videoCategories).set({
      name: input.name.trim(),
      description: input.description?.trim() || null,
      instructions: input.instructions,
      position: input.position,
      updatedAt: new Date(),
      updatedBy: input.userId,
    }).where(eq(videoCategories.id, input.id)).returning({ id: videoCategories.id });
    if (updated.length === 0) throw new RefusalError("Catégorie introuvable.");
  } catch (e) {
    if (e instanceof RefusalError) throw e;
    asRefusal(e);
  }
}

// Les projets rattachés retombent sur « aucune catégorie » par le ON DELETE SET NULL du schéma —
// rien à faire ici, et surtout aucune suppression en cascade de projets.
export async function deleteVideoCategoryCore(id: string): Promise<void> {
  const deleted = await db.delete(videoCategories).where(eq(videoCategories.id, id))
    .returning({ id: videoCategories.id });
  if (deleted.length === 0) throw new RefusalError("Catégorie introuvable.");
}

export async function setProjectCategoryCore(
  input: { projectId: string; categoryId: string | null },
): Promise<void> {
  const updated = await db.update(videoProjects)
    .set({ categoryId: input.categoryId, updatedAt: new Date() })
    .where(eq(videoProjects.id, input.projectId))
    .returning({ id: videoProjects.id });
  if (updated.length === 0) throw new RefusalError("Projet introuvable.");
}
