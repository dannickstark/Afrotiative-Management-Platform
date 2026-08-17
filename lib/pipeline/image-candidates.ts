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
// d'une publication. Voir CHROME_PATTERN ci-dessous pour la mécanique exacte.
// NB : `share` et `social` ont été délibérément RETIRÉS de cette liste — MAIMP est une publication
// économique/financière où « share price » et « responsabilité sociale » sont du vocabulaire
// éditorial courant, pas du chrome de site. Les vraies icônes de partage social sont de toute façon
// presque toujours interceptées par la règle .svg ou par la règle « déclaré minuscule ». Ne pas les
// réintroduire sans revoir ce compromis.
const CHROME_WORDS = [
  "logo", "favicon", "icon", "avatar", "sprite", "banner", "banniere",
  "pixel", "spacer", "blank", "placeholder", "emoji",
];

// Un "mot" de chrome ne doit matcher qu'en tant que segment complet — pas en sous-chaîne d'un mot
// plus long. `\b` est INSUFFISANT ici : en JS, `_` et les chiffres font partie de `\w`, donc `\b`
// NE borne PAS sur eux — `/\blogo\b/i.test("site_logo_2024.png")` est `false`. On utilise donc des
// lookarounds explicites qui exigent qu'un caractère alphanumérique [A-Za-z0-9] NE précède/suive PAS
// le mot : "site_logo_2024.png" matche désormais (le `_` sépare bien "logo" du reste), tandis que
// "iconic", "socialite" et un chiffre accolé sans séparateur ("logo2.png", où le chiffre PROLONGE le
// mot plutôt que de le border) ne matchent toujours pas.
// (Tradeoff assumé : ceci matche aussi bien dans le path que dans la query — un mot de chrome
// apparaissant dans un paramètre de requête sans rapport avec le fichier serait donc, lui aussi,
// considéré comme du chrome. On ne restructure pas la mécanique de matching pour ce cas rare.)
const CHROME_PATTERN = new RegExp(
  `(?:${CHROME_WORDS.map((w) => `(?<![A-Za-z0-9])${w}(?![A-Za-z0-9])`).join("|")})`,
  "i",
);

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

  // Regroupe par clé de base et ne garde qu'UN représentant par groupe : celui SANS suffixe -WxH
  // (l'URL "nue") si le groupe en contient une, sinon celui aux plus grandes dimensions déclarées.
  // Convention WordPress : le fichier nu (`photo.jpg`) est l'ORIGINAL téléversé, et les variantes
  // `-WxH` (`photo-1024x576.jpg`) sont des redimensionnements générés — souvent plus PETITS que
  // l'original (un original 2400×1350 à côté d'un "large" 1024×576). Garder systématiquement la
  // plus grande variante DÉCLARÉE revenait donc à livrer une image moins résolue que ce qui est
  // disponible. On préserve la provenance et le rang du PREMIER élément vu pour la position finale
  // — l'ordre d'entrée est celui des sources, pas quelque chose qu'on veut perturber en dehors du
  // gain de dédoublonnage lui-même.
  // Aire déclarée : -1 signifie "aucune dimension connue" (pas de suffixe -WxH — soit l'original nu,
  // soit une URL qui n'obéit pas à cette convention).
  const groups = new Map<string, { firstIndex: number; best: ImageCandidate; bestArea: number; hasBare: boolean }>();
  survivors.forEach((c, index) => {
    const key = baseKey(c.url);
    const dim = suffixDimensions(c.url);
    const area = dim ? dim.width * dim.height : -1;
    const isBare = dim === null;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { firstIndex: index, best: c, bestArea: area, hasBare: isBare });
      return;
    }
    // L'URL nue (originale) gagne toujours dès qu'elle apparaît dans le groupe. Sinon, aire
    // strictement plus grande gagne ; à égalité d'absence de dimension, on garde la première vue
    // (stabilité).
    if (isBare && !existing.hasBare) {
      existing.best = c;
      existing.bestArea = area;
      existing.hasBare = true;
    } else if (!existing.hasBare && area > existing.bestArea) {
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
