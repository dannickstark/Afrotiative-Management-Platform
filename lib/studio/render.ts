import satori, { type Font as SatoriFont } from "satori";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import QRCode from "qrcode";
import type { Scene, TextLayer } from "./scene";
import { resolveTokens, type TokenValues } from "./values";
import { prepareImage } from "./images";
import { loadFallbackFonts, NullAssetLoader, type AssetLoader, type LoadedFont } from "./fonts";
import { sceneToElement, type SatoriNode } from "./element";
import type { TokenId } from "./tokens";

export type RenderOutcome = {
  bytes: Uint8Array;
  width: number;
  height: number;
  degraded: boolean;
  mime: string;
};

export type RenderSceneOptions = {
  scene: Scene;
  values: TokenValues;
  assets?: AssetLoader;
  encode?: "jpeg" | "webp";
  // Tests uniquement — voir prepareImage.
  fetchImpl?: typeof fetch;
};

const AUTOFIT_MIN = 12;
const AUTOFIT_PASSES = 5;

// fonts.ts (une autre tâche, non modifiable ici) type LoadedFont.weight comme un `number` simple ;
// satori exige la sous-union littérale 100|200|…|900. Nos propres sources de polices (repli
// embarqué + AssetLoader) respectent déjà cette contrainte en pratique — c'est une conversion de
// frontière, pas un contournement de logique.
function asSatoriFonts(fonts: LoadedFont[]): SatoriFont[] {
  return fonts as unknown as SatoriFont[];
}

// Recherche dichotomique sur la taille de police : on rend le SEUL calque texte (pas d'image, donc
// quelques millisecondes par passe) et on garde la plus grande taille qui tient dans le cadre.
//
// IMPORTANT, vérifié empiriquement (satori 0.29) : si on transmet `height` à satori en option, le
// SVG racine renvoie CETTE valeur telle quelle dans son attribut height= — ce n'est PAS la hauteur
// du contenu rendu, c'est un simple écho de la boîte demandée. Mesurer « la hauteur du rendu »
// aurait alors mesuré notre propre entrée, et la recherche dichotomique aurait toujours convergé
// vers AUTOFIT_MIN (le brouillon initial passait `height: layer.frame.h * 4`, une valeur
// systématiquement > frame.h, donc toujours jugée « ne tient pas », quel que soit le texte). En ne
// transmettant QUE `width`, satori calcule la hauteur intrinsèque du contenu (avec retour à la
// ligne sur cette largeur) et l'expose dans l'attribut height= — c'est cette valeur-là qu'il faut
// comparer au cadre.
export async function fitFontSize(layer: TextLayer, fonts: LoadedFont[]): Promise<number> {
  let low = AUTOFIT_MIN;
  let high = layer.font.size;
  let best = AUTOFIT_MIN;

  for (let i = 0; i < AUTOFIT_PASSES && low <= high; i++) {
    const mid = Math.floor((low + high) / 2);
    const probe: SatoriNode = {
      type: "div",
      props: {
        style: {
          display: "flex", width: layer.frame.w,
          fontFamily: layer.font.family, fontSize: mid, fontWeight: layer.font.weight,
          lineHeight: layer.lineHeight,
        },
        children: layer.content,
      },
    };
    const svg = await satori(probe as never, { width: layer.frame.w, fonts: asSatoriFonts(fonts), embedFont: false });
    const height = Number(/height="(\d+(?:\.\d+)?)"/.exec(svg)?.[1] ?? layer.frame.h);
    if (height <= layer.frame.h) { best = mid; low = mid + 1; } else { high = mid - 1; }
  }
  return best;
}

