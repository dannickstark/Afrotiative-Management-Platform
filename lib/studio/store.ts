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
export function computeInputHash(input: {
  templateId: string;
  templateVersion: number;
  values: TokenValues;
}): string {
  const sorted = Object.keys(input.values).sort().map((k) => [k, input.values[k as keyof TokenValues]]);
  const canonical = JSON.stringify([input.templateId, input.templateVersion, sorted]);
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

export async function saveRender(row: typeof renders.$inferInsert) {
  const [saved] = await db.insert(renders).values(row).returning();
  return saved;
}

export { publicUrlFor };
