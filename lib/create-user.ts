import { randomUUID } from "node:crypto";
import { auth, type Role } from "./auth";
import { db, user, account } from "@/db";

export async function createCredentialUser(input: { email: string; name: string; role: Role; password: string }) {
  const ctx = await auth.$context;
  const hash = await ctx.password.hash(input.password);
  const id = randomUUID();
  await db.insert(user).values({ id, email: input.email, name: input.name, role: input.role, emailVerified: true });
  await db.insert(account).values({ id: randomUUID(), userId: id, accountId: id, providerId: "credential", password: hash });
  return id;
}
