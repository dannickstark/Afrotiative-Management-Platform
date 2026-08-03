import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { auth } from "@/lib/auth";
import { createCredentialUser } from "@/lib/create-user";
import { db, user } from "@/db";
import { eq } from "drizzle-orm";

const email = "auth_test@afrotiative.test";
const password = "Test1234!secure";

describe("auth", () => {
  beforeAll(async () => {
    await db.delete(user).where(eq(user.email, email));
    await createCredentialUser({ email, password, name: "Auth Test", role: "editor" });
  });
  afterAll(async () => { await db.delete(user).where(eq(user.email, email)); });

  it("signs in with correct credentials", async () => {
    const res = await auth.api.signInEmail({ body: { email, password } });
    expect(res.user.email).toBe(email);
  });

  it("rejects a wrong password", async () => {
    await expect(auth.api.signInEmail({ body: { email, password: "wrong-pass-000" } }))
      .rejects.toThrow();
  });
});
