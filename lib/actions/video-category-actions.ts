"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { videoCategorySchema, videoCategoryIdSchema } from "@/lib/validation";
import {
  createVideoCategoryCore, updateVideoCategoryCore, deleteVideoCategoryCore,
} from "@/lib/video/categories-persist";
import { RefusalError } from "@/lib/video/persist";

// Ce module n'exporte QUE des actions gardées : le cœur DB vit dans lib/video/categories-persist.ts,
// sans "use server" (motif de lib/actions/taxonomy-actions.ts).

// "configure" et non "manage" : écrire les instructions d'un expert relève des réglages du module,
// pas de la rédaction d'un script. Même garde que /settings/video.
async function guard() {
  const u = await requireUser();
  requirePermission(u.role, "video", "configure");
  return u;
}

function revalidate(): void {
  revalidatePath("/settings/video");
  revalidatePath("/video");
  revalidatePath("/video/[id]", "page");
}

// Un refus métier (nom déjà pris, catégorie introuvable) revient en message français ; une vraie
// panne DB relance et devient une erreur serveur.
async function refusable<T>(run: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    return { ok: true, value: await run() };
  } catch (e) {
    if (e instanceof RefusalError) return { ok: false, message: e.message };
    throw e;
  }
}

export async function createVideoCategory(
  input: unknown,
): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  const u = await guard();
  const parsed = videoCategorySchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Entrée invalide." };

  const res = await refusable(() => createVideoCategoryCore({ ...parsed.data, userId: u.id }));
  if (!res.ok) return res;
  revalidate();
  return { ok: true, id: res.value };
}

export async function updateVideoCategory(
  input: unknown,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const u = await guard();
  const parsed = videoCategorySchema.extend(videoCategoryIdSchema.shape).safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Entrée invalide." };

  const res = await refusable(() => updateVideoCategoryCore({ ...parsed.data, userId: u.id }));
  if (!res.ok) return res;
  revalidate();
  return { ok: true };
}

export async function deleteVideoCategory(
  input: unknown,
): Promise<{ ok: true } | { ok: false; message: string }> {
  await guard();
  const parsed = videoCategoryIdSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Entrée invalide." };

  await deleteVideoCategoryCore(parsed.data.id);
  revalidate();
  return { ok: true };
}
