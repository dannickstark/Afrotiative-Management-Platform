# Scripts vidéo — sous-projet 1 : contrat, brief & import — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Livrer le module `/video` : un espace par vidéo qui produit un **brief** à coller dans un chat Claude, puis **importe** la réponse JSON en la validant et en la fusionnant par identifiant de beat.

**Architecture:** Un schéma Zod unique (`lib/video/schema.ts`) est la source dont sont dérivés le validateur, le bloc JSON-Schema du brief, l'exemple, et (au sous-projet suivant) les schémas d'outils MCP. Toute la logique de contrat vit dans des modules **purs, sans accès base** (`schema.ts`, `import.ts`, `duration.ts`, `brief.ts`) ; seules les server actions traduisent leurs sorties en écritures. La fusion est **à trois voies** : `importedSnapshot` (dernier import) vs ligne actuelle vs nouveau payload.

**Tech Stack:** Next.js 16.3 (App Router, RSC + server actions), React 19, TypeScript, Zod 4.4.3 (`z.toJSONSchema` natif), Drizzle 0.45.2 + Postgres/Neon, better-auth 1.6.25, shadcn/ui sur Base UI + Tailwind v4, Bun (`bun test`).

**Spec:** `docs/superpowers/specs/2026-08-16-video-script-contrat-import-design.md`

## Global Constraints

- **Toute la copie d'interface est en français.** Les messages d'erreur d'import sont lus par l'utilisateur : ils sont en français.
- **Les clés du payload JSON sont en français** (`projet`, `variantes`, `beats`, `texte`, `inserts`…). Le mapping vers les colonnes anglaises se fait **uniquement** dans `lib/video/import.ts`.
- `SCHEMA_VERSION = "1.0"`. Une **majeure** inconnue est refusée ; une mineure inconnue est acceptée.
- **Aucun import partiel** : payload entièrement valide, ou rien n'est écrit. L'application sélective du diff est un choix humain postérieur, distinct.
- **Aucune logique de contrat hors de `lib/video/`.** Le handler MCP du SP1 bis appellera `parseIncoming`, `computeMerge`, `applyMerge`, `payloadSchema`, `SCHEMA_VERSION` — ces signatures sont publiques et stables.
- **Aucun appel réseau, aucune IA, dans ce sous-projet.** Pas de vérification de vivacité des URLs (SP3).
- Les modules `lib/video/*.ts` **n'importent jamais `@/db`**, à **une seule exception nommée** : `lib/video/persist.ts` (Task 9), qui est le cœur de persistance et n'a donc pas vocation à tourner dans la lane pure. Tous les autres — `schema.ts`, `import.ts`, `duration.ts`, `brief.ts` — doivent rester purs.
- Cadence de lecture par défaut : **155 mots/minute**.
- Chaque nouveau fichier de test sans base ni réseau est ajouté à `PURE_FILES` dans `scripts/test-fast.ts`.
- Les server actions suivent le motif de `lib/actions/taxonomy-actions.ts` : `"use server"`, un `guard()` local (`requireUser` + `requirePermission`), imports dynamiques de `@/db`.

---

### Task 1: Schéma de base de données

**Files:**
- Modify: `db/schema.ts` (ajouts en fin de fichier)
- Create: `db/migrations/00XX_*.sql` (généré)
- Test: `tests/video-schema-db.test.ts`

**Interfaces:**
- Consumes: rien
- Produces: `videoProjects`, `scriptVariants`, `scriptBeats`, `beatInserts`, `beatTakes`, `interviewSpeakers`, `scriptJournal`, `videoSettings` et les enums `videoProjectStatus`, `scriptPlatform`, `beatKind`, `takeStatus`, `insertKind`, `linkStatus`, `scriptJournalSource`, `scriptJournalOutcome`, exportés depuis `@/db/schema`.

**Ordre de déclaration impératif :** `interviewSpeakers` **avant** `scriptBeats` (la colonne `speakerId` la référence).

- [ ] **Step 1: Écrire le test qui échoue**

`tests/video-schema-db.test.ts` :

```ts
import { describe, it, expect } from "bun:test";
import { beatKind, scriptPlatform, videoProjects, scriptBeats, scriptJournal } from "@/db/schema";

describe("schéma vidéo", () => {
  it("expose les types de beat prévus par le spec", () => {
    expect(beatKind.enumValues).toEqual([
      "narration", "question", "reponse", "insert", "broll",
      "transition", "texte_ecran", "son", "note",
    ]);
  });

  it("expose les plateformes prévues", () => {
    expect(scriptPlatform.enumValues).toEqual([
      "youtube_long", "youtube_short", "tiktok", "reel", "interview",
    ]);
  });

  it("un beat porte l'identifiant externe et l'instantané d'import", () => {
    const cols = Object.keys(scriptBeats);
    expect(cols).toContain("externalId");
    expect(cols).toContain("importedSnapshot");
    expect(cols).toContain("locallyEditedAt");
  });

  it("un projet peut être rattaché à un article, sans obligation", () => {
    expect(videoProjects.articleId.notNull).toBe(false);
  });

  it("le journal conserve le payload brut", () => {
    expect(Object.keys(scriptJournal)).toContain("rawPayload");
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `bun test tests/video-schema-db.test.ts`
Expected: FAIL — `beatKind` n'est pas exporté par `@/db/schema`.

- [ ] **Step 3: Ajouter les enums et les tables**

Dans `db/schema.ts`, à la suite des tables existantes :

```ts
// ---- Module Vidéo (SP1 : contrat, brief & import) ----
export const videoProjectStatus = pgEnum("video_project_status", [
  "brouillon", "en_ecriture", "pret_a_tourner", "tourne", "en_montage", "publie", "archive",
]);
export const scriptPlatform = pgEnum("script_platform", [
  "youtube_long", "youtube_short", "tiktok", "reel", "interview",
]);
export const beatKind = pgEnum("beat_kind", [
  "narration", "question", "reponse", "insert", "broll",
  "transition", "texte_ecran", "son", "note",
]);
export const takeStatus = pgEnum("take_status", ["bonne", "mauvaise", "a_revoir"]);
export const insertKind = pgEnum("insert_kind", ["image", "video", "extrait", "graphique", "fichier"]);
// `interdit` = refusé par le garde SSRF (lib/url-guard.ts) ; `mort` = URL légitime qui ne répond
// plus. Les deux se lisent différemment côté monteur, d'où deux valeurs et non une.
export const linkStatus = pgEnum("link_status", ["non_verifie", "ok", "mort", "interdit"]);
export const scriptJournalSource = pgEnum("script_journal_source", ["copier_coller", "mcp", "manuel"]);
export const scriptJournalOutcome = pgEnum("script_journal_outcome", ["rejete", "applique", "annule"]);

export const videoProjects = pgTable("video_projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  subject: text("subject"),
  status: videoProjectStatus("status").notNull().default("brouillon"),
  // Origine double (spec §décision 6) : un projet dérive d'un article approuvé OU naît autonome.
  articleId: uuid("article_id").references(() => articles.id),
  createdBy: text("created_by").references(() => user.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("video_projects_status_idx").on(t.status),
  index("video_projects_article_idx").on(t.articleId),
]);

export const scriptVariants = pgTable("script_variants", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => videoProjects.id, { onDelete: "cascade" }),
  platform: scriptPlatform("platform").notNull(),
  targetDurationSec: integer("target_duration_sec"),
  aspectRatio: text("aspect_ratio").notNull().default("16:9"),
  position: integer("position").notNull(),
  // Ouverte au SP6 (variantes dérivées) : une variante TikTok pointe vers le YouTube long dont elle
  // dérive. Nulle partout au SP1.
  derivedFromId: uuid("derived_from_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("script_variants_project_position_uq").on(t.projectId, t.position),
  index("script_variants_project_idx").on(t.projectId),
]);

