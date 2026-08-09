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
  const res = await client.fetch(endpointFor(cfg, key), {
    method: "PUT",
    body: bytes as unknown as BodyInit,
    headers: { "content-type": mime, "content-length": String(bytes.byteLength) },
  });
  if (!res.ok) {
    throw new Error(`Téléversement R2 échoué (HTTP ${res.status}).`);
  }
  return publicUrlFor(cfg, key);
}
