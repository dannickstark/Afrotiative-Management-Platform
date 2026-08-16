import { payloadSchema, SCHEMA_VERSION, TC_RE, type Payload } from "@/lib/video/schema";

// Module PUR, sans accès base : c'est la contrainte de conception principale de ce fichier. Le
// handler MCP du SP1 bis appelle exactement ces fonctions et renvoie `issues` à l'agent pour qu'il
// se corrige. Aucune logique de contrat ne doit exister ailleurs.
export type Issue = { path: string; message: string; received?: unknown };
export type ParseResult = { ok: true; payload: Payload } | { ok: false; issues: Issue[] };

/**
 * Normalisations d'entrée, et RIEN d'autre : BOM, balises de code englobantes, bavardage avant la
 * première `{` et après la dernière `}`. Pas de correction de clés, pas de devinette de type, pas
 * de repli IA — l'entrée JSON stricte est une décision verrouillée du spec.
 */
export function stripEnvelope(raw: string): string {
  let s = raw.replace(/^﻿/, "").trim();
  const fenced = s.match(/^```[a-z]*\s*\n([\s\S]*?)\n?```$/i);
  if (fenced) s = fenced[1].trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last > first) s = s.slice(first, last + 1);
  return s.trim();
}

function majorOf(version: string): string {
  return version.split(".")[0] ?? "";
}

function tcToMs(tc: string): number {
  const [hms, frac = "0"] = tc.split(".");
  const [h, m, sec] = hms.split(":").map(Number);
  return ((h * 3600 + m * 60 + sec) * 1000) + Number(frac.padEnd(3, "0"));
}

// Règles INTER-CHAMPS, volontairement hors du schéma Zod : z.toJSONSchema() ignore les
// raffinements, donc les y mettre les ferait disparaître du contrat envoyé au chat. Elles sont
// décrites en toutes lettres dans le brief (lib/video/brief.ts).
function semanticIssues(payload: Payload): Issue[] {
  const issues: Issue[] = [];
  payload.variantes.forEach((variante, vi) => {
    const seen = new Map<string, number>();
    variante.beats.forEach((beat, bi) => {
      const previous = seen.get(beat.id);
      if (previous !== undefined) {
        issues.push({
          path: `variantes[${vi}].beats[${bi}].id`,
          message: `identifiant dupliqué « ${beat.id} » (déjà utilisé par le beat ${previous})`,
          received: beat.id,
        });
      } else {
        seen.set(beat.id, bi);
      }
      (beat.inserts ?? []).forEach((insert, ii) => {
        if (insert?.tc_in && insert?.tc_out && TC_RE.test(insert.tc_in) && TC_RE.test(insert.tc_out)
            && tcToMs(insert.tc_out) <= tcToMs(insert.tc_in)) {
          issues.push({
            path: `variantes[${vi}].beats[${bi}].inserts[${ii}].tc_out`,
            message: `le timecode de fin doit être postérieur au début (${insert.tc_in})`,
            received: insert.tc_out,
          });
        }
      });
    });
  });
  return issues;
}

function formatPath(path: PropertyKey[]): string {
  return path.reduce<string>((acc, segment) => (
    typeof segment === "number" ? `${acc}[${segment}]` : acc ? `${acc}.${String(segment)}` : String(segment)
  ), "");
}

export function parseIncoming(raw: string | unknown): ParseResult {
  let candidate: unknown;
  if (typeof raw === "string") {
    try {
      candidate = JSON.parse(stripEnvelope(raw));
    } catch (e) {
      return { ok: false, issues: [{ path: "", message: `JSON illisible : ${(e as Error).message}` }] };
    }
  } else {
    candidate = raw; // chemin MCP : l'objet arrive déjà désérialisé
  }

  // La version se vérifie AVANT le schéma : sur un payload d'une majeure future, les erreurs de
  // champ seraient du bruit masquant la vraie cause.
  const version = (candidate as { schema_version?: unknown } | null)?.schema_version;
  if (typeof version === "string" && majorOf(version) !== majorOf(SCHEMA_VERSION)) {
    return {
      ok: false,
      issues: [{
        path: "schema_version",
        message: `version de schéma incompatible : attendu ${majorOf(SCHEMA_VERSION)}.x, reçu ${version}`,
        received: version,
      }],
    };
  }

  // `reportInput: true` : sans ça, Zod 4 omet la valeur reçue de chaque issue (protection par
  // défaut contre la fuite de données sensibles dans les messages d'erreur). Ici les issues partent
  // vers l'agent qui a produit le payload, pas vers un tiers, donc les réintégrer est sans risque
  // et indispensable pour qu'il se corrige sans deviner.
  const parsed = payloadSchema.safeParse(candidate, { reportInput: true });
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        path: formatPath(i.path),
        message: i.message,
        received: "input" in i ? (i as { input?: unknown }).input : undefined,
      })),
    };
  }

  const semantic = semanticIssues(parsed.data);
  if (semantic.length > 0) return { ok: false, issues: semantic };

  return { ok: true, payload: parsed.data };
}