// DÉCLARÉE AVANT script_beats : scriptBeats.speakerId la référence. Ouverte au SP5.
export const interviewSpeakers = pgTable("interview_speakers", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => videoProjects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  role: text("role"),
  consentGiven: boolean("consent_given").notNull().default(false),
  consentNote: text("consent_note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const scriptBeats = pgTable("script_beats", {
  id: uuid("id").primaryKey().defaultRandom(),
  variantId: uuid("variant_id").notNull().references(() => scriptVariants.id, { onDelete: "cascade" }),
  // L'identifiant stable venant du JSON — LA clé de fusion. Sans lui, un ré-import ne peut que
  // remplacer (spec §5.3).
  externalId: text("external_id").notNull(),
  position: integer("position").notNull(),
  kind: beatKind("kind").notNull(),
  spokenText: text("spoken_text").notNull().default(""),
  directionNote: text("direction_note"),
  screenText: text("screen_text"),
  transitionIn: text("transition_in"),
  transitionOut: text("transition_out"),
  estimatedDurationSec: integer("estimated_duration_sec").notNull().default(0),
  durationOverrideSec: integer("duration_override_sec"),
  framing: jsonb("framing").$type<Record<string, unknown>>().notNull().default({}),
  speakerId: uuid("speaker_id").references(() => interviewSpeakers.id),
  answersBeatId: uuid("answers_beat_id"),
  sources: jsonb("sources").$type<string[]>().notNull().default([]),
  // Le fragment de payload EXACTEMENT tel qu'appliqué au dernier import : c'est la « base » de la
  // fusion à trois voies. Sans lui, impossible de distinguer « Claude a changé ce beat » de
  // « l'humain l'a changé », et un ré-import écrase en silence.
  importedSnapshot: jsonb("imported_snapshot").$type<Record<string, unknown>>(),
  locallyEditedAt: timestamp("locally_edited_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("script_beats_variant_external_uq").on(t.variantId, t.externalId),
  // PAS d'unicité sur position : un réordonnancement écrit plusieurs lignes dans une transaction et
  // passerait par des états transitoirement en doublon. La continuité est une invariante
  // applicative, reconstruite par applyMerge (spec §1.4).
  index("script_beats_variant_position_idx").on(t.variantId, t.position),
]);

export const beatInserts = pgTable("beat_inserts", {
  id: uuid("id").primaryKey().defaultRandom(),
  beatId: uuid("beat_id").notNull().references(() => scriptBeats.id, { onDelete: "cascade" }),
  kind: insertKind("kind").notNull(),
  url: text("url"),
  r2Key: text("r2_key"),
  tcIn: text("tc_in"),
  tcOut: text("tc_out"),
  displayDurationSec: integer("display_duration_sec"),
  credit: text("credit"),
  rightsNote: text("rights_note"),
  linkStatus: linkStatus("link_status").notNull().default("non_verifie"),
  linkCheckedAt: timestamp("link_checked_at"),
  position: integer("position").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [index("beat_inserts_beat_idx").on(t.beatId)]);

// Ouverte au SP4 (journal de prises).
export const beatTakes = pgTable("beat_takes", {
  id: uuid("id").primaryKey().defaultRandom(),
  beatId: uuid("beat_id").notNull().references(() => scriptBeats.id, { onDelete: "cascade" }),
  number: integer("number").notNull(),
  status: takeStatus("status").notNull(),
  startedAt: timestamp("started_at"),
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("beat_takes_beat_number_uq").on(t.beatId, t.number)]);

// Une seule table pour TOUT ce qui vient de l'extérieur : import collé (SP1) et écriture d'agent
// MCP (SP1 bis). C'est ce qui rend l'écriture complète des agents réversible.
export const scriptJournal = pgTable("script_journal", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => videoProjects.id, { onDelete: "cascade" }),
  variantId: uuid("variant_id").references(() => scriptVariants.id, { onDelete: "set null" }),
  source: scriptJournalSource("source").notNull(),
  toolName: text("tool_name"),
  actorUserId: text("actor_user_id").references(() => user.id),
  schemaVersion: text("schema_version"),
  // Conservé BRUT, avant toute normalisation : quand un import échoue, la seule façon de
  // diagnostiquer est de relire ce que le modèle a produit, pas ce que le parseur en a compris.
  rawPayload: jsonb("raw_payload"),
  errorReport: jsonb("error_report").$type<unknown[]>().notNull().default([]),
  diff: jsonb("diff").$type<Record<string, unknown>>().notNull().default({}),
  applied: jsonb("applied").$type<Record<string, unknown>>().notNull().default({}),
  outcome: scriptJournalOutcome("outcome").notNull(),
  revertedAt: timestamp("reverted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("script_journal_project_idx").on(t.projectId, t.createdAt)]);

export const videoSettings = pgTable("video_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  briefTemplate: text("brief_template").notNull(),
  wordsPerMinute: integer("words_per_minute").notNull().default(155),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  updatedBy: text("updated_by").references(() => user.id),
});
```

- [ ] **Step 4: Lancer le test et vérifier qu'il passe**

Run: `bun test tests/video-schema-db.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Générer la migration et vérifier les types**

Run: `bun run db:generate` puis `bun run typecheck`
Expected: un nouveau fichier `db/migrations/00XX_*.sql` contenant les 8 `CREATE TABLE` et les 8 `CREATE TYPE` ; typecheck sans erreur.

- [ ] **Step 6: Inscrire le test dans la lane pure**

Dans `scripts/test-fast.ts`, ajouter `"video-schema-db.test.ts"` à `PURE_FILES` (ordre alphabétique dans le bloc existant).

Run: `bun run test:pure`
Expected: PASS, le nouveau fichier apparaît dans la lane pure.

- [ ] **Step 7: Commit**

```bash
git add db/schema.ts db/migrations tests/video-schema-db.test.ts scripts/test-fast.ts
git commit -m "feat(video): tables et enums du module vidéo"
```

---

### Task 2: Le contrat JSON (`lib/video/schema.ts`)

**Files:**
- Create: `lib/video/schema.ts`
- Test: `tests/video-contract.test.ts`

**Interfaces:**
- Consumes: rien (module pur, aucun import de `@/db`)
- Produces:
  - `SCHEMA_VERSION: "1.0"`
  - `payloadSchema` (Zod), `beatPayloadSchema`, `insertPayloadSchema`, `variantPayloadSchema`
  - types `Payload`, `BeatPayload`, `InsertPayload`, `VariantPayload`
  - `BEAT_KINDS`, `PLATFORMS`, `RATIOS`, `TC_RE`, `BEAT_ID_RE`
  - `contractJsonSchema(): object` — le JSON-Schema dérivé
  - `EXAMPLE_PAYLOAD: Payload`

**Décision de conception :** les règles **de forme** vivent dans le schéma Zod ; les règles **inter-champs** (unicité des `id`, `tc_out > tc_in`) vivent dans une passe sémantique séparée, en Task 4. Deux raisons : `z.toJSONSchema()` ignore les raffinements (ils disparaîtraient du contrat envoyé au chat), et un schéma sans raffinement est garanti représentable en JSON-Schema.

- [ ] **Step 1: Écrire le test qui échoue**

`tests/video-contract.test.ts` :

```ts
import { describe, it, expect } from "bun:test";
import {
  SCHEMA_VERSION, payloadSchema, contractJsonSchema, EXAMPLE_PAYLOAD, BEAT_KINDS,
} from "@/lib/video/schema";

const valid = () => structuredClone(EXAMPLE_PAYLOAD);

describe("contrat vidéo", () => {
  it("l'exemple embarqué est valide au regard du schéma", () => {
    // Le point : c'est ce qui empêche l'exemple montré au chat de dériver du validateur.
    expect(payloadSchema.safeParse(EXAMPLE_PAYLOAD).success).toBe(true);
  });

  it("expose la version courante", () => {
    expect(SCHEMA_VERSION).toBe("1.0");
    expect(EXAMPLE_PAYLOAD.schema_version).toBe(SCHEMA_VERSION);
  });

  it("refuse un type de beat inconnu", () => {
    const p = valid();
    p.variantes[0].beats[0].type = "bviroll" as never;
    expect(payloadSchema.safeParse(p).success).toBe(false);
  });

  it("refuse un identifiant de beat mal formé", () => {
    const p = valid();
    p.variantes[0].beats[0].id = "B 01 Accroche" as never;
    expect(payloadSchema.safeParse(p).success).toBe(false);
  });

  it("refuse une clé inventée (objets stricts)", () => {
    const p = valid() as Record<string, unknown>;
    (p.variantes as Record<string, unknown>[])[0].duree_totale = 720;
    expect(payloadSchema.safeParse(p).success).toBe(false);
  });

  it("refuse un timecode mal formé", () => {
    const p = valid();
    p.variantes[0].beats[0].inserts![0].tc_in = "3:12" as never;
    expect(payloadSchema.safeParse(p).success).toBe(false);
  });

  it("accepte indifféremment null et l'absence sur les champs optionnels", () => {
    const withNull = valid();
    withNull.variantes[0].beats[0].note_realisation = null;
    expect(payloadSchema.safeParse(withNull).success).toBe(true);

    const without = valid();
    delete (without.variantes[0].beats[0] as Record<string, unknown>).note_realisation;
    expect(payloadSchema.safeParse(without).success).toBe(true);
  });

  it("exige au moins une variante et au moins un beat", () => {
    const p = valid();
    p.variantes = [];
    expect(payloadSchema.safeParse(p).success).toBe(false);
  });

  it("produit un JSON-Schema fermé, utilisable dans le brief", () => {
    const js = contractJsonSchema() as Record<string, unknown>;
    expect(js.type).toBe("object");
    expect(JSON.stringify(js)).toContain("schema_version");
    expect(JSON.stringify(js)).toContain("additionalProperties\":false");
    for (const kind of BEAT_KINDS) expect(JSON.stringify(js)).toContain(kind);
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `bun test tests/video-contract.test.ts`
Expected: FAIL — le module `@/lib/video/schema` n'existe pas.

- [ ] **Step 3: Écrire le contrat**

`lib/video/schema.ts` :

```ts
import { z } from "zod";

// LA source unique du module vidéo. Quatre choses en sont dérivées et ne sont jamais réécrites à la
// main : le validateur d'import (lib/video/import.ts), le bloc JSON-Schema du brief
// (lib/video/brief.ts), l'exemple montré au chat, et — au SP1 bis — les schémas d'entrée des outils
// MCP. Écrites séparément, ces quatre-là divergent, et la divergence se manifeste en import
// inexplicablement refusé.
export const SCHEMA_VERSION = "1.0";

export const BEAT_KINDS = [
  "narration", "question", "reponse", "insert", "broll",
  "transition", "texte_ecran", "son", "note",
] as const;
export const PLATFORMS = ["youtube_long", "youtube_short", "tiktok", "reel", "interview"] as const;
export const RATIOS = ["16:9", "9:16", "1:1"] as const;

export const TC_RE = /^\d{2}:\d{2}:\d{2}(\.\d{1,3})?$/;
export const BEAT_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

// `.nullish()` partout sur l'optionnel : un modèle produit indifféremment `null` et l'absence de
// clé, et refuser l'un des deux ferait échouer des payloads sémantiquement identiques.
export const insertPayloadSchema = z.strictObject({
  type: z.enum(["image", "video", "extrait", "graphique", "fichier"]),
  url: z.string().url().max(2048).nullish(),
  tc_in: z.string().regex(TC_RE).nullish(),
  tc_out: z.string().regex(TC_RE).nullish(),
  duree_affichage_sec: z.number().int().min(1).max(600).nullish(),
  credit: z.string().max(200).nullish(),   // optionnel (décision 7)
  droits: z.string().max(500).nullish(),   // optionnel (décision 7)
});

export const beatPayloadSchema = z.strictObject({
  id: z.string().regex(BEAT_ID_RE),
  type: z.enum(BEAT_KINDS),
  texte: z.string().max(5000).nullish(),
  note_realisation: z.string().max(1000).nullish(),
  texte_ecran: z.string().max(300).nullish(),
  transition_entree: z.string().max(120).nullish(),
  transition_sortie: z.string().max(120).nullish(),
  sources: z.array(z.string().url()).max(20).nullish(),
  inserts: z.array(insertPayloadSchema).max(20).nullish(),
});

export const variantPayloadSchema = z.strictObject({
  plateforme: z.enum(PLATFORMS),
  duree_cible_sec: z.number().int().min(5).max(14400).nullish(),
  ratio: z.enum(RATIOS).nullish(),
  beats: z.array(beatPayloadSchema).min(1).max(500),
});

export const payloadSchema = z.strictObject({
  schema_version: z.string().min(1),
  projet: z.strictObject({
    titre: z.string().min(1).max(200),
    sujet: z.string().max(2000).nullish(),
    angle: z.string().max(2000).nullish(),
  }),
  variantes: z.array(variantPayloadSchema).min(1).max(10),
});

export type InsertPayload = z.infer<typeof insertPayloadSchema>;
export type BeatPayload = z.infer<typeof beatPayloadSchema>;
export type VariantPayload = z.infer<typeof variantPayloadSchema>;
export type Payload = z.infer<typeof payloadSchema>;

// Zod 4.4.3 : z.toJSONSchema est natif, aucune dépendance supplémentaire. Le schéma ne contient
// volontairement AUCUN raffinement (les règles inter-champs sont dans lib/video/import.ts), car
// toJSONSchema les ignorerait — elles disparaîtraient silencieusement du contrat envoyé au chat.
export function contractJsonSchema(): object {
  return z.toJSONSchema(payloadSchema);
}

export const EXAMPLE_PAYLOAD: Payload = {
  schema_version: SCHEMA_VERSION,
  projet: {
    titre: "La success story de Babadampulu",
    sujet: "Comment une PME agroalimentaire ivoirienne est devenue exportatrice régionale",
    angle: "Le tournant de 2019 et ce qu'il coûte à répliquer",
  },
  variantes: [
    {
      plateforme: "youtube_long",
      duree_cible_sec: 720,
      ratio: "16:9",
      beats: [
        {
          id: "b-01-accroche",
          type: "narration",
          texte: "En 2019, cette PME vendait dans deux marchés d'Abidjan. Aujourd'hui elle exporte dans six pays.",
          note_realisation: "Plan serré, regard caméra. Débit rapide.",
          texte_ecran: "Abidjan, 2019",
          transition_entree: null,
          transition_sortie: "cut sec",
          sources: ["https://www.agenceecofin.com/exemple-article"],
          inserts: [
            {
              type: "video",
              url: "https://www.youtube.com/watch?v=exemple",
              tc_in: "00:03:12",
              tc_out: "00:03:19",
              duree_affichage_sec: 7,
              credit: "Bloomberg",
              droits: "extrait court, citation",
            },
          ],
        },
        {
          id: "b-02-contexte",
          type: "narration",
          texte: "Pour comprendre ce basculement, il faut regarder trois chiffres.",
          note_realisation: "Plan large.",
          texte_ecran: null,
          transition_entree: null,
          transition_sortie: null,
          sources: [],
          inserts: [
            {
              type: "graphique",
              url: null,
              tc_in: null,
              tc_out: null,
              duree_affichage_sec: 5,
              credit: null,
              droits: null,
            },
          ],
        },
      ],
    },
  ],
};
```

- [ ] **Step 4: Lancer le test et vérifier qu'il passe**

Run: `bun test tests/video-contract.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Inscrire le test dans la lane pure et commiter**

Ajouter `"video-contract.test.ts"` à `PURE_FILES` dans `scripts/test-fast.ts`.

```bash
bun run test:pure
git add lib/video/schema.ts tests/video-contract.test.ts scripts/test-fast.ts
git commit -m "feat(video): contrat JSON dérivé d'un schéma Zod unique"
```

---

### Task 3: Estimation de durée (`lib/video/duration.ts`)

**Files:**
- Create: `lib/video/duration.ts`
- Test: `tests/video-duration.test.ts`

**Interfaces:**
- Consumes: rien
- Produces:
  - `DEFAULT_WPM = 155`
  - `countWords(html: string): number`
  - `estimateSeconds(html: string, wpm?: number): number`
  - `beatSeconds(beat: { spokenText: string; durationOverrideSec: number | null }, wpm?: number): number`
  - `variantSeconds(beats: { spokenText: string; durationOverrideSec: number | null }[], wpm?: number): number`
  - `LONG_BEAT_WORDS = 35`
  - `isBreathRisk(html: string): boolean`

- [ ] **Step 1: Écrire le test qui échoue**

`tests/video-duration.test.ts` :

```ts
import { describe, it, expect } from "bun:test";
import {
  countWords, estimateSeconds, beatSeconds, variantSeconds, isBreathRisk, DEFAULT_WPM,
} from "@/lib/video/duration";

describe("countWords", () => {
  it("compte les mots en ignorant les balises", () => {
    expect(countWords("<p>Trois petits mots</p>")).toBe(3);
  });

  it("ne compte pas les balises comme des mots", () => {
    expect(countWords("<p><strong>Un</strong> <em>deux</em></p>")).toBe(2);
  });

  it("renvoie zéro sur du vide", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("<p></p>")).toBe(0);
  });

  it("décode les entités les plus courantes avant de compter", () => {
    expect(countWords("<p>l&#x27;économie ivoirienne</p>")).toBe(2);
  });
});

describe("estimateSeconds", () => {
  it("convertit à la cadence par défaut, arrondi au supérieur", () => {
    const html = `<p>${Array(155).fill("mot").join(" ")}</p>`;
    expect(estimateSeconds(html)).toBe(60);
  });

  it("respecte une cadence explicite", () => {
    const html = `<p>${Array(100).fill("mot").join(" ")}</p>`;
    expect(estimateSeconds(html, 100)).toBe(60);
  });

  it("arrondit au supérieur plutôt qu'au plus proche", () => {
    expect(estimateSeconds("<p>un mot</p>", 60)).toBe(2);
  });

  it("la cadence par défaut est celle du spec", () => {
    expect(DEFAULT_WPM).toBe(155);
  });
});

describe("beatSeconds", () => {
  it("utilise l'estimation quand aucune durée n'est forcée", () => {
    expect(beatSeconds({ spokenText: `<p>${Array(155).fill("m").join(" ")}</p>`, durationOverrideSec: null })).toBe(60);
  });

  it("la durée forcée l'emporte", () => {
    expect(beatSeconds({ spokenText: `<p>${Array(155).fill("m").join(" ")}</p>`, durationOverrideSec: 12 })).toBe(12);
  });

  it("une durée forcée à zéro l'emporte aussi", () => {
    // Le point : `?? ` et non `|| `, sinon 0 retomberait sur l'estimation.
    expect(beatSeconds({ spokenText: "<p>un mot</p>", durationOverrideSec: 0 })).toBe(0);
  });
});

describe("variantSeconds", () => {
  it("somme les beats", () => {
    expect(variantSeconds([
      { spokenText: "", durationOverrideSec: 10 },
      { spokenText: "", durationOverrideSec: 32 },
    ])).toBe(42);
  });
});

describe("isBreathRisk", () => {
  it("signale un bloc de plus de 35 mots", () => {
    expect(isBreathRisk(`<p>${Array(36).fill("mot").join(" ")}</p>`)).toBe(true);
  });

  it("ne signale pas un bloc court", () => {
    expect(isBreathRisk("<p>une phrase courte</p>")).toBe(false);
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `bun test tests/video-duration.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter**

`lib/video/duration.ts` :

```ts
// Module PUR : ni base, ni réseau, ni DOM. Appelé côté serveur à l'écriture d'un beat (la durée est
// STOCKÉE, pour que la vue montage et les exports du SP2 n'aient rien à recalculer) et côté client
// pour l'affichage vivant du cumul.
export const DEFAULT_WPM = 155;      // cadence de lecture française posée par le spec
export const LONG_BEAT_WORDS = 35;   // seuil d'avertissement « souffle »

const ENTITIES: Record<string, string> = {
  "&#x27;": "'", "&#39;": "'", "&apos;": "'", "&quot;": '"',
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&nbsp;": " ",
};

function toText(html: string): string {
  const stripped = html.replace(/<[^>]*>/g, " ");
  return stripped.replace(/&(#x27|#39|apos|quot|amp|lt|gt|nbsp);/g, (m) => ENTITIES[m] ?? m);
}

export function countWords(html: string): number {
  const text = toText(html).trim();
  if (!text) return 0;
  // Une apostrophe ne sépare pas deux mots parlés : « l'économie » se dit d'un souffle et compte
  // pour un. Le découpage se fait donc sur les blancs, pas sur la ponctuation.
  return text.split(/\s+/).filter(Boolean).length;
}

export function estimateSeconds(html: string, wpm: number = DEFAULT_WPM): number {
  const words = countWords(html);
  if (words === 0) return 0;
  return Math.ceil((words / wpm) * 60);
}

type BeatLike = { spokenText: string; durationOverrideSec: number | null };

export function beatSeconds(beat: BeatLike, wpm: number = DEFAULT_WPM): number {
  // `??` et non `||` : une durée forcée à 0 est un choix humain légitime (un beat muet).
  return beat.durationOverrideSec ?? estimateSeconds(beat.spokenText, wpm);
}

export function variantSeconds(beats: BeatLike[], wpm: number = DEFAULT_WPM): number {
  return beats.reduce((sum, b) => sum + beatSeconds(b, wpm), 0);
}

export function isBreathRisk(html: string): boolean {
  return countWords(html) > LONG_BEAT_WORDS;
}
```

- [ ] **Step 4: Lancer le test et vérifier qu'il passe**

Run: `bun test tests/video-duration.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Inscrire dans la lane pure et commiter**

```bash
# ajouter "video-duration.test.ts" à PURE_FILES dans scripts/test-fast.ts
bun run test:pure
git add lib/video/duration.ts tests/video-duration.test.ts scripts/test-fast.ts
git commit -m "feat(video): estimation de durée parlée à partir du texte des beats"
```

---

### Task 4: Import — couche tolérante et validation stricte

**Files:**
- Create: `lib/video/import.ts`
- Test: `tests/video-import-parse.test.ts`

**Interfaces:**
- Consumes: `payloadSchema`, `SCHEMA_VERSION`, `TC_RE`, `Payload` de `@/lib/video/schema`
- Produces:
  - `type Issue = { path: string; message: string; received?: unknown }`
  - `type ParseResult = { ok: true; payload: Payload } | { ok: false; issues: Issue[] }`
  - `stripEnvelope(raw: string): string`
  - `parseIncoming(raw: string | unknown): ParseResult`

- [ ] **Step 1: Écrire le test qui échoue**

`tests/video-import-parse.test.ts` :

```ts
import { describe, it, expect } from "bun:test";
import { stripEnvelope, parseIncoming } from "@/lib/video/import";
import { EXAMPLE_PAYLOAD } from "@/lib/video/schema";

const json = () => JSON.stringify(EXAMPLE_PAYLOAD);

describe("stripEnvelope", () => {
  it("retire les balises de code", () => {
    expect(stripEnvelope("```json\n{\"a\":1}\n```")).toBe("{\"a\":1}");
  });

  it("retire des balises sans langage", () => {
    expect(stripEnvelope("```\n{\"a\":1}\n```")).toBe("{\"a\":1}");
  });

  it("retire le BOM", () => {
    expect(stripEnvelope("﻿{\"a\":1}")).toBe("{\"a\":1}");
  });

  it("retire le bavardage avant et après l'objet", () => {
    expect(stripEnvelope("Voici le script :\n{\"a\":1}\nJ'espère que ça convient !")).toBe("{\"a\":1}");
  });

  it("laisse intact un JSON déjà propre", () => {
    expect(stripEnvelope("{\"a\":1}")).toBe("{\"a\":1}");
  });
});

describe("parseIncoming", () => {
  it("accepte un payload de référence", () => {
    const r = parseIncoming(json());
    expect(r.ok).toBe(true);
  });

  it("accepte un objet déjà désérialisé (chemin MCP)", () => {
    const r = parseIncoming(EXAMPLE_PAYLOAD);
    expect(r.ok).toBe(true);
  });

  it("accepte un payload enveloppé de balises et de bavardage", () => {
    expect(parseIncoming("Bien sûr !\n```json\n" + json() + "\n```").ok).toBe(true);
  });

  it("refuse un JSON syntaxiquement invalide, en français", () => {
    const r = parseIncoming("{ pas du json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0].message).toContain("JSON");
  });

  it("refuse une majeure de schéma inconnue", () => {
    const p = structuredClone(EXAMPLE_PAYLOAD);
    p.schema_version = "2.0";
    const r = parseIncoming(JSON.stringify(p));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0].path).toBe("schema_version");
  });

  it("accepte une mineure inconnue de la même majeure", () => {
    const p = structuredClone(EXAMPLE_PAYLOAD);
    p.schema_version = "1.7";
    expect(parseIncoming(JSON.stringify(p)).ok).toBe(true);
  });

  it("rapporte le chemin exact d'une erreur de champ", () => {
    const p = structuredClone(EXAMPLE_PAYLOAD);
    p.variantes[0].beats[0].type = "bviroll" as never;
    const r = parseIncoming(JSON.stringify(p));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.some((i) => i.path === "variantes[0].beats[0].type")).toBe(true);
      expect(r.issues.some((i) => i.received === "bviroll")).toBe(true);
    }
  });

  it("refuse des identifiants de beat dupliqués dans une variante", () => {
    const p = structuredClone(EXAMPLE_PAYLOAD);
    p.variantes[0].beats[1].id = p.variantes[0].beats[0].id;
    const r = parseIncoming(JSON.stringify(p));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0].message).toContain("dupliqué");
  });

  it("refuse un tc_out antérieur ou égal au tc_in", () => {
    const p = structuredClone(EXAMPLE_PAYLOAD);
    p.variantes[0].beats[0].inserts![0].tc_out = "00:03:12";
    const r = parseIncoming(JSON.stringify(p));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0].path).toContain("tc_out");
  });

  it("n'accepte aucun payload partiellement valide", () => {
    const p = structuredClone(EXAMPLE_PAYLOAD);
    p.variantes[0].beats[1].id = "ID INVALIDE" as never;
    const r = parseIncoming(JSON.stringify(p));
    expect(r.ok).toBe(false); // le beat 0 est bon, ça ne suffit pas
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `bun test tests/video-import-parse.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter la couche tolérante puis la couche stricte**

`lib/video/import.ts` (début du fichier ; la fusion est ajoutée en Task 5) :

```ts
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

  const parsed = payloadSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        path: formatPath(i.path),
        message: i.message,
        received: "received" in i ? (i as { received?: unknown }).received : undefined,
      })),
    };
  }

  const semantic = semanticIssues(parsed.data);
  if (semantic.length > 0) return { ok: false, issues: semantic };

  return { ok: true, payload: parsed.data };
}
```

- [ ] **Step 4: Lancer le test et vérifier qu'il passe**

Run: `bun test tests/video-import-parse.test.ts`
Expected: PASS (16 tests)

- [ ] **Step 5: Inscrire dans la lane pure et commiter**

```bash
# ajouter "video-import-parse.test.ts" à PURE_FILES dans scripts/test-fast.ts
bun run test:pure
git add lib/video/import.ts tests/video-import-parse.test.ts scripts/test-fast.ts
git commit -m "feat(video): import tolérant en entrée, strict en validation"
```

---

### Task 5: Import — fusion à trois voies

**Files:**
- Modify: `lib/video/import.ts` (ajout en fin de fichier)
- Test: `tests/video-import-merge.test.ts`

**Interfaces:**
- Consumes: `Payload`, `BeatPayload` de `@/lib/video/schema` ; `Issue` de ce même fichier
- Produces:
  - `type BeatSnapshot` — la forme normalisée d'un beat, identique côté base et côté payload
  - `type BeatRow = { externalId: string; position: number; snapshot: BeatSnapshot; importedSnapshot: BeatSnapshot | null }`
  - `type BeatChange = { externalId: string; kind: "ajout" | "modification"; fields: string[]; next: BeatSnapshot; position: number }`
  - `type BeatConflict = { externalId: string; fields: string[]; base: BeatSnapshot | null; ours: BeatSnapshot; theirs: BeatSnapshot; position: number }`
  - `type Diff = { added: BeatChange[]; modified: BeatChange[]; conflicts: BeatConflict[]; removed: { externalId: string }[]; order: string[] }`
  - `type Selection = { accept: string[] }` — les `externalId` retenus par l'humain
  - `type Mutations = { create: BeatRow[]; update: { externalId: string; snapshot: BeatSnapshot }[]; remove: string[]; order: string[] }`
  - `toSnapshot(beat: BeatPayload): BeatSnapshot`
  - `MERGE_FIELDS: readonly string[]`
  - `computeMerge(current: BeatRow[], next: BeatPayload[]): Diff`
  - `applyMerge(diff: Diff, selection: Selection): Mutations`

- [ ] **Step 1: Écrire le test qui échoue**

`tests/video-import-merge.test.ts` :

```ts
import { describe, it, expect } from "bun:test";
import { toSnapshot, computeMerge, applyMerge, type BeatRow } from "@/lib/video/import";
import type { BeatPayload } from "@/lib/video/schema";