// qrcode produit un SVG (vecteur, donc net à toute résolution) qu'on embarque en data URI. Vérifié
// empiriquement : satori accepte un `<img src="data:image/svg+xml;base64,...">` et le traduit en
// `<image href="...">` dans le SVG de sortie, et resvg rasterise correctement cette balise
// `<image>` imbriquée (les pixels du QR apparaissent bien dans le PNG final) — pas besoin de
// rasteriser nous-mêmes avec sharp au préalable.
async function qrDataUri(text: string, fg: string, bg: string, margin: number): Promise<string> {
  const svg = await QRCode.toString(text, { type: "svg", margin, color: { dark: fg, light: bg } });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

export async function renderScene(opts: RenderSceneOptions): Promise<RenderOutcome> {
  const assets = opts.assets ?? new NullAssetLoader();
  const encode = opts.encode ?? "jpeg";
  let degraded = false;

  // 1. Résolution des jetons — lève MissingTokensError en nommant ce qui manque.
  const resolved = resolveTokens(opts.scene, opts.values);

  // 2. Polices. Une police d'asset introuvable retombe sur le repli embarqué et marque le rendu
  //    dégradé — c'est la SEULE défaillance tolérée du pipeline, tout le reste échoue franchement.
  const fonts: LoadedFont[] = [...(await loadFallbackFonts())];
  const seen = new Set<string>();
  for (const layer of resolved.layers) {
    if (layer.type !== "text" || !layer.font.assetId || seen.has(layer.font.assetId)) continue;
    seen.add(layer.font.assetId);
    const font = await assets.font(layer.font.assetId);
    if (font) fonts.push(font); else degraded = true;
  }

  // 3. Pré-passe images + QR, en parallèle.
  const prepared = new Map<string, string>();
  await Promise.all(resolved.layers.map(async (layer) => {
    if (!layer.visible) return;
    if (layer.type === "image") {
      const url = layer.source.kind === "url"
        ? layer.source.url
        : layer.source.kind === "asset" ? await assets.imageUrl(layer.source.assetId) : null;
      if (!url) { degraded = true; return; }
      prepared.set(layer.id, await prepareImage({
        url, width: layer.frame.w, height: layer.frame.h, fit: layer.fit,
        blur: layer.blur, overlay: layer.overlay, fetchImpl: opts.fetchImpl,
      }));
    } else if (layer.type === "qr") {
      const value = opts.values[layer.slot as TokenId];
      if (!value) { degraded = true; return; }
      prepared.set(layer.id, await qrDataUri(value, layer.fg, layer.bg, layer.margin));
    }
  }));

  // 4. autoFit — après la résolution des jetons, puisque c'est le TEXTE FINAL qu'il faut mesurer.
  const scene: Scene = {
    ...resolved,
    layers: await Promise.all(resolved.layers.map(async (layer) =>
      layer.type === "text" && layer.autoFit
        ? { ...layer, font: { ...layer.font, size: await fitFontSize(layer, fonts) } }
        : layer,
    )),
  };

  // 5. satori -> SVG -> resvg -> PNG -> sharp.
  const svg = await satori(sceneToElement(scene, prepared) as never, {
    width: scene.canvas.width,
    height: scene.canvas.height,
    fonts: asSatoriFonts(fonts),
    embedFont: true, // glyphes convertis en tracés : resvg n'a jamais besoin des polices
  });

  const png = new Resvg(svg, { fitTo: { mode: "width", value: scene.canvas.width } }).render().asPng();

  // removeAlpha() n'est appliqué qu'en JPEG : le format n'a structurellement pas de canal alpha
  // (sharp l'aplatit de toute façon automatiquement sur du noir si on ne le fait pas — vérifié
  // empiriquement, résultat identique avec ou sans l'appel explicite), donc autant le documenter
  // ici. En revanche WebP SUPPORTE la transparence : appeler removeAlpha() inconditionnellement
  // (comme le brouillon initial) aurait supprimé la transparence d'un canevas "transparent" même
  // quand l'appelant demande explicitement du WebP pour la préserver — on ne le fait donc pas sur
  // ce chemin.
  //
  // Par ailleurs, un canevas "transparent" est rendu par resvg avec des pixels non peints à
  // (0,0,0,0) (RVB prémultiplié à zéro) — vérifié empiriquement. En JPEG, ils deviennent donc du
  // noir opaque, jamais une autre couleur : c'est un aplatissement sur NOIR, pas sur une couleur de
  // canevas « attendue » par l'utilisateur, ce qui est cohérent avec le fait qu'un canevas
  // "transparent" exporté vers un format sans alpha n'a de toute façon pas de couleur de repli
  // définie ailleurs dans le schéma.
  const bytes = new Uint8Array(
    encode === "webp"
      ? await sharp(png).webp({ quality: 88 }).toBuffer()
      : await sharp(png).removeAlpha().jpeg({ quality: 86, mozjpeg: true }).toBuffer(),
  );

  return {
    bytes,
    width: scene.canvas.width,
    height: scene.canvas.height,
    degraded,
    mime: encode === "webp" ? "image/webp" : "image/jpeg",
  };
}
