// lib/studio/layer-geometry.ts — Correctif revue finale (Minor) : `dynamic-text.ts` et
// `shape-gallery.ts` portaient chacun une copie quasi identique du même clamp « centrée, jamais plus
// grande que le canevas, jamais hors de ses bords » — voir dynamic-text.ts:108-119 (avant ce
// correctif) et shape-gallery.ts:90-99 (avant ce correctif). Ce module en est la SEULE source :
// `centeredFrame` pour la géométrie générique (formes, QR), `textFrameFor` pour la formule propre
// aux calques texte (largeur relative à une marge, hauteur relative à la taille de police) que
// dynamic-text.ts ET text-presets.ts (« Styles », un calque texte NON lié) réutilisent toutes deux —
// un module FEUILLE, sans dépendance vers l'un ou l'autre pour ne créer aucun cycle.
export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

// PURE — bornée AUX dimensions du canevas d'abord (jamais plus grande que lui), puis centrée et
// reclampée : garantit x/y >= 0 et x+w/y+h <= canevas quel que soit le format, y compris un format
// vertical étroit (story, 1080×1920) où une boîte pensée pour un format large déborderait sans ce
// clamp final.
export function centeredFrame(canvas: { width: number; height: number }, w: number, h: number): Frame {
  const boundedW = Math.min(Math.max(w, 1), canvas.width);
  const boundedH = Math.min(Math.max(h, 1), canvas.height);
  const x = Math.min(Math.max(Math.round((canvas.width - boundedW) / 2), 0), canvas.width - boundedW);
  const y = Math.min(Math.max(Math.round((canvas.height - boundedH) / 2), 0), canvas.height - boundedH);
  return { x, y, w: boundedW, h: boundedH };
}

// Marge horizontale relative au canevas, et nombre de lignes de hauteur allouées à la boîte — un
// calque texte reste redimensionnable ensuite depuis la bande de propriétés, cette boîte n'a donc
// besoin que d'atterrir DANS le canevas, pas d'épouser exactement le texte final.
const TEXT_MARGIN_RATIO = 0.08;
const TEXT_LINE_ALLOWANCE = 2;

// PURE — le cadre initial d'un calque texte inséré par un clic (Texte dynamique OU Styles), relatif
// au CANEVAS et à la taille de police du préréglage plutôt que fixe.
export function textFrameFor(canvas: { width: number; height: number }, fontSize: number): Frame {
  const desiredW = canvas.width * (1 - 2 * TEXT_MARGIN_RATIO);
  const desiredH = fontSize * 1.2 * TEXT_LINE_ALLOWANCE;
  return centeredFrame(canvas, desiredW, desiredH);
}
