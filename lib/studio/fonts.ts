import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type LoadedFont = {
  name: string;
  data: ArrayBuffer;
  weight: number;
  style: "normal" | "italic";
};

// Police de repli EMBARQUÉE dans le dépôt : elle garantit qu'un rendu aboutit toujours, même sans
// aucun asset téléversé et même si R2 est injoignable. TTF obligatoire — Satori ne lit pas le WOFF2.
export const FALLBACK_FONT_FAMILY = "Noto Sans";

const FALLBACK_FILES: { file: string; weight: number }[] = [
  { file: "NotoSans-Regular.ttf", weight: 400 },
  { file: "NotoSans-SemiBold.ttf", weight: 600 },
  { file: "NotoSans-Bold.ttf", weight: 700 },
];

let fallbackPromise: Promise<LoadedFont[]> | null = null;

// Mémoïsé sur la promesse et non sur le résultat : deux appels concurrents au démarrage ne doivent
// pas lire les fichiers deux fois.
export function loadFallbackFonts(): Promise<LoadedFont[]> {
  fallbackPromise ??= Promise.all(
    FALLBACK_FILES.map(async ({ file, weight }) => {
      const buf = await readFile(join(process.cwd(), "lib/studio/fonts", file));
      return {
        name: FALLBACK_FONT_FAMILY,
        data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
        weight,
        style: "normal" as const,
      };
    }),
  );
  return fallbackPromise;
}

// Le studio lit ses assets à travers cette interface. V1 n'a pas de bibliothèque d'assets (V2 la
// livre) : NullAssetLoader est donc l'implémentation par défaut, et tout gabarit V1 s'appuie sur
// la police de repli.
export interface AssetLoader {
  font(assetId: string): Promise<LoadedFont | null>;
  imageUrl(assetId: string): Promise<string | null>;
}

export class NullAssetLoader implements AssetLoader {
  async font(assetId: string): Promise<LoadedFont | null> { return null; }
  async imageUrl(assetId: string): Promise<string | null> { return null; }
}
