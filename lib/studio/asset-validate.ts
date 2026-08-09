// lib/studio/asset-validate.ts — PUR : aucune E/S réseau, aucun accès base de données. Toute la
// logique de décision "ce fichier est-il un asset acceptable ?" vit ici, testable sans DB ni R2 ni
// serveur HTTP (tests/studio-asset-validate.test.ts).
//
// Principe central (spec §5) : le type MIME déclaré par le navigateur (File.type, formData.get)
// N'EST JAMAIS CONSULTÉ par ce module. Ni comme filtre d'entrée, ni comme repli — un fichier qui se
// prétend "image/png" mais dont le contenu réel est un texte brut est rejeté parce que sharp()
// échoue à le décoder, jamais parce qu'on aurait comparé sa chaîne déclarée à une liste blanche. La
// "kind" (image vs police) elle-même vient du CHAMP DE FORMULAIRE que l'utilisateur a choisi (deux
// zones de dépôt distinctes dans l'UI, lib/actions/asset-actions.ts), jamais d'une inférence sur le
// Content-Type — ça reste un choix humain explicite, pas une donnée que le navigateur pourrait
// mentir.
import sharp from "sharp";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_FONT_BYTES = 2 * 1024 * 1024;

function mo(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Images — la "validation réelle" DE la spec EST la liste acceptée : on ne vérifie pas séparément
// "le type déclaré est-il dans la liste ?" puis "le contenu est-il valide ?" (ce serait encore
// faire confiance au navigateur pour la première moitié) — on demande à sharp() ce que le contenu
// EST réellement (meta.format), et c'est CETTE valeur, jamais le Content-Type du navigateur, qui
// est comparée à la liste acceptée.
const ACCEPTED_IMAGE_FORMATS = ["png", "jpeg", "webp", "svg"] as const;
type AcceptedImageFormat = (typeof ACCEPTED_IMAGE_FORMATS)[number];
const IMAGE_EXT: Record<AcceptedImageFormat, string> = { png: "png", jpeg: "jpg", webp: "webp", svg: "svg" };
const IMAGE_MIME: Record<AcceptedImageFormat, string> = {
  png: "image/png", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml",
};

export type ImageValidation =
  | { ok: true; format: AcceptedImageFormat; ext: string; mime: string; width: number; height: number }
  | { ok: false; message: string };

export async function validateImageAsset(bytes: Uint8Array): Promise<ImageValidation> {
  if (bytes.byteLength === 0) return { ok: false, message: "Fichier vide." };
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return { ok: false, message: `Image trop volumineuse (${mo(bytes.byteLength)}) : la limite est de ${mo(MAX_IMAGE_BYTES)}.` };
  }

  // Le type de retour est INFÉRÉ (pas d'annotation `sharp.Metadata` explicite) : sous
  // isolatedModules, référencer le namespace de types d'un module `export =` comme sharp à travers
  // son import par défaut synthétique (`import sharp from "sharp"`) échoue à la compilation — les
  // autres fichiers de ce dépôt qui utilisent sharp (lib/studio/images.ts…) n'ont jamais eu besoin
  // d'annoter ce type non plus, pour la même raison.
  let meta: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    meta = await sharp(bytes).metadata();
  } catch (e) {
    // Message autonome, SANS le texte natif de sharp (en anglais) — même politique que
    // lib/studio/images.ts:prepareImage pour un motif identique (contenu illisible par sharp).
    console.error("[studio] validation sharp() d'un asset image échouée :", e);
    return { ok: false, message: "Fichier image invalide : le contenu ne peut pas être décodé (PNG, JPEG, WebP ou SVG attendu)." };
  }

  // "Doit réussir ET donner des dimensions" (spec §5) — sharp() peut réussir à lire des métadonnées
  // partielles sur un flux corrompu sans jamais résoudre width/height ; ce garde couvre ce cas.
  if (!meta.width || !meta.height) {
    return { ok: false, message: "Fichier image invalide : impossible de déterminer ses dimensions." };
  }

  const format = meta.format as string | undefined;
  if (!format || !(ACCEPTED_IMAGE_FORMATS as readonly string[]).includes(format)) {
    return {
      ok: false,
      message: `Format d'image non pris en charge (${format ?? "inconnu"}) : PNG, JPEG, WebP ou SVG attendu.`,
    };
  }
  const accepted = format as AcceptedImageFormat;

  return {
    ok: true, format: accepted, ext: IMAGE_EXT[accepted], mime: IMAGE_MIME[accepted],
    width: meta.width, height: meta.height,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Polices — octets magiques, PAS le Content-Type déclaré (spec §5). Comparaison sur les 4 premiers
// octets réels du fichier, pas sur une sous-chaîne construite depuis une valeur fournie par
// l'appelant.
function magicMatches(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.byteLength < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic[i]) return false;
  return true;
}

