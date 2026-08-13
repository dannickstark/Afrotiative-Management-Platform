"use client";

import Link from "next/link";
import { fontFaceFamily, fontProxyUrl } from "@/lib/studio/font-face";
import { DEFAULT_CATEGORY_COLOR } from "@/lib/studio/default-category-color";
import type { AssetRow } from "@/lib/queries/assets";

// components/studio/panels/marque-panel.tsx — Tâche 2 (U1, spec §3) : le contenu de la catégorie
// « Marque » du rail. LECTURE SEULE (spec §3 : « Read-only surfaces onto what the asset and font
// libraries already hold ») — ce panneau n'a NI formulaire de téléversement, NI suppression, NI
// dialogue de taxonomie : il affiche ce qui existe déjà et RENVOIE vers les pages de gestion
// existantes (/studio/assets, /settings/taxonomy) pour toute écriture, plutôt que de reconstruire
// leurs chemins d'écriture ici. C'est pour ça qu'aucun `AssetLibrary` ni `TaxonomyTables` n'est monté
// dans ce fichier : les monter donnerait, dans ce panneau étroit, des boutons Téléverser/Supprimer/
// Modifier qui n'ont pas leur place dans une surface annoncée lecture seule.
//
// Trois sections (spec §3) :
//   1. Polices téléversées — nom + échantillon rendu, même technique (@font-face inline pointé sur
//      le proxy même origine) que components/studio/asset-library.tsx et asset-picker.tsx, pour ne
//      jamais diverger sur comment une police d'asset s'aperçoit dans le navigateur.
//   2. Logo de la marque — {{brand.logo}} (lib/studio/tokens.ts) vient de STUDIO_BRAND_LOGO_URL
//      (lib/studio/bindings.ts:brandLogoUrl()), UNE variable d'environnement, pas un asset
//      téléversable : il n'existe donc aucune page de gestion à lier ici, seulement l'aperçu.
//   3. Couleurs de catégorie — {{category.color}} retombe sur DEFAULT_CATEGORY_COLOR quand une
//      catégorie n'a pas de couleur propre (db/schema.ts:wpCategories.color) ; la modification reste
//      sur /settings/taxonomy (taxonomy:manage), pas ici.
export interface MarqueCategoryColor {
  id: string;
  name: string;
  color: string | null;
}

export interface MarquePanelProps {
  assets: AssetRow[];
  brandLogoUrl: string;
  categories: MarqueCategoryColor[];
}

export function MarquePanel({ assets, brandLogoUrl, categories }: MarquePanelProps) {
  const fonts = assets.filter((a) => a.kind === "font");

  return (
    <div className="flex flex-col gap-4" data-testid="marque-panel">
      <section className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-heading text-xs font-semibold text-muted-foreground uppercase">Polices ({fonts.length})</h3>
          <Link href="/studio/assets" className="text-xs text-muted-foreground underline underline-offset-2">
            Gérer
          </Link>
        </div>
        {fonts.length === 0 ? (
          <p className="text-xs text-muted-foreground">Aucune police téléversée pour l&rsquo;instant.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {fonts.map((f) => (
              <li key={f.id} className="rounded-md border p-2">
                <style>{`@font-face { font-family: "${fontFaceFamily(f.id)}"; src: url("${fontProxyUrl(f.id)}"); font-weight: ${f.fontWeight ?? 400}; font-style: ${f.fontStyle ?? "normal"}; font-display: swap; }`}</style>
                <p className="truncate text-sm font-medium">{f.fontFamily ?? f.name}</p>
                <p className="truncate text-sm" style={{ fontFamily: `"${fontFaceFamily(f.id)}"` }}>
                  Abécédaire 0123
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-1.5">
        <h3 className="font-heading text-xs font-semibold text-muted-foreground uppercase">Logo de la marque</h3>
        {brandLogoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={brandLogoUrl} alt="Logo de la marque"
            className="max-h-16 w-full rounded border bg-muted object-contain p-2"
          />
        ) : (
          <p className="text-xs text-muted-foreground">
            Aucun logo configuré (variable <code>STUDIO_BRAND_LOGO_URL</code>).
          </p>
        )}
      </section>

      <section className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-heading text-xs font-semibold text-muted-foreground uppercase">Couleurs des catégories</h3>
          <Link href="/settings/taxonomy" className="text-xs text-muted-foreground underline underline-offset-2">
            Gérer
          </Link>
        </div>
        {categories.length === 0 ? (
          <p className="text-xs text-muted-foreground">Aucune catégorie.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {categories.map((c) => (
              <li key={c.id} className="flex items-center gap-2 text-sm">
                <span
                  className="size-3.5 shrink-0 rounded-full border"
                  style={{ backgroundColor: c.color ?? DEFAULT_CATEGORY_COLOR }}
                  aria-hidden
                />
                <span className="truncate">{c.name}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
