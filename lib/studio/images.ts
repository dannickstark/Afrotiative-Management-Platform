import sharp from "sharp";
import { isSafePublicHttpUrl } from "@/lib/url-guard";

export class ImageFetchError extends Error {}

// Properties Pro P1, Tâche 3 — l'image préparée renvoie DÉSORMAIS sa taille en pixels À CÔTÉ de la
// data URI. Le chemin de rendu unique (element.ts#imageNode, fond en `<div>`) en a besoin : pour
// `cover`/`contain`/`tile`, la POSITION de fond que Satori exige en PIXELS (focalToPositionPx, le `%`
// de Satori est bogué — spike, Tâche 1) se calcule à partir de la taille EFFECTIVE de l'image peinte,
// elle-même dérivée de la taille INTRINSÈQUE de l'asset préparé. Seul `prepareImage` connaît cette
// intrinsèque (il vient de la décoder), il la remonte donc.
export type PreparedImage = {
  uri: string;
  w: number;
  h: number;
  /** Qualité, D — `true` quand l'image préparée est peinte AGRANDIE dans son cadre, c'est-à-dire
   * quand la source n'avait pas assez de pixels pour le remplir (`paintedScale > 1`, au-delà d'une
   * tolérance de 5 % qui absorbe les arrondis entiers de `.resize()`). C'est la seule cause de flou
   * que le moteur ne peut PAS corriger : `withoutEnlargement` refuse à raison de suréchantillonner
   * ici, mais le fond CSS de Satori étire quand même l'image sur le cadre au moment de peindre —
   * silencieusement. Remonté à l'appelant (render.ts -> preview-core.ts -> l'éditeur) pour que ce
   * soit DIT plutôt que constaté après publication. N'a AUCUN effet sur le rendu lui-même. */
  lowRes: boolean;
};

