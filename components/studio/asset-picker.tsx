"use client";

import { useMemo } from "react";
import { Image as ImageIcon, Type as TypeIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { fontFaceFamily, fontProxyUrl } from "@/lib/studio/font-face";
import type { AssetRow } from "@/lib/queries/assets";
import type { ImageSource, TextLayer } from "@/lib/studio/scene";

// PAS `import { FALLBACK_FONT_FAMILY } from "@/lib/studio/fonts"` : repéré en pilotant un vrai
// navigateur — lib/studio/fonts.ts ouvre par `import { readFile } from "node:fs/promises"` (pour
// loadFallbackFonts, un chemin serveur pur), et Turbopack refuse catégoriquement d'inclure
// "node:fs/promises" dans un chunk CLIENT : "the chunking context (unknown) does not support
// external modules" — un panic qui fait planter TOUTE la page /studio/[id] en 500, pas seulement ce
// composant. Ce fichier porte "use client" (Popover interactif) ; importer QUOI QUE CE SOIT de
// fonts.ts, même un unique littéral inoffensif, suffit à tirer tout le module (donc l'import Node)
// dans le bundle navigateur. Dupliqué ici à dessein — garder en phase avec
// lib/studio/fonts.ts:FALLBACK_FONT_FAMILY si sa valeur change un jour.
const FALLBACK_FONT_FAMILY = "Noto Sans";

// components/studio/asset-picker.tsx — Tâche 13 : brancher la bibliothèque d'assets (Tâche 11) dans
// l'éditeur. Un calque image choisit sa source dans la bibliothèque ; un calque texte choisit sa
// police parmi les polices téléversées, la police embarquée (Noto Sans) restant TOUJOURS
// sélectionnable — jamais un état qu'on ne peut atteindre qu'en vidant un champ à la main.

// ─────────────────────────────────────────────────────────────────────────────
// Fonctions PURES — c'est exactement ce que property-panel.tsx branche sur onPick plus bas. Les
// tests (tests/studio-asset-picker.test.ts) les appellent DIRECTEMENT, sans DOM : même convention
// que tests/studio-token-picker.test.ts, qui compose tokensFor() + setLayerProp() plutôt que de
// cliquer sur un Popover dont le contenu ne se rend pas fermé côté serveur (react-dom/server, pas de
// jsdom sous `bun test` — voir la note en tête de ce fichier de test).
export function pickImageAsset(assetId: string): ImageSource {
  return { kind: "asset", assetId };
}

// La police intégrée reste sélectionnable via CE MÊME chemin (assetId: undefined) — pas une branche
// UI à part qui contournerait pickFont : "la famille embarquée reste sélectionnable" (brief Tâche
// 13) est ainsi un état ORDINAIRE de pickFont, pas un cas spécial non testé.
export const BUNDLED_FONT_PICK: { assetId: undefined; family: string } = { assetId: undefined, family: FALLBACK_FONT_FAMILY };

export function pickFont(
  font: TextLayer["font"],
  pick: { assetId: string | undefined; family: string },
): TextLayer["font"] {
  return { ...font, assetId: pick.assetId, family: pick.family };
}

// ─────────────────────────────────────────────────────────────────────────────
export interface ImageAssetPickerProps {
  assets: AssetRow[];
  value: string;
  onPick: (assetId: string) => void;
  // Correctif revue finale — Important 3 (images-panel.tsx) : le déclencheur ci-dessous doit pouvoir
  // être RÉELLEMENT désactivé — l'attribut HTML natif `disabled`, pas seulement une classe Tailwind
  // `disabled:` (un piège déjà rencontré par ce sous-projet : une recherche de sous-chaîne "disabled"
  // fait un faux positif sur la classe utilitaire, présente qu'il soit désactivé ou non). `Button`
  // (components/ui/button.tsx) transmet ce prop tel quel à l'élément `<button>` sous-jacent.
  disabled?: boolean;
}

export function ImageAssetPicker({ assets, value, onPick, disabled }: ImageAssetPickerProps) {
  const images = useMemo(() => assets.filter((a) => a.kind === "image"), [assets]);
  const current = images.find((a) => a.id === value) ?? null;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button" variant="outline" size="sm"
            className="w-full justify-start gap-2 font-normal"
            data-action="asset-picker-image"
            disabled={disabled}
            // testid EXPORTÉ (Tâche 2, U1 spec §3) : components/studio/panels/images-panel.tsx
            // héberge ce MÊME déclencheur plutôt que de reconstruire une grille d'assets — seul CE
            // composant pose cet attribut, c'est ce que tests/studio-asset-picker.test.ts vérifie.
            data-testid="asset-picker"
          >
            {current ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={current.url} alt="" className="size-5 shrink-0 rounded object-cover" />
            ) : (
              <ImageIcon className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate">{current?.name ?? "Choisir dans la bibliothèque…"}</span>
          </Button>
        }
      />
      <PopoverContent className="w-72 p-1.5" data-testid="asset-picker-image-content">
        {images.length === 0 ? (
          <p className="p-2 text-xs text-muted-foreground">
            Aucune image dans la bibliothèque — téléversez-en une depuis Studio → Bibliothèque.
          </p>
        ) : (
          <ul className="grid max-h-72 grid-cols-3 gap-1.5 overflow-auto p-0.5">
            {images.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  data-asset-id={a.id}
                  onClick={() => onPick(a.id)}
                  className={cn(
                    "flex w-full flex-col items-center gap-1 rounded-md border p-1 text-left hover:bg-accent",
                    a.id === value && "border-primary ring-1 ring-primary",
                  )}
                >
                  {/* Miniature réelle (spec Tâche 13 : "thumbnails for images") — même URL publique
                      que la bibliothèque (Tâche 11), aucun second téléchargement/traitement ici. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={a.url} alt={a.name} className="aspect-square w-full rounded bg-muted object-cover" />
                  <span className="w-full truncate text-[10px]">{a.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
export interface FontAssetPickerProps {
  assets: AssetRow[];
  value: string | undefined;
  onPick: (pick: { assetId: string | undefined; family: string }) => void;
}

export function FontAssetPicker({ assets, value, onPick }: FontAssetPickerProps) {
  const fonts = useMemo(() => assets.filter((a) => a.kind === "font"), [assets]);
  const current = fonts.find((a) => a.id === value) ?? null;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button" variant="outline" size="sm"
            className="w-full justify-start gap-2 font-normal"
            data-action="asset-picker-font"
          >
            <TypeIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">
              {current ? (current.fontFamily ?? current.name) : `${FALLBACK_FONT_FAMILY} (police intégrée)`}
            </span>
          </Button>
        }
      />
      <PopoverContent className="w-72 p-1.5" data-testid="asset-picker-font-content">
        <ul className="flex max-h-72 flex-col gap-0.5 overflow-auto p-0.5">
          <li>
            {/* La police embarquée : TOUJOURS présente, en premier — voir BUNDLED_FONT_PICK
                ci-dessus, c'est le même chemin pickFont() que n'importe quelle police téléversée. */}
            <button
              type="button"
              data-font-default
              onClick={() => onPick(BUNDLED_FONT_PICK)}
              className={cn(
                "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                !value && "bg-accent",
              )}
            >
              <span>
                {FALLBACK_FONT_FAMILY} <span className="text-xs text-muted-foreground">(police intégrée)</span>
              </span>
            </button>
          </li>
          {fonts.map((a) => (
            <li key={a.id}>
              {/* Échantillon RENDU (spec Tâche 13 : "a rendered sample for fonts") — @font-face
                  pointé sur le proxy même origine (fontProxyUrl), comme la bibliothèque (Tâche 11,
                  lib/studio/font-face.ts) : le bucket R2 public n'envoie pas d'en-têtes CORS, que
                  @font-face exige pour toute ressource cross-origin (repéré en navigateur réel). */}
              <style>{`@font-face { font-family: "${fontFaceFamily(a.id)}"; src: url("${fontProxyUrl(a.id)}"); font-weight: ${a.fontWeight ?? 400}; font-style: ${a.fontStyle ?? "normal"}; font-display: swap; }`}</style>
              <button
                type="button"
                data-asset-id={a.id}
                onClick={() => onPick({ assetId: a.id, family: a.fontFamily ?? a.name })}
                className={cn(
                  "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                  a.id === value && "bg-accent",
                )}
              >
                <span style={{ fontFamily: `"${fontFaceFamily(a.id)}"` }}>{a.fontFamily ?? a.name}</span>
              </button>
            </li>
          ))}
          {fonts.length === 0 && (
            <p className="p-2 text-xs text-muted-foreground">Aucune police téléversée pour l&rsquo;instant.</p>
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
