// Diagnostic (jetable) — vérifie que le pool OpenRouter tourne réellement sur des jetons DISTINCTS
// et interroge OpenRouter pour chaque jeton (GET /api/v1/key) afin de comparer l'usage déclaré.
// N'imprime JAMAIS un jeton en clair : seulement un préfixe/suffixe et une empreinte SHA-256.
import { createHash } from "node:crypto";
import { asc } from "drizzle-orm";
import { db, openrouterTokens } from "@/db";
import { loadOpenRouterPoolState } from "@/lib/ai/token-pool";

const fp = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const mask = (s: string) => `${s.slice(0, 10)}…${s.slice(-4)} (len ${s.length})`;

const rows = await db.select().from(openrouterTokens).orderBy(asc(openrouterTokens.sortOrder), asc(openrouterTokens.createdAt));
console.log(`\n=== Lignes openrouter_tokens (${rows.length}) ===`);
for (const r of rows) {
  console.log(
    `- ${r.label} | active=${r.active} sortOrder=${r.sortOrder} cooldownUntil=${r.cooldownUntil?.toISOString() ?? "—"} ` +
      `lastStatus=${r.lastStatus ?? "—"} lastUsedAt=${r.lastUsedAt?.toISOString() ?? "JAMAIS"} lastError=${r.lastError ?? "—"}`,
  );
}

const state = await loadOpenRouterPoolState();
console.log(`\n=== État du pool : configured=${state.configured}, ${state.tokens.length} jeton(s) utilisable(s) ===`);
for (const [i, t] of state.tokens.entries()) {
  console.log(`${i + 1}. ${t.label} | id=${t.id ?? "(env)"} | ${mask(t.token)} | sha=${fp(t.token)}`);
}
const uniq = new Set(state.tokens.map((t) => fp(t.token)));
console.log(uniq.size === state.tokens.length ? "→ tous les jetons sont DISTINCTS" : `→ ⚠ DOUBLONS : ${uniq.size} valeurs distinctes pour ${state.tokens.length} entrées`);

console.log(`\n=== Interrogation OpenRouter GET /api/v1/key (usage déclaré par clé) ===`);
for (const t of state.tokens) {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${t.token}` } });
    const raw = (await res.json().catch(() => null)) as { data?: Record<string, unknown> } | null;
    const d = raw?.data;
    console.log(
      d
        ? `- ${t.label} → HTTP ${res.status} | usage=${d.usage} (jour=${d.usage_daily}, semaine=${d.usage_weekly}, mois=${d.usage_monthly}) | free_tier=${d.is_free_tier} | limite=${d.limit ?? "aucune"}`
        : `- ${t.label} → HTTP ${res.status} (réponse non lisible)`,
    );
  } catch (e) {
    console.log(`- ${t.label} → échec réseau : ${String(e)}`);
  }
}

// --probe : appel RÉEL par jeton (même modèle, même chemin generateObject que le pipeline) pour
// distinguer « la clé ne marche pas » de « le modèle ne rend pas d'objet conforme ». Chaque appel
// réussi doit apparaître dans l'activité OpenRouter du compte correspondant.
if (process.argv.includes("--probe")) {
  const { generateObject } = await import("ai");
  const { z } = await import("zod");
  const { buildOpenRouterModel } = await import("@/lib/ai/providers");
  const { getPipelineConfig } = await import("@/lib/config/pipeline-config");
  const cfg = getPipelineConfig();
  console.log(`\n=== Sonde generateObject (modèle : ${cfg.openrouter?.model ?? process.env.OPENROUTER_MODEL ?? "défaut"}) ===`);
  for (const t of state.tokens) {
    try {
      const { object } = await generateObject({
        model: buildOpenRouterModel(cfg, t.token),
        schema: z.object({ ville: z.string(), pays: z.string() }),
        prompt: "Donne la capitale du Cameroun.",
        providerOptions: { openaiCompatible: { strictJsonSchema: false } },
      });
      console.log(`- ${t.label} → OK ${JSON.stringify(object)}`);
    } catch (e) {
      console.log(`- ${t.label} → ÉCHEC ${(e as Error).name}: ${String((e as Error).message).slice(0, 200)}`);
    }
  }
}

process.exit(0);
