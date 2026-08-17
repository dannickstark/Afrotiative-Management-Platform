import {
  payloadSchema, SCHEMA_VERSION, TC_RE, type BeatPayload, type InsertPayload, type Payload,
} from "@/lib/video/schema";

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

// La forme normalisée d'un beat : identique qu'elle vienne de la base ou du payload. C'est ce qui
// rend la comparaison à trois voies possible sans conversion à chaque appel.
export type BeatSnapshot = {
  kind: BeatPayload["type"];
  spokenText: string;
  directionNote: string | null;
  screenText: string | null;
  transitionIn: string | null;
  transitionOut: string | null;
  sources: string[];
  inserts: NonNullable<BeatPayload["inserts"]>;
};

export const MERGE_FIELDS = [
  "kind", "spokenText", "directionNote", "screenText",
  "transitionIn", "transitionOut", "sources", "inserts",
] as const;

/**
 * LE producteur commun de la forme des inserts (round de correction final, I1). Toutes les sources
 * d'un `BeatSnapshot` passent par ici : le payload (toSnapshot ci-dessous), les colonnes de
 * `beat_inserts`, et le jsonb `importedSnapshot` relu (lib/video/persist.ts). Sans ça, les trois
 * formes divergeaient : Zod 4 n'ajoute PAS à sa sortie une clé optionnelle absente de l'entrée, donc
 * un payload omettant `credit` produisait un insert à 5 clés, là où les colonnes en produisent
 * toujours 7 (`credit: null`). computeMerge comparant par `JSON.stringify`, `differs(ours.inserts,
 * base.inserts)` était vrai À JAMAIS : tout beat à insert était réputé édité à la main, donc tout
 * changement d'insert venu de Claude arrivait en conflit au lieu d'une fusion automatique.
 *
 * Mêmes clés, MÊME ORDRE que insertPayloadSchema (lib/video/schema.ts), les absentes valant `null` :
 * l'accord se fait par construction, plus par discipline de chaque appelant.
 */
export function normalizeInserts(raw: readonly Partial<InsertPayload>[] | null | undefined): InsertPayload[] {
  return (raw ?? []).map((ins) => ({
    type: ins.type as InsertPayload["type"],
    url: ins.url ?? null,
    tc_in: ins.tc_in ?? null,
    tc_out: ins.tc_out ?? null,
    duree_affichage_sec: ins.duree_affichage_sec ?? null,
    credit: ins.credit ?? null,
    droits: ins.droits ?? null,
  }));
}

export function toSnapshot(beat: BeatPayload): BeatSnapshot {
  return {
    kind: beat.type,
    spokenText: beat.texte ?? "",
    directionNote: beat.note_realisation ?? null,
    screenText: beat.texte_ecran ?? null,
    transitionIn: beat.transition_entree ?? null,
    transitionOut: beat.transition_sortie ?? null,
    sources: beat.sources ?? [],
    inserts: normalizeInserts(beat.inserts),
  };
}

/**
 * L'INVERSE exact de `toSnapshot` (round de correction final, C1) : d'un instantané interne vers le
 * fragment de contrat correspondant. `get_script` (lib/mcp/tools.ts, via readScriptCore) rendait
 * jusqu'ici le vocabulaire INTERNE — `id` valant l'UUID de ligne, plus `kind`, `spokenText`,
 * `directionNote`… — alors que l'agent doit produire `id` (= l'externalId), `type`, `texte`,
 * `note_realisation`… L'agent qui lisait, révisait et resoumettait en reportant `id` → `id`
 * envoyait donc des UUID comme identifiants de beats ; un UUID satisfait BEAT_ID_RE, donc rien ne le
 * refusait, computeMerge y voyait N suppressions (non appliquées par défaut) et N ajouts (appliqués)
 * — le script était DUPLIQUÉ en silence. C'est le mode d'échec même que get_script existe pour
 * supprimer.
 *
 * Écrite ICI, collée à `toSnapshot`, et typée `BeatPayload` : la sortie est celle de
 * lib/video/schema.ts, donc un renommage de clé du contrat casse la compilation au lieu de laisser
 * les deux sens diverger en silence.
 */
