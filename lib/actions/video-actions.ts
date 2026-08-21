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
  getInsertUrlCore, setInsertLinkStatusCore, verifyProjectLinksCore, setProjectStatusCore,
} from "@/lib/video/persist";
import { setProjectCategoryCore } from "@/lib/video/categories-persist";
import { verifyUrl } from "@/lib/video/link-check";
import { uploadInsertMediaCore } from "@/lib/video/insert-upload-core";
import { addTakeCore, updateTakeCore, deleteTakeCore, selectTakeCore } from "@/lib/video/takes-core";
import { TAKE_STATUSES, type TakeStatus } from "@/lib/video/schema";
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

// Édition d'un insert (SP3 « Inserts enrichis ») — accepte désormais le patch complet
// (url/kind/tcIn/tcOut/displayDurationSec/credit/rightsNote, tous optionnels), pas seulement `url` :
// voir le commentaire de updateInsertSchema (lib/validation.ts). Même garde que le reste de ce
// fichier ; le cœur DB vit dans updateBeatInsertCore (lib/video/persist.ts), pas ici.
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

// Vérification de lien d'insert (SP3, Task 3) : un seul insert (l'utilisateur clique « vérifier »
// sur une ligne précise) ou tout le projet (bouton global). Même garde "manage" que le reste de ce
// fichier — c'est le journaliste qui déclenche la vérification de ses propres inserts.
export async function verifyInsertLink(
  insertId: string,
): Promise<{ ok: true; status: "ok" | "mort" | "interdit" } | { ok: false; message: string }> {
  await guard();
  const insert = await getInsertUrlCore(insertId);
  if (!insert) return { ok: false, message: "Insert introuvable." };
  const { status } = await verifyUrl(insert.url);
  const res = await refusable(() => setInsertLinkStatusCore({ insertId, status }));
  if (!res.ok) return res;
  revalidateVideo();
  return { ok: true, status };
}

// Upload R2 d'un média d'insert (SP3, Task 4) : le journaliste dépose une image/un graphique pour
// remplacer une url externe fragile par un asset hébergé par nous. Même garde "manage" que le reste
// de ce fichier ; le cœur DB brut vit dans uploadInsertMediaCore (lib/video/insert-upload-core.ts).
export async function uploadInsertMedia(
  formData: FormData,
): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  await guard();
  const insertId = formData.get("insertId");
  const file = formData.get("file");
  if (typeof insertId !== "string" || !(file instanceof File)) return { ok: false, message: "Requête invalide." };
  const res = await refusable(() => uploadInsertMediaCore({ insertId, file }));
  if (!res.ok) return res;
  revalidateVideo();
  return { ok: true, url: res.value.url };
}

export async function verifyProjectLinks(
  projectId: string,
): Promise<{ ok: true; counts: { ok: number; mort: number; interdit: number } } | { ok: false; message: string }> {
  await guard();
  const res = await refusable(() => verifyProjectLinksCore({ projectId }));
  if (!res.ok) return res;
  revalidateVideo();
  return { ok: true, counts: res.value };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tournage — transitions de statut et prises (SP4, Task 4)
// ─────────────────────────────────────────────────────────────────────────────

async function transition(projectId: string, to: string): Promise<{ ok: true } | { ok: false; message: string }> {
  await guard();
  const res = await refusable(() => setProjectStatusCore({ projectId, to }));
  if (!res.ok) return res;
  revalidateVideo();
  return { ok: true };
}
export const markReadyToShoot = (projectId: string) => transition(projectId, "pret_a_tourner");
export const startShooting = (projectId: string) => transition(projectId, "tourne");
export const finishShooting = (projectId: string) => transition(projectId, "en_montage");

function parseStatus(v: unknown): TakeStatus | null {
  return typeof v === "string" && (TAKE_STATUSES as readonly string[]).includes(v) ? (v as TakeStatus) : null;
}

export async function addTake(
  input: { beatId: string; status?: string },
): Promise<{ ok: true; id: string; number: number } | { ok: false; message: string }> {
  await guard();
  if (typeof input?.beatId !== "string") return { ok: false, message: "Requête invalide." };
  const status = input.status === undefined ? undefined : (parseStatus(input.status) ?? undefined);
  const res = await refusable(() => addTakeCore({ beatId: input.beatId, status }));
  if (!res.ok) return res;
  revalidateVideo();
  return { ok: true, id: res.value.id, number: res.value.number };
}

export async function updateTake(
  input: { takeId: string; status?: string; note?: string | null },
): Promise<{ ok: true } | { ok: false; message: string }> {
  await guard();
  if (typeof input?.takeId !== "string") return { ok: false, message: "Requête invalide." };
  const status = input.status === undefined ? undefined : parseStatus(input.status);
  if (input.status !== undefined && status === null) return { ok: false, message: "Statut de prise invalide." };
  const res = await refusable(() => updateTakeCore({ takeId: input.takeId, status: status ?? undefined, note: input.note }));
  if (!res.ok) return res;
  revalidateVideo();
  return { ok: true };
}

export async function deleteTake(takeId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  await guard();
  const res = await refusable(() => deleteTakeCore({ takeId }));
  if (!res.ok) return res;
  revalidateVideo();
  return { ok: true };
}

export async function selectTake(
  input: { beatId: string; takeId: string | null },
): Promise<{ ok: true } | { ok: false; message: string }> {
  await guard();
  if (typeof input?.beatId !== "string") return { ok: false, message: "Requête invalide." };
  const res = await refusable(() => selectTakeCore({ beatId: input.beatId, takeId: input.takeId }));
  if (!res.ok) return res;
  revalidateVideo();
  return { ok: true };
}
