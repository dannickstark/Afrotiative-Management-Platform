// lib/studio/asset-core.ts — le SEUL chemin d'écriture vers render_assets (avec le nettoyage R2
// associé). Même discipline que lib/studio/template-core.ts : ce module N'A PAS de directive
// "use server" et n'est donc PAS appelable directement depuis le client — tout export d'un module
// "use server" est une Server Action appelable SANS authentification propre (voir le commentaire en
// tête de lib/actions/taxonomy-actions.ts), donc exporter les écritures brutes ci-dessous depuis
// lib/actions/asset-actions.ts en ferait un chemin d'écriture non gardé. lib/actions/asset-actions.ts
// est la SEULE porte : chaque fonction *Core d'ici n'est appelée qu'après requireUser() +
// requirePermission(user.role, "template", "manage").
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, renderAssets, renderTemplates } from "@/db";
import { getStudioConfig } from "./config";
import { putObject, deleteObject } from "@/lib/storage/r2";
import {
  validateImageAsset, validateFontAsset, findReferencingTemplates,
} from "./asset-validate";

export type ActionResult<T extends object = object> =
  ({ ok: true } & T) | { ok: false; message: string };

// ─────────────────────────────────────────────────────────────────────────────
export type UploadAssetInput = {
  kind: "image" | "font";
  name: string;
  file: File;
  // Ignorés pour kind: "image" — pertinents seulement pour une police, faute d'extracteur de
  // métadonnées de police dans ce dépôt (pas de fontkit/opentype.js en dépendance) : la famille, la
  // graisse et le style sont donc SAISIS par l'utilisateur au téléversement plutôt qu'inférés du
  // fichier — ce sont exactement les trois colonnes que render_assets réserve à cet effet
  // (font_family, font_weight, font_style, db/schema.ts).
  fontFamily?: string;
  fontWeight?: number;
  fontStyle?: "normal" | "italic";
  userId: string;
};

// yyyy/mm en UTC — même convention que storageKeyFor (lib/studio/store.ts), pour que
// assets/{yyyy}/{mm}/… range les fichiers dans le même schéma de préfixe temporel que renders/{yyyy}/{mm}/….
function assetKey(ext: string, now: Date): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `assets/${year}/${month}/${randomUUID()}.${ext}`;
}

export async function uploadAssetCore(input: UploadAssetInput): Promise<ActionResult<{ id: string }>> {
  const name = input.name.trim();
  if (!name) return { ok: false, message: "Le nom de l'asset est requis." };

  const cfg = getStudioConfig();
  if (!cfg) return { ok: false, message: "Stockage R2 non configuré." };

  const bytes = new Uint8Array(await input.file.arrayBuffer());

  let ext: string;
  let mime: string;
  let width: number | null = null;
  let height: number | null = null;
  let fontFamily: string | null = null;
  let fontWeight: number | null = null;
  let fontStyle: string | null = null;

  if (input.kind === "image") {
    const v = await validateImageAsset(bytes);
    if (!v.ok) return { ok: false, message: v.message };
    ext = v.ext; mime = v.mime; width = v.width; height = v.height;
  } else {
    const v = validateFontAsset(bytes);
    if (!v.ok) return { ok: false, message: v.message };
    ext = v.ext; mime = v.mime;
    fontFamily = input.fontFamily?.trim() || name;
    fontWeight = input.fontWeight ?? 400;
    fontStyle = input.fontStyle === "italic" ? "italic" : "normal";
  }

  const key = assetKey(ext, new Date());
  let url: string;
  try {
    url = await putObject(cfg, key, bytes, mime);
  } catch (e) {
    // Message autonome, SANS le texte natif — même politique que lib/studio/store.ts:R2RenderStore
    // et lib/studio/render.ts pour toute frontière avec une bibliothèque/un service externe.
    console.error("[studio] téléversement R2 d'un asset échoué :", e);
    return { ok: false, message: "Téléversement impossible : le stockage R2 est momentanément indisponible." };
  }

  const [row] = await db.insert(renderAssets).values({
    kind: input.kind, name, storageKey: key, url, mime, bytes: bytes.byteLength,
    width, height, fontFamily, fontWeight, fontStyle, uploadedBy: input.userId,
  }).returning({ id: renderAssets.id });

  return { ok: true, id: row!.id };
}

// ─────────────────────────────────────────────────────────────────────────────
// "Un asset référencé par au moins un gabarit NON ARCHIVÉ ne peut pas être supprimé ; le message
// nomme les gabarits concernés" (spec §5). La décision elle-même (findReferencingTemplates) est
// PURE et vit dans asset-validate.ts — testable sans DB (tests/studio-asset-validate.test.ts) ; ici
// on ne fait que lui fournir la bonne liste (WHERE archived = false), exactement comme
// template-core.ts filtre ses propres requêtes de portée.
export async function deleteAssetCore(id: string): Promise<ActionResult> {
  const [asset] = await db.select().from(renderAssets).where(eq(renderAssets.id, id)).limit(1);
  if (!asset) return { ok: false, message: "Asset introuvable." };

  const activeTemplates = await db
    .select({ id: renderTemplates.id, name: renderTemplates.name, scene: renderTemplates.scene })
    .from(renderTemplates)
    .where(eq(renderTemplates.archived, false));

  const referencing = findReferencingTemplates(id, activeTemplates);
  if (referencing.length > 0) {
    const names = referencing.map((t) => `« ${t.name} »`).join(", ");
    const noun = referencing.length > 1 ? "les gabarits" : "le gabarit";
    return {
      ok: false,
      message: `Impossible de supprimer « ${asset.name} » : utilisé par ${noun} ${names}. Retirez-le de ${referencing.length > 1 ? "ces gabarits" : "ce gabarit"} ou archivez-${referencing.length > 1 ? "les" : "le"} d'abord.`,
    };
  }

  await db.delete(renderAssets).where(eq(renderAssets.id, id));

  // Le fichier R2 est supprimé APRÈS la ligne (spec §5) : si la ligne avait déjà disparu (double
  // clic, deux onglets), on ne veut pas laisser un asset "en vie" côté base alors que l'objet R2 a
  // été supprimé sous ses pieds. Un échec de suppression R2 ici (panne transitoire) est journalisé
  // mais NE FAIT PAS échouer l'opération dans son ensemble : la ligne est déjà partie, c'est l'état
  // qui compte pour l'utilisateur (l'asset a bien disparu de la bibliothèque) ; un objet R2 orphelin
  // est un déchet silencieux et sans conséquence fonctionnelle, pas une incohérence visible.
  const cfg = getStudioConfig();
  if (cfg) {
    try {
      await deleteObject(cfg, asset.storageKey);
    } catch (e) {
      console.error(`[studio] suppression R2 de l'asset « ${id} » (clé ${asset.storageKey}) échouée :`, e);
    }
  }

  return { ok: true };
}
