"use client";
import { useSession } from "@/lib/auth-client";
import type { Role } from "@/lib/auth";

export function RoleGate({ allow, children }: { allow: Role[]; children: React.ReactNode }) {
  const { data } = useSession();
  const role = data?.user?.role as Role | undefined;
  if (!role || !allow.includes(role)) return null;
  return <>{children}</>;
}
