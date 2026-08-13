import satori, { type Font as SatoriFont } from "satori";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import QRCode from "qrcode";
import type { Scene, TextLayer } from "./scene";
import { resolveTokens, type TokenValues } from "./values";
import { prepareImage, type PreparedImage } from "./images";
import { loadFallbackFonts, NullAssetLoader, type AssetLoader, type LoadedFont } from "./fonts";
import { sceneToElement, textStyleFor, type SatoriNode } from "./element";
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

// Erreur typée : message en français, SANS le texte brut de l'erreur native sous-jacente (satori,
// resvg, sharp et qrcode parlent anglais et exposent des détails d'implémentation non actionables
// pour un rédacteur) — même politique que ImageFetchError dans images.ts. Tout échec de ce module
// qui n'est pas la dégradation tolérée (police d'asset introuvable) sort sous cette forme.
export class RenderError extends Error {}

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
//
// La sonde utilise textStyleFor (element.ts) — LA MÊME fonction que le rendu final — pour construire
// son style. Avant ce partage, la sonde reconstruisait la liste des propriétés à la main et en
// oubliait deux (letterSpacing, fontStyle) : un texte avec un espacement de lettres large mesurait
// une hauteur trop petite, « tenait » selon la sonde, puis débordait silencieusement une fois
// réellement peint (overflow: hidden coupe le surplus sans avertir personne). Vérifié empiriquement
// avant correction : à 1040×220, taille 64, letterSpacing 20, la sonde d'origine (qui ignorait
// letterSpacing) mesurait une hauteur qui tient, alors que le texte réellement peint atteint 345px.
export async function fitFontSize(layer: TextLayer, fonts: LoadedFont[]): Promise<number> {
  const satoriFonts = asSatoriFonts(fonts);

  async function fitsAt(size: number): Promise<boolean> {
    const probe: SatoriNode = {
      type: "div",
      props: {
        style: { display: "flex", width: layer.frame.w, ...textStyleFor({ ...layer, font: { ...layer.font, size } }) },
        children: layer.content,
      },
    };
    let svg: string;
    try {
      svg = await satori(probe as never, { width: layer.frame.w, fonts: satoriFonts, embedFont: false });
    } catch (e) {
      console.error(`[studio] sonde autoFit du calque « ${layer.name || layer.id} » échouée :`, e);
      throw new RenderError(
        `Mesure du texte du calque « ${layer.name || layer.id} » impossible : une valeur (couleur, police) est invalide.`,
        { cause: e },
      );
    }
    const height = Number(/height="(\d+(?:\.\d+)?)"/.exec(svg)?.[1] ?? layer.frame.h);
    return height <= layer.frame.h;
  }

  // Ne JAMAIS agrandir au-delà de la taille demandée par le gabarit. Si celle-ci est déjà en dessous
  // du plancher de lisibilité (AUTOFIT_MIN), il n'y a rien à chercher — la renvoyer telle quelle.
  // Bug constaté empiriquement dans la version précédente : avec font.size=10, low(12) > high(10),
  // la boucle ne s'exécutait jamais, et `best` restait à sa valeur initiale AUTOFIT_MIN=12 — un
  // texte agrandi au lieu d'être laissé tel quel, exactement l'inverse de ce qu'autoFit doit faire.
  if (layer.font.size <= AUTOFIT_MIN) return layer.font.size;

  // Teste D'ABORD la taille demandée elle-même. Si le texte tient déjà, on la renvoie TELLE QUELLE.
  // Bug constaté empiriquement dans la version précédente : la recherche dichotomique, bornée à
  // AUTOFIT_PASSES=5 itérations sur l'intervalle [AUTOFIT_MIN, taille], ne teste jamais la borne
  // haute elle-même et converge sur une valeur résiduelle systématiquement inférieure — un titre qui
  // tenait déjà à 64px ressortait rétréci à 63px sans raison, l'écart croissant avec la taille de
  // base (mesuré : base 96 -> 94, base 160 -> 156). AutoFit ne doit RÉDUIRE que si le texte déborde
  // réellement.
  if (await fitsAt(layer.font.size)) return layer.font.size;

  let low = AUTOFIT_MIN;
  let high = layer.font.size - 1;
  let best = AUTOFIT_MIN;
  for (let i = 0; i < AUTOFIT_PASSES && low <= high; i++) {
    const mid = Math.floor((low + high) / 2);
    if (await fitsAt(mid)) { best = mid; low = mid + 1; } else { high = mid - 1; }
  }
  return best;
}

