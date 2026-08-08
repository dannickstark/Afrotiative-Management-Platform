import { z } from "zod";
import { Cron } from "croner";

export const saveDraftSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(3, "Titre trop court"),
  bodyHtml: z.string(),
  excerpt: z.string().optional(),
  categoryId: z.string().uuid().nullable(),
  tags: z.array(z.object({ tagName: z.string(), isNew: z.boolean() })),
  featuredImageUrl: z.string().url().nullable(),
  imageCredit: z.string().nullable(),
  imageSourceUrl: z.string().url().nullable(),
});

export type SaveDraftInput = z.infer<typeof saveDraftSchema>;

export const feedSchema = z.object({
  name: z.string().min(1, "Nom requis"),
  feedUrl: z.string().url("URL du flux invalide"),
  siteUrl: z.string().url("URL du site invalide").optional().or(z.literal("")),
  active: z.boolean(),
});
export type FeedInput = z.infer<typeof feedSchema>;

// Pure (no DB/session) so both the unit test and FeedSheet's client-side validation can call it
// directly. Deliberately NOT co-located in lib/actions/feed-actions.ts: that file needs a
// file-level "use server" directive so feed-sheet.tsx (a Client Component) can import its actions
// directly, and Next.js only allows async-function exports from a file-level "use server" module
// — a synchronous export like this one would silently disappear from the client-importable
// surface (verified: `bun run build` fails with "export validateFeedInput doesn't exist in
// target module" when it's declared there).
export function validateFeedInput(input: unknown) {
  const r = feedSchema.safeParse(input);
  return r.success
    ? { ok: true as const, data: r.data }
    : { ok: false as const, message: r.error.issues[0]?.message ?? "Entrée invalide" };
}

export const roleEnum = z.enum(["admin", "editor", "journalist"]);

export const memberSchema = z.object({
  email: z.string().email("Email invalide"),
  name: z.string().min(2, "Nom trop court"),
  role: roleEnum,
});
export type MemberInput = z.infer<typeof memberSchema>;

// Same reasoning as validateFeedInput above: kept out of lib/actions/team-actions.ts because that
// file needs a file-level "use server" directive (so components/settings/add-member-dialog.tsx, a
// Client Component, can import addMember/setMemberRole/etc. directly), and Next.js 16 only allows
// async-function exports from such a file.
export function validateMemberInput(input: unknown) {
  const r = memberSchema.safeParse(input);
  return r.success
    ? { ok: true as const, data: r.data }
    : { ok: false as const, message: r.error.issues[0]?.message ?? "Entrée invalide" };
}

// Cron validator backed by croner (SP2 wires scheduleCron to an in-app scheduler — see
// lib/pipeline/scheduler.ts, which parses this same string with `new Cron(...)`). Validating with
// the actual library the scheduler uses — rather than a hand-rolled regex — means a value that
// passes here is guaranteed to be schedulable; `paused: true` builds the Cron purely to run its
// parser without starting a timer. `new Cron` throws (rather than returning a result) on a bad
// pattern, hence the try/catch.
function isValidCron(v: string): boolean {
  try {
    new Cron(v, { paused: true });
    return true;
  } catch {
    return false;
  }
}

// SP9a — basic email shape check (deliberately not RFC-5322-exhaustive: this only gates a
// comma-separated recipients list an admin types into a settings field, not user-facing signup).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidRecipientsList(v: string): boolean {
  return v.split(",").every((part) => EMAIL_RE.test(part.trim()));
}

