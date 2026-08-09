import { AwsClient } from "aws4fetch";
import type { StudioConfig } from "@/lib/studio/config";

// Client S3v4 minimal. `aws4fetch` (~2 ko) plutôt que @aws-sdk/client-s3 (plusieurs Mo) : on n'a
// besoin que d'un PUT signé, les rendus font moins d'un Mo et ne demandent pas de multipart.
export function publicUrlFor(cfg: StudioConfig, key: string): string {
  return `${cfg.publicBaseUrl.replace(/\/+$/, "")}/${key.replace(/^\/+/, "")}`;
}

function endpointFor(cfg: StudioConfig, key: string): string {
  return `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}/${key.replace(/^\/+/, "")}`;
}

export async function putObject(
  cfg: StudioConfig, key: string, bytes: Uint8Array, mime: string,
): Promise<string> {
  const client = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  // PAS de "content-length" manuel ici (retiré, V3 Tâche 2) : `fetch` le calcule déjà correctement
  // à partir du corps. Bug trouvé en pilotant un vrai navigateur contre le VRAI compte R2 (aucun
  // test `bun test` ne pouvait le voir, MemoryRenderStore ne touchant jamais le réseau) — la
  // Server Action passe par le `fetch` global PATCHÉ par Next.js (couche de cache App Router), qui
  // finit par envoyer un corps dont la longueur ne correspond plus exactement à l'en-tête fourni
  // ici : undici refuse alors la requête avec `InvalidArgumentError: invalid content-length header`
  // AVANT même qu'elle ne parte — jamais reproduit par un script Node nu (même pipeline satori →
  // resvg → sharp, mêmes octets), seulement à travers l'enveloppe fetch de Next.js. C'était le
  // PREMIER appel de ce module à passer par du réseau réel plutôt que par un mock (renderForArticle
  // n'avait jamais été exercé en dehors de `bun test`, où lib/studio/store.ts:MemoryRenderStore
  // remplace toujours R2RenderStore) — donc invisible jusqu'à V3.
  const res = await client.fetch(endpointFor(cfg, key), {
    method: "PUT",
    body: bytes as unknown as BodyInit,
    headers: { "content-type": mime },
  });
  if (!res.ok) {
    throw new Error(`Téléversement R2 échoué (HTTP ${res.status}).`);
  }
  return publicUrlFor(cfg, key);
}

// Tâche 11 (bibliothèque d'assets) : deleteAsset() supprime l'objet R2 APRÈS avoir supprimé la
// ligne render_assets (spec §5). Un 404 est traité comme un succès — l'objet est déjà absent, ce
// qui est exactement l'état visé ; le distinguer d'un "vrai" succès n'apporterait rien à l'appelant.
export async function deleteObject(cfg: StudioConfig, key: string): Promise<void> {
  const client = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const res = await client.fetch(endpointFor(cfg, key), { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Suppression R2 échouée (HTTP ${res.status}).`);
  }
}
