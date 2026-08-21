// SP3 Tâche 4 — upload R2 d'un média d'insert (image/graphique). Même discipline que
// lib/studio/asset-core.ts#uploadAssetCore : ce module N'A PAS de directive "use server" — tout
// export d'un module "use server" est un point d'entrée réseau sans authentification propre (voir
// lib/actions/taxonomy-actions.ts) — donc la seule porte gardée est
// lib/actions/video-actions.ts#uploadInsertMedia (requireUser() + requirePermission("video","manage")).
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, beatInserts, scriptBeats, scriptVariants } from "@/db";
import { getStudioConfig } from "@/lib/studio/config";
import { putObject, type R2Deps } from "@/lib/storage/r2";
import { validateImageAsset } from "@/lib/studio/asset-validate";
import { RefusalError } from "@/lib/video/persist";

// yyyy/mm en UTC — même convention que assetKey (lib/studio/asset-core.ts) et storageKeyFor
// (lib/studio/store.ts) : video/inserts/{yyyy}/{mm}/… range les médias d'insert dans le même
// schéma de préfixe temporel que assets/{yyyy}/{mm}/… et renders/{yyyy}/{mm}/….
export function insertMediaKey(ext: string, now: Date): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `video/inserts/${year}/${month}/${randomUUID()}.${ext}`;
}

export async function uploadInsertMediaCore(
  input: { insertId: string; file: File; deps?: R2Deps },
): Promise<{ url: string; r2Key: string }> {
  const cfg = getStudioConfig();
  if (!cfg) throw new RefusalError("Stockage R2 non configuré.");

  const bytes = new Uint8Array(await input.file.arrayBuffer());
  const v = await validateImageAsset(bytes);
  if (!v.ok) throw new RefusalError(v.message);

  const key = insertMediaKey(v.ext, new Date());
  // putObject AVANT la transaction (comme uploadAssetCore) : en cas d'échec DB, l'objet R2 est
  // orphelin — acceptable (nettoyage hors périmètre), on ne référence rien tant que la ligne n'est pas écrite.
  const url = await putObject(cfg, key, bytes, v.mime, input.deps);

  await db.transaction(async (tx) => {
    const [loc] = await tx.select({ beatId: beatInserts.beatId }).from(beatInserts).where(eq(beatInserts.id, input.insertId));
    if (!loc) throw new RefusalError("Insert introuvable.");
    const [beat] = await tx.select({ variantId: scriptBeats.variantId }).from(scriptBeats).where(eq(scriptBeats.id, loc.beatId));
    if (!beat) throw new RefusalError("Beat introuvable pour cet insert.");
    await tx.select({ id: scriptVariants.id }).from(scriptVariants).where(eq(scriptVariants.id, beat.variantId)).for("update");
    await tx.update(scriptBeats).set({ locallyEditedAt: new Date(), updatedAt: new Date() }).where(eq(scriptBeats.id, loc.beatId));
    // Asset hébergé par nous → lien réputé `ok`.
    await tx.update(beatInserts).set({ r2Key: key, url, linkStatus: "ok", linkCheckedAt: new Date(), updatedAt: new Date() })
      .where(eq(beatInserts.id, input.insertId));
    await tx.update(scriptVariants).set({ updatedAt: new Date() }).where(eq(scriptVariants.id, beat.variantId));
  });

  return { url, r2Key: key };
}
