import sharp from "sharp";
import { isSafePublicHttpUrl } from "@/lib/url-guard";

export class ImageFetchError extends Error {}

// Properties Pro P1, Tâche 3 — l'image préparée renvoie DÉSORMAIS sa taille en pixels À CÔTÉ de la
// data URI. Le chemin de rendu unique (element.ts#imageNode, fond en `<div>`) en a besoin : pour
// `cover`/`contain`/`tile`, la POSITION de fond que Satori exige en PIXELS (focalToPositionPx, le `%`
// de Satori est bogué — spike, Tâche 1) se calcule à partir de la taille EFFECTIVE de l'image peinte,
// elle-même dérivée de la taille INTRINSÈQUE de l'asset préparé. Seul `prepareImage` connaît cette
// intrinsèque (il vient de la décoder), il la remonte donc.
export type PreparedImage = { uri: string; w: number; h: number };

export type PrepareImageOptions = {
  url: string;
  // Les dimensions du CADRE (px). Ne servent plus à RECADRER (le chemin unique a besoin de l'image à
  // sa taille naturelle pour un point focal hors-centre sur `cover`) : elles bornent seulement la
  // taille préparée à un plafond raisonnable (côté long ≤ 2×max(w,h)) — assez de marge pour la mise à
  // l'échelle `cover`/retina, sans faire enfler la data URI.
  width: number;
  height: number;
  blur?: number;
  overlay?: string;
  // Properties Pro P1 (revue de branche) — le MODE de cadrage et ses paramètres, nécessaires UNIQUEMENT
  // pour corriger la force du flou (voir le bloc flou plus bas). Le flou est appliqué à la résolution
  // PRÉPARÉE (bornée au plafond, donc dépendante de la résolution SOURCE), puis Satori redimensionne
  // l'image préparée sur le cadre — ce qui, sans correction, ferait dépendre le flou final du plafond.
  // On a besoin de l'échelle prepared->peint, qui dépend du mode. Absents = repli `cover` (le cas le
  // plus courant, et celui de l'ancien `fit:"cover"`). N'affectent RIEN d'autre que le sigma du flou.
  sizing?: "cover" | "contain" | "stretch" | "tile" | "custom";
  tileScale?: number;
  customSize?: { w: number; h: number };
  // Injecté par les tests uniquement : permet d'atteindre un serveur fixture local. Le garde SSRF
  // n'est jamais contourné par la seule présence de ce paramètre — voir plus bas, la levée de la
  // garde exige EN PLUS process.env.NODE_ENV === "test", pour qu'un futur appelant de production
  // (cache, retry…) ne puisse pas désactiver silencieusement la protection en fournissant un
  // fetchImpl (par exemple pour l'instrumentation).
  fetchImpl?: typeof fetch;
};

// L'échelle ISOTROPE prepared->peint, par mode de cadrage — pour pré-diviser le sigma du flou (voir
// prepareImage). Reflète EXACTEMENT le `effImg` d'element.ts#effectiveImage pour cover/contain/tile,
// où la mise à l'échelle est UNIFORME (un seul facteur). Pour stretch/custom, la mise à l'échelle est
// non uniforme (axes X et Y différents) alors qu'un flou gaussien sharp est isotrope : on prend la
// MOYENNE GÉOMÉTRIQUE des deux facteurs d'axe, une approximation isotrope raisonnable — la correction
// de FLOU pour ces deux modes n'est donc pas exacte au pixel, seulement débarrassée de la dépendance
// au plafond, ce qui est le contrat (cover/contain, les cas dominants, sont exacts).
function paintedScale(
  sizing: "cover" | "contain" | "stretch" | "tile" | "custom",
  fw: number, fh: number, iw: number, ih: number,
  tileScale: number | undefined, customSize: { w: number; h: number } | undefined,
): number {
  switch (sizing) {
    case "contain":
      return Math.min(fw / iw, fh / ih);
    case "stretch":
      return Math.sqrt((fw / iw) * (fh / ih));
    case "tile":
      return tileScale ?? 1;
    case "custom":
      // customSize absent malgré sizing:"custom" : repli CONTAIN, identique à element.ts#effectiveImage.
      if (!customSize) return Math.min(fw / iw, fh / ih);
      return Math.sqrt((customSize.w / iw) * (customSize.h / ih));
    case "cover":
    default:
      return Math.max(fw / iw, fh / ih);
  }
}