export function toPayloadBeat(externalId: string, snapshot: BeatSnapshot): BeatPayload {
  return {
    id: externalId,
    type: snapshot.kind,
    texte: snapshot.spokenText,
    note_realisation: snapshot.directionNote,
    texte_ecran: snapshot.screenText,
    transition_entree: snapshot.transitionIn,
    transition_sortie: snapshot.transitionOut,
    sources: snapshot.sources,
    inserts: normalizeInserts(snapshot.inserts),
  };
}

export type BeatRow = {
  externalId: string;
  position: number;
  snapshot: BeatSnapshot;              // l'état actuel en base (base + éditions humaines)
  importedSnapshot: BeatSnapshot | null; // ce que le dernier import avait posé ; null = jamais importé
};

export type BeatChange = {
  externalId: string; kind: "ajout" | "modification"; fields: string[];
  next: BeatSnapshot; position: number;
};
export type BeatConflict = {
  externalId: string; fields: string[];
  base: BeatSnapshot | null; ours: BeatSnapshot; theirs: BeatSnapshot; position: number;
};
export type Diff = {
  added: BeatChange[]; modified: BeatChange[]; conflicts: BeatConflict[];
  removed: { externalId: string }[]; order: string[];
};
export type Selection = { accept: string[] };
export type Mutations = {
  create: BeatRow[];
  update: { externalId: string; snapshot: BeatSnapshot }[];
  remove: string[];
  order: string[];
};

