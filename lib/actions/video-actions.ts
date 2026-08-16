"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { createVideoProjectSchema, updateBeatSchema } from "@/lib/validation";
import {
  createVideoProjectCore, updateBeatCore, reorderBeatsCore,
  prepareImportCore, applyImportCore, revertJournalEntryCore,
} from "@/lib/video/persist";
import type { Diff, Issue } from "@/lib/video/import";

// Le cœur DB brut (lib/video/persist.ts) est un module SANS "use server" : tout export d'un module
// "use server" est un point d'entrée réseau sans authentification propre (motif de
// lib/actions/taxonomy-actions.ts), donc le writer brut n'y a pas sa place — et c'est aussi ce qui
// le rendra réutilisable par le futur serveur MCP (SP1 bis). Ce fichier n'exporte QUE des actions
// gardées par requireUser() + requirePermission(). "manage" et non "configure" : c'est le
// journaliste qui écrit les scripts vidéo — "configure" reste réservé aux réglages du module
// (/settings/video).
async function guard() {
  const u = await requireUser();
  requirePermission(u.role, "video", "manage");
  return u;
}

export async function createVideoProject(
  input: unknown,
): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  const u = await guard();

  const parsed = createVideoProjectSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Entrée invalide." };

  const id = await createVideoProjectCore({ ...parsed.data, userId: u.id });
  revalidatePath("/video");
  return { ok: true, id };
}

export async function updateBeat(
  input: unknown,
): Promise<{ ok: true } | { ok: false; message: string }> {
  await guard();

  const parsed = updateBeatSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Entrée invalide." };

  await updateBeatCore(parsed.data);
  return { ok: true };
}

export async function reorderBeats(
  variantId: string,
  order: string[],
): Promise<{ ok: true } | { ok: false; message: string }> {
  await guard();

  if (!variantId || order.length === 0) return { ok: false, message: "Réordonnancement invalide." };

  await reorderBeatsCore({ variantId, order });
  return { ok: true };
}

export async function prepareImport(input: {
  projectId: string;
  variantId: string;
  raw: string;
  source: "copier_coller" | "mcp" | "manuel";
}): Promise<{ ok: true; journalId: string; diff: Diff } | { ok: false; issues: Issue[] }> {
  const u = await guard();
  return prepareImportCore({ ...input, userId: u.id });
}

export async function applyImport(input: {
  journalId: string;
  variantId: string;
  accept: string[];
  variantUpdatedAt: Date;
}): Promise<{ ok: true; applied: number } | { ok: false; message: string }> {
  await guard();

  const result = await applyImportCore(input);
  if (result.ok) revalidatePath("/video");
  return result;
}

export async function revertJournalEntry(
  journalId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  await guard();

  const result = await revertJournalEntryCore(journalId);
  if (result.ok) revalidatePath("/video");
  return result;
}
