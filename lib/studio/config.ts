// R2 (Cloudflare, S3-compatible) — la configuration du studio. Comme getWpConfig()
// (lib/wp/config.ts), les cinq variables manquantes désactivent proprement la fonctionnalité :
// on renvoie null, on ne lève jamais. Les appelants rendent alors un message français.
export type StudioConfig = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicBaseUrl: string;
};

export function getStudioConfig(): StudioConfig | null {
  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = process.env.R2_BUCKET?.trim();
  const publicBaseUrl = process.env.R2_PUBLIC_BASE_URL?.trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket || !publicBaseUrl) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket, publicBaseUrl };
}
