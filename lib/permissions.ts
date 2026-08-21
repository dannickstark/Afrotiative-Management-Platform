import { createAccessControl } from "better-auth/plugins/access";

export const statement = {
  article: ["create", "edit", "approve", "publish", "reject", "regenerate"],
  feed: ["read", "manage"],
  taxonomy: ["read", "manage"],
  team: ["read", "manage"],
  pipeline: ["read", "configure"],
  // "configure" (round de correction 1, Task 8) : distinct de "manage" — "manage" couvre
  // l'édition des projets/beats vidéo (journaliste inclus), "configure" couvre les RÉGLAGES du
  // module (/settings/video : modèle de brief, cadence) qui doivent rester admin/éditeur
  // seulement, comme pipeline: ["read", "configure"] ci-dessus.
  video: ["read", "manage", "configure", "annotate"],
} as const;

export const ac = createAccessControl(statement);

export const journalist = ac.newRole({
  article: ["create", "edit"],
  feed: ["read"], taxonomy: ["read"],
  video: ["read", "manage"],
});
export const editor = ac.newRole({
  article: ["create", "edit", "approve", "publish", "reject", "regenerate"],
  feed: ["read", "manage"], taxonomy: ["read", "manage"], pipeline: ["read"],
  video: ["read", "manage", "configure", "annotate"],
});
export const admin = ac.newRole({
  article: ["create", "edit", "approve", "publish", "reject", "regenerate"],
  feed: ["read", "manage"], taxonomy: ["read", "manage"],
  team: ["read", "manage"], pipeline: ["read", "configure"],
  video: ["read", "manage", "configure", "annotate"],
});
// Task 5 (conducteur de montage) : rôle dédié au montage vidéo — lecture + annotation
// uniquement, aucun accès aux autres ressources (article, feed, etc.).
export const monteur = ac.newRole({
  video: ["read", "annotate"],
});
