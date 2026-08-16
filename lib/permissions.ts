import { createAccessControl } from "better-auth/plugins/access";

export const statement = {
  article: ["create", "edit", "approve", "publish", "reject", "regenerate"],
  feed: ["read", "manage"],
  taxonomy: ["read", "manage"],
  team: ["read", "manage"],
  pipeline: ["read", "configure"],
  video: ["read", "manage"],
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
  video: ["read", "manage"],
});
export const admin = ac.newRole({
  article: ["create", "edit", "approve", "publish", "reject", "regenerate"],
  feed: ["read", "manage"], taxonomy: ["read", "manage"],
  team: ["read", "manage"], pipeline: ["read", "configure"],
  video: ["read", "manage"],
});
