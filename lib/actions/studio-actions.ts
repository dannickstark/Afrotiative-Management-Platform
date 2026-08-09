"use server";
// lib/actions/studio-actions.ts — les SEULES portes gardées vers render_templates /
// render_template_versions. Tout export d'un module "use server" est une Server Action appelable
// SANS authentification propre (voir le commentaire en tête de lib/actions/taxonomy-actions.ts) :
// c'est pourquoi les écritures brutes vivent dans lib/studio/template-core.ts (un module SANS
// "use server", donc non exposé comme point d'entrée réseau) et pourquoi chaque export ci-dessous
// commence par requireUser() + requirePermission() avant d'appeler son homologue *Core.
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import type { SessionUser } from "@/lib/session";
import {
  createTemplateSchema, createTemplateCore, renameTemplateCore, duplicateTemplateCore,
  archiveTemplateCore, saveTemplateSceneCore, publishTemplateCore, restoreVersionCore,
  type CreateTemplateInput,
} from "@/lib/studio/template-core";

async function guard(action: "manage" | "publish"): Promise<SessionUser> {
  const user = await requireUser();
  requirePermission(user.role, "template", action);
  return user;
}

export async function createTemplate(input: CreateTemplateInput) {
  const user = await guard("manage");
  const parsed = createTemplateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, message: parsed.error.issues[0]?.message ?? "Entrée invalide." };
  }

  const res = await createTemplateCore(parsed.data, user.id);
  if (res.ok) revalidatePath("/studio");
  return res;
}

export async function renameTemplate(id: string, name: string) {
  await guard("manage");
  const res = await renameTemplateCore(id, name);
  if (res.ok) revalidatePath("/studio");
  return res;
}

export async function duplicateTemplate(id: string) {
  const user = await guard("manage");
  const res = await duplicateTemplateCore(id, user.id);
  if (res.ok) revalidatePath("/studio");
  return res;
}

export async function archiveTemplate(id: string, archived: boolean) {
  await guard("manage");
  const res = await archiveTemplateCore(id, archived);
  if (res.ok) revalidatePath("/studio");
  return res;
}

// Point d'entrée de l'autosauvegarde (spec §3, différé 1,5 s côté client — Tâche 9). Garder ce
// chemin léger : pas de revalidatePath("/studio") ici, seule /studio/[id] affiche le brouillon.
export async function saveTemplateScene(id: string, scene: unknown) {
  await guard("manage");
  const res = await saveTemplateSceneCore(id, scene);
  if (res.ok) revalidatePath(`/studio/${id}`);
  return res;
}

export async function publishTemplate(id: string) {
  const user = await guard("publish");
  const res = await publishTemplateCore(id, user.id);
  if (res.ok) { revalidatePath("/studio"); revalidatePath(`/studio/${id}`); }
  return res;
}

export async function restoreVersion(id: string, version: number) {
  await guard("manage");
  const res = await restoreVersionCore(id, version);
  if (res.ok) revalidatePath(`/studio/${id}`);
  return res;
}
