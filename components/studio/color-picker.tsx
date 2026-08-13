"use client";

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Pipette } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { parseColor, hsvaToHex, withAlpha, formatHex, type Hsva } from "@/lib/studio/color";
import { pickerRowsFor } from "./token-picker";
import { useCommitBuffer } from "./property-fields";
import type { TemplateContext } from "@/lib/studio/tokens";

// components/studio/color-picker.tsx — Chantier C, Tâche 4 : un VRAI sélecteur de couleur façon
// Figma (carré SV + curseurs teinte/alpha + hex + pipette + nuancier de marque + récents + onglet
// jeton), qui REMPLACE l'ancien `<Input>` hex nu au cœur de `ColorField` (property-panel.tsx) —
// jamais le contrat de ce dernier : `value`/`onCommit` restent une chaîne `hexColor` unique
// (littérale OU `{{jeton}}` entier, jamais un mélange, §0/schema.ts inchangé). `ColorField` reste
// l'appelant : il tamponne toujours localement et ce composant-ci lui redonne la main via le MÊME
// `onCommit(v: string)` à chaque geste littéral COMPLET (relâchement de glisser, clic de
// nuancier/récent/pipette, hex validé au blur) — jamais pendant un `pointermove`, pour que
// `setLayerProp` (lib/studio/editor-state.ts) n'empile qu'UNE entrée d'historique par geste (même
// discipline que `NumberField`, property-fields.tsx).
//
// EyeDropper : TS ne connaît pas cette API (support Chromium uniquement) — déclaration minimale, et
// feature-detection avant de rendre le bouton (masqué sur Firefox/Safari plutôt qu'un bouton mort).
declare global {
  interface Window {
    EyeDropper?: { new (): { open: () => Promise<{ sRGBHex: string }> } };
  }
}

// BRAND_SWATCHES — nuancier de marque, en hex LITTÉRAL (le schéma `hexColor` n'accepte que ça),
// SOURCÉ des jetons de thème d'`app/globals.css` (qui, eux, sont en oklch — pas de convertisseur
// oklch→hex écrit ici, jugement délibéré du brief : une palette cohérente et fidèle au SENTIMENT de
// la marque suffit, pas un calcul pixel-exact). Terracotta (--primary) + la rampe ambre/brun
// (--chart-1..5) + les neutres chauds (--muted/--border/--foreground) + noir/blanc/transparent.
export const BRAND_SWATCHES: string[] = [
  "#b35c31", // terracotta — --primary oklch(0.555 0.163 48.998), la teinte de marque principale
  "#f0cf6b", // ambre clair — --chart-1 oklch(0.905 0.182 98.111)
  "#e0a83f", // ambre — --chart-2 oklch(0.795 0.184 86.047)
  "#c9822f", // ambre foncé/orangé — --chart-3 oklch(0.681 0.162 75.834)
  "#a8623a", // brun-orangé — --chart-4 oklch(0.554 0.135 66.442)
  "#7a4a30", // brun profond — --chart-5 oklch(0.476 0.114 61.907)
  "#f5f2ec", // neutre chaud très clair — --muted/--background oklch(~0.966/1 0.005 106.5)
  "#e6e1d6", // neutre chaud clair — --border/--input oklch(0.93 0.007 106.5)
  "#26221c", // neutre chaud très foncé — --foreground/--card-foreground oklch(0.153 0.006 107.1)
  "#000000",
  "#ffffff",
  "transparent",
];

// Récents — un tableau de SESSION (module-level, jamais persisté), MRU (le plus récent en tête),
// plafonné pour rester une rangée, jamais une seconde grille. `pushRecent` ne reçoit QUE des commits
// LITTÉRAUX (jamais un `{{jeton}}` — un jeton n'est pas "une couleur récente", c'est une liaison).
export let recentColors: string[] = [];
const MAX_RECENTS = 8;