function beat(id: string, over: Partial<BeatPayload> = {}): BeatPayload {
  return {
    id, type: "narration", texte: `texte de ${id}`, note_realisation: null, texte_ecran: null,
    transition_entree: null, transition_sortie: null, sources: [], inserts: [], ...over,
  } as BeatPayload;
}

// Une ligne « propre » : ce que l'import précédent a posé, jamais retouché par l'humain.
function row(id: string, position: number, over: Partial<BeatPayload> = {}): BeatRow {
  const snap = toSnapshot(beat(id, over));
  return { externalId: id, position, snapshot: snap, importedSnapshot: snap };
}

describe("computeMerge", () => {
  it("classe un beat inconnu en ajout", () => {
    const d = computeMerge([row("b-01", 0)], [beat("b-01"), beat("b-02")]);
    expect(d.added.map((a) => a.externalId)).toEqual(["b-02"]);
  });

  it("classe en modification un beat que seul Claude a changé", () => {
    const d = computeMerge([row("b-01", 0)], [beat("b-01", { texte: "nouveau texte" })]);
    expect(d.modified.map((m) => m.externalId)).toEqual(["b-01"]);
    expect(d.modified[0].fields).toContain("spokenText");
  });

  it("ne signale pas un beat inchangé", () => {
    const d = computeMerge([row("b-01", 0)], [beat("b-01")]);
    expect(d.modified).toEqual([]);
    expect(d.added).toEqual([]);
    expect(d.conflicts).toEqual([]);
  });

  it("fusionne des champs disjoints sans conflit", () => {
    const r = row("b-01", 0);
    r.snapshot = { ...r.snapshot, screenText: "posé à la main" }; // édition locale
    const d = computeMerge([r], [beat("b-01", { texte: "réécrit par Claude" })]);
    expect(d.conflicts).toEqual([]);
    expect(d.modified[0].next.screenText).toBe("posé à la main");
    expect(d.modified[0].next.spokenText).toBe("réécrit par Claude");
  });

  it("signale un conflit quand les deux ont touché le MÊME champ", () => {
    const r = row("b-01", 0);
    r.snapshot = { ...r.snapshot, spokenText: "ma version" };
    const d = computeMerge([r], [beat("b-01", { texte: "sa version" })]);
    expect(d.modified).toEqual([]);
    expect(d.conflicts).toHaveLength(1);
    expect(d.conflicts[0].fields).toEqual(["spokenText"]);
    expect(d.conflicts[0].ours.spokenText).toBe("ma version");
    expect(d.conflicts[0].theirs.spokenText).toBe("sa version");
  });

  it("classe en suppression un beat absent du payload", () => {
    const d = computeMerge([row("b-01", 0), row("b-02", 1)], [beat("b-01")]);
    expect(d.removed).toEqual([{ externalId: "b-02" }]);
  });

  it("l'ordre suit le payload", () => {
    const d = computeMerge([row("b-01", 0), row("b-02", 1)], [beat("b-02"), beat("b-01")]);
    expect(d.order).toEqual(["b-02", "b-01"]);
  });

  it("un beat jamais importé (créé à la main) sans base n'est pas écrasé en silence", () => {
    const r: BeatRow = { externalId: "b-99", position: 0, snapshot: toSnapshot(beat("b-99", { texte: "à moi" })), importedSnapshot: null };
    const d = computeMerge([r], [beat("b-99", { texte: "à lui" })]);
    expect(d.conflicts).toHaveLength(1);
  });
});

