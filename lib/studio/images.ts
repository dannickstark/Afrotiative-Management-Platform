import sharp from "sharp";
import { isSafePublicHttpUrl } from "@/lib/url-guard";

export class ImageFetchError extends Error {}

export type PrepareImageOptions = {
  url: string;
  width: number;
  height: number;
  fit: "cover" | "contain";
  blur?: number;
  overlay?: string;
  // Injecté par les tests uniquement : permet d'atteindre un serveur fixture local. Le garde SSRF
  // n'est jamais contourné par la seule présence de ce paramètre — voir plus bas, la levée de la
  // garde exige EN PLUS process.env.NODE_ENV === "test", pour qu'un futur appelant de production
  // (cache, retry…) ne puisse pas désactiver silencieusement la protection en fournissant un
  // fetchImpl (par exemple pour l'instrumentation).
  fetchImpl?: typeof fetch;
};

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
// Le recadrage vise les dimensions EXACTES du calque en pixels de sortie : le rendu final est déjà
// à sa résolution native (1080-1600 px), suréchantillonner coûterait de la mémoire sans gain.
export async function prepareImage(opts: PrepareImageOptions): Promise<string> {
  const { url, width, height, fit, blur, overlay } = opts;
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

  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));

  // Tout ce qui suit (décodage sharp, redimensionnement, flou, teinte, encodage) peut échouer sur
  // des octets corrompus, tronqués, ou simplement pas une image (ex. une page d'erreur HTML servie
  // avec un statut 200) — un cas déjà rencontré en revue. Sans ce filet, l'erreur sharp brute (en
  // anglais, et PAS une ImageFetchError) s'échapperait vers l'appelant, qui ne l'attraperait pas :
  // le contrat du module est que tout échec sort sous forme d'ImageFetchError en français.
  let out: Buffer;
  try {
    let pipeline = sharp(bytes).resize(w, h, {
      fit: fit === "cover" ? "cover" : "contain",
      position: "attention", // recadrage centré sur la zone la plus « intéressante »
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    });

    // sharp attend un sigma, pas un rayon CSS. blur/2 approche visuellement le flou d'un navigateur.
    if (blur && blur > 0) pipeline = pipeline.blur(Math.max(0.3, blur / 2));

    if (overlay && overlay !== "transparent") {
      const tint = await sharp({
        create: { width: w, height: h, channels: 4, background: parseHex(overlay) },
      }).png().toBuffer();
      pipeline = sharp(await pipeline.png().toBuffer()).composite([{ input: tint, blend: "over" }]);
    }

    out = await pipeline.png().toBuffer();
  } catch (e) {
    // Message autonome, volontairement SANS le texte de l'erreur sharp sous-jacente (en anglais).
    console.error(`[studio] traitement sharp de l'image téléchargée (${url}) échoué :`, e);
    throw new ImageFetchError(`Le fichier téléchargé depuis « ${url} » n'est pas une image exploitable.`, { cause: e });
  }

  return `data:image/png;base64,${out.toString("base64")}`;
}
