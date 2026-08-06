// The live WordPress URL is not stored (only distributions.externalId = the post id), so reconstruct
// the ?p=<id> permalink — it resolves on any WP regardless of pretty-permalink settings. Pure and
// DB-free so both server queries and (if ever needed) client components can import it safely.
export function wpPostUrl(baseUrl: string | null | undefined, postId: string | null): string | null {
  if (!baseUrl || !postId) return null;
  return `${baseUrl.replace(/\/$/, "")}/?p=${encodeURIComponent(postId)}`;
}