// sfnt version 0x00010000 (TrueType "classique").
const TTF_MAGIC = [0x00, 0x01, 0x00, 0x00] as const;
// "true" — ancien identifiant Apple pour TrueType, toujours produit par certains outils.
const TRUE_MAGIC = [0x74, 0x72, 0x75, 0x65] as const;
// "ttcf" — TrueType Collection.
const TTCF_MAGIC = [0x74, 0x74, 0x63, 0x66] as const;
// "OTTO" — OpenType à contours CFF (PostScript).
const OTTO_MAGIC = [0x4f, 0x54, 0x54, 0x4f] as const;
// "wOFF" / "wOF2" — Web Open Font Format 1 et 2. Satori ne sait lire NI L'UN NI L'AUTRE (V1
// §Contraintes) : seul le format 2 est mentionné par le contrat, mais le format 1 tomberait sinon
// silencieusement dans le refus générique "signature non reconnue" plutôt que d'expliquer POURQUOI
// — même défaut pour l'utilisateur, donc même traitement explicite ici.
const WOFF_MAGIC = [0x77, 0x4f, 0x46, 0x46] as const;
const WOFF2_MAGIC = [0x77, 0x4f, 0x46, 0x32] as const;

export type FontValidation =
  | { ok: true; ext: "ttf" | "otf"; mime: string }
  | { ok: false; message: string };

export function validateFontAsset(bytes: Uint8Array): FontValidation {
  if (bytes.byteLength === 0) return { ok: false, message: "Fichier vide." };
  if (bytes.byteLength > MAX_FONT_BYTES) {
    return { ok: false, message: `Police trop volumineuse (${mo(bytes.byteLength)}) : la limite est de ${mo(MAX_FONT_BYTES)}.` };
  }

  // WOFF2 (et WOFF1) refusés EXPLICITEMENT, avant le refus générique — le message doit nommer la
  // vraie raison (Satori ne sait pas les lire), pas se contenter de "signature non reconnue".
  if (magicMatches(bytes, WOFF2_MAGIC)) {
    return {
      ok: false,
      message: "Le format WOFF2 n'est pas pris en charge : le moteur de rendu (Satori) ne sait pas lire le WOFF2. Utilisez un fichier TTF ou OTF.",
    };
  }
  if (magicMatches(bytes, WOFF_MAGIC)) {
    return {
      ok: false,
      message: "Le format WOFF n'est pas pris en charge : le moteur de rendu (Satori) ne sait lire que TTF ou OTF.",
    };
  }

  if (magicMatches(bytes, OTTO_MAGIC)) return { ok: true, ext: "otf", mime: "font/otf" };
  if (magicMatches(bytes, TTF_MAGIC) || magicMatches(bytes, TRUE_MAGIC) || magicMatches(bytes, TTCF_MAGIC)) {
    return { ok: true, ext: "ttf", mime: "font/ttf" };
  }

  return { ok: false, message: "Fichier de police invalide : signature binaire non reconnue (TTF ou OTF attendu)." };
}

// ─────────────────────────────────────────────────────────────────────────────
// Suppression (spec §5) : "un asset référencé par au moins un gabarit NON ARCHIVÉ ne peut pas être
// supprimé ; le message nomme les gabarits concernés." La partie DÉCISIONNELLE (quels gabarits
// référencent cet asset ?) est PURE et vit ici — c'est ce qui la rend testable sans base de données
// (tests/studio-asset-validate.test.ts). La lecture des gabarits NON ARCHIVÉS eux-mêmes reste la
// responsabilité de l'appelant (lib/studio/asset-core.ts) : cette fonction ne filtre PAS l'archivage
// elle-même, elle scanne exactement les lignes qu'on lui donne — l'appelant lui passe déjà la bonne
// liste (WHERE archived = false), exactement comme template-core.ts filtre ses propres requêtes.
export type TemplateReferenceCheckRow = { id: string; name: string; scene: unknown };

// Un calque référence l'asset si (a) c'est un calque image dont la source est { kind: "asset",
// assetId } et que l'identifiant correspond, ou (b) un calque texte dont font.assetId correspond.
// Défensif sur la forme de `scene` : une valeur déjà invalide ou pas encore migrée ne doit jamais
// faire planter le scan, seulement ne rien y trouver.
export function sceneReferencesAsset(scene: unknown, assetId: string): boolean {
  if (!scene || typeof scene !== "object") return false;
  const layers = (scene as { layers?: unknown }).layers;
  if (!Array.isArray(layers)) return false;

  return layers.some((layer) => {
    if (!layer || typeof layer !== "object") return false;
    const l = layer as Record<string, unknown>;
    if (l.type === "image") {
      const source = l.source as Record<string, unknown> | undefined;
      return !!source && source.kind === "asset" && source.assetId === assetId;
    }
    if (l.type === "text") {
      const font = l.font as Record<string, unknown> | undefined;
      return !!font && font.assetId === assetId;
    }
    return false;
  });
}

export function findReferencingTemplates(
  assetId: string,
  templates: TemplateReferenceCheckRow[],
): { id: string; name: string }[] {
  return templates
    .filter((t) => sceneReferencesAsset(t.scene, assetId))
    .map((t) => ({ id: t.id, name: t.name }));
}
