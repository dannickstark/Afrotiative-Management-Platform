import { z } from "zod";

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
