import type { Role } from "@/lib/auth";

type Matrix = Record<Role, Record<string, string[]>>;

const MATRIX: Matrix = {
  journalist: {
    article: ["create", "edit"], feed: ["read"], taxonomy: ["read"], llmTokens: [],
    // Task 7 (module vidéo) : c'est le journaliste qui écrit les scripts vidéo.
    video: ["read", "manage"],
  },
  editor: {
    article: ["create", "edit", "approve", "publish", "reject", "regenerate"],
    feed: ["read", "manage"], taxonomy: ["read", "manage"], pipeline: ["read"],
    template: ["read", "manage", "publish"],
    // D1 spec §6: the editor diffuses from the article page (read + send) but does not administer
    // channel settings (/settings/social/[channel] — manage stays admin-only).
    social: ["read", "send"],
    // Task 6 (OpenRouter token pool) — editor+admin manage the token pool from
    // /settings/integrations (add/delete/toggle/test); journalist gets nothing (no entry below).
    llmTokens: ["manage"],
    // "configure" (round de correction 1, Task 8) gates /settings/video (SETTINGS_CHILDREN
    // restricts that entry to admin/editor) — kept distinct from "manage", which the journalist
    // also holds for editing video projects/beats in later tasks.
    video: ["read", "manage", "configure", "annotate"],
  },
  admin: {
    article: ["create", "edit", "approve", "publish", "reject", "regenerate"],
    feed: ["read", "manage"], taxonomy: ["read", "manage"],
    team: ["read", "manage"], pipeline: ["read", "configure"],
    template: ["read", "manage", "publish"],
    social: ["read", "manage", "send"],
    llmTokens: ["manage"],
    video: ["read", "manage", "configure", "annotate"],
  },
  // Task 5 (conducteur de montage) : rôle dédié au montage — lecture + annotation vidéo
  // uniquement, aucun accès aux autres ressources.
  monteur: {
    video: ["read", "annotate"],
  },
};

export const ROLE_LABEL: Record<Role, string> = {
  admin: "Admin", editor: "Éditeur", journalist: "Journaliste", monteur: "Monteur",
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
