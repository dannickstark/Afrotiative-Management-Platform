import { eq } from "drizzle-orm";
import { db, renderAssets } from "@/db";

// app/api/studio/asset-fonts/[id]/route.ts — Tâche 13 (Lot 3). Proxy MÊME ORIGINE pour les octets
// d'une police d'asset, ajouté après avoir piloté un VRAI navigateur (pas repérable par `bun test`,
// qui n'exécute jamais de code navigateur) : `@font-face` EXIGE des en-têtes CORS pour charger une
// ressource cross-origin (contrairement à `<img src>`, qui s'affiche sans CORS) — le bucket R2
// public (lib/storage/r2.ts:publicUrlFor) n'en envoie aucun. Sans ce proxy, l'échantillon rendu de
// components/studio/asset-library.tsx et components/studio/asset-picker.tsx échouait
// SILENCIEUSEMENT dans Chrome (« blocked by CORS policy » en console ; à l'écran, juste un texte
// affiché dans une police de repli, sans le moindre message d'erreur visible).
//
// Public et SANS authentification, délibérément : la ressource relayée est déjà publique (l'URL R2
// source, elle, ne demande aucune authentification) — ce proxy ne change donc rien à la surface de
// sécurité réelle, il la rend seulement MÊME ORIGINE pour satisfaire la contrainte CORS propre aux
// polices. DbAssetLoader (lib/studio/asset-loader.ts, exécuté CÔTÉ SERVEUR pour le vrai rendu) n'a
// besoin d'AUCUN de ces deux détours : un fetch() serveur-à-serveur n'est jamais soumis à CORS, une
// politique appliquée par le NAVIGATEUR uniquement.
export async function GET(_req: Request, ctx: RouteContext<"/api/studio/asset-fonts/[id]">) {
  const { id } = await ctx.params;

  let row: { url: string; kind: string; mime: string } | undefined;
  try {
    [row] = await db
      .select({ url: renderAssets.url, kind: renderAssets.kind, mime: renderAssets.mime })
      .from(renderAssets).where(eq(renderAssets.id, id)).limit(1);
  } catch {
    // Identifiant malformé (pas un UUID) : PostgreSQL lève plutôt que de renvoyer zéro ligne pour
    // une colonne uuid — traité comme "introuvable", pas comme une erreur serveur.
    return new Response(null, { status: 404 });
  }
  if (!row || row.kind !== "font") return new Response(null, { status: 404 });

  let upstream: Response;
  try {
    upstream = await fetch(row.url);
  } catch {
    return new Response(null, { status: 502 });
  }
  if (!upstream.ok || !upstream.body) return new Response(null, { status: 502 });

  return new Response(upstream.body, {
    headers: {
      "content-type": row.mime || "font/ttf",
      // Immuable : chaque asset a sa propre clé R2 (assets/{yyyy}/{mm}/{uuid}.{ext},
      // lib/studio/asset-core.ts:assetKey) — jamais réécrite en place, donc jamais périmée.
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
