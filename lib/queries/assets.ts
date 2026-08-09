import { db, renderAssets, user } from "@/db";
import { desc, eq } from "drizzle-orm";

// lib/queries/assets.ts — lecture SEULE de render_assets (Tâche 11). Alimente à la fois la page
// bibliothèque (app/(app)/studio/assets/page.tsx) et les sélecteurs branchés dans l'éditeur
// (Tâche 13, components/studio/asset-picker.tsx) : les deux ont besoin de la MÊME projection
// (thumbnail/échantillon), pas d'une liste tronquée pour l'un et complète pour l'autre.
export type AssetRow = {
  id: string;
  kind: "image" | "font";
  name: string;
  url: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  fontFamily: string | null;
  fontWeight: number | null;
  fontStyle: "normal" | "italic" | null;
  uploadedByName: string | null;
  createdAt: Date;
};

export async function listAssets(): Promise<AssetRow[]> {
  const rows = await db
    .select({
      id: renderAssets.id, kind: renderAssets.kind, name: renderAssets.name,
      url: renderAssets.url, mime: renderAssets.mime, bytes: renderAssets.bytes,
      width: renderAssets.width, height: renderAssets.height,
      fontFamily: renderAssets.fontFamily, fontWeight: renderAssets.fontWeight, fontStyle: renderAssets.fontStyle,
      uploadedByName: user.name, createdAt: renderAssets.createdAt,
    })
    .from(renderAssets)
    .leftJoin(user, eq(user.id, renderAssets.uploadedBy))
    .orderBy(desc(renderAssets.createdAt));

  return rows.map((r) => ({
    ...r,
    kind: r.kind as "image" | "font",
    fontStyle: r.fontStyle === "italic" ? "italic" as const : r.fontStyle === "normal" ? "normal" as const : null,
  }));
}
