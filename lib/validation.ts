import { z } from "zod";
import { Cron } from "croner";
import { isSafePublicHttpUrl } from "@/lib/url-guard";

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
  categoryIds: z.array(z.string().uuid("Identifiant de catégorie invalide")).nullable().optional(),
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

// Chaque champ est optionnel : la correction est PARTIELLE par nature — on ne renseigne que ce
// qui manque. Un champ absent de l'entrée n'est pas touché en base (voir fixArticleFields).
// Le garde-fou SSRF est appliqué ici, au plus près de la saisie, avec le même prédicat que la
// publication : inutile d'accepter une URL que WordPress refusera ensuite de télécharger.
export const fixFieldsSchema = z.object({
  id: z.string().uuid(),
  categoryId: z.string().uuid().optional(),
  featuredImageUrl: z.string().url("URL d'image invalide")
    .refine(isSafePublicHttpUrl, "URL d'image non autorisée").optional(),
  imageCredit: z.string().trim().min(1, "Crédit vide").optional(),
  imageSourceUrl: z.string().url("URL source invalide")
    .refine(isSafePublicHttpUrl, "URL source non autorisée").optional(),
});
export type FixFieldsInput = z.infer<typeof fixFieldsSchema>;

// lib/diffusion/settings-core.ts's UpdateChannelSettingsPatch, server-side (D1 final review,
// Important 4). Lives here (not in lib/actions/diffusion-settings-actions.ts) for the same reason
// as pipelineSettingsSchema/feedSchema above: that file needs a file-level "use server" directive,
// and Next.js only allows async-function exports from such a module.
//
// Before this schema existed, updateChannelSettings (the Server Action — a PUBLIC network endpoint)
// validated only captionMaxChars server-side; every other field was checked ONLY by
// components/settings/social-channel-form.tsx's client-side guards, which a direct/future caller
// bypasses entirely. Two concrete failures that opened: `autoIntervalHours: 0` made isDue
// unconditionally true (lib/diffusion/schedule-core.ts: `now - lastAutoSendAt >= 0` always holds),
// so a channel would send on EVERY 15-minute scheduler tick — 96/day once a real adapter exists,
// not once per configured interval; and a non-integer value reached an `integer` Postgres column
// and surfaced as a raw, untranslated driver error instead of a clean French message.
//
// Every field is `.optional()`, matching UpdateChannelSettingsPatch's own `Partial<...>` shape — a
// caller may legitimately send only a subset (the current form always sends all eight, but the
// patch type itself does not require that), and only the fields actually present get validated.
// captionMaxChars's channel-specific [min, max] bound (Facebook 63,206 vs X 280) is NOT re-checked
// here — that stays updateChannelSettingsCore's job (it needs the channel key, which this schema
// alone doesn't carry) — this only guards the shape (integer, positive) common to every channel.
export const socialChannelSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  captionMaxChars: z.number().int("Doit être un nombre entier.").positive("Doit être un entier positif.").optional(),
  captionPrompt: z.string().nullable().optional(),
  autoEnabled: z.boolean().optional(),
  autoIntervalHours: z.number().int("Doit être un nombre entier.").positive("L'intervalle doit être un entier positif (en heures).").optional(),
  autoMaxBacklogDays: z.number().int("Doit être un nombre entier.").positive("La profondeur de rattrapage doit être un entier positif (en jours).").optional(),
  autoWindowStartHour: z.number().int("Doit être un nombre entier.")
    .min(0, "L'heure de début de fenêtre doit être comprise entre 0 et 23.")
    .max(23, "L'heure de début de fenêtre doit être comprise entre 0 et 23.").optional(),
  autoWindowEndHour: z.number().int("Doit être un nombre entier.")
    .min(0, "L'heure de fin de fenêtre doit être comprise entre 0 et 23.")
    .max(23, "L'heure de fin de fenêtre doit être comprise entre 0 et 23.").optional(),
  // Task 2 (D7 spec §4) — an admin correcting the estimate setChannelCredentialsCore defaulted to
  // now + 60 days (LinkedIn's token generator / Meta's Access Token Debugger show the real date).
  // Nullable: clearing the field means "expiry unknown", not "never expires".
  tokenExpiresAt: z.date().nullable().optional(),
});
export type SocialChannelSettingsInput = z.infer<typeof socialChannelSettingsSchema>;

// Task 1 (D2+D3) — lib/diffusion/settings-core.ts's setChannelCredentialsCore. Field NAMES are
// deliberately NOT enumerated here (no "pageId" | "pageAccessToken" union): which fields a channel
// needs is that channel's adapter's business (Facebook: page id + token; Instagram: IG user id +
// the SAME token; a future LinkedIn: an organization URN; WhatsApp: none) and is decided in Task
// 2+'s application code, never in this shared schema — enumerating them here would be exactly the
// per-platform coupling the storage design (db/schema.ts's `credentials` jsonb) was chosen to
// avoid. This validates SHAPE only: a non-empty map of non-empty string values. An empty value
// would silently encrypt "" as if it were a real secret — reject it up front, in French, rather
// than let a blank write-only field through.
export const channelCredentialsSchema = z.record(
  z.string().min(1, "Nom de champ d'identifiant invalide."),
  z.string().min(1, "La valeur d'un identifiant ne peut pas être vide."),
).refine((v) => Object.keys(v).length > 0, { message: "Aucun identifiant à enregistrer." });
export type ChannelCredentialsInput = z.infer<typeof channelCredentialsSchema>;

