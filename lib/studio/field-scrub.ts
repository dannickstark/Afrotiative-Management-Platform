// lib/studio/field-scrub.ts — maths PURES de balayage/curseur. Aucune dépendance.
//
// Règle d'arrondi (unique, pour scrubValue) : la valeur brute est arrondie au
// multiple de l'INCRÉMENT EFFECTIF, où l'incrément effectif dépend du
// modificateur :
//   - aucun modificateur → incrément = `step` (grille nominale) ;
//   - Maj (rapide)       → incrément = `step` (même grille nominale, mais
//     ×10 de sensibilité : moins de pixels par pas) ;
//   - Alt (précision fine) → incrément = `step * 0.1` (grille DIX FOIS PLUS
//     FINE) — Alt laisse donc atteindre des valeurs intermédiaires,
//     inaccessibles au step nominal (ex. 0.1 sur un champ de step=1), en
//     plus de ralentir l'avancement par pixel.
export type ScrubModifier = "none" | "shift" | "alt";

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const roundToStep = (v: number, step: number) => (step > 0 ? Math.round(v / step) * step : v);

export function scrubValue(
  start: number,
  dxPx: number,
  opts: { step?: number; min?: number; max?: number; modifier?: ScrubModifier; pxPerStep?: number } = {},
): number {
  const step = opts.step ?? 1;
  const pxPerStep = opts.pxPerStep ?? 4;
  const factor = opts.modifier === "shift" ? 10 : opts.modifier === "alt" ? 0.1 : 1;
  const steps = (dxPx / pxPerStep) * factor;
  const raw = start + steps * step;
  const effectiveIncrement = step * (opts.modifier === "alt" ? 0.1 : 1);
  const stepped = roundToStep(raw, effectiveIncrement);
  return clamp(stepped, opts.min ?? -Infinity, opts.max ?? Infinity);
}

export const valueToFraction = (value: number, min: number, max: number): number =>
  max === min ? 0 : clamp((value - min) / (max - min), 0, 1);

export function sliderValue(fraction: number, opts: { min: number; max: number; step?: number }): number {
  const step = opts.step ?? 1;
  const raw = opts.min + clamp(fraction, 0, 1) * (opts.max - opts.min);
  return clamp(roundToStep(raw, step), opts.min, opts.max);
}

export const opacityToPercent = (opacity: number): number => Math.round(clamp(opacity, 0, 1) * 100);
export const percentToOpacity = (percent: number): number => clamp(percent, 0, 100) / 100;
