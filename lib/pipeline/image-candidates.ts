import type { ImageCandidate } from "@/db";

// Nettoie la liste brute des candidats d'image d'une régénération (lib/pipeline/regenerate-core.ts)
// AVANT qu'elle n'alimente le choix de l'IA (mode auto) ou le bac de choix manuel du /queue (mode
// manuel). Un article aux sources multiples, extraites par plusieurs providers, peut accumuler des
// dizaines d'URLs quasi-identiques (chrome du site, vignettes, la même photo servie à N tailles) —
// c'est ce bruit que ce module réduit. Module PUR : aucune dépendance DB/réseau, testable en
// isolation (tests/image-candidates.test.ts, lane "pure" de scripts/test-fast.ts).

const MAX_DEFAULT = 12;

// Segments de chemin qui trahissent presque toujours du chrome de site plutôt qu'une photo
// éditoriale. On matche des SEGMENTS de chemin (délimités par `/`, `-`, `_`, `.`), jamais une
// sous-chaîne nue : `icon` nu attraperait "iconic", `social` nu attraperait "socialite" ou le nom
// d'une publication. Voir buildChromePattern ci-dessous pour la mécanique exacte.
const CHROME_WORDS = [
  "logo", "favicon", "icon", "avatar", "sprite", "banner", "banniere",
  "pixel", "spacer", "blank", "placeholder", "emoji", "share", "social",
];

// Un "mot" de chrome ne doit matcher qu'en tant que segment complet (entre limites de mot) — pas en
// sous-chaîne d'un mot plus long. `\b` suffit ici car tous les mots de CHROME_WORDS sont
// alphabétiques : `\b` borne déjà sur `/`, `-`, `_`, `.` et sur les chiffres, donc "iconic" (bordé
// par "icon" + "ic") ne matche pas la frontière `\bicon\b`, et "socialite" non plus.
const CHROME_PATTERN = new RegExp(`\\b(?:${CHROME_WORDS.join("|")})\\b`, "i");

const NON_PHOTO_EXT = /\.(svg|ico|gif)(?:$|\?)/i;

// Extrait le "path+query" (sans le protocole/host) sur lequel on applique les règles de substring —
// on évite ainsi qu'un nom de domaine contenant un mot de chrome (improbable mais pas impossible)
// ne fausse le filtrage, et on reste cohérent avec l'énoncé ("match sur le path+query").
function pathAndQuery(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    // URL non standard (ex: déjà relative) — on retombe sur la chaîne complète.
    return url;
  }
}

// Dimensions déclarées dans l'URL, sous deux formes usuelles : suffixe `-WxH` avant l'extension
// (convention WordPress : photo-1024x576.jpg), ou paramètre de requête `w=`/`width=`.
function suffixDimensions(url: string): { width: number; height: number } | null {
  const m = url.match(/-(\d+)x(\d+)(?:\.[a-z0-9]+)?(?:\?.*)?$/i);
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}

function queryWidth(url: string): number | null {
  try {
    const u = new URL(url);
    const w = u.searchParams.get("w") ?? u.searchParams.get("width");
    if (w === null) return null;
    const n = Number(w);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// Clé de regroupement des variantes de redimensionnement : on retire le suffixe `-WxH` (s'il existe)
// juste avant l'extension pour retomber sur l'URL "de base" — `…/photo-1024x576.jpg` et
// `…/photo.jpg` partagent ainsi la même clé.
function baseKey(url: string): string {
  return url.replace(/-\d+x\d+(?=\.[a-z0-9]+(?:\?.*)?$)/i, "");
}

function isNonPhotographic(url: string): boolean {
  if (/^data:/i.test(url)) return true;
  return NON_PHOTO_EXT.test(pathAndQuery(url));
}

function isChrome(url: string): boolean {
  return CHROME_PATTERN.test(pathAndQuery(url));
}

// « Déclaré minuscule » : suffixe -WxH dont les DEUX dimensions sont ≤ 200, ou un paramètre
// w=/width= ≤ 200. Une seule petite dimension (ex: -320x150, une bannière large mais basse) ne
// suffit pas à qualifier l'image de vignette.
function isDeclaredTiny(url: string): boolean {
  const dim = suffixDimensions(url);
  if (dim && dim.width <= 200 && dim.height <= 200) return true;
  const w = queryWidth(url);
  if (w !== null && w <= 200) return true;
  return false;
}

function applyFilters(candidates: ImageCandidate[]): ImageCandidate[] {
  const survivors = candidates.filter(
    (c) => !isNonPhotographic(c.url) && !isChrome(c.url) && !isDeclaredTiny(c.url),
  );

  // Regroupe par clé de base et ne garde qu'UN représentant par groupe : celui aux plus grandes
  // dimensions déclarées, sinon (aucune variante dimensionnée dans le groupe) celui sans suffixe.
  // On préserve la provenance et le rang du PREMIER élément vu pour la position finale — l'ordre
  // d'entrée est celui des sources, pas quelque chose qu'on veut perturber en dehors du gain de
  // dédoublonnage lui-même.
  // Aire déclarée : -1 signifie "aucune dimension connue" (pas de suffixe -WxH), ce qui la place
  // toujours en dessous de la moindre variante dimensionnée dans le classement par aire.
  const groups = new Map<string, { firstIndex: number; best: ImageCandidate; bestArea: number }>();
  survivors.forEach((c, index) => {
    const key = baseKey(c.url);
    const dim = suffixDimensions(c.url);
    const area = dim ? dim.width * dim.height : -1;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { firstIndex: index, best: c, bestArea: area });
      return;
    }
    // Aire strictement plus grande gagne. Si le groupe n'a encore vu AUCUNE variante dimensionnée
    // (bestArea === -1) et que celle-ci non plus n'en a pas, on garde la première vue (stabilité).
    if (area > existing.bestArea) {
      existing.best = c;
      existing.bestArea = area;
    }
  });

  return [...groups.values()]
    .sort((a, b) => a.firstIndex - b.firstIndex)
    .map((g) => g.best);
}

export function filterImageCandidates(candidates: ImageCandidate[], max: number = MAX_DEFAULT): ImageCandidate[] {
  if (candidates.length === 0) return [];

  const filtered = applyFilters(candidates);

  // Règle de sécurité : un filtrage qui viderait une liste non vide serait pire que l'absence de
  // filtrage — il ferait basculer planRegeneration dans son chemin d'abandon (« Aucune image
  // candidate trouvée ») et casserait la régénération d'image pour cet article. On dégrade vers le
  // bruit d'origine (plafonné), jamais vers la casse.
  const result = filtered.length > 0 ? filtered : candidates;
  return result.slice(0, max);
}
