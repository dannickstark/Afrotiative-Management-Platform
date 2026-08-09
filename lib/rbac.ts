import type { Role } from "@/lib/auth";

type Matrix = Record<Role, Record<string, string[]>>;

const MATRIX: Matrix = {
  journalist: { article: ["create", "edit"], feed: ["read"], taxonomy: ["read"] },
  editor: {
    article: ["create", "edit", "approve", "publish", "reject", "regenerate"],
    feed: ["read", "manage"], taxonomy: ["read", "manage"], pipeline: ["read"],
    template: ["read", "manage", "publish"],
  },
  admin: {
    article: ["create", "edit", "approve", "publish", "reject", "regenerate"],
    feed: ["read", "manage"], taxonomy: ["read", "manage"],
    team: ["read", "manage"], pipeline: ["read", "configure"],
    template: ["read", "manage", "publish"],
  },
};

export const ROLE_LABEL: Record<Role, string> = {
  admin: "Admin", editor: "Éditeur", journalist: "Journaliste",
};

export function can(role: Role, resource: string, action: string): boolean {
  return MATRIX[role]?.[resource]?.includes(action) ?? false;
}

export class PermissionError extends Error {
  constructor(resource: string, action: string) {
    super(`Action non autorisée : ${action} sur ${resource}`);
    this.name = "PermissionError";
  }
}

export function requirePermission(role: Role, resource: string, action: string): void {
  if (!can(role, resource, action)) throw new PermissionError(resource, action);
}