function differs(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

/**
 * Fusion à trois voies, beat par beat, clé = externalId :
 *   base   = importedSnapshot (ce que le dernier import avait posé)
 *   nôtre  = snapshot (base + éditions humaines)
 *   leur   = le fragment du nouveau payload
 * Champs disjoints → fusionnés. Même champ touché des deux côtés → CONFLIT, jamais tranché ici.
 */
export function computeMerge(current: BeatRow[], next: BeatPayload[]): Diff {
  const byId = new Map(current.map((r) => [r.externalId, r]));
  const diff: Diff = { added: [], modified: [], conflicts: [], removed: [], order: next.map((b) => b.id) };

  next.forEach((payloadBeat, index) => {
    const theirs = toSnapshot(payloadBeat);
    const row = byId.get(payloadBeat.id);

    if (!row) {
      diff.added.push({ externalId: payloadBeat.id, kind: "ajout", fields: [...MERGE_FIELDS], next: theirs, position: index });
      return;
    }

    const base = row.importedSnapshot;
    const ours = row.snapshot;

    // Sans base (beat jamais importé, créé à la main), impossible de savoir si l'état actuel vient
    // d'une édition humaine ou d'un import : on ne tranche donc jamais tout seul, mais on ne fabrique
    // pas non plus un conflit fantôme là où les deux versions coïncident.
    if (base === null) {
      const diffFields = MERGE_FIELDS.filter((f) => differs(theirs[f], ours[f]));
      if (diffFields.length === 0) return; // identique : rien à signaler
      diff.conflicts.push({ externalId: payloadBeat.id, fields: diffFields, base, ours, theirs, position: index });
      return;
    }

    const theirChanged = MERGE_FIELDS.filter((f) => differs(theirs[f], base[f]));
    const ourChanged = MERGE_FIELDS.filter((f) => differs(ours[f], base[f]));
    if (theirChanged.length === 0) return; // inchangé côté Claude

    const contested = theirChanged.filter((f) => ourChanged.includes(f) && differs(theirs[f], ours[f]));
    if (contested.length > 0) {
      diff.conflicts.push({ externalId: payloadBeat.id, fields: contested, base, ours, theirs, position: index });
      return;
    }

    // Champs disjoints : on part de NOTRE version et on n'y pose que ce que Claude a changé.
    const merged = { ...ours } as BeatSnapshot;
    for (const f of theirChanged) (merged as Record<string, unknown>)[f] = theirs[f];
    diff.modified.push({ externalId: payloadBeat.id, kind: "modification", fields: theirChanged, next: merged, position: index });
  });

  const incoming = new Set(next.map((b) => b.id));
  for (const row of current) {
    if (!incoming.has(row.externalId)) diff.removed.push({ externalId: row.externalId });
  }
  return diff;
}

/**
 * LA règle produit, en UN seul endroit (round de correction final, I1) : sans sélection explicite,
 * on retient les ajouts et les modifications, JAMAIS les suppressions ni les conflits. Un modèle qui
 * abrège sa réponse ne doit pas pouvoir effacer un beat par omission, et un conflit ne se tranche
 * jamais tout seul.
 *
 * Elle vivait en DEUX copies — lib/mcp/tools.ts (canal agent, sans revue humaine) et
 * components/video/diff-review.tsx (canal humain) — sans fonction partagée ni test d'accord : la
 * faire évoluer sur un canal laissait l'autre ouvert, et c'est le canal agent qui compte le plus.
 * Son domicile est ici, aux côtés de computeMerge (qui produit le diff) et d'applyMerge (qui
 * consomme la sélection).
 *
 * `Partial<Diff>` toléré : lib/mcp/tools.ts relit le diff depuis la colonne jsonb du journal, où une
 * entrée rejetée porte `{}`. La règle rend alors une sélection vide, elle ne lève pas.
 */
export function defaultAccept(diff: Partial<Diff>): string[] {
  return [
    ...(diff.added ?? []).map((a) => a.externalId),
    ...(diff.modified ?? []).map((m) => m.externalId),
  ];
}

/**
 * Traduit le diff et la SÉLECTION HUMAINE en mutations. Une suppression non retenue n'efface rien,
 * et un beat conservé malgré une suppression proposée est repoussé en fin d'ordre plutôt que perdu.
 */
export function applyMerge(diff: Diff, selection: Selection): Mutations {
  const accepted = new Set(selection.accept);
  const create: BeatRow[] = diff.added
    .filter((a) => accepted.has(a.externalId))
    .map((a) => ({ externalId: a.externalId, position: a.position, snapshot: a.next, importedSnapshot: a.next }));

  const update = [
    ...diff.modified.filter((m) => accepted.has(m.externalId)).map((m) => ({ externalId: m.externalId, snapshot: m.next })),
    // Round de correction final, C1 : accepter un conflit n'applique QUE les champs CONTESTÉS
    // (`c.fields`) de la version de Claude, jamais son instantané complet (`c.theirs`). `c.fields`
    // ne liste que les champs touchés des deux côtés ; poser `theirs` en entier ramenait à leur
    // valeur de base tous les autres champs — y compris ceux que SEUL l'humain avait édités et que
    // Claude n'a jamais touchés. C'est exactement la perte d'édition humaine que ce module existe
    // pour empêcher. Même traitement que les modifications à champs disjoints ci-dessus : on part de
    // NOTRE version et on n'y pose que ce qui est tranché.
    ...diff.conflicts.filter((c) => accepted.has(c.externalId)).map((c) => {
      const merged = { ...c.ours } as BeatSnapshot;
      for (const f of c.fields) {
        (merged as Record<string, unknown>)[f] = (c.theirs as unknown as Record<string, unknown>)[f];
      }
      return { externalId: c.externalId, snapshot: merged };
    }),
  ];

  const remove = diff.removed.filter((r) => accepted.has(r.externalId)).map((r) => r.externalId);

  // L'ordre du payload d'abord, puis les rescapés d'une suppression refusée, dans leur ordre actuel.
  const removedButKept = diff.removed.filter((r) => !accepted.has(r.externalId)).map((r) => r.externalId);
  const droppedAdds = new Set(diff.added.filter((a) => !accepted.has(a.externalId)).map((a) => a.externalId));
  const order = [...diff.order.filter((id) => !droppedAdds.has(id)), ...removedButKept];

  return { create, update, remove, order };
}