export function pushRecent(hex: string): void {
  recentColors = [hex, ...recentColors.filter((c) => c !== hex)].slice(0, MAX_RECENTS);
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

// CARRY-FORWARD (revue T1) : `hsvaToHex` suppose `h ∈ [0,360)` — le curseur teinte, au bout à
// droite, peut produire exactement 360. Normaliser ICI, systématiquement, avant de construire ou de
// committer un Hsva dérivé d'un glisser, plutôt que de compter sur le fait que 360 % 60 tombe
// "par chance" juste (voir tests/studio-color-picker.test.ts, « teinte à fond à droite »).
const normalizeHue = (h: number) => ((h % 360) + 360) % 360;

const CHECKERBOARD = "repeating-linear-gradient(45deg, #999 0, #999 3px, #ccc 3px, #ccc 6px)";

function fractionFromRect(el: Element, clientX: number): number {
  const rect = el.getBoundingClientRect();
  const width = rect.width || 1; // jsdom (bun test) ne mesure jamais de layout réel — voir le test.
  return clamp((clientX - rect.left) / width, 0, 1);
}

function svFromRect(el: Element, clientX: number, clientY: number): { s: number; v: number } {
  const rect = el.getBoundingClientRect();
  const w = rect.width || 1;
  const h = rect.height || 1;
  return {
    s: clamp((clientX - rect.left) / w, 0, 1),
    v: clamp(1 - (clientY - rect.top) / h, 0, 1),
  };
}

export interface ColorPickerProps {
  /** Une couleur EST toujours une valeur unique — hex, "transparent", ou un `{{jeton}}` entier
   * (schéma `hexColor`, lib/studio/scene.ts) — jamais un mélange (même contrat que `ColorField`). */
  value: string;
  context: TemplateContext;
  onCommit: (v: string) => void;
  dataField?: string;
}

export function ColorPicker({ value, context, onCommit, dataField }: ColorPickerProps) {
  const isToken = value.startsWith("{{");
  const showsBound = isToken || value === "transparent" || value === "";

  const [open, setOpen] = useState(false);

  // La couleur littérale DÉRIVÉE de `value` — repli sur du noir opaque quand `value` est un jeton ou
  // invalide (§0 : le tampon interne ne doit jamais planter sur une entrée que `parseColor` refuse).
  const baseHsva: Hsva = isToken ? { h: 0, s: 0, v: 0, a: 1 } : (parseColor(value) ?? { h: 0, s: 0, v: 0, a: 1 });

  // Tampon de GLISSER (carré SV / teinte / alpha) : `null` tant qu'aucun geste n'est en cours — la
  // couleur AFFICHÉE (`hsva` ci-dessous) retombe alors sur `baseHsva`, dérivée de la VRAIE valeur
  // committée. Pendant un glisser, ce tampon porte la valeur DE TRAVAIL — jamais committée avant le
  // relâchement (`pointerup`), pour qu'un glisser entier ne pousse qu'UNE seule entrée d'historique
  // (même discipline que le balayage de `NumberField`, property-fields.tsx).
  const [dragHsva, setDragHsva] = useState<Hsva | null>(null);
  const hsva = dragHsva ?? baseHsva;

  const svDragging = useRef(false);
  const hueDragging = useRef(false);
  const alphaDragging = useRef(false);

  function commitLiteral(hex: string) {
    onCommit(hex);
    pushRecent(hex);
  }

  // ── Carré Saturation/Valeur ──────────────────────────────────────────────────────────────────
  function svDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    svDragging.current = true;
    setDragHsva({ ...hsva, ...svFromRect(e.currentTarget, e.clientX, e.clientY) });
  }
  function svMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!svDragging.current) return;
    // Lit `e.currentTarget` SYNCHRONEMENT, jamais depuis l'intérieur du correcteur fonctionnel de
    // `setDragHsva` ci-dessous — React invoque un correcteur fonctionnel de façon DIFFÉRÉE (parfois
    // au rendu SUIVANT), et `currentTarget` d'un événement synthétique ne reste valide que pendant
    // le passage synchrone du gestionnaire (vérifié directement : y référencer `e.currentTarget`
    // lève `TypeError: null is not an object`, RED sans cette extraction).
    const next = svFromRect(e.currentTarget, e.clientX, e.clientY);
    setDragHsva((prev) => ({ ...(prev ?? hsva), ...next }));
  }
  function svUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (!svDragging.current) return;
    svDragging.current = false;
    const final: Hsva = { ...hsva, ...svFromRect(e.currentTarget, e.clientX, e.clientY) };
    commitLiteral(hsvaToHex(final));
    setDragHsva(null);
  }
  function svCancel() {
    svDragging.current = false;
    setDragHsva(null);
  }

  // ── Curseur teinte ───────────────────────────────────────────────────────────────────────────
  function hueDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    hueDragging.current = true;
    setDragHsva({ ...hsva, h: normalizeHue(fractionFromRect(e.currentTarget, e.clientX) * 360) });
  }
  function hueMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!hueDragging.current) return;
    const h = normalizeHue(fractionFromRect(e.currentTarget, e.clientX) * 360); // voir svMove : lecture SYNCHRONE de e.currentTarget
    setDragHsva((prev) => ({ ...(prev ?? hsva), h }));
  }
  function hueUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (!hueDragging.current) return;
    hueDragging.current = false;
    const final: Hsva = { ...hsva, h: normalizeHue(fractionFromRect(e.currentTarget, e.clientX) * 360) };
    commitLiteral(hsvaToHex(final));
    setDragHsva(null);
  }
  function hueCancel() {
    hueDragging.current = false;
    setDragHsva(null);
  }

  // ── Curseur alpha ────────────────────────────────────────────────────────────────────────────
  function alphaDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    alphaDragging.current = true;
    setDragHsva({ ...hsva, a: fractionFromRect(e.currentTarget, e.clientX) });
  }
  function alphaMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!alphaDragging.current) return;
    const a = fractionFromRect(e.currentTarget, e.clientX); // voir svMove : lecture SYNCHRONE de e.currentTarget
    setDragHsva((prev) => ({ ...(prev ?? hsva), a }));
  }
  function alphaUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (!alphaDragging.current) return;
    alphaDragging.current = false;
    const final: Hsva = { ...hsva, a: fractionFromRect(e.currentTarget, e.clientX) };
    commitLiteral(hsvaToHex(final));
    setDragHsva(null);
  }
  function alphaCancel() {
    alphaDragging.current = false;
    setDragHsva(null);
  }

  // ── Entrée hex/RGB ───────────────────────────────────────────────────────────────────────────
  // `onInput` (jamais `onChange`) — comportement RÉEL identique pour un `<input>` texte (React
  // normalise `onChange` sur l'événement natif "input" dans tout navigateur réel, exactement ce
  // qu'`onInput` relaie directement) ; voir tests/studio-color-picker.test.ts pour la raison exacte
  // qui a fait pencher pour `onInput` ICI plutôt que la convention `onChange` du reste du panneau.
  const { local: hexLocal, setLocal: setHexLocal, setEditing: setHexEditing } = useCommitBuffer(value);

  function commitHex() {
    setHexEditing(false);
    const trimmed = hexLocal.trim();
    if (trimmed === "transparent") {
      if (value !== "transparent") commitLiteral("transparent");
      else setHexLocal(value);
      return;
    }
    const formatted = formatHex(trimmed);
    if (formatted) {
      if (formatted !== value) commitLiteral(formatted);
      else setHexLocal(value);
    } else {
      setHexLocal(value); // entrée invalide : on revient à la dernière valeur committée.
    }
  }

  // ── Pipette (EyeDropper) ─────────────────────────────────────────────────────────────────────
  const supportsEyeDropper = typeof window !== "undefined" && "EyeDropper" in window;
  async function useEyeDropper() {
    try {
      const { sRGBHex } = await new window.EyeDropper!().open();
      const hex = formatHex(sRGBHex);
      if (hex) commitLiteral(hex);
    } catch {
      // Annulé (Échap) ou refusé — rien à committer, pas une erreur à remonter.
    }
  }

  // ── Onglet Jeton ─────────────────────────────────────────────────────────────────────────────
  const tokenRows = pickerRowsFor(context, "color");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            data-field={dataField}
            data-testid="color-picker-trigger"
            className="flex w-full items-center gap-1.5 rounded-lg border border-input bg-transparent px-2.5 py-1 text-left text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <span
              aria-hidden="true"
              data-testid="color-swatch-preview"
              className="size-6 shrink-0 rounded border border-input"
              style={showsBound ? { backgroundImage: CHECKERBOARD } : { backgroundColor: value }}
            />
            <span className="truncate">{value}</span>
          </button>
        }
      />
      <PopoverContent className="w-72 p-2.5" data-testid="color-picker-content">
        <Tabs defaultValue={isToken ? "jeton" : "couleur"}>
          <TabsList className="w-full">
            <TabsTrigger value="couleur" className="flex-1">Couleur</TabsTrigger>
            <TabsTrigger value="jeton" className="flex-1" data-testid="color-token-tab">Jeton</TabsTrigger>
          </TabsList>

          <TabsContent value="couleur" className="flex flex-col gap-2.5 pt-2">
            <div
              data-testid="color-sv"
              className="relative h-32 w-full cursor-crosshair touch-none rounded-md"
              style={{
                backgroundColor: `hsl(${hsva.h}, 100%, 50%)`,
                backgroundImage: "linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)",
              }}
              onPointerDown={svDown}
              onPointerMove={svMove}
              onPointerUp={svUp}
              onPointerCancel={svCancel}
            >
              <span
                aria-hidden="true"
                className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
                style={{ left: `${hsva.s * 100}%`, top: `${(1 - hsva.v) * 100}%`, backgroundColor: hsvaToHex(withAlpha(hsva, 1)) }}
              />
            </div>

            <div
              data-testid="color-hue"
              className="relative h-3 w-full cursor-pointer touch-none rounded-full"
              style={{ backgroundImage: "linear-gradient(to right, red, yellow, lime, cyan, blue, magenta, red)" }}
              onPointerDown={hueDown}
              onPointerMove={hueMove}
              onPointerUp={hueUp}
              onPointerCancel={hueCancel}
            >
              <span
                aria-hidden="true"
                className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-white shadow"
                style={{ left: `${(hsva.h / 360) * 100}%` }}
              />
            </div>

            <div
              data-testid="color-alpha"
              className="relative h-3 w-full cursor-pointer touch-none rounded-full"
              style={{
                backgroundImage: `linear-gradient(to right, transparent, ${hsvaToHex(withAlpha(hsva, 1))}), ${CHECKERBOARD}`,
              }}
              onPointerDown={alphaDown}
              onPointerMove={alphaMove}
              onPointerUp={alphaUp}
              onPointerCancel={alphaCancel}
            >
              <span
                aria-hidden="true"
                className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
                style={{ left: `${hsva.a * 100}%` }}
              />
            </div>

            <div className="flex items-center gap-1.5">
              <input
                value={hexLocal}
                data-testid="color-hex"
                onFocus={() => setHexEditing(true)}
                onInput={(e) => setHexLocal(e.currentTarget.value)}
                onBlur={commitHex}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  else if (e.key === "Escape") { setHexLocal(value); setHexEditing(false); e.currentTarget.blur(); }
                }}
                placeholder="#RRGGBB"
                className="h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              />
              {supportsEyeDropper && (
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  data-testid="color-eyedropper"
                  title="Pipette"
                  onClick={useEyeDropper}
                >
                  <Pipette className="size-3.5" />
                </Button>
              )}
            </div>

            <div>
              <p className="mb-1 text-[11px] text-muted-foreground">Nuancier de marque</p>
              <div className="grid grid-cols-6 gap-1">
                {BRAND_SWATCHES.map((swatch) => (
                  <button
                    key={swatch}
                    type="button"
                    data-testid="color-swatch"
                    data-hex={swatch}
                    title={swatch}
                    className="size-6 rounded border border-input"
                    style={swatch === "transparent" ? { backgroundImage: CHECKERBOARD } : { backgroundColor: swatch }}
                    onClick={() => commitLiteral(swatch)}
                  />
                ))}
              </div>
            </div>

            {recentColors.length > 0 && (
              <div>
                <p className="mb-1 text-[11px] text-muted-foreground">Récents</p>
                <div className="flex flex-wrap gap-1">
                  {recentColors.map((hex, i) => (
                    <button
                      key={`${hex}-${i}`}
                      type="button"
                      data-testid="color-recent"
                      data-hex={hex}
                      title={hex}
                      className="size-6 rounded border border-input"
                      style={hex === "transparent" ? { backgroundImage: CHECKERBOARD } : { backgroundColor: hex }}
                      onClick={() => commitLiteral(hex)}
                    />
                  ))}
                </div>
              </div>
            )}
          </TabsContent>

          <TabsContent value="jeton" className="pt-2">
            {tokenRows.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">Aucun jeton couleur dans ce gabarit.</p>
            ) : (
              <ul className="flex flex-col gap-0.5" data-testid="color-token-rows">
                {tokenRows.map((row) => {
                  const reasonId = `color-token-reason-${row.id}`;
                  return (
                    <li key={row.id}>
                      <button
                        type="button"
                        data-token={row.id}
                        data-available={row.available}
                        aria-disabled={!row.available}
                        aria-describedby={row.available ? undefined : reasonId}
                        onClick={() => {
                          if (!row.available) return;
                          onCommit(`{{${row.id}}}`);
                          setOpen(false);
                        }}
                        className={cn(
                          "flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                          !row.available && "cursor-not-allowed opacity-50 hover:bg-transparent",
                        )}
                      >
                        <span>{row.label}</span>
                        <span className="text-xs text-muted-foreground">{`{{${row.id}}}`}</span>
                        {!row.available && (
                          <span id={reasonId} className="text-[11px] text-muted-foreground">{row.reason}</span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}
