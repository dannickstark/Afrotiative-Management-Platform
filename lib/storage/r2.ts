import { AwsV4Signer } from "aws4fetch";
import { fetch as undiciFetch } from "undici";
import type { StudioConfig } from "@/lib/studio/config";
import { retryTransient } from "./retry";

// Client S3v4 minimal. `aws4fetch` (~2 ko) plutôt que @aws-sdk/client-s3 (plusieurs Mo) : on n'a
// besoin que d'un PUT signé, les rendus font moins d'un Mo et ne demandent pas de multipart.
export function publicUrlFor(cfg: StudioConfig, key: string): string {
  return `${cfg.publicBaseUrl.replace(/\/+$/, "")}/${key.replace(/^\/+/, "")}`;
}

function endpointFor(cfg: StudioConfig, key: string): string {
  return `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}/${key.replace(/^\/+/, "")}`;
}

// ─── Réessai des pannes R2 TRANSITOIRES ──────────────────────────────────────────────────────────
// Le bug « Téléversement impossible : le stockage R2 est momentanément indisponible » (asset-core.ts)
// apparaissait PARFOIS. Cause racine : la boucle de réessai d'aws4fetch (v1.0.20) ne réessaie que les
// STATUTS HTTP 5xx/429 (`if (res.status < 500 && res.status !== 429) return res`), mais PAS une erreur
// réseau LEVÉE — quand `fetch` REJETTE (socket reset/timeout, TLS, erreurs undici, y compris la classe
// content-length documentée plus bas), l'exception traverse la boucle sans réessai. `putObject` ne
// rattrapait rien : une panne réseau transitoire vers R2 remontait telle quelle à l'utilisateur. On
// désactive donc le réessai interne d'aws4fetch (`retries: 0`) et on centralise TOUT le réessai ici,
// via `retryTransient`, en couvrant AUSSI les erreurs réseau levées. Le PUT est idempotent (même clé,
// écrasement), donc réessayer est sûr.

/** Une erreur R2 porteuse du STATUT HTTP — pour distinguer transitoire (5xx/429/408) de permanent (4xx). */
export class R2HttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Opération R2 échouée (HTTP ${status}).`);
    this.name = "R2HttpError";
    this.status = status;
  }
}

/** TRANSITOIRE (réessayable) : toute erreur réseau LEVÉE (fetch rejette/timeout), et les statuts HTTP
 * 5xx/429/408. PERMANENT (échec immédiat) : les autres 4xx (403 auth, 400 requête, 404…). */
export function isTransientR2Error(e: unknown): boolean {
  if (e instanceof R2HttpError) return e.status === 429 || e.status === 408 || e.status >= 500;
  return true;
}

export type R2SendResult = { ok: boolean; status: number };
/** UNE tentative réseau signée. En prod c'est aws4fetch ; les tests l'injectent pour piloter
 * échecs transitoires/permanents sans réseau réel ni signature. */
export type R2SendRequest = (url: string, init: RequestInit) => Promise<R2SendResult>;
export type R2Deps = { sendRequest?: R2SendRequest; sleep?: (ms: number) => Promise<void> };

const R2_ATTEMPTS = 3;
const R2_TIMEOUT_MS = 30_000; // par tentative : un socket qui pend est abandonné → AbortError → réessai

// LE VRAI CORRECTIF DU 411 « Length Required ». Cause racine confirmée : dans une Server Action, le
// PUT signé partait par le `fetch` GLOBAL PATCHÉ par Next.js (couche de cache App Router), qui
// n'émettait PAS de `Content-Length` pour un corps binaire (transfer-encoding chunked) — or R2/S3
// EXIGE Content-Length sur un PUT et répond 411 sinon. `aws4fetch`#AwsClient.fetch utilise ce global
// patché ; on ne s'en sert donc plus pour TRANSMETTRE. On SIGNE avec `AwsV4Signer` (S3v4, hash du
// corps), puis on ENVOIE avec le `fetch` d'`undici` importé DIRECTEMENT — jamais patché par Next.js —
// qui pose bien Content-Length depuis l'octet-source (Uint8Array). Vérifié contre le VRAI compte R2
// (PUT 200, DELETE 204), là où le global patché rendait 411. `retryTransient` reste l'unique autorité
// de réessai (couvre AUSSI les erreurs réseau levées, ignorées par le réessai interne d'aws4fetch).
function realSender(cfg: StudioConfig): R2SendRequest {
  return async (url, init) => {
    const signer = new AwsV4Signer({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body, // signé (x-amz-content-sha256) ET envoyé — les deux DOIVENT être identiques
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      service: "s3",
      region: "auto",
    });
    const signed = await signer.sign();
    const res = await undiciFetch(signed.url.toString(), {
      method: signed.method,
      headers: [...signed.headers],
      body: init.body as Uint8Array | undefined,
      signal: init.signal ?? undefined,
    });
    return { ok: res.ok, status: res.status };
  };
}

export async function putObject(
  cfg: StudioConfig, key: string, bytes: Uint8Array, mime: string, deps: R2Deps = {},
): Promise<string> {
  const send = deps.sendRequest ?? realSender(cfg);
  const url = endpointFor(cfg, key);
  // PAS de "content-length" manuel ici (retiré, V3 Tâche 2) : `fetch` le calcule déjà correctement
  // à partir du corps. Bug trouvé en pilotant un vrai navigateur contre le VRAI compte R2 (aucun
  // test `bun test` ne pouvait le voir, MemoryRenderStore ne touchant jamais le réseau) — la
  // Server Action passe par le `fetch` global PATCHÉ par Next.js (couche de cache App Router), qui
  // finit par envoyer un corps dont la longueur ne correspond plus exactement à l'en-tête fourni
  // ici : undici refuse alors la requête avec `InvalidArgumentError: invalid content-length header`
  // AVANT même qu'elle ne parte — jamais reproduit par un script Node nu (même pipeline satori →
  // resvg → sharp, mêmes octets), seulement à travers l'enveloppe fetch de Next.js.
  await retryTransient(async () => {
    const res = await send(url, {
      method: "PUT",
      body: bytes as unknown as BodyInit,
      headers: { "content-type": mime },
      signal: AbortSignal.timeout(R2_TIMEOUT_MS),
    });
    if (!res.ok) throw new R2HttpError(res.status);
  }, { attempts: R2_ATTEMPTS, sleep: deps.sleep, shouldRetry: isTransientR2Error });
  return publicUrlFor(cfg, key);
}

// Tâche 11 (bibliothèque d'assets) : deleteAsset() supprime l'objet R2 APRÈS avoir supprimé la
// ligne render_assets (spec §5). Un 404 est traité comme un succès — l'objet est déjà absent, ce
// qui est exactement l'état visé ; le distinguer d'un "vrai" succès n'apporterait rien à l'appelant.
export async function deleteObject(cfg: StudioConfig, key: string, deps: R2Deps = {}): Promise<void> {
  const send = deps.sendRequest ?? realSender(cfg);
  const url = endpointFor(cfg, key);
  await retryTransient(async () => {
    const res = await send(url, { method: "DELETE", signal: AbortSignal.timeout(R2_TIMEOUT_MS) });
    if (!res.ok && res.status !== 404) throw new R2HttpError(res.status);
  }, { attempts: R2_ATTEMPTS, sleep: deps.sleep, shouldRetry: isTransientR2Error });
}
