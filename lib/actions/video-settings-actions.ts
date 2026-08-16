"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { videoSettingsSchema, type VideoSettingsInput } from "@/lib/validation";

async function guard() {
  const u = await requireUser();
  // "configure", pas "manage" (round de correction 1) : "manage" est accordé aux trois rôles,
  // journaliste compris, pour l'édition des projets/beats vidéo — mais les RÉGLAGES du module
  // (modèle de brief, cadence) doivent rester admin/éditeur, comme SETTINGS_CHILDREN le prévoit
  // déjà pour /settings/video. Cette action est le vrai point d'entrée réseau : la garde compte
  // ici autant que sur la page.
  requirePermission(u.role, "video", "configure");
  return u;
}

// Écrit la ligne unique de video_settings (créée par getVideoSettings si elle n'existe pas
// encore) — même motif que taxonomy-actions.ts : imports dynamiques de @/db et drizzle-orm, pour
// que ce module "use server" n'exporte que des actions gardées.
export async function saveVideoSettings(input: VideoSettingsInput): Promise<{ ok: true } | { ok: false; message: string }> {
  const u = await guard();
  const parsed = videoSettingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, message: parsed.error.issues[0].message };

  const { db, videoSettings } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const rows = await db.select({ id: videoSettings.id }).from(videoSettings).limit(1);
  if (rows[0]) {
    await db.update(videoSettings)
      .set({ ...parsed.data, updatedAt: new Date(), updatedBy: u.id })
      .where(eq(videoSettings.id, rows[0].id));
  } else {
    await db.insert(videoSettings).values({ ...parsed.data, updatedBy: u.id });
  }
  revalidatePath("/settings/video");
  return { ok: true as const };
}
