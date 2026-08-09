"use server";
import { requireUser } from "@/lib/session";
import { getQueuePreview, type QueuePreview } from "@/lib/queries/queue";

// Le panneau est ouvert à la demande depuis un composant client ; le corps de l'article n'est
// donc chargé que pour l'article réellement consulté, jamais pour les 25 lignes de la page.
export async function loadPreview(id: string): Promise<QueuePreview | null> {
  await requireUser();
  return getQueuePreview(id);
}
