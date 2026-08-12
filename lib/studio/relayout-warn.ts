import satori, { type Font as SatoriFont } from "satori";
import type { Layer, Scene, TextLayer } from "@/lib/studio/scene";
import { constraintsOf } from "@/lib/studio/scene";
import type { FormatKey } from "@/lib/studio/formats";
import { relayoutToFormat } from "@/lib/studio/relayout";
import { textStyleFor, type SatoriNode } from "@/lib/studio/element";
import { loadFallbackFonts, type LoadedFont } from "@/lib/studio/fonts";

// lib/studio/relayout-warn.ts — Chantier D, Tâche 3 : « un calque texte contraint en largeur change
// de largeur RÉELLE quand le format change (relayout.ts) → son retour à la ligne change AUSSI → s'il
// porte `maxLines`, ce nouveau retour à la ligne peut déborder et être coupé au rendu. On le DIT,
// mesuré au rendu — jamais deviné. » (brief, tâche 3)
//
// SIBLING de relayout.ts, PAS un ajout dedans (le brief l'offre en alternative explicite) : l'en-tête
// de relayout.ts documente ce module comme « DB-free/client-safe... il ne fait QUE de l'arithmétique
// sur des nombres, JAMAIS d'E/S ». `constrainedTextOverflows` ci-dessous fait le contraire — elle
// charge la police de repli depuis le disque (lib/studio/fonts.ts#loadFallbackFonts, `node:fs/promises`)
// et invoque satori pour un VRAI rendu de mesure — exactement le mécanisme de
// render.ts#fitFontSize, réutilisé plutôt que reconstruit. Ce fichier reste DB-free (aucun import de
// `@/db`), mais N'EST PAS client-safe : voir components/studio/asset-picker.tsx pour le précédent —
// importer QUOI QUE CE SOIT depuis lib/studio/fonts.ts dans un composant "use client" tire
// `node:fs/promises` dans le bundle navigateur et fait planter Turbopack (« the chunking context
// (unknown) does not support external modules »). components/studio/geometry-strip.tsx (également
// modifié par cette tâche) n'importe donc JAMAIS ce module : il reçoit le résultat déjà calculé en
// prop (voir son commentaire d'en-tête pour le détail de cette frontière).

// Les DEUX contraintes horizontales qui changent RÉELLEMENT la largeur d'un calque d'un format à
// l'autre (relayout.ts#relayoutAxis) — les trois autres (`left`, `right`, `center`) gardent la
// taille strictement inchangée, donc un calque qui les porte ne peut STRUCTURELLEMENT PAS déborder
// À CAUSE d'un changement de format (il peut déjà déborder à l'accueil, mais ce n'est pas ce que
// cette alerte-ci signale — voir le test d'anti-vacuité dédié dans tests/studio-relayout.test.ts).
const WIDTH_CHANGING_H = new Set(["leftRight", "scale"]);

// fonts.ts type `LoadedFont.weight` en `number` simple ; satori exige la sous-union littérale
// 100|200|…|900 — même conversion de frontière que render.ts#asSatoriFonts (pas une deuxième
// implémentation divergente, une copie MINIME parce que render.ts ne l'exporte pas).
function asSatoriFonts(fonts: LoadedFont[]): SatoriFont[] {
  return fonts as unknown as SatoriFont[];
}

// Le nombre de lignes RENDUES d'un calque texte à une largeur donnée — MESURÉ, pas deviné. Même
// technique que render.ts#fitFontSize : transmettre SEULEMENT `width` à satori (jamais `height`) lui
// fait calculer et renvoyer la hauteur INTRINSÈQUE du contenu enroulé à cette largeur, dans
// l'attribut `height=` du SVG produit — voir le commentaire de fitFontSize pour la mise en garde
// vérifiée empiriquement sur ce point précis.
//
// `maxLines` n'est PAS transmis à ce style de sonde (repris de `{ ...layer, maxLines: undefined }`) :
// vérifié empiriquement (rapport de tâche) que le `lineClamp` de satori n'a AUCUN effet sur la
// hauteur renvoyée avec le style réellement peint par element.ts#textStyleFor (`display: "flex"`,
// posé par frameStyle — satori n'applique son troncage de hauteur que si `display: "block"`, jamais
// atteint ici). La mesure porte donc sur la hauteur NATURELLE (tout le texte enroulé, sans troncage),
// convertie en nombre de lignes via `fontSize * lineHeight` — vérifié empiriquement : satori rend des
// multiples QUASI EXACTS de cette valeur (dépassement < 1.5%, jamais assez pour franchir la moitié
// d'une ligne), donc `Math.round` la retrouve sans ambiguïté.
async function naturalLineCount(layer: TextLayer, width: number, fonts: SatoriFont[]): Promise<number> {
  const probe: SatoriNode = {
    type: "div",
    props: {
      style: { display: "flex", width, ...textStyleFor({ ...layer, maxLines: undefined }) },
      children: layer.content,
    },
  };
  const svg = await satori(probe as never, { width, fonts });
  const height = Number(/height="(\d+(?:\.\d+)?)"/.exec(svg)?.[1] ?? 0);
  const lineBox = layer.font.size * layer.lineHeight;
  return lineBox > 0 ? Math.round(height / lineBox) : 0;
}

/**
 * VRAI quand `layer` est un calque texte qui porte À LA FOIS une contrainte horizontale qui change
 * sa largeur d'un format à l'autre (`leftRight`/`scale`) ET un `maxLines`, ET que son rendu, relayouté
 * vers `format` (relayout.ts#relayoutToFormat — surcharges de format comprises), enroule le texte sur
 * PLUS de lignes que `maxLines` ne l'autorise.
 *
 * FAUX dans tous les autres cas : pas un calque texte, pas de `maxLines` (rien à comparer), une
 * contrainte horizontale qui ne change pas la largeur (le débordement, s'il existe, n'est alors pas
 * INDUIT par le changement de format — voir le test d'anti-vacuité dédié), ou un rendu qui tient bien
 * dans `maxLines` à la largeur relayoutée (notamment : TOUJOURS faux au format d'accueil, puisque
 * `relayoutToFormat` y est l'identité — chantier D, Tâche 2).
 */
export async function constrainedTextOverflows(scene: Scene, layer: Layer, format: FormatKey): Promise<boolean> {
  if (layer.type !== "text" || !layer.maxLines) return false;
  if (!WIDTH_CHANGING_H.has(constraintsOf(layer).h)) return false;

  const relaid = relayoutToFormat(scene, format);
  const relaidLayer = relaid.layers.find((l) => l.id === layer.id);
  if (!relaidLayer || relaidLayer.type !== "text") return false;

  const fonts = asSatoriFonts(await loadFallbackFonts());
  const lines = await naturalLineCount(layer, relaidLayer.frame.w, fonts);
  return lines > layer.maxLines;
}
