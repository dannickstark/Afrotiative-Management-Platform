"use server";
// lib/actions/asset-actions.ts — la SEULE porte gardée vers render_assets. Tout export d'un module
// "use server" est une Server Action appelable SANS authentification propre (voir le commentaire en
// tête de lib/actions/taxonomy-actions.ts) : c'est pourquoi les écritures brutes vivent dans
// lib/studio/asset-core.ts (un module SANS "use server", donc non exposé comme point d'entrée
// réseau) et pourquoi chaque export ci-dessous commence par requireUser() + requirePermission()
// avant d'appeler son homologue *Core.
//
// Guardé par "template:manage" (spec §5), pas une ressource "asset" séparée : la bibliothèque
// d'assets est un outil de fabrication de gabarits, pas une ressource de premier rang dans le
// modèle RBAC — même rôle qui gère les gabarits gère leurs assets (lib/rbac.ts n'a d'ailleurs aucune
// entrée "asset" dans sa matrice).
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { uploadAssetCore, deleteAssetCore } from "@/lib/studio/asset-core";

async function guard() {
  const user = await requireUser();
  requirePermission(user.role, "template", "manage");
  return user;
}

// Next.js passe le FormData d'un <form action={uploadAsset}> automatiquement en premier argument
// (node_modules/next/dist/docs/01-app/02-guides/forms.md — lu avant d'écrire cette action, voir
// AGENTS.md) ; components/studio/asset-library.tsx construit et transmet le sien à la main pour
// séparer proprement les DEUX formulaires (image / police) d'une même page sans dupliquer l'action.
export async function uploadAsset(formData: FormData) {
  const user = await guard();

  const kindRaw = formData.get("kind");
  const kind = kindRaw === "font" ? "font" as const : kindRaw === "image" ? "image" as const : null;
  if (!kind) return { ok: false as const, message: "Type d'asset invalide." };

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false as const, message: "Aucun fichier sélectionné." };
  }

  const nameRaw = formData.get("name");
  const name = typeof nameRaw === "string" && nameRaw.trim() ? nameRaw.trim() : file.name;

  const fontFamilyRaw = formData.get("fontFamily");
  const fontFamily = typeof fontFamilyRaw === "string" && fontFamilyRaw.trim() ? fontFamilyRaw.trim() : undefined;

  const fontWeightRaw = formData.get("fontWeight");
  const parsedWeight = typeof fontWeightRaw === "string" ? Number(fontWeightRaw) : NaN;
  const fontWeight = Number.isFinite(parsedWeight) && parsedWeight > 0 ? parsedWeight : undefined;

  const fontStyle = formData.get("fontStyle") === "italic" ? "italic" as const : "normal" as const;

  const res = await uploadAssetCore({ kind, name, file, fontFamily, fontWeight, fontStyle, userId: user.id });
  if (res.ok) revalidatePath("/studio/assets");
  return res;
}

export async function deleteAsset(id: string) {
  await guard();
  const res = await deleteAssetCore(id);
  if (res.ok) revalidatePath("/studio/assets");
  return res;
}
