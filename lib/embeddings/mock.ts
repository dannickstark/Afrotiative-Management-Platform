export function mockEmbed(text: string, dims: number): number[] {
  // deterministic hash → pseudo-random unit vector
  const v = new Array(dims).fill(0);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  for (let i = 0; i < dims; i++) { h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0; v[i] = ((h % 2000) / 1000) - 1; }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}
