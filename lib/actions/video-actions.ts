"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import {
  createVideoProjectSchema, updateBeatSchema, updateInsertSchema, prepareImportSchema, applyImportSchema,
  reorderBeatsSchema, revertJournalEntrySchema,
} from "@/lib/validation";
import {
  createVideoProjectCore, updateBeatCore, updateBeatInsertCore, reorderBeatsCore,
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

// Round de correction 1 (Task 12, I3) : le succès renvoie l'état RÉELLEMENT stocké
// (`spokenText` assaini par sanitizeArticleHtml, `estimatedDurationSec` recalculé avec la cadence
// des réglages) — updateBeatCore le renvoie désormais plutôt que `void`. L'appelant client
// (components/video/beat-inspector.tsx) doit s'en servir pour sa mise à jour optimiste plutôt que
// de réinjecter son propre HTML Tiptap non assaini ou une durée recalculée côté client.
export async function updateBeat(
  input: unknown,
): Promise<
  | { ok: true; spokenText: string; estimatedDurationSec: number; durationOverrideSec: number | null }
  | { ok: false; message: string }
> {
  await guard();

  const parsed = updateBeatSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Entrée invalide." };

  const beat = await updateBeatCore(parsed.data);
  revalidatePath("/video");
  return { ok: true, ...beat };
}

// Complément Task 12 (revue) — l'humain corrige à la main l'URL d'un insert (spec §6 : « liste des
// inserts avec URL éditable »). Même garde que le reste de ce fichier ; le cœur DB vit dans
// updateBeatInsertCore (lib/video/persist.ts), pas ici. Restreint à `url` (round de correction 1,
// I4) : voir le commentaire de updateInsertSchema (lib/validation.ts).
export async function updateInsert(
  input: unknown,
): Promise<{ ok: true } | { ok: false; message: string }> {
  await guard();

  const parsed = updateInsertSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Entrée invalide." };

  await updateBeatInsertCore(parsed.data);
  revalidatePath("/video");
  return { ok: true };
}

export async function reorderBeats(
  input: unknown,
): Promise<{ ok: true } | { ok: false; message: string }> {
  await guard();

  const parsed = reorderBeatsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Entrée invalide." };

  await reorderBeatsCore(parsed.data);
  return { ok: true };
}

export async function prepareImport(
  input: unknown,
): Promise<{ ok: true; journalId: string; diff: Diff } | { ok: false; issues: Issue[] }> {
  const u = await guard();

  const parsed = prepareImportSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    };
  }

  return prepareImportCore({ ...parsed.data, userId: u.id });
}

export async function applyImport(
  input: unknown,
): Promise<{ ok: true; applied: number } | { ok: false; message: string }> {
  await guard();

  const parsed = applyImportSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Entrée invalide." };

  const result = await applyImportCore(parsed.data);
  if (result.ok) revalidatePath("/video");
  return result;
}

export async function revertJournalEntry(
  input: unknown,
): Promise<{ ok: true } | { ok: false; message: string }> {
  await guard();

  const parsed = revertJournalEntrySchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Entrée invalide." };

  const result = await revertJournalEntryCore(parsed.data.journalId);
  if (result.ok) revalidatePath("/video");
  return result;
}