export type PrepareImageOptions = {
  url: string;
  // Les dimensions du CADRE (px). Pour `cover`, elles PILOTENT le recadrage focal (voir prepareImage) :
  // la fenêtre source visible d'un `cover` est calculée à partir de l'aspect du cadre, et l'image
  // préparée en ressort à l'aspect du CADRE. Pour les autres modes (contain/stretch/tile/custom),
  // l'image garde son aspect NATUREL et le cadre ne fait que borner la taille préparée à un plafond
  // raisonnable (côté long ≤ 2×max(w,h)) — assez de marge pour un rendu retina, sans enfler la data URI.
  width: number;
  height: number;
  blur?: number;
  overlay?: string;
  // Le POINT FOCAL normalisé [0,1] (défaut {0.5,0.5} = centre), utilisé UNIQUEMENT par le recadrage
  // `cover` ci-dessous pour choisir QUELLE fenêtre de la source est conservée. Sans effet sur les
  // autres modes (l'aspect naturel y est préservé, le positionnement reste au fond CSS de Satori).
  focal?: { x: number; y: number };
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
      // La taille logique PEINTE d'un `custom` est min(custom, cadre) PAR AXE (element.ts#effectiveImage,
      // suivi de revue) — PAS `cw`/`ch` bruts : un axe débordant est recadré dans sharp à l'extent du
      // cadre. `iw`/`ih` sont les dims PRÉPARÉES (= cet extent peint × outScale pour un axe débordant, la
      // source bornée pour un axe en retrait). Moyenne géométrique des deux ratios d'axe (flou isotrope) :
      return Math.sqrt((Math.min(customSize.w, fw) / iw) * (Math.min(customSize.h, fh) / ih));
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
//
// RECADRAGE `cover` AU POINT FOCAL (revue de branche). Pour `cover`, prepareImage RECADRE la source dans
// sharp au point focal, puis la redimensionne à l'ASPECT DU CADRE. Satori peint alors l'image préparée
// `background-size:cover` à 1:1 (l'aspect correspond → aucun débordement → `background-position` 0), ce
// qui rend l'export FIDÈLE au point focal ET identique à l'aperçu navigateur.
//   POURQUOI (le bug corrigé). L'approche précédente livrait l'image à sa taille naturelle et déléguait
// le recadrage `cover` au `background-position` de Satori (en pixels, via focalToPositionPx). Or Satori
// 0.29 PLAFONNE une `background-position` négative à 0 — et un `cover` qui déborde le cadre (aspect
// source ≠ aspect cadre, c.-à-d. quasi toute vraie photo) calcule justement une position NÉGATIVE.
// Satori l'épinglait à 0 : l'export restait figé sur le coin HAUT-GAUCHE quel que soit le point focal,
// alors que l'aperçu navigateur (layer-view.tsx, position en `%` correctement appliquée par le CSS natif)
// conservait, lui, la région focale. Montage et Rendu réel DIVERGEAIENT. En recadrant en amont dans
// sharp, l'image préparée EST déjà la fenêtre focale : plus de débordement, plus de position négative,
// plus de divergence. Le point focal par défaut {0.5,0.5} → recadrage CENTRÉ.
//   La formule est le recadrage focal standard, équivalent au CSS `background-position:<focal>%` sur une
// image mise à l'échelle `cover` : fenêtre visible (fw/s, fh/s) avec s=max(fw/iw, fh/ih), origine
// (iw−cw)·fx / (ih−ch)·fy bornée aux limites de la source.
//
// RECADRAGE FOCAL `custom` DÉBORDANT (suivi de revue), MIROIR de `cover` mais PAR AXE. Un `sizing:
// "custom"` peint un fond de taille EXPLICITE (cw×ch) positionné au point focal. Sur un axe qui DÉBORDE
// le cadre (custom > cadre), la position vaut (cadre−custom)·focal < 0 — Satori 0.29 la plafonne à 0,
// même bug que `cover`. On recadre donc ICI la fenêtre focale de l'axe débordant (voir la branche
// `sizing==="custom"` plus bas), pour que l'image préparée arrive à l'extent PEINT min(custom,cadre) et
// qu'element.ts recalcule une position 0 sur cet axe. `custom` est ANISOTROPE : chaque axe est traité
// INDÉPENDAMMENT — un axe EN RETRAIT (custom ≤ cadre) n'est PAS recadré (source entière) et sera
// simplement letterboxé à position POSITIVE (que Satori gère). Un `custom` dont AUCUN axe ne déborde
// (ou sans customSize) reste dans le régime « taille naturelle bornée » ci-dessous, OCTET pour OCTET
// l'ancien comportement.
//
// Les modes contain/stretch/tile NE débordent pas le cadre (contain tient dedans ; stretch = cadre ;
// les décalages de tuile sont POSITIFS) : ils gardent l'image à sa taille NATURELLE, seulement BORNÉE à
// un plafond (côté long ≤ 2×max(cadre)) en préservant l'aspect, et leur recadrage/positionnement reste
// au fond CSS de Satori (element.ts#imageNode).
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
  let scaleToPainted: number;
  try {
    // D'abord la préparation SEULE — son encodage donne la taille RÉELLE de l'image préparée
    // (info.width/height), dont l'appelant a besoin pour `effImg` ET dont le bloc flou ci-dessous a
    // besoin pour connaître l'échelle prepared->peint.
    const sizing = opts.sizing ?? "cover";
    let bounded: { data: Buffer; info: { width: number; height: number } };
    if (sizing === "cover") {
      // RECADRAGE FOCAL `cover` (voir le bloc de tête). On lit l'intrinsèque de la source, on calcule la
      // fenêtre visible d'un `cover` au point focal, on l'EXTRAIT, puis on la redimensionne à l'ASPECT DU
      // CADRE — borné retina (≤ 2×) et jamais agrandi au-delà du recadrage natif (petite source : Satori
      // l'agrandira au rendu, sans coût mémoire ici).
      const meta = await sharp(bytes).metadata();
      const iw = Math.max(1, meta.width ?? fw);
      const ih = Math.max(1, meta.height ?? fh);
      const fx = Math.min(1, Math.max(0, opts.focal?.x ?? 0.5));
      const fy = Math.min(1, Math.max(0, opts.focal?.y ?? 0.5));
      const s = Math.max(fw / iw, fh / ih);
      const cw = Math.min(iw, Math.max(1, Math.round(fw / s)));
      const ch = Math.min(ih, Math.max(1, Math.round(fh / s)));
      const left = Math.round(Math.min(Math.max((iw - cw) * fx, 0), iw - cw));
      const top = Math.round(Math.min(Math.max((ih - ch) * fy, 0), ih - ch));
      // Sortie à l'aspect EXACT du cadre : `fit:"fill"` fige (tw, th) quelle que soit la dérive
      // sous-pixel de l'aspect du recadrage entier — c'est ce qui garantit que element.ts#effectiveImage
      // recalcule une position 0 (aucun débordement) pour ce `cover`.
      const outScale = Math.min(2, cw / fw, ch / fh);
      const tw = Math.max(1, Math.round(fw * outScale));
      const th = Math.max(1, Math.round(fh * outScale));
      bounded = await sharp(bytes)
        .extract({ left, top, width: cw, height: ch })
        .resize(tw, th, { fit: "fill" })
        .png().toBuffer({ resolveWithObject: true });
    } else if (sizing === "custom" && opts.customSize && (opts.customSize.w > fw || opts.customSize.h > fh)) {
      // RECADRAGE FOCAL `custom` DÉBORDANT (suivi de revue), MIROIR de `cover` mais PAR AXE. `custom`
      // peint un fond de taille EXPLICITE (cw×ch) positionné au point focal. Un axe qui DÉBORDE le cadre
      // (custom > cadre) calcule une `background-position` NÉGATIVE, que Satori 0.29 plafonne à 0 (coin
      // haut-gauche, focal inerte) — même bug que `cover`, même remède : on extrait ICI la fenêtre focale
      // de l'axe débordant, pour que l'image préparée arrive à l'extent PEINT (min(custom,cadre)) et que
      // element.ts recalcule une position 0 sur cet axe. CUSTOM est ANISOTROPE : chaque axe est traité
      // INDÉPENDAMMENT — un axe en retrait (custom ≤ cadre) n'est PAS recadré (fenêtre = source entière),
      // il sera simplement letterboxé à position POSITIVE par element.ts. On n'entre ici QUE si customSize
      // existe ET qu'au moins un axe déborde ; sinon (pas de customSize, ou aucun débordement) on retombe
      // dans l'`else` ci-dessous (aspect naturel borné) — non-débordant reste donc OCTET pour OCTET l'ancien.
      const meta = await sharp(bytes).metadata();
      const iw = Math.max(1, meta.width ?? fw);
      const ih = Math.max(1, meta.height ?? fh);
      const fx = Math.min(1, Math.max(0, opts.focal?.x ?? 0.5));
      const fy = Math.min(1, Math.max(0, opts.focal?.y ?? 0.5));
      const { w: cw, h: ch } = opts.customSize;
      const overflowX = cw > fw;
      const overflowY = ch > fh;
      // Fenêtre source par axe : sur un axe débordant, la portion visible du fond (cw×ch) dans le cadre
      // vaut cadre/custom de sa largeur, ancrée au focal — reprojetée en pixels source (× i/custom). Sur
      // un axe en retrait, la source ENTIÈRE (l'image tient dans son extent, pas de recadrage).
      const srcW = overflowX ? Math.max(1, Math.round((fw * iw) / cw)) : iw;
      const srcH = overflowY ? Math.max(1, Math.round((fh * ih) / ch)) : ih;
      const left = overflowX ? Math.min(Math.max(Math.round(((cw - fw) * fx * iw) / cw), 0), iw - srcW) : 0;
      const top = overflowY ? Math.min(Math.max(Math.round(((ch - fh) * fy * ih) / ch), 0), ih - srcH) : 0;
      // Extent PEINT par axe = min(custom, cadre) (le `effImg` d'element.ts) : sortie à cet aspect via
      // `fit:"fill"` (fige la dérive sous-pixel), bornée retina (≤ 2×) et jamais agrandie au-delà de la
      // fenêtre extraite (petite source : Satori l'agrandira au rendu, sans coût mémoire ici).
      const ptx = Math.min(cw, fw);
      const pty = Math.min(ch, fh);
      const outScale = Math.min(2, srcW / ptx, srcH / pty);
      const tw = Math.max(1, Math.round(ptx * outScale));
      const th = Math.max(1, Math.round(pty * outScale));
      bounded = await sharp(bytes)
        .extract({ left, top, width: srcW, height: srcH })
        .resize(tw, th, { fit: "fill" })
        .png().toBuffer({ resolveWithObject: true });
    } else {
      // contain/stretch/tile/custom NON débordant : aspect NATUREL préservé, seulement borné au plafond `cap`.
      bounded = await sharp(bytes)
        .resize(cap, cap, { fit: "inside", withoutEnlargement: true })
        .png().toBuffer({ resolveWithObject: true });
    }
    ow = bounded.info.width;
    oh = bounded.info.height;

    // L'échelle prepared->peint, calculée UNE FOIS ici : elle sert à DEUX choses désormais — le
    // drapeau `lowRes` juste en dessous, et la correction du sigma du flou plus bas (où elle était
    // calculée auparavant, à l'intérieur du `if (blur)`). Même appel, mêmes arguments : déplacer ce
    // calcul ne change RIEN au flou, il le rend seulement disponible aux deux usages.
    scaleToPainted = paintedScale(sizing, fw, fh, ow, oh, opts.tileScale, opts.customSize);

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
      const sigma = Math.max(0.3, (blur / 2) / scaleToPainted);
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

  // Tolérance 1,05 (voir PreparedImage.lowRes) : un `.resize()` arrondit à l'entier, une source
  // exactement à la taille du cadre peut donc ressortir à un facteur 1,001 sans être « trop petite ».
  return { uri: `data:image/png;base64,${out.toString("base64")}`, w: ow, h: oh, lowRes: scaleToPainted > 1.05 };
}