describe("applyMerge", () => {
  it("n'applique que ce qui est retenu", () => {
    const d = computeMerge([row("b-01", 0)], [beat("b-01", { texte: "nouveau" }), beat("b-02")]);
    const m = applyMerge(d, { accept: ["b-02"] });
    expect(m.create.map((c) => c.externalId)).toEqual(["b-02"]);
    expect(m.update).toEqual([]);
  });

  it("une suppression non retenue n'efface rien", () => {
    const d = computeMerge([row("b-01", 0), row("b-02", 1)], [beat("b-01")]);
    const m = applyMerge(d, { accept: [] });
    expect(m.remove).toEqual([]);
  });

  it("une suppression retenue efface", () => {
    const d = computeMerge([row("b-01", 0), row("b-02", 1)], [beat("b-01")]);
    const m = applyMerge(d, { accept: ["b-02"] });
    expect(m.remove).toEqual(["b-02"]);
  });

  it("un conflit retenu applique la version de Claude", () => {
    const r = row("b-01", 0);
    r.snapshot = { ...r.snapshot, spokenText: "ma version" };
    const d = computeMerge([r], [beat("b-01", { texte: "sa version" })]);
    const m = applyMerge(d, { accept: ["b-01"] });
    expect(m.update[0].snapshot.spokenText).toBe("sa version");
  });

  it("l'ordre final ne contient que les beats qui survivent", () => {
    const d = computeMerge([row("b-01", 0), row("b-02", 1)], [beat("b-02"), beat("b-03")]);
    const m = applyMerge(d, { accept: ["b-03", "b-02"] }); // b-01 supprimé mais NON retenu
    expect(m.order).toEqual(["b-02", "b-03", "b-01"]);
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `bun test tests/video-import-merge.test.ts`
Expected: FAIL — `toSnapshot` n'est pas exporté.

- [ ] **Step 3: Implémenter la fusion**

À ajouter à `lib/video/import.ts` :

```ts
import type { BeatPayload } from "@/lib/video/schema";

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

export function toSnapshot(beat: BeatPayload): BeatSnapshot {
  return {
    kind: beat.type,
    spokenText: beat.texte ?? "",
    directionNote: beat.note_realisation ?? null,
    screenText: beat.texte_ecran ?? null,
    transitionIn: beat.transition_entree ?? null,
    transitionOut: beat.transition_sortie ?? null,
    sources: beat.sources ?? [],
    inserts: beat.inserts ?? [],
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
    const theirChanged = MERGE_FIELDS.filter((f) => !base || differs(theirs[f], base[f]));
    const ourChanged = MERGE_FIELDS.filter((f) => !base || differs(ours[f], base[f]));
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
    ...diff.conflicts.filter((c) => accepted.has(c.externalId)).map((c) => ({ externalId: c.externalId, snapshot: c.theirs })),
  ];

  const remove = diff.removed.filter((r) => accepted.has(r.externalId)).map((r) => r.externalId);

  // L'ordre du payload d'abord, puis les rescapés d'une suppression refusée, dans leur ordre actuel.
  const removedButKept = diff.removed.filter((r) => !accepted.has(r.externalId)).map((r) => r.externalId);
  const droppedAdds = new Set(diff.added.filter((a) => !accepted.has(a.externalId)).map((a) => a.externalId));
  const order = [...diff.order.filter((id) => !droppedAdds.has(id)), ...removedButKept];

  return { create, update, remove, order };
}
```

- [ ] **Step 4: Lancer le test et vérifier qu'il passe**

Run: `bun test tests/video-import-merge.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Inscrire dans la lane pure et commiter**

```bash
# ajouter "video-import-merge.test.ts" à PURE_FILES dans scripts/test-fast.ts
bun run test:pure
git add lib/video/import.ts tests/video-import-merge.test.ts scripts/test-fast.ts
git commit -m "feat(video): fusion à trois voies des beats au ré-import"
```

---

### Task 6: Le brief (`lib/video/brief.ts`)

**Files:**
- Create: `lib/video/brief.ts`
- Test: `tests/video-brief.test.ts`

**Interfaces:**
- Consumes: `contractJsonSchema`, `EXAMPLE_PAYLOAD`, `SCHEMA_VERSION` de `@/lib/video/schema`
- Produces:
  - `DEFAULT_BRIEF_TEMPLATE: string`
  - `type BriefVars = { titre: string; sujet: string; plateforme: string; duree_cible: string; ratio: string; article_titre: string; article_url: string; article_extrait: string }`
  - `renderTemplate(template: string, vars: BriefVars): { text: string; unknown: string[] }`
  - `contractBlock(): string`
  - `buildBrief(template: string, vars: BriefVars): { text: string; unknown: string[] }`

- [ ] **Step 1: Écrire le test qui échoue**

`tests/video-brief.test.ts` :

```ts
import { describe, it, expect } from "bun:test";
import { renderTemplate, contractBlock, buildBrief, DEFAULT_BRIEF_TEMPLATE, type BriefVars } from "@/lib/video/brief";
import { payloadSchema, SCHEMA_VERSION } from "@/lib/video/schema";

const VARS: BriefVars = {
  titre: "La success story de Babadampulu",
  sujet: "PME agroalimentaire devenue exportatrice",
  plateforme: "YouTube long",
  duree_cible: "12 min",
  ratio: "16:9",
  article_titre: "", article_url: "", article_extrait: "",
};

describe("renderTemplate", () => {
  it("interpole les variables connues", () => {
    const r = renderTemplate("Sujet : {{titre}}", VARS);
    expect(r.text).toBe("Sujet : La success story de Babadampulu");
    expect(r.unknown).toEqual([]);
  });

  it("laisse une variable inconnue telle quelle et la signale", () => {
    // La remplacer par du vide ferait disparaître une faute de frappe dans un prompt qu'on colle
    // sans le relire.
    const r = renderTemplate("Ton : {{tonalite}}", VARS);
    expect(r.text).toBe("Ton : {{tonalite}}");
    expect(r.unknown).toEqual(["tonalite"]);
  });

  it("ne signale qu'une fois une variable inconnue répétée", () => {
    expect(renderTemplate("{{x}} et {{x}}", VARS).unknown).toEqual(["x"]);
  });
});

describe("contractBlock", () => {
  it("contient le JSON-Schema, l'exemple et la version", () => {
    const block = contractBlock();
    expect(block).toContain("schema_version");
    expect(block).toContain(SCHEMA_VERSION);
    expect(block).toContain("b-01-accroche");
  });

  it("énonce les règles dures, y compris la stabilité des identifiants", () => {
    const block = contractBlock();
    expect(block).toContain("uniquement");   // « réponds uniquement par un objet JSON »
    expect(block).toContain("identiques");   // « conserve les id à l'identique »
  });

  it("énonce les règles inter-champs absentes du JSON-Schema", () => {
    const block = contractBlock();
    expect(block).toContain("tc_out");
    expect(block).toContain("unique");
  });

  it("l'exemple inclus est valide au regard du schéma", () => {
    // Le point : le brief ne peut pas montrer au chat un exemple que l'import refuserait.
    const start = contractBlock().indexOf("{\n  \"schema_version\"");
    const example = contractBlock().slice(start, contractBlock().lastIndexOf("}") + 1);
    expect(payloadSchema.safeParse(JSON.parse(example)).success).toBe(true);
  });
});

describe("buildBrief", () => {
  it("concatène style maison, recherche et contrat, dans cet ordre", () => {
    const r = buildBrief(DEFAULT_BRIEF_TEMPLATE, VARS);
    const styleAt = r.text.indexOf("Babadampulu");
    const contractAt = r.text.indexOf("schema_version");
    expect(styleAt).toBeGreaterThan(-1);
    expect(contractAt).toBeGreaterThan(styleAt);
  });

  it("remonte les variables inconnues du modèle", () => {
    expect(buildBrief("Ton : {{inexistante}}", VARS).unknown).toEqual(["inexistante"]);
  });

  it("le modèle par défaut n'a aucune variable inconnue", () => {
    expect(buildBrief(DEFAULT_BRIEF_TEMPLATE, VARS).unknown).toEqual([]);
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `bun test tests/video-brief.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter**

`lib/video/brief.ts` :

```ts
import { contractJsonSchema, EXAMPLE_PAYLOAD, SCHEMA_VERSION } from "@/lib/video/schema";

// Le brief se colle dans un chat Claude. Trois blocs : le style maison (éditable en Réglages), les
// instructions de recherche (code), le contrat (code, NON modifiable — c'est lui qui garantit que
// l'import fonctionne).
export type BriefVars = {
  titre: string; sujet: string; plateforme: string; duree_cible: string; ratio: string;
  article_titre: string; article_url: string; article_extrait: string;
};

export const DEFAULT_BRIEF_TEMPLATE = `Tu m'aides à écrire le script d'une vidéo pour Afrotiative Media.

Sujet : {{titre}}
Angle : {{sujet}}
Format : {{plateforme}}, durée cible {{duree_cible}}, cadrage {{ratio}}
Article de référence : {{article_titre}} {{article_url}}

Ligne éditoriale : business et finance panafricains francophones. Ton posé, factuel, jamais
sensationnaliste. Le premier beat doit donner une raison concrète de rester ; pas de formule
d'accroche creuse. Phrases courtes, écrites pour être DITES à voix haute, pas lues.

{{article_extrait}}`;

const RESEARCH_BLOCK = `## Recherche attendue

Avant d'écrire, cherche sur Internet :
- les faits, dates et chiffres du sujet, avec pour chacun l'URL de la source ;
- des images et des extraits vidéo réutilisables pour illustrer chaque section — donne l'URL exacte,
  et pour une vidéo les timecodes de début et de fin du passage utile ;
- le crédit à afficher pour chaque média, quand il est connu.

Rattache chaque affirmation chiffrée à une source dans le champ \`sources\` du beat concerné.`;

/**
 * Interpolation `{{cle}}`. Une variable inconnue est LAISSÉE TELLE QUELLE et remontée à l'appelant :
 * la remplacer par du vide ferait disparaître une faute de frappe dans un prompt qu'on colle sans
 * le relire.
 */
export function renderTemplate(template: string, vars: BriefVars): { text: string; unknown: string[] } {
  const unknown: string[] = [];
  const text = template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (match, key: string) => {
    if (key in vars) return String(vars[key as keyof BriefVars] ?? "");
    if (!unknown.includes(key)) unknown.push(key);
    return match;
  });
  return { text, unknown };
}

export function contractBlock(): string {
  return `## Format de réponse — impératif

Réponds **uniquement** par un objet JSON, sans texte avant ni après, sans balises de code.

Règles dures :
- \`schema_version\` vaut "${SCHEMA_VERSION}".
- Chaque beat porte un \`id\` stable, en minuscules, de la forme \`b-01-accroche\`. Ces identifiants
  doivent rester **identiques** d'une génération à l'autre pour un même script : c'est ce qui permet
  de fusionner tes corrections sans écraser le travail déjà fait.
- Ne réutilise jamais un \`id\` pour un autre beat. Un \`id\` est **unique** dans une variante.
- Pour un insert vidéo, \`tc_out\` doit être postérieur à \`tc_in\`.
- N'invente aucune clé : toute clé absente du schéma fait échouer l'import.

### Schéma JSON

\`\`\`json
${JSON.stringify(contractJsonSchema(), null, 2)}
\`\`\`

### Exemple complet et valide

${JSON.stringify(EXAMPLE_PAYLOAD, null, 2)}`;
}

export function buildBrief(template: string, vars: BriefVars): { text: string; unknown: string[] } {
  const rendered = renderTemplate(template, vars);
  return { text: `${rendered.text}\n\n${RESEARCH_BLOCK}\n\n${contractBlock()}`, unknown: rendered.unknown };
}
```

- [ ] **Step 4: Lancer le test et vérifier qu'il passe**

Run: `bun test tests/video-brief.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Inscrire dans la lane pure et commiter**

```bash
# ajouter "video-brief.test.ts" à PURE_FILES dans scripts/test-fast.ts
bun run test:pure
git add lib/video/brief.ts tests/video-brief.test.ts scripts/test-fast.ts
git commit -m "feat(video): génération du brief à coller dans le chat"
```

---

### Task 7: RBAC et navigation

**Files:**
- Modify: `lib/permissions.ts`, `lib/rbac.ts:6-26`, `components/shell/nav-items.ts:1` et `:44-86`
- Test: `tests/video-rbac-nav.test.ts`

**Interfaces:**
- Consumes: rien
- Produces: ressource `video` avec les actions `read` / `manage` dans `can()` ; une section de navigation `video`.

Les trois rôles existants ont accès au module (le rôle `Monteur` arrive au SP2). `journalist` obtient `read` + `manage` : c'est lui qui écrit les vidéos.

- [ ] **Step 1: Écrire le test qui échoue**

`tests/video-rbac-nav.test.ts` :

```ts
import { describe, it, expect } from "bun:test";
import { can } from "@/lib/rbac";
import { visibleNavSections, ROUTE_LABELS, deriveCrumbs } from "@/components/shell/nav-items";

describe("droits vidéo", () => {
  it("les trois rôles peuvent lire et écrire des scripts", () => {
    for (const role of ["admin", "editor", "journalist"] as const) {
      expect(can(role, "video", "read")).toBe(true);
      expect(can(role, "video", "manage")).toBe(true);
    }
  });

  it("une action inconnue reste refusée", () => {
    expect(can("journalist", "video", "publish")).toBe(false);
  });
});

describe("navigation vidéo", () => {
  it("la section apparaît pour les trois rôles", () => {
    for (const role of ["admin", "editor", "journalist"] as const) {
      const ids = visibleNavSections(role).map((s) => s.id);
      expect(ids).toContain("video");
    }
  });

  it("le fil d'Ariane connaît /video", () => {
    expect(ROUTE_LABELS["/video"]).toBe("Vidéos");
    expect(deriveCrumbs("/video/6f1c2f7e-0000-4000-8000-000000000000")).toEqual([
      { href: "/video", label: "Vidéos" },
    ]);
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `bun test tests/video-rbac-nav.test.ts`
Expected: FAIL — `can(role, "video", "read")` renvoie `false`.

- [ ] **Step 3: Ajouter la ressource et la section**

Dans `lib/permissions.ts`, ajouter `video: ["read", "manage"]` au `statement`, puis `video: ["read", "manage"]` dans chacun des trois rôles `journalist` / `editor` / `admin`.

Dans `lib/rbac.ts`, ajouter `video: ["read", "manage"]` aux trois entrées de `MATRIX`.

Dans `components/shell/nav-items.ts`, importer `Clapperboard` depuis `lucide-react` et insérer la section **après** `studio` :

```ts
  {
    id: "video",
    label: "Vidéo",
    items: [
      // SP1 : l'écriture se fait en amont dans un chat Claude ; cette entrée mène à l'espace qui
      // produit le brief et importe la réponse.
      { href: "/video", label: "Vidéos", icon: Clapperboard },
    ],
  },
```

`ROUTE_LABELS` et `deriveCrumbs` sont dérivés de `NAV_ITEMS` — rien d'autre à modifier.

- [ ] **Step 4: Lancer le test et vérifier qu'il passe**

Run: `bun test tests/video-rbac-nav.test.ts tests/rbac.test.ts tests/nav-sections.test.ts tests/shell-nav.test.ts`
Expected: PASS — y compris les tests de navigation existants, qui ne doivent pas régresser.

- [ ] **Step 5: Inscrire dans la lane pure et commiter**

```bash
# ajouter "video-rbac-nav.test.ts" à PURE_FILES dans scripts/test-fast.ts
bun run test:pure
git add lib/permissions.ts lib/rbac.ts components/shell/nav-items.ts tests/video-rbac-nav.test.ts scripts/test-fast.ts
git commit -m "feat(video): droits et entrée de navigation du module vidéo"
```

---

### Task 8: Réglages vidéo (modèle de brief, cadence)

**Files:**
- Create: `lib/queries/video-settings.ts`, `lib/actions/video-settings-actions.ts`, `app/(app)/settings/video/page.tsx`, `components/video/video-settings-form.tsx`
- Modify: `db/seed.ts`, `components/shell/nav-items.ts:18-31` (`SETTINGS_CHILDREN`)
- Test: `tests/video-settings.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_BRIEF_TEMPLATE` de `@/lib/video/brief` ; `videoSettings` de `@/db`
- Produces:
  - `getVideoSettings(): Promise<{ briefTemplate: string; wordsPerMinute: number }>` (`lib/queries/video-settings.ts`) — crée la ligne unique à la volée si absente
  - `saveVideoSettings(input: { briefTemplate: string; wordsPerMinute: number })` (server action)
  - `videoSettingsSchema` dans `lib/validation.ts`

- [ ] **Step 1: Écrire le test qui échoue**

`tests/video-settings.test.ts` :

```ts
import { describe, it, expect } from "bun:test";
import { videoSettingsSchema } from "@/lib/validation";
import { DEFAULT_BRIEF_TEMPLATE, buildBrief } from "@/lib/video/brief";

describe("videoSettingsSchema", () => {
  it("accepte des réglages plausibles", () => {
    expect(videoSettingsSchema.safeParse({ briefTemplate: "Bonjour", wordsPerMinute: 155 }).success).toBe(true);
  });

  it("refuse un modèle vide", () => {
    expect(videoSettingsSchema.safeParse({ briefTemplate: "", wordsPerMinute: 155 }).success).toBe(false);
  });

  it("refuse une cadence hors bornes", () => {
    expect(videoSettingsSchema.safeParse({ briefTemplate: "x", wordsPerMinute: 20 }).success).toBe(false);
    expect(videoSettingsSchema.safeParse({ briefTemplate: "x", wordsPerMinute: 500 }).success).toBe(false);
  });
});

describe("modèle par défaut", () => {
  it("produit un brief exploitable sans aucune variable inconnue", () => {
    const r = buildBrief(DEFAULT_BRIEF_TEMPLATE, {
      titre: "T", sujet: "S", plateforme: "YouTube long", duree_cible: "12 min", ratio: "16:9",
      article_titre: "", article_url: "", article_extrait: "",
    });
    expect(r.unknown).toEqual([]);
    expect(r.text).toContain("schema_version");
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `bun test tests/video-settings.test.ts`
Expected: FAIL — `videoSettingsSchema` n'est pas exporté par `@/lib/validation`.

- [ ] **Step 3: Ajouter le schéma, la requête, l'action et l'écran**

Dans `lib/validation.ts` :

```ts
export const videoSettingsSchema = z.object({
  briefTemplate: z.string().min(1, "Le modèle de brief ne peut pas être vide").max(20000),
  // Bornes larges mais réelles : sous 60 mots/min on ne parle plus, au-dessus de 400 on n'articule
  // plus. Hors de là, c'est une saisie erronée, pas un choix.
  wordsPerMinute: z.number().int().min(60, "Cadence trop basse").max(400, "Cadence trop élevée"),
});
export type VideoSettingsInput = z.infer<typeof videoSettingsSchema>;
```

`lib/queries/video-settings.ts` :

```ts
import { db, videoSettings } from "@/db";
import { DEFAULT_BRIEF_TEMPLATE } from "@/lib/video/brief";
import { DEFAULT_WPM } from "@/lib/video/duration";

// Ligne unique, créée à la volée : le module reste utilisable sur une base non semée (déploiement
// neuf, base de test), sans exiger une étape de seed préalable.
export async function getVideoSettings(): Promise<{ briefTemplate: string; wordsPerMinute: number }> {
  const rows = await db.select().from(videoSettings).limit(1);
  if (rows[0]) return { briefTemplate: rows[0].briefTemplate, wordsPerMinute: rows[0].wordsPerMinute };
  const [created] = await db
    .insert(videoSettings)
    .values({ briefTemplate: DEFAULT_BRIEF_TEMPLATE, wordsPerMinute: DEFAULT_WPM })
    .returning();
  return { briefTemplate: created.briefTemplate, wordsPerMinute: created.wordsPerMinute };
}
```

`lib/actions/video-settings-actions.ts` — motif de `lib/actions/taxonomy-actions.ts` :

```ts
"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { videoSettingsSchema, type VideoSettingsInput } from "@/lib/validation";

async function guard() {
  const u = await requireUser();
  requirePermission(u.role, "video", "manage");
  return u;
}

export async function saveVideoSettings(input: VideoSettingsInput): Promise<{ ok: true } | { ok: false; message: string }> {
  const u = await guard();
  const parsed = videoSettingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, message: parsed.error.issues[0].message };

  const { db, videoSettings } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const rows = await db.select({ id: videoSettings.id }).from(videoSettings).limit(1);
  if (rows[0]) {
    await db.update(videoSettings)
      .set({ ...parsed.data, updatedAt: new Date(), updatedBy: u.id })
      .where(eq(videoSettings.id, rows[0].id));
  } else {
    await db.insert(videoSettings).values({ ...parsed.data, updatedBy: u.id });
  }
  revalidatePath("/settings/video");
  return { ok: true as const };
}
```

`app/(app)/settings/video/page.tsx` : RSC qui appelle `requireUser()`, `requirePermission(user.role, "video", "manage")`, `getVideoSettings()`, et rend `<VideoSettingsForm …/>`.
`components/video/video-settings-form.tsx` : Client Component — un `Textarea` pour `briefTemplate`, un `Input type="number"` pour `wordsPerMinute`, bouton « Enregistrer » appelant `saveVideoSettings`. Aide sous le champ listant les variables disponibles : `{{titre}}`, `{{sujet}}`, `{{plateforme}}`, `{{duree_cible}}`, `{{ratio}}`, `{{article_titre}}`, `{{article_url}}`, `{{article_extrait}}`.

Dans `components/shell/nav-items.ts`, ajouter à `SETTINGS_CHILDREN` :

```ts
  { href: "/settings/video", label: "Vidéo", roles: ["admin", "editor"] },
```

Dans `db/seed.ts`, semer la ligne `videoSettings` avec `DEFAULT_BRIEF_TEMPLATE` et `DEFAULT_WPM` si la table est vide.

- [ ] **Step 4: Lancer les tests**

Run: `bun test tests/video-settings.test.ts && bun run typecheck`
Expected: PASS (5 tests), typecheck sans erreur.

- [ ] **Step 5: Appliquer la migration et vérifier l'écran**

Run: `bun run db:migrate`
Puis démarrer `bun run dev`, ouvrir `/settings/video`, modifier la cadence, enregistrer, recharger : la valeur persiste.

- [ ] **Step 6: Inscrire dans la lane pure et commiter**

```bash
# ajouter "video-settings.test.ts" à PURE_FILES dans scripts/test-fast.ts
bun run test:pure
git add lib/validation.ts lib/queries/video-settings.ts lib/actions/video-settings-actions.ts \
        app/\(app\)/settings/video components/video/video-settings-form.tsx \
        components/shell/nav-items.ts db/seed.ts tests/video-settings.test.ts scripts/test-fast.ts
git commit -m "feat(video): réglages du module vidéo (modèle de brief, cadence de lecture)"
```

---

### Task 9: Requêtes et actions de projet

**Files:**
- Create: `lib/queries/video.ts`, `lib/actions/video-actions.ts`
- Modify: `lib/validation.ts`
- Test: `tests/video-actions.test.ts` (**lane DB** — n'est PAS ajouté à `PURE_FILES`)

**Interfaces:**
- Consumes: `parseIncoming`, `computeMerge`, `applyMerge`, `toSnapshot`, types `Diff` / `Mutations` de `@/lib/video/import` ; `beatSeconds` de `@/lib/video/duration` ; `getVideoSettings` de `@/lib/queries/video-settings` ; `sanitizeArticleHtml` de `@/lib/sanitize`
- Produces:
  - `listVideoProjects()`, `getVideoProject(id)`, `getVariantBeats(variantId)` (`lib/queries/video.ts`)
  - `createVideoProject(input)`, `updateBeat(input)`, `reorderBeats(input)`, `prepareImport(input)`, `applyImport(input)`, `revertJournalEntry(id)` (server actions)
  - `createVideoProjectSchema`, `updateBeatSchema` dans `lib/validation.ts`

Détails de comportement imposés par le spec :
- `updateBeat` pose `locallyEditedAt = now()` et recalcule `estimatedDurationSec` via `beatSeconds` avec la cadence des réglages ; `spokenText` passe par `sanitizeArticleHtml`.
- `prepareImport` **n'écrit rien** hors du journal : elle parse, calcule le diff, journalise (`outcome: "rejete"` si invalide) et renvoie le diff.
- `applyImport` écrit en **une seule transaction** : create / update / remove / réordonnancement, puis `importedSnapshot` mis à jour pour tous les beats touchés, puis `locallyEditedAt = null` sur ces mêmes beats, puis journalise `outcome: "applique"` avec `applied`.
- Concurrence : `applyImport` reçoit le `variantUpdatedAt` sur lequel le diff a été calculé et refuse si la variante a changé depuis (« l'aperçu est périmé, recalculez le diff »).
- Variante absente (spec §8) : si le payload vise une `plateforme` qui n'existe pas encore dans le projet, `prepareImportCore` **crée la variante**, à condition que `plateforme`, `duree_cible_sec` et `ratio` soient tous présents ; sinon elle renvoie une `Issue` sur `variantes[n]` demandant les trois champs.
- `revertJournalEntry` restaure les champs depuis `applied`, et **refuse** si un import postérieur non annulé touche l'un des mêmes `externalId`.

- [ ] **Step 1: Écrire le test qui échoue**

`tests/video-actions.test.ts` — s'appuie sur la vraie base, motif de `tests/article-actions.test.ts` :

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, videoProjects, scriptVariants, scriptBeats, scriptJournal } from "@/db";
import { eq } from "drizzle-orm";
import { EXAMPLE_PAYLOAD } from "@/lib/video/schema";
import { createVideoProjectCore, prepareImportCore, applyImportCore } from "@/lib/video/persist";

let projectId: string;

beforeAll(async () => {
  projectId = await createVideoProjectCore({
    title: "Test — Babadampulu", subject: "sujet", platform: "youtube_long",
    targetDurationSec: 720, aspectRatio: "16:9", articleId: null, userId: null,
  });
});

afterAll(async () => { await db.delete(videoProjects).where(eq(videoProjects.id, projectId)); });

describe("import de bout en bout", () => {
  it("un payload valide produit un diff en ajouts", async () => {
    const variant = (await db.select().from(scriptVariants).where(eq(scriptVariants.projectId, projectId)))[0];
    const r = await prepareImportCore({ projectId, variantId: variant.id, raw: JSON.stringify(EXAMPLE_PAYLOAD), userId: null, source: "copier_coller" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.diff.added).toHaveLength(2);
  });

  it("l'application écrit les beats et l'instantané d'import", async () => {
    const variant = (await db.select().from(scriptVariants).where(eq(scriptVariants.projectId, projectId)))[0];
    const prepared = await prepareImportCore({ projectId, variantId: variant.id, raw: JSON.stringify(EXAMPLE_PAYLOAD), userId: null, source: "copier_coller" });
    if (!prepared.ok) throw new Error("diff attendu");
    await applyImportCore({ journalId: prepared.journalId, variantId: variant.id, accept: ["b-01-accroche", "b-02-contexte"], variantUpdatedAt: variant.updatedAt });

    const beats = await db.select().from(scriptBeats).where(eq(scriptBeats.variantId, variant.id));
    expect(beats).toHaveLength(2);
    expect(beats.every((b) => b.importedSnapshot !== null)).toBe(true);
    expect(beats.find((b) => b.externalId === "b-01-accroche")!.estimatedDurationSec).toBeGreaterThan(0);
  });

  it("un payload invalide est journalisé comme rejeté sans rien écrire", async () => {
    const variant = (await db.select().from(scriptVariants).where(eq(scriptVariants.projectId, projectId)))[0];
    const before = (await db.select().from(scriptBeats).where(eq(scriptBeats.variantId, variant.id))).length;
    const r = await prepareImportCore({ projectId, variantId: variant.id, raw: "{ pas du json", userId: null, source: "copier_coller" });
    expect(r.ok).toBe(false);
    const after = (await db.select().from(scriptBeats).where(eq(scriptBeats.variantId, variant.id))).length;
    expect(after).toBe(before);
    const journal = await db.select().from(scriptJournal).where(eq(scriptJournal.projectId, projectId));
    expect(journal.some((j) => j.outcome === "rejete")).toBe(true);
  });

  it("un diff calculé sur un état périmé est refusé", async () => {
    const variant = (await db.select().from(scriptVariants).where(eq(scriptVariants.projectId, projectId)))[0];
    const prepared = await prepareImportCore({ projectId, variantId: variant.id, raw: JSON.stringify(EXAMPLE_PAYLOAD), userId: null, source: "copier_coller" });
    if (!prepared.ok) throw new Error("diff attendu");
    const stale = new Date(variant.updatedAt.getTime() - 60_000);
    const r = await applyImportCore({ journalId: prepared.journalId, variantId: variant.id, accept: [], variantUpdatedAt: stale });
    expect(r.ok).toBe(false);
  });
});
```

**Note de conception révélée par ce test :** le cœur DB est extrait dans `lib/video/persist.ts`, un module **sans** `"use server"`. Les server actions de `lib/actions/video-actions.ts` l'enveloppent avec le garde RBAC. Même motif que `lib/taxonomy-sync-core.ts` : tout export d'un module `"use server"` est un point d'entrée appelable sans authentification propre, donc le writer brut n'y a pas sa place — et c'est aussi ce qui rendra ce cœur réutilisable par le handler MCP du SP1 bis.

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `bun test tests/video-actions.test.ts`
Expected: FAIL — `@/lib/video/persist` n'existe pas.

- [ ] **Step 3: Écrire le cœur de persistance**

Créer `lib/video/persist.ts` — module **sans** `"use server"` — exportant `createVideoProjectCore`, `prepareImportCore`, `applyImportCore`, `updateBeatCore`, `reorderBeatsCore`, `revertJournalEntryCore`, conformément aux comportements listés en tête de tâche.

`applyImportCore` est la fonction délicate : contrôle de péremption, transaction unique, puis remise à zéro de l'état de fusion. Squelette imposé :

```ts
import { db, scriptVariants, scriptBeats, scriptJournal } from "@/db";
import { and, eq, inArray } from "drizzle-orm";
import { applyMerge, type Diff, type BeatSnapshot } from "@/lib/video/import";
import { beatSeconds } from "@/lib/video/duration";
import { sanitizeArticleHtml } from "@/lib/sanitize";
import { getVideoSettings } from "@/lib/queries/video-settings";

export async function applyImportCore(args: {
  journalId: string; variantId: string; accept: string[]; variantUpdatedAt: Date;
}): Promise<{ ok: true; applied: number } | { ok: false; message: string }> {
  const [variant] = await db.select().from(scriptVariants).where(eq(scriptVariants.id, args.variantId));
  if (!variant) return { ok: false as const, message: "Variante introuvable." };
  // Péremption : le diff a été calculé sur un état qui a bougé depuis. Appliquer quand même
  // écraserait une modification qu'on n'a jamais montrée à l'utilisateur.
  if (variant.updatedAt.getTime() !== args.variantUpdatedAt.getTime()) {
    return { ok: false as const, message: "L'aperçu est périmé — recalculez le diff avant d'appliquer." };
  }

  const [entry] = await db.select().from(scriptJournal).where(eq(scriptJournal.id, args.journalId));
  if (!entry) return { ok: false as const, message: "Entrée de journal introuvable." };

  const { wordsPerMinute } = await getVideoSettings();
  const mutations = applyMerge(entry.diff as unknown as Diff, { accept: args.accept });

  await db.transaction(async (tx) => {
    for (const row of mutations.create) {
      const snapshot = sanitizeSnapshot(row.snapshot);
      await tx.insert(scriptBeats).values({
        variantId: args.variantId, externalId: row.externalId,
        position: mutations.order.indexOf(row.externalId),
        kind: snapshot.kind, spokenText: snapshot.spokenText,
        directionNote: snapshot.directionNote, screenText: snapshot.screenText,
        transitionIn: snapshot.transitionIn, transitionOut: snapshot.transitionOut,
        sources: snapshot.sources,
        estimatedDurationSec: beatSeconds({ spokenText: snapshot.spokenText, durationOverrideSec: null }, wordsPerMinute),
        // L'instantané devient la nouvelle base de fusion, et l'édition locale est remise à zéro :
        // ce beat est désormais exactement ce que le dernier import a posé.
        importedSnapshot: snapshot, locallyEditedAt: null,
      });
      await insertBeatInserts(tx, row.externalId, args.variantId, snapshot.inserts);
    }

    for (const patch of mutations.update) {
      const snapshot = sanitizeSnapshot(patch.snapshot);
      await tx.update(scriptBeats).set({
        kind: snapshot.kind, spokenText: snapshot.spokenText,
        directionNote: snapshot.directionNote, screenText: snapshot.screenText,
        transitionIn: snapshot.transitionIn, transitionOut: snapshot.transitionOut,
        sources: snapshot.sources,
        estimatedDurationSec: beatSeconds({ spokenText: snapshot.spokenText, durationOverrideSec: null }, wordsPerMinute),
        importedSnapshot: snapshot, locallyEditedAt: null, updatedAt: new Date(),
      }).where(and(eq(scriptBeats.variantId, args.variantId), eq(scriptBeats.externalId, patch.externalId)));
      await replaceBeatInserts(tx, patch.externalId, args.variantId, snapshot.inserts);
    }

    if (mutations.remove.length > 0) {
      await tx.delete(scriptBeats).where(and(
        eq(scriptBeats.variantId, args.variantId), inArray(scriptBeats.externalId, mutations.remove),
      ));
    }

    // Réordonnancement APRÈS ajouts et suppressions : l'ordre porte sur les beats survivants.
    for (const [index, externalId] of mutations.order.entries()) {
      await tx.update(scriptBeats).set({ position: index }).where(and(
        eq(scriptBeats.variantId, args.variantId), eq(scriptBeats.externalId, externalId),
      ));
    }

    await tx.update(scriptVariants).set({ updatedAt: new Date() }).where(eq(scriptVariants.id, args.variantId));
    await tx.update(scriptJournal)
      .set({ outcome: "applique", applied: mutations as unknown as Record<string, unknown> })
      .where(eq(scriptJournal.id, args.journalId));
  });

  return { ok: true as const, applied: mutations.create.length + mutations.update.length };
}

// spokenText vient d'un modèle et transite par un éditeur riche — il passe par le même assainisseur
// que le corps d'article (spec §8).
function sanitizeSnapshot(s: BeatSnapshot): BeatSnapshot {
  return { ...s, spokenText: sanitizeArticleHtml(s.spokenText) };
}
```

`insertBeatInserts` / `replaceBeatInserts` sont deux helpers locaux du même fichier : ils écrivent les lignes `beat_inserts` du beat visé (résolu par `variantId` + `externalId`), en remplaçant intégralement l'existant côté `replace`.

- [ ] **Step 4: Écrire les requêtes et les server actions**

`lib/queries/video.ts` : lectures pour les écrans (liste des projets avec durée cumulée, projet + variantes + beats + inserts, historique du journal).

`lib/actions/video-actions.ts` : `"use server"`, `guard()` = `requireUser()` + `requirePermission(u.role, "video", "manage")`, puis délégation au cœur. Ajouter `createVideoProjectSchema` et `updateBeatSchema` à `lib/validation.ts`.

- [ ] **Step 5: Lancer les tests et vérifier qu'ils passent**

Run: `bun test tests/video-actions.test.ts && bun run typecheck`
Expected: PASS (4 tests), typecheck sans erreur.

- [ ] **Step 6: Commit**

```bash
git add lib/video/persist.ts lib/queries/video.ts lib/actions/video-actions.ts lib/validation.ts tests/video-actions.test.ts
git commit -m "feat(video): persistance des projets, des beats et des imports"
```

---

### Task 10: Écran de liste et création de projet

**Files:**
- Create: `app/(app)/video/page.tsx`, `components/video/project-list.tsx`, `components/video/new-project-dialog.tsx`
- Test: `tests/video-project-list.test.ts`

**Interfaces:**
- Consumes: `listVideoProjects` de `@/lib/queries/video` ; `createVideoProject` de `@/lib/actions/video-actions`
- Produces: `ProjectList` (props `{ projects: ProjectRow[] }`), `type ProjectRow = { id: string; title: string; status: string; platforms: string[]; estimatedSec: number; articleTitle: string | null; updatedAt: Date }`

- [ ] **Step 1: Écrire le test qui échoue**

`tests/video-project-list.test.ts`, rendu SSR — motif de `tests/empty-state.test.ts` :

```ts
import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectList, type ProjectRow } from "@/components/video/project-list";

const rows: ProjectRow[] = [{
  id: "6f1c2f7e-0000-4000-8000-000000000000",
  title: "La success story de Babadampulu",
  status: "brouillon",
  platforms: ["youtube_long", "tiktok"],
  estimatedSec: 725,
  articleTitle: "Une PME ivoirienne à l'export",
  updatedAt: new Date("2026-08-16T10:00:00Z"),
}];

describe("ProjectList", () => {
  it("affiche le titre du projet", () => {
    const html = renderToStaticMarkup(React.createElement(ProjectList, { projects: rows }));
    expect(html).toContain("La success story de Babadampulu");
  });

  it("affiche la durée cumulée en minutes et secondes", () => {
    const html = renderToStaticMarkup(React.createElement(ProjectList, { projects: rows }));
    expect(html).toContain("12 min 05 s");
  });

  it("affiche les plateformes en français", () => {
    const html = renderToStaticMarkup(React.createElement(ProjectList, { projects: rows }));
    expect(html).toContain("YouTube long");
    expect(html).toContain("TikTok");
  });

  it("lie vers l'espace du projet", () => {
    const html = renderToStaticMarkup(React.createElement(ProjectList, { projects: rows }));
    expect(html).toContain("/video/6f1c2f7e-0000-4000-8000-000000000000");
  });

  it("montre un état vide explicite quand il n'y a aucun projet", () => {
    const html = renderToStaticMarkup(React.createElement(ProjectList, { projects: [] }));
    expect(html).toContain("Aucune vidéo");
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `bun test tests/video-project-list.test.ts`
Expected: FAIL — composant introuvable.

- [ ] **Step 3: Implémenter la liste, le formatage et l'état vide**

`components/video/project-list.tsx` — Server Component, table shadcn, `EmptyState` du shell pour le cas vide, libellés français des plateformes (`youtube_long` → « YouTube long », `youtube_short` → « Short YouTube », `tiktok` → « TikTok », `reel` → « Reel », `interview` → « Interview »), durée formatée `X min SS s`.

`components/video/new-project-dialog.tsx` — Client Component : titre, sujet/angle, plateforme, durée cible (minutes), ratio, sélecteur d'article optionnel (articles `approved`/`published`). Appelle `createVideoProject` puis redirige vers `/video/[id]`.

`app/(app)/video/page.tsx` — RSC : `requireUser()`, `requirePermission(user.role, "video", "read")`, `listVideoProjects()`, `PageHeader` partagé avec le bouton **+ Nouvelle vidéo**.

- [ ] **Step 4: Lancer le test et vérifier qu'il passe**

Run: `bun test tests/video-project-list.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Vérifier dans le navigateur**

`bun run dev`, ouvrir `/video`, créer un projet, vérifier la redirection et la présence dans la liste.

- [ ] **Step 6: Inscrire dans la lane pure et commiter**

```bash
# ajouter "video-project-list.test.ts" à PURE_FILES dans scripts/test-fast.ts
bun run test:pure
git add app/\(app\)/video/page.tsx components/video tests/video-project-list.test.ts scripts/test-fast.ts
git commit -m "feat(video): liste des projets vidéo et création d'un espace"
```

---

### Task 11: Panneau Brief

**Files:**
- Create: `components/video/brief-panel.tsx`
- Modify: `app/(app)/video/[id]/page.tsx` (créé ici, complété en Task 12)
- Test: `tests/video-brief-panel.test.ts`

**Interfaces:**
- Consumes: `buildBrief`, `type BriefVars` de `@/lib/video/brief` ; `getVideoSettings` de `@/lib/queries/video-settings`
- Produces: `BriefPanel` (props `{ brief: string; unknownVars: string[] }`)

- [ ] **Step 1: Écrire le test qui échoue**

`tests/video-brief-panel.test.ts` :

```ts
import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BriefPanel } from "@/components/video/brief-panel";

describe("BriefPanel", () => {
  it("affiche le brief", () => {
    const html = renderToStaticMarkup(React.createElement(BriefPanel, { brief: "Sujet : Babadampulu", unknownVars: [] }));
    expect(html).toContain("Sujet : Babadampulu");
  });

  it("signale les variables inconnues du modèle", () => {
    const html = renderToStaticMarkup(React.createElement(BriefPanel, { brief: "x", unknownVars: ["tonalite"] }));
    expect(html).toContain("tonalite");
    expect(html).toContain("Variable inconnue");
  });

  it("ne montre aucun avertissement quand le modèle est sain", () => {
    const html = renderToStaticMarkup(React.createElement(BriefPanel, { brief: "x", unknownVars: [] }));
    expect(html).not.toContain("Variable inconnue");
  });

  it("propose de copier le brief", () => {
    const html = renderToStaticMarkup(React.createElement(BriefPanel, { brief: "x", unknownVars: [] }));
    expect(html).toContain("Copier le brief");
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `bun test tests/video-brief-panel.test.ts`
Expected: FAIL — composant introuvable.

- [ ] **Step 3: Implémenter**

`components/video/brief-panel.tsx` — Client Component (bouton de copie via `navigator.clipboard.writeText`), `<pre>` défilant avec le brief, alerte listant les variables inconnues quand il y en a, texte d'aide : « Collez ce brief dans un chat Claude, puis rapportez sa réponse JSON dans l'onglet Importer. »

`app/(app)/video/[id]/page.tsx` — RSC : charge le projet, les réglages, construit `BriefVars` (durée cible formatée en minutes, libellé français de plateforme, champs article vides si aucun article lié), appelle `buildBrief`, rend `BriefPanel` dans un premier onglet.

- [ ] **Step 4: Lancer le test et vérifier qu'il passe**

Run: `bun test tests/video-brief-panel.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Inscrire dans la lane pure et commiter**

```bash
# ajouter "video-brief-panel.test.ts" à PURE_FILES dans scripts/test-fast.ts
bun run test:pure
git add components/video/brief-panel.tsx app/\(app\)/video/\[id\]/page.tsx tests/video-brief-panel.test.ts scripts/test-fast.ts
git commit -m "feat(video): panneau Brief avec copie et avertissement de variables"
```

---

### Task 12: Vue Écriture — liste de beats et inspecteur

**Files:**
- Create: `components/video/beat-list.tsx`, `components/video/beat-inspector.tsx`, `components/video/duration-meter.tsx`
- Modify: `app/(app)/video/[id]/page.tsx`
- Test: `tests/video-beat-list.test.ts`

**Interfaces:**
- Consumes: `beatSeconds`, `variantSeconds`, `isBreathRisk` de `@/lib/video/duration` ; `updateBeat`, `reorderBeats` de `@/lib/actions/video-actions`
- Produces:
  - `type BeatView = { id: string; externalId: string; position: number; kind: string; spokenText: string; directionNote: string | null; screenText: string | null; transitionIn: string | null; transitionOut: string | null; estimatedDurationSec: number; durationOverrideSec: number | null; locallyEdited: boolean; inserts: InsertView[] }`
  - `type InsertView = { id: string; kind: string; url: string | null; tcIn: string | null; tcOut: string | null; displayDurationSec: number | null; credit: string | null; linkStatus: string }`
  - `BeatList` (props `{ beats: BeatView[]; targetDurationSec: number | null }`), `BeatInspector`, `DurationMeter`

- [ ] **Step 1: Écrire le test qui échoue**

`tests/video-beat-list.test.ts` :

```ts
import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BeatList, type BeatView } from "@/components/video/beat-list";
import { DurationMeter } from "@/components/video/duration-meter";

function beat(over: Partial<BeatView> = {}): BeatView {
  return {
    id: "u1", externalId: "b-01-accroche", position: 0, kind: "narration",
    spokenText: "<p>En 2019, cette PME vendait dans deux marchés.</p>",
    directionNote: "Plan serré", screenText: null, transitionIn: null, transitionOut: "cut sec",
    estimatedDurationSec: 4, durationOverrideSec: null, locallyEdited: false, inserts: [], ...over,
  };
}

describe("BeatList", () => {
  it("affiche l'identifiant externe du beat", () => {
    const html = renderToStaticMarkup(React.createElement(BeatList, { beats: [beat()], targetDurationSec: 720 }));
    expect(html).toContain("b-01-accroche");
  });

  it("affiche le texte parlé", () => {
    const html = renderToStaticMarkup(React.createElement(BeatList, { beats: [beat()], targetDurationSec: 720 }));
    expect(html).toContain("cette PME vendait");
  });

  it("marque un beat modifié localement", () => {
    const html = renderToStaticMarkup(React.createElement(BeatList, { beats: [beat({ locallyEdited: true })], targetDurationSec: 720 }));
    expect(html).toContain("Modifié localement");
  });

  it("avertit sur un beat trop long à dire d'un souffle", () => {
    const long = `<p>${Array(40).fill("mot").join(" ")}</p>`;
    const html = renderToStaticMarkup(React.createElement(BeatList, { beats: [beat({ spokenText: long })], targetDurationSec: 720 }));
    expect(html).toContain("souffle");
  });

  it("n'avertit pas sur un beat court", () => {
    const html = renderToStaticMarkup(React.createElement(BeatList, { beats: [beat()], targetDurationSec: 720 }));
    expect(html).not.toContain("souffle");
  });

  it("affiche l'état vide avant tout import", () => {
    const html = renderToStaticMarkup(React.createElement(BeatList, { beats: [], targetDurationSec: 720 }));
    expect(html).toContain("Aucun beat");
  });
});

describe("DurationMeter", () => {
  it("affiche le cumul face à la cible", () => {
    const html = renderToStaticMarkup(React.createElement(DurationMeter, { totalSec: 725, targetSec: 720 }));
    expect(html).toContain("12 min 05 s");
    expect(html).toContain("12 min 00 s");
  });

  it("affiche un écart signé au-dessus de la cible", () => {
    const html = renderToStaticMarkup(React.createElement(DurationMeter, { totalSec: 725, targetSec: 720 }));
    expect(html).toContain("+5 s");
  });

  it("affiche un écart signé en dessous de la cible", () => {
    const html = renderToStaticMarkup(React.createElement(DurationMeter, { totalSec: 700, targetSec: 720 }));
    expect(html).toContain("−20 s");
  });

  it("n'affiche aucun écart sans cible", () => {
    const html = renderToStaticMarkup(React.createElement(DurationMeter, { totalSec: 700, targetSec: null }));
    expect(html).not.toContain("+");
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `bun test tests/video-beat-list.test.ts`
Expected: FAIL — composants introuvables.

- [ ] **Step 3: Implémenter**

`components/video/duration-meter.tsx` — cumul, cible, écart signé (`+5 s` / `−20 s`, avec le vrai signe moins U+2212), rien quand `targetSec` est `null`.

`components/video/beat-list.tsx` — liste ordonnée : numéro, `externalId` en libellé technique discret, badge de type, extrait du texte, durée, badge « Modifié localement », avertissement « souffle » quand `isBreathRisk(spokenText)`, glisser-déposer appelant `reorderBeats`, état vide « Aucun beat — importez la réponse de Claude pour commencer. ».

`components/video/beat-inspector.tsx` — panneau latéral : éditeur Tiptap restreint pour `spokenText` (même socle que l'éditeur d'article), champs note de réalisation / texte à l'écran / transitions, liste des sources, liste des inserts avec **URL éditable**, timecodes, durée d'affichage, crédit. Enregistre via `updateBeat`.

Brancher le tout dans un second onglet de `app/(app)/video/[id]/page.tsx`, avec sélecteur de variante.

- [ ] **Step 4: Lancer le test et vérifier qu'il passe**

Run: `bun test tests/video-beat-list.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Vérifier dans le navigateur**

Modifier le texte d'un beat, enregistrer, recharger : le texte persiste, la durée estimée a bougé, le badge « Modifié localement » apparaît.

- [ ] **Step 6: Inscrire dans la lane pure et commiter**

```bash
# ajouter "video-beat-list.test.ts" à PURE_FILES dans scripts/test-fast.ts
bun run test:pure
git add components/video app/\(app\)/video/\[id\]/page.tsx tests/video-beat-list.test.ts scripts/test-fast.ts
git commit -m "feat(video): vue Écriture — liste de beats, inspecteur, cumul de durée"
```

---

### Task 13: Écran d'import et de diff

**Files:**
- Create: `components/video/import-panel.tsx`, `components/video/diff-review.tsx`, `components/video/journal-history.tsx`
- Modify: `app/(app)/video/[id]/page.tsx`
- Test: `tests/video-diff-review.test.ts`

**Interfaces:**
- Consumes: `type Diff`, `type Issue` de `@/lib/video/import` ; `prepareImport`, `applyImport`, `revertJournalEntry` de `@/lib/actions/video-actions`
- Produces: `ImportPanel`, `DiffReview` (props `{ diff: Diff; onApply(accept: string[]): void }`), `IssueList` (props `{ issues: Issue[] }`), `JournalHistory`

**Comportement imposé (spec §5.3) :** ajouts et modifications **cochés par défaut** ; suppressions et conflits **décochés par défaut**.

- [ ] **Step 1: Écrire le test qui échoue**

`tests/video-diff-review.test.ts` — interactions, via le harnais DOM :

```ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { installDom, mount, click, flush } from "./dom-harness";
import * as React from "react";
import { DiffReview } from "@/components/video/diff-review";
import { IssueList } from "@/components/video/import-panel";
import type { Diff } from "@/lib/video/import";

let teardown: () => void;
beforeAll(() => { teardown = installDom(); });
afterAll(() => { teardown(); });

const snap = {
  kind: "narration" as const, spokenText: "<p>texte</p>", directionNote: null, screenText: null,
  transitionIn: null, transitionOut: null, sources: [], inserts: [],
};

const diff: Diff = {
  added: [{ externalId: "b-03", kind: "ajout", fields: ["spokenText"], next: snap, position: 2 }],
  modified: [{ externalId: "b-01", kind: "modification", fields: ["spokenText"], next: snap, position: 0 }],
  conflicts: [{ externalId: "b-02", fields: ["spokenText"], base: snap, ours: { ...snap, spokenText: "<p>ma version</p>" }, theirs: { ...snap, spokenText: "<p>sa version</p>" }, position: 1 }],
  removed: [{ externalId: "b-09" }],
  order: ["b-01", "b-02", "b-03"],
};

describe("DiffReview", () => {
  it("coche par défaut les ajouts et les modifications, pas les suppressions ni les conflits", async () => {
    let accepted: string[] | null = null;
    const { container, unmount } = await mount(
      React.createElement(DiffReview, { diff, onApply: (a: string[]) => { accepted = a; } }),
    );
    click(container.querySelector("[data-testid=apply]") as HTMLElement);
    await flush();
    expect(accepted!.sort()).toEqual(["b-01", "b-03"]);
    unmount();
  });

  it("un conflit coché applique la version de Claude", async () => {
    let accepted: string[] | null = null;
    const { container, unmount } = await mount(
      React.createElement(DiffReview, { diff, onApply: (a: string[]) => { accepted = a; } }),
    );
    click(container.querySelector("[data-testid=accept-b-02]") as HTMLElement);
    click(container.querySelector("[data-testid=apply]") as HTMLElement);
    await flush();
    expect(accepted!).toContain("b-02");
    unmount();
  });

  it("montre les deux versions d'un conflit", async () => {
    const { container, unmount } = await mount(React.createElement(DiffReview, { diff, onApply: () => {} }));
    expect(container.textContent).toContain("ma version");
    expect(container.textContent).toContain("sa version");
    unmount();
  });

  it("annonce une suppression comme proposée, non appliquée", async () => {
    const { container, unmount } = await mount(React.createElement(DiffReview, { diff, onApply: () => {} }));
    expect(container.textContent).toContain("b-09");
    expect(container.textContent).toContain("Suppression proposée");
    unmount();
  });
});

describe("IssueList", () => {
  it("affiche le chemin et le message de chaque erreur", async () => {
    const { container, unmount } = await mount(React.createElement(IssueList, {
      issues: [{ path: "variantes[0].beats[6].type", message: "type inconnu « bviroll »", received: "bviroll" }],
    }));
    expect(container.textContent).toContain("variantes[0].beats[6].type");
    expect(container.textContent).toContain("bviroll");
    unmount();
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `bun test tests/video-diff-review.test.ts`
Expected: FAIL — composants introuvables.

- [ ] **Step 3: Implémenter**

`components/video/import-panel.tsx` — zone de collage + dépôt de fichier `.json`, appel de `prepareImport`, puis affichage de `IssueList` (erreurs) **ou** de `DiffReview` (diff). `IssueList` rend chaque `Issue` avec son `path` en police monospace, son `message`, et la valeur reçue quand elle existe.

`components/video/diff-review.tsx` — quatre sections (Ajouts, Modifications, Conflits, Suppressions proposées), cases à cocher initialisées selon la règle par défaut, conflits affichés côte à côte (« Votre version » / « Version de Claude »), bouton d'application `data-testid="apply"`, cases `data-testid="accept-<externalId>"`.

`components/video/journal-history.tsx` — historique du journal : date, source, issue, et pour chaque entrée appliquée un bouton « Annuler » appelant `revertJournalEntry`, plus l'accès au payload brut.

Brancher un troisième onglet **Importer** dans `app/(app)/video/[id]/page.tsx`.

- [ ] **Step 4: Lancer le test et vérifier qu'il passe**

Run: `bun test tests/video-diff-review.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Vérification de bout en bout dans le navigateur**

1. Copier le brief depuis l'onglet Brief.
2. Coller `EXAMPLE_PAYLOAD` (ou une vraie réponse de chat) dans l'onglet Importer → diff en ajouts → appliquer → les beats apparaissent dans l'onglet Écriture.
3. Modifier le texte d'un beat dans l'app.
4. Ré-importer le **même** payload → le beat modifié localement apparaît en **conflit**, décoché.
5. Retirer un beat du payload et ré-importer → suppression **proposée mais décochée**.
6. Annuler la dernière entrée du journal → l'état précédent est restauré.

- [ ] **Step 6: Suite complète, lane pure et commit**

```bash
# ajouter "video-diff-review.test.ts" à PURE_FILES dans scripts/test-fast.ts
bun run test:pure
bun run typecheck
bun test
git add components/video app/\(app\)/video/\[id\]/page.tsx tests/video-diff-review.test.ts scripts/test-fast.ts
git commit -m "feat(video): import collé, revue de diff et journal annulable"
```

---

## Vérification finale du sous-projet

- [ ] `bun run typecheck` — sans erreur
- [ ] `bun run test:pure` — la lane pure passe, 9 nouveaux fichiers inclus
- [ ] `bun test` — suite complète verte (lane DB comprise)
- [ ] Parcours manuel complet du Step 5 de la Task 13, réussi de bout en bout
- [ ] `lib/video/*.ts` n'importe `@/db` nulle part : `grep -rn "@/db" lib/video/` ne renvoie que `lib/video/persist.ts`
