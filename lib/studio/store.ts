import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, renders } from "@/db";
import { getStudioConfig } from "./config";
import { putObject, publicUrlFor } from "@/lib/storage/r2";
import type { TokenValues } from "./values";

export interface RenderStore {
  put(key: string, bytes: Uint8Array, mime: string): Promise<string>;
}

export class R2RenderStore implements RenderStore {
  async put(key: string, bytes: Uint8Array, mime: string): Promise<string> {
    const cfg = getStudioConfig();
    if (!cfg) throw new Error("Stockage R2 non configuré.");
    return putObject(cfg, key, bytes, mime);
  }
}

// Implémentation de test : c'est elle qui rend tout le chemin de rendu vérifiable sans compte R2
// ni réseau.
export class MemoryRenderStore implements RenderStore {
  readonly objects = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array, mime: string): Promise<string> {
    this.objects.set(key, bytes);
    return `memory://${key}`;
  }
}

// Empreinte canonique des ENTRÉES d'un rendu. Les clés sont triées, donc l'ordre de construction
// de l'objet `values` n'a aucune influence — sans ce tri, deux appels identiques produiraient deux
// empreintes différentes et le cache ne servirait jamais.
//
// `format` (chantier D, Tâche 6) — optionnel, et délibérément absent du canonique quand il l'est
// (plutôt que normalisé en `null`) : AVANT cette tâche, rien ne relayoutait jamais un gabarit avant
// rendu, donc (templateId, templateVersion, values) suffisait — DEUX canaux partageant le MÊME
// gabarit par défaut (resolveTemplate retombant sur (context, null, null)) produisaient de toute
// façon la MÊME image, puisque `renderScene` ne consultait que `scene.canvas`, jamais un format
// cible. Maintenant que renderForArticle (lib/studio/index.ts) relayoute vers `o.format` AVANT
// rendu, deux canaux de formats DIFFÉRENTS partageant ce même gabarit produisent des images
// DIFFÉRENTES (canevas et cadres relayoutés différemment) — sans `format` dans l'empreinte, le
// second canal à demander ce gabarit trouverait le rendu du PREMIER en cache et le SERVIRAIT TEL
// QUEL (mauvaises dimensions, mise en page pour un autre format). Le garder ABSENT du canonique
// pour les appelants qui ne le fournissent toujours pas (lib/studio/manual-core.ts ; tout contexte
// sans notion de format cible) préserve EXACTEMENT les empreintes déjà en base pour ces chemins —
// aucune invalidation de cache non nécessaire.
//
// `encode` (qualité, C) — MÊME discipline, MÊME raison, un cran plus loin : le format d'ENCODAGE de
// sortie fait maintenant partie des entrées (lib/wp/publish.ts demande du WebP, les autres
// appelants restent en JPEG). Deux appelants partageant gabarit, valeurs et format cible mais
// demandant des encodages DIFFÉRENTS produisent deux fichiers différents — sans `encode` dans
// l'empreinte, le second trouverait le rendu du premier en cache et servirait un JPEG là où un WebP
// était demandé (ou l'inverse), avec l'extension et le Content-Type de l'autre. Absent, le canonique
// est STRICTEMENT celui d'avant ce chantier : aucune empreinte déjà en base n'est invalidée, donc
// aucun re-rendu inutile de tout le cache existant.
export function computeInputHash(input: {
  templateId: string;
  templateVersion: number;
  values: TokenValues;
  format?: string;
  encode?: string;
}): string {
  const sorted = Object.keys(input.values).sort().map((k) => [k, input.values[k as keyof TokenValues]]);
  const canonical = input.encode !== undefined
    // `input.format ?? null` (et non l'omission) : c'est un NOUVEAU canonique, il n'a aucune
    // empreinte historique à préserver — il doit seulement rester non ambigu entre ses propres cas.
    ? JSON.stringify([input.templateId, input.templateVersion, sorted, input.format ?? null, input.encode])
    : input.format !== undefined
      ? JSON.stringify([input.templateId, input.templateVersion, sorted, input.format])
      : JSON.stringify([input.templateId, input.templateVersion, sorted]);
  return createHash("sha256").update(canonical).digest("hex");
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/webp": "webp", "image/png": "png" };

export function storageKeyFor(hash: string, mime: string, now: Date): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `renders/${year}/${month}/${hash}.${EXT[mime] ?? "jpg"}`;
}

export async function findCachedRender(inputHash: string) {
  const [row] = await db.select().from(renders).where(eq(renders.inputHash, inputHash)).limit(1);
  return row ?? null;
}

// Idempotent par construction : deux rendus identiques concurrents (double clic, deux onglets — la
// fenêtre est large de plusieurs secondes à cause du réseau + satori + resvg + sharp) peuvent tous
// les deux dépasser le court-circuit findCachedRender AVANT que l'un des deux ait inséré sa ligne.
// Le second insert violerait alors renders_input_hash_unique (SQLSTATE 23505) — sans
// onConflictDoNothing, cette erreur Postgres brute remontait telle quelle jusqu'à l'appelant. Avec
// lui, l'insert perdant ne renvoie simplement aucune ligne (pas d'exception) ; on relit alors la
// ligne posée par le gagnant et on la renvoie — même contrat de retour dans les deux cas, et les
// octets déjà téléversés sur R2 par le perdant ne sont jamais jetés pour une simple erreur.
export async function saveRender(row: typeof renders.$inferInsert) {
  const [saved] = await db.insert(renders).values(row)
    .onConflictDoNothing({ target: renders.inputHash })
    .returning();
  if (saved) return saved;
  const existing = await findCachedRender(row.inputHash);
  if (existing) return existing;
  // Ne peut arriver que si la ligne gagnante a été supprimée entre l'insert et cette relecture
  // (fenêtre infime) — pas de repli silencieux possible ici, l'appelant doit voir une erreur claire.
  throw new Error(`saveRender : conflit sur inputHash « ${row.inputHash} » mais aucune ligne trouvée après relecture.`);
}

export { publicUrlFor };
