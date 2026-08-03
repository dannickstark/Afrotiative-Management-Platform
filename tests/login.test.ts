import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { auth } from "@/lib/auth";
import { createCredentialUser } from "@/lib/create-user";
import { db, user } from "@/db";
import { eq } from "drizzle-orm";

// Verifies the exact error shape login-form.tsx relies on to distinguish a
// banned account ("Ce compte a été désactivé…") from a wrong password /
// unknown email (generic "Email ou mot de passe incorrect.") without leaking
// account existence. See components/login-form.tsx for the client mapping.

const email = "login_test_banned@afrotiative.test";
const unknownEmail = "login_test_no_such_user@afrotiative.test";
const password = "Test1234!secure";

describe("login error shapes", () => {
  beforeAll(async () => {
    await db.delete(user).where(eq(user.email, email));
    await createCredentialUser({ email, password, name: "Login Test", role: "journalist" });
  });
  afterAll(async () => { await db.delete(user).where(eq(user.email, email)); });

  it("wrong password on an existing account yields the generic INVALID_EMAIL_OR_PASSWORD code", async () => {
    try {
      await auth.api.signInEmail({ body: { email, password: "totally-wrong" } });
      throw new Error("expected signInEmail to throw");
    } catch (err: any) {
      expect(err.status).toBe("UNAUTHORIZED");
      expect(err.body?.code).toBe("INVALID_EMAIL_OR_PASSWORD");
    }
  });

  it("an unknown email yields the SAME generic code as a wrong password (no account-existence leak)", async () => {
    try {
      await auth.api.signInEmail({ body: { email: unknownEmail, password } });
      throw new Error("expected signInEmail to throw");
    } catch (err: any) {
      expect(err.status).toBe("UNAUTHORIZED");
      expect(err.body?.code).toBe("INVALID_EMAIL_OR_PASSWORD");
    }
  });

  it("a banned account with the correct password yields a distinct BANNED_USER code", async () => {
    await db.update(user).set({ banned: true }).where(eq(user.email, email));
    try {
      await auth.api.signInEmail({ body: { email, password } });
      throw new Error("expected signInEmail to throw");
    } catch (err: any) {
      expect(err.status).toBe("FORBIDDEN");
      expect(err.body?.code).toBe("BANNED_USER");
    } finally {
      await db.update(user).set({ banned: false }).where(eq(user.email, email));
    }
  });
});
