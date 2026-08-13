// lib/studio/color.ts — maths de couleur PURES. Aucune dépendance (client-safe, sans base, sans React).
export type Hsva = { h: number; s: number; v: number; a: number };

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function hexToRgba(hex: string): { r: number; g: number; b: number; a: number } | null {
  if (!HEX_RE.test(hex)) return null;
  let h = hex.slice(1);
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a };
}

export function parseColor(input: string): Hsva | null {
  if (input === "transparent") return { h: 0, s: 0, v: 0, a: 0 };
  const rgba = hexToRgba(input);
  if (!rgba) return null;
  const { r, g, b, a } = rgba;
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max, a };
}

export const hexToHsva = (hex: string): Hsva | null => (HEX_RE.test(hex) ? parseColor(hex) : null);

export function hsvaToHex({ h, s, v, a }: Hsva): string {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  const seg = Math.floor(h / 60) % 6;
  [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][seg].forEach((val, i) => {
    const n = Math.round((val + m) * 255);
    if (i === 0) r = n; else if (i === 1) g = n; else b = n;
  });
  const hx = (n: number) => n.toString(16).padStart(2, "0");
  const base = `#${hx(r)}${hx(g)}${hx(b)}`;
  return a >= 1 ? base : `${base}${hx(Math.round(a * 255))}`;
}

export const withAlpha = (c: Hsva, a: number): Hsva => ({ ...c, a: Math.min(1, Math.max(0, a)) });

export function formatHex(input: string): string | null {
  const hsva = hexToHsva(input.trim());
  return hsva ? hsvaToHex(hsva) : null;
}