// D7 credential debt (D2+D3 final review, M8/M9) — channelCredentialsSchema above validates SHAPE
// only (a non-empty map of non-empty strings) because it has no channel argument, so it cannot know
// which field NAMES are legal. setChannelCredentialsCore (lib/diffusion/settings-core.ts) DOES know
// the channel, and calls this with that channel's own declared field keys
// (SOCIAL_CHANNELS[channel].credentialFields, lib/diffusion/channels.ts) to catch two things
// channelCredentialsSchema alone cannot: a key that isn't declared for this channel (M8 — a typo, or
// a value copy-pasted from a different channel's form) and a value over 4096 characters (M9 —
// generous for a page id / access token / URN, but not unbounded: an operator pasting an entire file
// into a credential field must be refused, not silently stored as-is). Same `{ ok, message }` shape
// as validateCategoryColor below — a plain function, not a zod schema, because the set of legal keys
// is only known at CALL time (one channel's credentialFields), not something a static zod shape can
// express without being rebuilt per channel anyway.
const CHANNEL_CREDENTIAL_VALUE_MAX_LENGTH = 4096;

export function validateChannelCredentialFields(
  declaredKeys: readonly string[],
  values: Record<string, string>,
): { ok: true } | { ok: false; message: string } {
  // A channel with NO declared fields yet (lib/diffusion/channels.ts's `credentialFields: []` —
  // today whatsapp/x/tiktok) has no known shape to validate a key NAME against: that `[]` means
  // "this channel's credential schema isn't defined in the registry yet", not "no field is ever
  // legal". Rejecting every key for such a channel would also reject the field names its own future
  // adapter task will introduce.
  //
  // Correction (D7 final review, Issue 12): this comment used to also list "linkedin" here and cite
  // tests/diffusion-crypto.test.ts's "linkedin" fixture as this carve-out's justification — true when
  // D2+D3 wrote it (linkedin.credentialFields really was `[]` back then), but D7 Tasks 4/6 gave
  // linkedin its own real declared keys (organizationUrn/accessToken, lib/diffusion/channels.ts), and
  // that same fixture now saves under THOSE real keys. It no longer exercises this carve-out at all —
  // linkedin is simply a channel with a full, real credential schema now, exactly like
  // facebook/instagram. The length bound below still applies regardless — that one is a universal
  // sanity bound, not tied to a specific field name.
  if (declaredKeys.length > 0) {
    for (const key of Object.keys(values)) {
      if (!declaredKeys.includes(key)) {
        return { ok: false, message: `Champ d'identifiant inconnu pour ce canal : « ${key} ».` };
      }
    }
  }
  for (const [key, value] of Object.entries(values)) {
    if (value.length > CHANNEL_CREDENTIAL_VALUE_MAX_LENGTH) {
      return {
        ok: false,
        message: `La valeur du champ « ${key} » dépasse la longueur maximale autorisée (${CHANNEL_CREDENTIAL_VALUE_MAX_LENGTH} caractères).`,
      };
    }
  }
  return { ok: true };
}

// wp_categories.color — the {{category.color}} token setCategoryColor writes (V2 Task 3, closing
// the V1-documented gap: the column and the render read existed, nothing could write it). Strict
// #RRGGBB only: no 3-digit shorthand (#FFF), no alpha channel, no CSS colour names — the studio's
// own hexColor (lib/studio/scene.ts) is deliberately more permissive because IT normalizes at
// render time; this is the single write path into the taxonomy, so it stays strict rather than
// silently normalizing a looser input. null or an empty/whitespace-only string clears the colour
// back to DEFAULT_CATEGORY_COLOR (lib/studio/default-category-color.ts) — never an error.
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

export function validateCategoryColor(
  input: string | null,
): { ok: true; data: string | null } | { ok: false; message: string } {
  if (input === null || input.trim() === "") return { ok: true, data: null };
  if (!HEX_COLOR_RE.test(input)) {
    return { ok: false, message: "Couleur invalide : format hexadécimal strict attendu, ex. #1B7F4A." };
  }
  return { ok: true, data: input };
}

// Réglages du module vidéo (Task 8) : le modèle de brief (style maison, édité au fil du temps) et
// la cadence de lecture (mots/minute) servant à estimer la durée parlée d'un beat.
export const videoSettingsSchema = z.object({
  briefTemplate: z.string().min(1, "Le modèle de brief ne peut pas être vide").max(20000),
  // Bornes larges mais réelles : sous 60 mots/min on ne parle plus, au-dessus de 400 on n'articule
  // plus. Hors de là, c'est une saisie erronée, pas un choix.
  wordsPerMinute: z.number().int().min(60, "Cadence trop basse").max(400, "Cadence trop élevée"),
});
export type VideoSettingsInput = z.infer<typeof videoSettingsSchema>;