// Lives in lib/validation.ts (not lib/actions/pipeline-settings-actions.ts) for the same reason as
// feedSchema/memberSchema above: that file needs a file-level "use server" directive, and Next.js
// only allows async-function exports from such a module.
export const pipelineSettingsSchema = z.object({
  maxItemsPerRun: z.number().int().positive("Doit être un entier positif"),
  // Floor at 5 s (SP5 Task 2 review, Finding 1): the per-operation timeout wraps "Dépôt en revue",
  // whose fn() is the article-writing DB transaction. withTimeout can only stop WAITING on a
  // promise, never cancel it — so a timeout below real DB-commit latency could report the stage
  // failed (articleId: null) while the transaction still commits moments later (a "phantom" pending
  // article the caller never learns about). 5 s comfortably exceeds any Neon commit, closing that
  // window, while still allowing a tight timeout for genuinely stuck provider calls.
  perOperationTimeoutMs: z.number().int().min(5000, "Le délai par opération doit être d'au moins 5 secondes."),
  clusterThreshold: z.number().min(0, "Doit être entre 0 et 1").max(1, "Doit être entre 0 et 1"),
  scoreThreshold: z.number().int().min(0, "Doit être entre 0 et 100").max(100, "Doit être entre 0 et 100"),
  autoPublishEnabled: z.boolean(),
  autoPublishMinSources: z.number().int().positive("Doit être un entier positif"),
  webSearchEnabled: z.boolean(),
  scheduleCron: z.string().optional().nullable().refine(
    (v) => !v || !v.trim() || isValidCron(v.trim()),
    "Cron invalide (ex. « 0 */2 * * * »)",
  ),
  // SP9a — optional email notification for alerts (default OFF). `.default(false)` (not a bare
  // `z.boolean()`) deliberately: PipelineSettingsForm's payload (SP9b builds its UI) doesn't send
  // this field yet, and a required boolean here would break that EXISTING client-side
  // `pipelineSettingsSchema.safeParse(payload)` call the moment this schema change lands — the
  // default keeps every current caller valid while still guaranteeing a real boolean in the
  // parsed output.
  alertEmailEnabled: z.boolean().default(false),
  // Comma-separated emails; empty/absent is always allowed (alerts stay in-app-only). Each
  // non-blank part must look like an email — a single malformed entry rejects the whole string.
  alertEmailRecipients: z.string().optional().nullable().refine(
    (v) => !v || !v.trim() || isValidRecipientsList(v),
    "Emails invalides (séparés par des virgules)",
  ),
  // Default recency cutoff (hours). Nullable = "no limit". `.default(null)` keeps existing callers
  // that don't send the field valid (mirrors alertEmailEnabled's default-for-compat pattern).
  defaultMaxItemAgeHours: z.number().int().positive("Doit être un entier positif").max(720, "Maximum 720 heures (30 jours)").nullable().default(null),
});
export type PipelineSettingsInput = z.infer<typeof pipelineSettingsSchema>;

// Per-run trigger parameters (all optional — omitted fields fall back to the settings defaults in
// resolveRunParams). `since` must not be in the future. maxItems capped at a sane ceiling.
const POSITIVE_INT_MSG = "Doit être un entier positif";
export const runParamsSchema = z.object({
  recency: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("age"), hours: z.number().int().positive(POSITIVE_INT_MSG).max(720, "Maximum 720 heures (30 jours)") }),
    z.object({ kind: z.literal("since"), at: z.string().datetime("Date/heure invalide") }),
    z.object({ kind: z.literal("none") }),
  ]).optional(),
  feedIds: z.array(z.string().uuid("Identifiant de flux invalide")).nullable().optional(),
  maxItems: z.number().int().positive(POSITIVE_INT_MSG).max(500, "Maximum 500 éléments").optional(),
}).refine(
  (v) => v.recency?.kind !== "since" || Date.parse(v.recency.at) <= Date.now(),
  { message: "La date « depuis » ne peut pas être dans le futur.", path: ["recency"] },
);
export type RunParamsInput = z.infer<typeof runParamsSchema>;

export const regenerateFieldsSchema = z.object({
  title: z.boolean(), body: z.boolean(), excerpt: z.boolean(),
  category: z.boolean(), tags: z.boolean(), image: z.boolean(),
}).refine((f) => Object.values(f).some(Boolean), { message: "Sélectionnez au moins un champ à régénérer." });
export type RegenerateFieldsInput = z.infer<typeof regenerateFieldsSchema>;

export const improveInputSchema = z.object({
  instruction: z.string().max(500, "Instruction trop longue (max 500 caractères).").optional(),
});
export type ImproveActionInput = z.infer<typeof improveInputSchema>;

// Plafond volontaire : les actions en lot publient séquentiellement sur WordPress, une sélection
// démesurée tiendrait la Server Action ouverte trop longtemps. 100 couvre largement une page de
// file (25 lignes) et plusieurs pages sélectionnées à la suite.
export const bulkIdsSchema = z.array(z.string().uuid()).min(1, "Sélectionnez au moins un article").max(100);

export const bulkRejectSchema = z.object({
  ids: bulkIdsSchema,
  reason: z.string().min(3, "Motif requis"),
});
