import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth, type Role } from "./auth";

export async function getSession() {
  return auth.api.getSession({ headers: await headers() });
}

export type SessionUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
  banned: boolean;
  image: string | null;
};

export function isSessionUsable(user: { banned: boolean } | null | undefined): boolean {
  return !!user && !user.banned;
}

export async function requireUser(): Promise<SessionUser> {
  const s = await getSession();
  const user = s?.user as unknown as SessionUser | undefined;
  if (!isSessionUsable(user)) redirect("/login"); // defense-in-depth — plan 004
  return user as SessionUser;
}
