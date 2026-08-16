// Module PUR : ni base, ni réseau, ni DOM. Appelé côté serveur à l'écriture d'un beat (la durée est
// STOCKÉE, pour que la vue montage et les exports du SP2 n'aient rien à recalculer) et côté client
// pour l'affichage vivant du cumul.
export const DEFAULT_WPM = 155;      // cadence de lecture française posée par le spec
export const LONG_BEAT_WORDS = 35;   // seuil d'avertissement « souffle »

const ENTITIES: Record<string, string> = {
  "&#x27;": "'", "&#39;": "'", "&apos;": "'", "&quot;": '"',
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&nbsp;": " ",
};

function toText(html: string): string {
  const stripped = html.replace(/<[^>]*>/g, " ");
  return stripped.replace(/&(#x27|#39|apos|quot|amp|lt|gt|nbsp);/g, (m) => ENTITIES[m] ?? m);
}

export function countWords(html: string): number {
  const text = toText(html).trim();
  if (!text) return 0;
  // Une apostrophe ne sépare pas deux mots parlés : « l'économie » se dit d'un souffle et compte
  // pour un. Le découpage se fait donc sur les blancs, pas sur la ponctuation.
  return text.split(/\s+/).filter(Boolean).length;
}

export function estimateSeconds(html: string, wpm: number = DEFAULT_WPM): number {
  const words = countWords(html);
  if (words === 0) return 0;
  return Math.ceil((words / wpm) * 60);
}

type BeatLike = { spokenText: string; durationOverrideSec: number | null };

export function beatSeconds(beat: BeatLike, wpm: number = DEFAULT_WPM): number {
  // `??` et non `||` : une durée forcée à 0 est un choix humain légitime (un beat muet).
  return beat.durationOverrideSec ?? estimateSeconds(beat.spokenText, wpm);
}

export function variantSeconds(beats: BeatLike[], wpm: number = DEFAULT_WPM): number {
  return beats.reduce((sum, b) => sum + beatSeconds(b, wpm), 0);
}

export function isBreathRisk(html: string): boolean {
  return countWords(html) > LONG_BEAT_WORDS;
}