// qrcode produit un SVG (vecteur, donc net à toute résolution) qu'on embarque en data URI. Vérifié
// empiriquement : satori accepte un `<img src="data:image/svg+xml;base64,...">` et le traduit en
// `<image href="...">` dans le SVG de sortie, et resvg rasterise correctement cette balise
// `<image>` imbriquée (les pixels du QR apparaissent bien dans le PNG final) — pas besoin de
// rasteriser nous-mêmes avec sharp au préalable.
async function qrDataUri(text: string, fg: string, bg: string, margin: number): Promise<string> {
  let svg: string;
  try {
    svg = await QRCode.toString(text, { type: "svg", margin, color: { dark: fg, light: bg } });
  } catch (e) {
    // Cas reproduit : un contenu trop long ("The amount of data is too big to be stored in a QR
    // Code") — message anglais et non actionable pour un rédacteur, on ne le propage pas tel quel.
    console.error("[studio] génération du QR code échouée :", e);
    throw new RenderError(
      "Génération du QR code impossible : le contenu du jeton est invalide ou trop volumineux pour être encodé.",
      { cause: e },
    );
  }
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

export async function renderScene(opts: RenderSceneOptions): Promise<RenderOutcome> {
  const assets = opts.assets ?? new NullAssetLoader();
  const encode = opts.encode ?? "jpeg";
  let degraded = false;

  // 1. Résolution des jetons — lève MissingTokensError en nommant ce qui manque.
  const resolved = resolveTokens(opts.scene, opts.values);

  // 2. Polices. Une police d'asset introuvable — ou dont le CHARGEMENT ÉCHOUE (le magasin d'assets
  //    est temporairement injoignable, par exemple) — retombe sur le repli embarqué et marque le
  //    rendu dégradé : c'est la SEULE défaillance tolérée du pipeline, tout le reste échoue
  //    franchement. Un magasin d'assets qui LÈVE au lieu de renvoyer null doit dégrader exactement
  //    comme un magasin qui renvoie null poliment — le jour où R2 a une panne ne doit pas être le
  //    jour où le rendu casse au lieu de simplement perdre la police personnalisée.
  let fallbackFonts: LoadedFont[];
  try {
    fallbackFonts = await loadFallbackFonts();
  } catch (e) {
    // Ne JAMAIS laisser passer le message natif ici : il contient un chemin absolu du serveur
    // (ex. « ENOENT: no such file or directory, open '/app/lib/studio/fonts/NotoSans-Regular.ttf' »)
    // — une fuite d'infrastructure autant qu'une fuite d'anglais dans un message par ailleurs
    // documenté comme affichable tel quel à un rédacteur.
    console.error("[studio] chargement de la police de repli échoué :", e);
    throw new RenderError("Génération de l'image impossible : la police de repli est introuvable sur le serveur.", { cause: e });
  }
  const fonts: LoadedFont[] = [...fallbackFonts];
  const seen = new Set<string>();
  for (const layer of resolved.layers) {
    if (layer.type !== "text" || !layer.font.assetId || seen.has(layer.font.assetId)) continue;
    seen.add(layer.font.assetId);
    let font: LoadedFont | null;
    try {
      font = await assets.font(layer.font.assetId);
    } catch (e) {
      // SEULE dégradation tolérée du pipeline (voir le commentaire au-dessus de ce bloc) : on avale
      // volontairement l'erreur et on retombe sur le repli, mais on la journalise quand même — en
      // production le message français ci-dessous est la seule trace qui existe QUELQUE PART, la
      // journaliser est ce qui rend l'incident (ex. panne R2) visible sans casser le rendu.
      console.error(`[studio] chargement de la police d'asset « ${layer.font.assetId} » échoué, repli sur la police embarquée :`, e);
      font = null;
    }
    if (font) fonts.push(font); else degraded = true;
  }

  // 3. Pré-passe images + QR, en parallèle. La valeur est une `PreparedImage` (uri + taille
  //    intrinsèque) : une IMAGE porte sa vraie taille (element.ts en a besoin pour `effImg`), un QR
  //    n'a qu'une uri vectorielle et stocke `w:0, h:0` (imageNode ne lit que `uri` pour un QR).
  const prepared = new Map<string, PreparedImage>();
  await Promise.all(resolved.layers.map(async (layer) => {
    if (!layer.visible) return;
    if (layer.type === "image") {
      let url: string | null;
      if (layer.source.kind === "url") {
        url = layer.source.url;
      } else if (layer.source.kind === "asset") {
        try {
          url = await assets.imageUrl(layer.source.assetId);
        } catch (e) {
          // Tâche 12 : ce chemin n'était atteignable par AUCUN magasin réel avant DbAssetLoader — la
          // revue de V1 avait déjà signalé qu'un magasin REJETANT ici laisserait fuir son message
          // natif (anglais, détails d'implémentation R2/réseau) jusqu'à l'appelant, exactement la
          // même politique que les trois autres frontières natives de ce fichier (satori/resvg/sharp
          // plus bas, qrcode dans qrDataUri). Contrairement à une police d'asset manquante (§2
          // ci-dessus, dégradation TOLÉRÉE), un magasin qui échoue à résoudre une IMAGE reste un
          // échec FRANC — element.ts documente déjà ce contrat, voir "Finding 2" plus bas dans ce
          // fichier et son test dans tests/studio-render.test.ts.
          console.error(`[studio] résolution de l'URL de l'asset image « ${layer.source.assetId} » (calque « ${layer.name || layer.id} ») échouée :`, e);
          throw new RenderError(
            `Image introuvable pour le calque « ${layer.name || layer.id} » : le magasin d'assets est indisponible.`,
            { cause: e },
          );
        }
      } else {
        url = null;
      }
      if (!url) {
        // Contrairement à une police manquante, une IMAGE manquante n'est pas la dégradation
        // tolérée : element.ts documente explicitement que « render.ts a déjà échoué franchement si
        // la préparation était obligatoire » — un calque image visible sans URL résolue ne doit
        // jamais atteindre le rendu final en silence (auparavant : `degraded = true; return;`,
        // produisant un rendu « réussi » avec le calque simplement absent).
        throw new RenderError(
          `Image introuvable pour le calque « ${layer.name || layer.id} » : l'asset référencé n'a pas pu être résolu.`,
        );
      }
      prepared.set(layer.id, await prepareImage({
        url, width: layer.frame.w, height: layer.frame.h,
        blur: layer.blur, overlay: layer.overlay, fetchImpl: opts.fetchImpl,
        // Le mode de cadrage — nécessaire pour le recadrage focal `cover` (images.ts) ET pour corriger
        // la force du flou (sigma indépendant du plafond). Même repli `sizing ?? (fit === "cover" ? …)`
        // que le reste du chemin.
        sizing: layer.sizing ?? (layer.fit === "cover" ? "cover" : "contain"),
        // Le point focal — pilote le recadrage `cover` côté sharp (images.ts). Absent = centre.
        focal: layer.focal,
        tileScale: layer.tile?.scale,
        customSize: layer.customSize,
      }));
    } else if (layer.type === "qr") {
      // Pas de garde `if (!value)` ici : resolveTokens (values.ts) a déjà levé MissingTokensError
      // plus haut pour TOUT jeton utilisé par la scène — y compris qrLayer.slot, qu'extractTokens
      // (tokens.ts) recense explicitement — donc `value` est toujours défini à ce stade. Un ancien
      // garde `if (!value) { degraded = true; return; }` était mort (prouvé par le test « exige la
      // valeur du jeton du slot QR… », studio-render.test.ts) et laissait croire à tort que
      // `degraded` pouvait couvrir un jeton QR manquant, alors que c'est un échec franc comme tout
      // autre jeton requis.
      const value = opts.values[layer.slot as TokenId]!;
      // Un QR reste un vecteur déjà dimensionné (chemin `<img>` d'imageNode) : pas de taille
      // intrinsèque à remonter, d'où `w:0, h:0` — imageNode ne lit que `uri` pour un calque QR.
      prepared.set(layer.id, { uri: await qrDataUri(value, layer.fg, layer.bg, layer.margin), w: 0, h: 0 });
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

  // 5. satori -> SVG -> resvg -> PNG -> sharp. Trois bibliothèques natives, trois façons de faire
  //    fuir de l'anglais non actionable vers un rédacteur (reproduit empiriquement : une couleur de
  //    jeton invalide fait échouer satori avec "Failed to parse declaration…" ; un canevas
  //    surdimensionné passe satori et resvg mais fait échouer sharp avec "Input image exceeds pixel
  //    limit"). Chaque étape est isolée dans son propre try/catch pour un message français distinct
  //    et actionable, sans jamais reproduire le texte brut de l'erreur native.
  let svg: string;
  try {
    svg = await satori(sceneToElement(scene, prepared) as never, {
      width: scene.canvas.width,
      height: scene.canvas.height,
      fonts: asSatoriFonts(fonts),
      embedFont: true, // glyphes convertis en tracés : resvg n'a jamais besoin des polices
    });
  } catch (e) {
    console.error("[studio] rendu satori de la scène échoué :", e);
    throw new RenderError(
      "Rendu de la scène impossible : une valeur du gabarit (couleur, police ou disposition) est invalide.",
      { cause: e },
    );
  }

  let png: Buffer;
  try {
    png = new Resvg(svg, { fitTo: { mode: "width", value: scene.canvas.width } }).render().asPng();
  } catch (e) {
    console.error("[studio] rasterisation resvg de la scène échouée :", e);
    throw new RenderError("Rasterisation de la scène impossible.", { cause: e });
  }

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
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(
      encode === "webp"
        ? await sharp(png).webp({ quality: 88 }).toBuffer()
        : await sharp(png).removeAlpha().jpeg({ quality: 86, mozjpeg: true }).toBuffer(),
    );
  } catch (e) {
    // Cas reproduit : un canevas surdimensionné (ex. 20000x20000) passe satori et resvg mais fait
    // échouer sharp au décodage du PNG intermédiaire ("Input image exceeds pixel limit").
    console.error("[studio] encodage sharp de l'image finale échoué :", e);
    throw new RenderError(
      "Encodage de l'image finale impossible : les dimensions du canevas sont probablement excessives.",
      { cause: e },
    );
  }

  return {
    bytes,
    width: scene.canvas.width,
    height: scene.canvas.height,
    degraded,
    mime: encode === "webp" ? "image/webp" : "image/jpeg",
  };
}
