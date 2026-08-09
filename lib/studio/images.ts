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
  // Injecté par les tests uniquement : garde le garde SSRF intact tout en autorisant un serveur
  // fixture local.
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

  if (!opts.fetchImpl && !isSafePublicHttpUrl(url)) {
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

  const out = await pipeline.png().toBuffer();
  return `data:image/png;base64,${out.toString("base64")}`;
}
