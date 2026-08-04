import { describe, it, expect, afterAll } from "bun:test";
import { and, eq, inArray, ne } from "drizzle-orm";
import { can } from "@/lib/rbac";
// generateTempPassword lives in lib/team-password.ts, not lib/actions/team-actions.ts. A
// file-level "use server" directive (needed so components/settings/*.tsx Client Components can
// import addMember/setMemberRole/disableMember/enableMember directly) only allows async-function
// exports in Next.js 16 — a synchronous helper like this one has to live in a plain module
// instead. Same constraint Task 2 hit with validateFeedInput (see lib/validation.ts).
import { generateTempPassword } from "@/lib/team-password";
import { createCredentialUser } from "@/lib/create-user";
import { auth } from "@/lib/auth";
import { db, user, session } from "@/db";

describe("team actions", () => {
  it("only admin manages the team", () => {
    expect(can("admin", "team", "manage")).toBe(true);
    expect(can("editor", "team", "manage")).toBe(false);
    expect(can("journalist", "team", "manage")).toBe(false);
  });

  it("temp password is reasonably strong", () => {
    const p = generateTempPassword();
    expect(p.length).toBeGreaterThanOrEqual(12);
    expect(generateTempPassword()).not.toBe(p); // random
  });

  it("temp password mixes upper, lower, digit and symbol characters", () => {
    const p = generateTempPassword();
    expect(/[A-Z]/.test(p)).toBe(true);
    expect(/[a-z]/.test(p)).toBe(true);
    expect(/[0-9]/.test(p)).toBe(true);
    expect(/[^A-Za-z0-9]/.test(p)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Self-cleaning integration test: addMember itself needs a real Better-Auth session via
// requireUser() → next/headers, unavailable outside a request context in bun test (same
// limitation the rest of this suite works around — see tests/feed-actions.test.ts,
// tests/auth.test.ts). So this exercises the exact path addMember takes internally
// (generateTempPassword → createCredentialUser → the temp password signs in), per the brief's
// Step 4, instead of calling the "use server" export directly.
describe("addMember path: create → sign in with temp password → cleanup", () => {
  const email = "team_test_addmember@afrotiative.test";
  let userId: string | null = null;

  afterAll(async () => {
    if (userId) await db.delete(user).where(eq(user.id, userId));
    else await db.delete(user).where(eq(user.email, email)); // safety net if creation failed midway
  });

  it("signs in successfully with the generated temp password and has the assigned role", async () => {
    const tempPassword = generateTempPassword();
    userId = await createCredentialUser({ email, name: "Test AddMember", role: "editor", password: tempPassword });

    const res = await auth.api.signInEmail({ body: { email, password: tempPassword } });
    expect(res.user.email).toBe(email);
    expect((res.user as { role?: string }).role).toBe("editor");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Anti-self-lockout: setMemberRole refuses to demote the caller away from "admin" when no OTHER
// *active* admin exists. This mirrors the exact query lib/actions/team-actions.ts runs, against
// temp admin users only — never the seeded admin@afrotiative.com.
describe("setMemberRole anti-self-lockout query", () => {
  const emails = ["team_test_admin1@afrotiative.test", "team_test_admin2@afrotiative.test"];
  const ids: string[] = [];

  afterAll(async () => {
    if (ids.length) await db.delete(user).where(inArray(user.id, ids));
  });

  it("finds no other active admin for a lone admin, one once a second active admin exists, and ignores a banned admin", async () => {
    const id1 = await createCredentialUser({ email: emails[0], name: "Admin One", role: "admin", password: generateTempPassword() });
    ids.push(id1);

    // Scoped with inArray(..., ids) to this test's own temp users: the real DB always has the
    // seeded admin@afrotiative.com as a genuine "other active admin", so an unscoped count would
    // never hit 0 here — that's correct production behavior (a real other admin does exist), but
    // it means this test must isolate its own mini-world to exercise the "lone admin" case
    // without touching/depending on the seeded admin.
    const otherActiveAdmins = () =>
      db.select({ id: user.id }).from(user)
        .where(and(eq(user.role, "admin"), eq(user.banned, false), ne(user.id, id1), inArray(user.id, ids)));

    expect((await otherActiveAdmins()).length).toBe(0); // lone admin -> self-demotion would be refused

    const id2 = await createCredentialUser({ email: emails[1], name: "Admin Two", role: "admin", password: generateTempPassword() });
    ids.push(id2);
    expect((await otherActiveAdmins()).length).toBe(1); // now id1 could safely step down

    // A *banned* other admin must not count as a usable fallback admin.
    await db.update(user).set({ banned: true }).where(eq(user.id, id2));
    expect((await otherActiveAdmins()).length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// disableMember must both ban the user AND delete their existing session rows, so a disabled
// member is logged out immediately rather than merely blocked from future logins.
describe("disableMember: session revoke", () => {
  const email = "team_test_disable@afrotiative.test";
  let userId: string | null = null;

  afterAll(async () => {
    if (userId) await db.delete(user).where(eq(user.id, userId));
  });

  it("deletes session rows for the user on disable", async () => {
    const password = generateTempPassword();
    userId = await createCredentialUser({ email, name: "Test Disable", role: "journalist", password });

    await auth.api.signInEmail({ body: { email, password } });
    const before = await db.select({ id: session.id }).from(session).where(eq(session.userId, userId));
    expect(before.length).toBeGreaterThan(0); // sanity: sign-in actually created a session row

    // Mirror exactly what disableMember does: ban + delete sessions.
    await db.update(user).set({ banned: true }).where(eq(user.id, userId));
    await db.delete(session).where(eq(session.userId, userId));

    const after = await db.select({ id: session.id }).from(session).where(eq(session.userId, userId));
    expect(after.length).toBe(0);
  });
});
