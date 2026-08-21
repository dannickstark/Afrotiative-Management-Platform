"use server";
// lib/actions/montage-actions.ts — Task 7 : server actions de partage du conducteur de montage.
// Motif de lib/actions/mcp-actions.ts : "use server" en tête, garde ("video:manage") en tête de
// chaque export, aucun secret dans une valeur de retour SAUF createShareLink, dont c'est
// précisément le contrat, une seule fois (l'URL contient le jeton en clair — voir
// components/video/montage-share-panel.tsx qui ne le garde qu'en état local, jamais renvoyé au
// serveur). Ce fichier grossira aux Tasks 9/10 — garder cette structure (garde partagée implicite
// via requirePermission en tête de chaque export) plutôt que de la répéter différemment.
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { requirePermission, can } from "@/lib/rbac";
import { createShareCore, revokeShareCore } from "@/lib/montage/access";

const createSchema = z.object({
  projectId: z.string().uuid(),
  expiresAt: z.string().datetime().nullable(),
});

export async function createShareLink(
  input: { projectId: string; expiresAt: string | null },
): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  const u = await requireUser();
  requirePermission(u.role, "video", "manage");
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Entrée invalide." };
  const { token } = await createShareCore({
    projectId: parsed.data.projectId,
    userId: u.id,
    expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
  });
  revalidatePath("/video/[id]", "page");
  const base = process.env.BETTER_AUTH_URL ?? "";
  return { ok: true, url: `${base}/montage/${token}` };
}

export async function revokeShareLink(shareId: string): Promise<{ ok: boolean; message?: string }> {
  const u = await requireUser();
  requirePermission(u.role, "video", "manage");
  const seesAll = can(u.role, "video", "configure");
  const res = await revokeShareCore({ shareId, userId: u.id, seesAll });
  if (res.ok) revalidatePath("/video/[id]", "page");
  return res;
}
