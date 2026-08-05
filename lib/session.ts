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

export async function requireUser(): Promise<SessionUser> {
  const s = await getSession();
  if (!s?.user) redirect("/login");
  return s.user as unknown as SessionUser;
}
