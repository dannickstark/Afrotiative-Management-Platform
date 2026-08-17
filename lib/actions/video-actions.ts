"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import {
  createVideoProjectSchema, updateBeatSchema, updateInsertSchema, prepareImportSchema, applyImportSchema,
  reorderBeatsSchema, revertJournalEntrySchema, setProjectCategorySchema,
} from "@/lib/validation";
import {
  createVideoProjectCore, updateBeatCore, updateBeatInsertCore, reorderBeatsCore,
  prepareImportCore, applyImportCore, revertJournalEntryCore, RefusalError,
} from "@/lib/video/persist";
import { setProjectCategoryCore } from "@/lib/video/categories-persist";
import type { Diff, Issue } from "@/lib/video/import";

// Round de correction final : toute écriture revalide AUSSI `/video/[id]`, la page où l'édition a
// effectivement lieu — jusqu'ici seule la liste `/video` l'était. Conséquence concrète de l'oubli :
// `variantUpdatedAt`, lu au rendu de la page projet et renvoyé jusqu'à `applyImport` pour le
// contrôle de péremption (lib/video/persist.ts#applyImportCore), restait périmé après toute
// édition, ce qui bloquait l'application de tout import jusqu'à un rechargement manuel.
// `"page"` est OBLIGATOIRE dès que le chemin porte un segment dynamique : la forme littérale
// `/video/<uuid>` demanderait de connaître le projectId, que `updateBeat`/`updateInsert`/
// `reorderBeats` ne reçoivent pas (ils ne portent qu'un beatId / insertId / variantId).
function revalidateVideo(): void {
  revalidatePath("/video");
  revalidatePath("/video/[id]", "page");
}

// `updateBeatCore`/`updateBeatInsertCore` LÈVENT leurs refus métier (« Beat introuvable »,
// « Variante introuvable ») au lieu de les retourner : leur valeur de retour porte déjà l'état
// stocké. Sans cette conversion, un refus routinier — le beat a été supprimé par un import concurrent
// pendant que l'inspecteur était ouvert — remontait en erreur serveur brute côté client, là où
// `applyImport`/`revertJournalEntry` renvoient depuis toujours un `{ ok: false, message }` français.
// Une vraie panne DB n'est PAS avalée : seules les `RefusalError` sont converties, le reste relance.
async function refusable<T>(run: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    return { ok: true, value: await run() };
  } catch (e) {
    if (e instanceof RefusalError) return { ok: false, message: e.message };
    throw e;
  }
}

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
  revalidateVideo();
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

  const beat = await refusable(() => updateBeatCore(parsed.data));
  if (!beat.ok) return beat;
  revalidateVideo();
  return { ok: true, ...beat.value };
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

  const result = await refusable(() => updateBeatInsertCore(parsed.data));
  if (!result.ok) return result;
  revalidateVideo();
  return { ok: true };
}

export async function reorderBeats(
  input: unknown,
): Promise<{ ok: true } | { ok: false; message: string }> {
  await guard();

  const parsed = reorderBeatsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Entrée invalide." };

  await reorderBeatsCore(parsed.data);
  // Un réordonnancement bumpe lui aussi `scriptVariants.updatedAt` (lib/video/persist.ts) : sans
  // revalidation, le `variantUpdatedAt` embarqué dans la page reste périmé et bloque l'application
  // de l'import suivant. Le glisser-déposer garde son rendu optimiste — la revalidation ne fait que
  // réaligner l'état serveur derrière lui, sur un ordre déjà identique.
  revalidateVideo();
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
  if (result.ok) revalidateVideo();
  return result;
}

export async function revertJournalEntry(
  input: unknown,
): Promise<{ ok: true } | { ok: false; message: string }> {
  await guard();

  const parsed = revertJournalEntrySchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Entrée invalide." };

  const result = await revertJournalEntryCore(parsed.data.journalId);
  if (result.ok) revalidateVideo();
  return result;
}

// Changer la catégorie d'un projet vidéo : garde "manage" (comme le reste de ce fichier), pas
// "configure" — c'est le journaliste qui choisit la catégorie de SA vidéo, "configure" reste
// réservé à l'édition des catégories elles-mêmes (lib/actions/video-category-actions.ts).
export async function setProjectCategory(
  input: unknown,
): Promise<{ ok: true } | { ok: false; message: string }> {
  await guard();
  const parsed = setProjectCategorySchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Entrée invalide." };

  const res = await refusable(() => setProjectCategoryCore(parsed.data));
  if (!res.ok) return res;
  revalidateVideo();
  return { ok: true };
}
