import { isSafePublicHttpUrl } from "@/lib/url-guard";

export type VerifyResult = { status: "ok" | "mort" | "interdit"; httpStatus?: number };

export async function verifyUrl(
  url: string | null,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<VerifyResult> {
  if (!url || !url.trim()) return { status: "mort" };
  // Garde SSRF appliquée AVANT tout fetch, TOUJOURS — contrairement à prepareImage, aucun bypass
  // NODE_ENV=test ici : une url privée ou non-http renvoie "mort" sans jamais appeler fetch, même
  // quand un `fetchImpl` de test est fourni.
  if (!isSafePublicHttpUrl(url)) return { status: "mort" };
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    // GET par plage : ne télécharge pas le fichier ; le corps n'est jamais lu.
    const res = await doFetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    const s = res.status;
    if (s >= 200 && s < 300) return { status: "ok", httpStatus: s };
    if (s === 401 || s === 403) return { status: "interdit", httpStatus: s };
    return { status: "mort", httpStatus: s };
  } catch {
    return { status: "mort" };
  }
}
