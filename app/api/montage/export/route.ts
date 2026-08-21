import { asc, eq } from "drizzle-orm";
import { db, scriptVariants } from "@/db";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { resolveShare } from "@/lib/montage/access";
import { readConducteurCore } from "@/lib/montage/persist";
import { toShotListCsv, toShotListJson, toMediaManifest } from "@/lib/montage/export";

export const runtime = "nodejs";

// Deux voies d'accès : `?token=` (public, via un lien de partage — ne donne jamais accès qu'au
// projet DE ce jeton) OU `?variantId=` (interne, session + garde video:read). Le jeton est traité
// EN PREMIER et, s'il est présent, écrase toute `variantId` fournie par le client : un jeton ne
// doit jamais pouvoir emprunter la variantId d'un autre projet.
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const format = url.searchParams.get("format") ?? "csv";
  const token = url.searchParams.get("token");

  let variantId = url.searchParams.get("variantId");
  if (token) {
    const share = await resolveShare(token);
    if (!share.ok) return new Response("Lien invalide", { status: 404 });
    const [v] = await db.select().from(scriptVariants).where(eq(scriptVariants.projectId, share.projectId)).orderBy(asc(scriptVariants.position)).limit(1);
    variantId = v?.id ?? null;
  } else {
    const u = await requireUser();
    requirePermission(u.role, "video", "read");
  }
  if (!variantId) return new Response("Variante introuvable", { status: 404 });

  const read = await readConducteurCore(variantId);
  if (!read) return new Response("Conducteur introuvable", { status: 404 });

  if (format === "json") {
    return Response.json(toShotListJson(read.conducteur), {
      headers: { "Content-Disposition": 'attachment; filename="conducteur.json"' },
    });
  }
  if (format === "manifest") {
    return Response.json(toMediaManifest(read.conducteur), {
      headers: { "Content-Disposition": 'attachment; filename="medias.json"' },
    });
  }
  return new Response(toShotListCsv(read.conducteur), {
    headers: { "content-type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="conducteur.csv"' },
  });
}
