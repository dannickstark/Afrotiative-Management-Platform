// lib/studio/field-scrub.ts — maths PURES de balayage/curseur. Aucune dépendance.
//
// Règle d'arrondi (unique, pour scrubValue) : le glisser avance TOUJOURS par
// multiples du `step` nominal (pas du step effectif après modificateur) — Maj
// et Alt changent la SENSIBILITÉ (combien de pixels il faut pour franchir un
// pas), pas la granularité de la grille finale. La valeur brute est donc
// systématiquement arrondie au multiple de `step`, quel que soit le
// modificateur ; Alt (précision fine) n'assouplit pas cette grille, il rend
// simplement chaque pas plus lent à atteindre (facteur ×0.1 sur `steps`).
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
  const stepped = roundToStep(raw, step);
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
