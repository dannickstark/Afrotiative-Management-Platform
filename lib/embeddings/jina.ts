export async function jinaEmbed(text: string, opts: { baseUrl: string; apiKey: string; model: string; dimensions: number }): Promise<number[]> {
  const res = await fetch(`${opts.baseUrl.replace(/\/$/, "")}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: opts.model, dimensions: opts.dimensions, input: [text.slice(0, 8000)] }),
  });
  if (!res.ok) throw new Error(`Jina embeddings ${res.status}`);
  const data = await res.json();
  const emb = data?.data?.[0]?.embedding;
  if (!Array.isArray(emb)) throw new Error("Jina embeddings: réponse invalide");
  return emb.length === opts.dimensions ? emb : normalizeDims(emb, opts.dimensions);
}
function normalizeDims(v: number[], dims: number): number[] {
  if (v.length > dims) return v.slice(0, dims);
  return v.concat(new Array(dims - v.length).fill(0));
}