// #RRGGBB ou #RRGGBBAA -> {r,g,b,alpha}
function parseHex(hex: string): { r: number; g: number; b: number; alpha: number } {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
    alpha: full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1,
  };
}

// C'est ICI que se fait le flou, en raster, avant composition — Satori n'a pas de backdrop-filter.
// L'image N'EST PLUS recadrée au cadre (Tâche 3, chemin unique) : elle est préparée à sa taille
// NATURELLE, seulement BORNÉE à un plafond (côté long ≤ 2×max(cadre.w, cadre.h)) en préservant le
// rapport d'aspect. Le recadrage/positionnement `cover`/`contain`/`tile`… est fait par le fond CSS de
// Satori (element.ts#imageNode) à partir de la taille intrinsèque remontée ci-dessous — c'est ce qui
// rend un point focal hors-centre possible sur `cover` (impossible quand l'image était pré-recadrée).
//
// NOTE POST-REVUE (recadrage `cover` : ce qui est réellement conservé). L'ancien chemin
// `<img objectFit:cover>` pré-recadrait via `sharp.resize(fit:"cover")`, dont le recadrage par défaut
// est CONTENU (`position:"attention"`, content-aware). Le chemin unique l'a DÉLIBÉRÉMENT abandonné : le
// recadrage est délégué au fond CSS de Satori. MAIS — mesuré à la revue de branche, épinglé par
// tests/studio-image-render.test.ts (§0, témoin hors-centre) — Satori 0.29 PLAFONNE `background-position`
// négatif à 0, donc un `cover` débordant conserve le coin HAUT-GAUCHE (l'origine), PAS le centre, et le
// point focal reste sans effet sur cet axe. L'aperçu navigateur (layer-view.tsx), lui, CENTRE (le CSS
// natif applique correctement la position en `%`) : Montage et Rendu réel DIVERGENT donc pour un `cover`
// débordant à point focal ≠ {0,0}. Corriger cela (recadrer en amont dans sharp AU point focal) est un
// chantier à part — hors périmètre de cette revue, qui ne touche ni cover ni le point focal.
export async function prepareImage(opts: PrepareImageOptions): Promise<PreparedImage> {
  const { url, width, height, blur, overlay } = opts;
  const doFetch = opts.fetchImpl ?? fetch;

  // fetchImpl ne lève la garde SSRF QUE sous bun test (process.env.NODE_ENV === "test") : c'est
  // ce qui empêche un futur appelant de production de désactiver la garde en injectant fetchImpl
  // (par ex. un wrapper de cache ou de retry). En dehors des tests, la garde s'applique toujours,
  // même si fetchImpl est fourni — celui-ci ne sert alors que de fonction fetch personnalisée.
  const guardBypassed = !!opts.fetchImpl && process.env.NODE_ENV === "test";
  if (!guardBypassed && !isSafePublicHttpUrl(url)) {
    throw new ImageFetchError(`Image refusée : l'URL « ${url} » n'est pas une adresse publique autorisée.`);
  }

  let bytes: Uint8Array;
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    throw new ImageFetchError(`Téléchargement de l'image échoué (${url}) : ${(e as Error).message}`);
  }

  const fw = Math.max(1, Math.round(width));
  const fh = Math.max(1, Math.round(height));
  // Plafond du côté long : 2×max(cadre) donne assez de marge pour la mise à l'échelle `cover` et un
  // rendu retina, sans laisser une photo 6000 px enfler la data URI. `withoutEnlargement` empêche de
  // SURéchantillonner une petite source (le fond CSS l'agrandira au rendu si besoin, sans coût mémoire
  // ici) ; `fit: "inside"` préserve le rapport d'aspect en bornant le côté long au plafond.
  const cap = 2 * Math.max(fw, fh);

  // Tout ce qui suit (décodage sharp, redimensionnement, flou, teinte, encodage) peut échouer sur
  // des octets corrompus, tronqués, ou simplement pas une image (ex. une page d'erreur HTML servie
  // avec un statut 200) — un cas déjà rencontré en revue. Sans ce filet, l'erreur sharp brute (en
  // anglais, et PAS une ImageFetchError) s'échapperait vers l'appelant, qui ne l'attraperait pas :
  // le contrat du module est que tout échec sort sous forme d'ImageFetchError en français.
  let out: Buffer;
  let ow: number;
  let oh: number;
  try {
    // D'abord le redimensionnement SEUL — son encodage donne la taille RÉELLE de l'image préparée
    // (info.width/height, produite par le cap + le rapport d'aspect), dont l'appelant a besoin pour
    // `effImg` ET dont le bloc flou ci-dessous a besoin pour connaître l'échelle prepared->peint.
    const bounded = await sharp(bytes)
      .resize(cap, cap, { fit: "inside", withoutEnlargement: true })
      .png().toBuffer({ resolveWithObject: true });
    ow = bounded.info.width;
    oh = bounded.info.height;

    // LE FLOU, indépendant du plafond (revue de branche). sharp attend un sigma, pas un rayon CSS, et
    // `blur/2` approche le flou d'un navigateur À LA RÉSOLUTION DU CADRE. Mais le flou est appliqué ICI,
    // à la résolution PRÉPARÉE (bornée, jusqu'à 2×cadre), et Satori redimensionne ENSUITE l'image
    // préparée sur le cadre — un facteur `s` (prepared->peint) qui diviserait d'autant le sigma
    // effectif sur le canevas, le rendant DÉPENDANT du plafond (donc de la résolution SOURCE : deux
    // photos de tailles différentes, même cadre, floueraient différemment). On PRÉ-DIVISE donc le sigma
    // par `s`, de sorte qu'après le redimensionnement de Satori le sigma effectif vaille ≈ blur/2 au
    // cadre, quelle que soit la source. EXACT pour cover/contain (échelle uniforme) ; approximé
    // (moyenne géométrique des axes) pour stretch/custom — voir `paintedScale`.
    let prepared = bounded.data;
    if (blur && blur > 0) {
      const s = paintedScale(opts.sizing ?? "cover", fw, fh, ow, oh, opts.tileScale, opts.customSize);
      const sigma = Math.max(0.3, (blur / 2) / s);
      prepared = await sharp(bounded.data).blur(sigma).png().toBuffer();
    }

    if (overlay && overlay !== "transparent") {
      // La teinte couvre l'image PRÉPARÉE (ow×oh), pas le cadre : l'image n'est plus recadrée au cadre.
      const tint = await sharp({
        create: { width: ow, height: oh, channels: 4, background: parseHex(overlay) },
      }).png().toBuffer();
      out = await sharp(prepared).composite([{ input: tint, blend: "over" }]).png().toBuffer();
    } else {
      out = prepared;
    }
  } catch (e) {
    // Message autonome, volontairement SANS le texte de l'erreur sharp sous-jacente (en anglais).
    console.error(`[studio] traitement sharp de l'image téléchargée (${url}) échoué :`, e);
    throw new ImageFetchError(`Le fichier téléchargé depuis « ${url} » n'est pas une image exploitable.`, { cause: e });
  }

  return { uri: `data:image/png;base64,${out.toString("base64")}`, w: ow, h: oh };
}
