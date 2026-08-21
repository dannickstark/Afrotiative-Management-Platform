import { asc, eq } from "drizzle-orm";
import { db, interviewSpeakers, scriptVariants, scriptBeats } from "@/db";
import { RefusalError } from "@/lib/video/persist";

// Cœur d'écriture des intervenants (mode interview, SP5). PAS de "use server" ici : voir la même
// remarque dans lib/video/categories-persist.ts — un module "use server" est un point d'entrée
// réseau sans authentification propre. Les actions gardées appelleront ces fonctions.

export async function createSpeakerCore(
  input: { projectId: string; name: string; role: string | null },
): Promise<string> {
  const [row] = await db.insert(interviewSpeakers).values({
    projectId: input.projectId, name: input.name.trim(), role: input.role?.trim() || null,
  }).returning({ id: interviewSpeakers.id });
  return row.id;
}

export async function updateSpeakerCore(
  input: { speakerId: string; name?: string; role?: string | null; consentGiven?: boolean; consentNote?: string | null },
): Promise<void> {
  const patch: Partial<typeof interviewSpeakers.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.role !== undefined) patch.role = input.role?.trim() || null;
  if (input.consentGiven !== undefined) patch.consentGiven = input.consentGiven;
  if (input.consentNote !== undefined) patch.consentNote = input.consentNote;
  const updated = await db.update(interviewSpeakers).set(patch)
    .where(eq(interviewSpeakers.id, input.speakerId)).returning({ id: interviewSpeakers.id });
  if (updated.length === 0) throw new RefusalError("Intervenant introuvable.");
}

// La FK script_beats.speaker_id est ON DELETE no action : supprimer un intervenant référencé par un
// beat lèverait une violation 23503 si on ne dénouait pas les beats d'abord. Le tout dans une seule
// transaction : on verrouille les variantes du projet (FOR UPDATE, ordonnées par id — même ordre de
// verrou que le reste du module vidéo) avant de dénouer puis supprimer, pour éviter une course avec
// une écriture concurrente sur les mêmes beats.
export async function deleteSpeakerCore(input: { speakerId: string }): Promise<void> {
  await db.transaction(async (tx) => {
    const [sp] = await tx.select({ projectId: interviewSpeakers.projectId }).from(interviewSpeakers)
      .where(eq(interviewSpeakers.id, input.speakerId));
    if (!sp) throw new RefusalError("Intervenant introuvable.");
    // Verrouiller les variantes du projet (par id) avant de dénouer les beats — respecte l'ordre de verrou.
    await tx.select({ id: scriptVariants.id }).from(scriptVariants)
      .where(eq(scriptVariants.projectId, sp.projectId)).orderBy(asc(scriptVariants.id)).for("update");
    // FK speakerId = ON DELETE no action : dénouer d'abord, sinon violation 23503.
    await tx.update(scriptBeats).set({ speakerId: null }).where(eq(scriptBeats.speakerId, input.speakerId));
    await tx.delete(interviewSpeakers).where(eq(interviewSpeakers.id, input.speakerId));
  });
}
