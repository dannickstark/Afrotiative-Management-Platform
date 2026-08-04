"use server";
import { and, eq, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { db, user, session } from "@/db";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { createCredentialUser } from "@/lib/create-user";
import { generateTempPassword } from "@/lib/team-password";
import { memberSchema, roleEnum, type MemberInput } from "@/lib/validation";

// Every action gates on team:manage (Admin only) before touching the DB — same guard() pattern
// as lib/actions/feed-actions.ts.
async function guard() {
  const u = await requireUser();
  requirePermission(u.role, "team", "manage");
  return u;
}

export async function addMember(input: MemberInput) {
  await guard();
  // Re-validate server-side even though the client (add-member-dialog.tsx) already runs
  // validateMemberInput — never trust the client-side check alone.
  const data = memberSchema.parse(input);

  const existing = await db.select({ id: user.id }).from(user).where(eq(user.email, data.email)).limit(1);
  if (existing.length) return { ok: false as const, message: "Un membre avec cet email existe déjà." };

  const tempPassword = generateTempPassword();
  await createCredentialUser({ email: data.email, name: data.name, role: data.role, password: tempPassword });
  revalidatePath("/settings/team");
  // Returned exactly once — the UI must show it in a copyable field and never re-display it.
  // Never log/persist this value in plaintext beyond this return (createCredentialUser hashes it
  // before the DB write).
  return { ok: true as const, tempPassword };
}

export async function setMemberRole(userId: string, role: z.infer<typeof roleEnum>) {
  const me = await guard();
  const parsedRole = roleEnum.parse(role); // runtime re-check even though the type already narrows it

  if (userId === me.id && parsedRole !== "admin") {
    // Anti-self-lockout: only refuse if no OTHER *active* (non-banned) admin exists. A banned
    // admin can't actually act as admin, so they don't count as a usable fallback — otherwise a
    // caller could demote themselves while the only other "admin" row is a disabled account,
    // leaving zero admins able to sign in.
    const otherActiveAdmins = await db.select({ id: user.id }).from(user)
      .where(and(eq(user.role, "admin"), eq(user.banned, false), ne(user.id, me.id)));
    if (otherActiveAdmins.length === 0) {
      return {
        ok: false as const,
        message: "Vous êtes le dernier administrateur actif — désignez un autre admin avant de changer votre propre rôle.",
      };
    }
  }

  await db.update(user).set({ role: parsedRole }).where(eq(user.id, userId));
  revalidatePath("/settings/team");
  return { ok: true as const };
}

export async function disableMember(userId: string) {
  const me = await guard();
  if (userId === me.id) return { ok: false as const, message: "Vous ne pouvez pas désactiver votre propre compte." };

  await db.update(user).set({ banned: true }).where(eq(user.id, userId));
  // A ban only blocks *future* Better-Auth sign-ins — it doesn't invalidate sessions already
  // issued. Delete this user's session rows too, so a disabled member is logged out immediately
  // rather than staying signed in until their session naturally expires.
  await db.delete(session).where(eq(session.userId, userId));

  revalidatePath("/settings/team");
  return { ok: true as const };
}

export async function enableMember(userId: string) {
  await guard();
  await db.update(user).set({ banned: false }).where(eq(user.id, userId));
  revalidatePath("/settings/team");
  return { ok: true as const };
}
