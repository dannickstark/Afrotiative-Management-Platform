import { describe, it, expect, afterAll, mock } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db, user, videoProjects } from "@/db";
import { can } from "@/lib/rbac";
import type { Role } from "@/lib/auth";
import { createVideoProjectCore } from "@/lib/video/persist";

describe("permissions des catégories de vidéo (matrice)", () => {
  it("seuls admin et éditeur configurent les catégories", () => {
    // Écrire les instructions d'un expert est un acte de configuration, pas de rédaction.
    expect(can("admin", "video", "configure")).toBe(true);
    expect(can("editor", "video", "configure")).toBe(true);
    expect(can("journalist", "video", "configure")).toBe(false);
  });

  it("le journaliste choisit la catégorie de sa vidéo", () => {
    expect(can("journalist", "video", "manage")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// La matrice ci-dessus, seule, ne garantit rien sur lib/actions/video-category-actions.ts ni
// lib/actions/video-actions.ts : ces tests passeraient à l'identique si `guard()` n'appelait
// jamais `requirePermission`. Ici on exécute les VRAIES actions gardées (Server Actions), avec
// un `requireUser` mocké — même recette que tests/diffusion-crypto.test.ts (Task 1) : capturer
// les exports réels de @/lib/session et next/cache, mocker `requireUser`, importer dynamiquement
// les modules d'action pour que leurs imports statiques résolvent contre les mocks, restaurer
// les exports réels en `afterAll`.
// ─────────────────────────────────────────────────────────────────────────────
const { requireUser: realRequireUser, getSession: realGetSession } = await import("@/lib/session");
const { revalidatePath: realRevalidatePath, revalidateTag: realRevalidateTag } = await import("next/cache");

const [seededJournalist] = await db.select({ id: user.id, role: user.role })
  .from(user).where(eq(user.email, "journaliste@afrotiative.com"));
if (!seededJournalist) throw new Error("Seed manquant : journaliste@afrotiative.com introuvable (bun run db:seed).");
const FAKE_JOURNALIST = {
  id: seededJournalist.id, name: "Test Journaliste", email: "journaliste@afrotiative.com",
  role: seededJournalist.role, banned: false, image: null,
};

const [seededAdmin] = await db.select({ id: user.id, role: user.role })
  .from(user).where(eq(user.email, "admin@afrotiative.com"));
if (!seededAdmin) throw new Error("Seed manquant : admin@afrotiative.com introuvable (bun run db:seed).");
const FAKE_ADMIN = {
  id: seededAdmin.id, name: "Test Admin", email: "admin@afrotiative.com",
  role: seededAdmin.role, banned: false, image: null,
};

// Aucun rôle de la matrice actuelle (lib/rbac.ts) ne manque de video/manage : journalist,
// editor et admin l'ont tous les trois — il n'existe donc pas de rôle réel pour exercer la
// branche « refus » de setProjectCategory. `can()` renvoie `false` pour toute clé absente de
// la matrice (`MATRIX[role]?.[...] ?? false`), donc un rôle synthétique, non répertorié,
// traverse le VRAI `requirePermission` (non mocké) sans jamais correspondre à une entrée — ce
// n'est pas un test en trompe-l'œil : il exécute le code de garde réel, juste avec une identité
// fabriquée pour garantir l'absence de permission plutôt que la choisir arbitrairement parmi les
// rôles existants (qui l'ont tous).
const FAKE_NO_MANAGE = {
  id: seededJournalist.id, name: "Test Sans Rôle Vidéo", email: "journaliste@afrotiative.com",
  role: "stagiaire" as Role, banned: false, image: null,
};

function setUser(fakeUser: typeof FAKE_ADMIN | typeof FAKE_NO_MANAGE) {
  mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: async () => fakeUser }));
}
function restoreSession() {
  mock.module("@/lib/session", () => ({ getSession: realGetSession, requireUser: realRequireUser }));
}

mock.module("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
setUser(FAKE_ADMIN);

const { createVideoCategory, updateVideoCategory, deleteVideoCategory } =
  await import("@/lib/actions/video-category-actions");
const { setProjectCategory } = await import("@/lib/actions/video-actions");

describe("garde video/configure sur les actions catégories (Server Actions)", () => {
  // next/cache reste mocké jusqu'à la toute fin du fichier (restauré dans l'`afterAll` du bloc
  // suivant) : le contrôle de non-régression de ce bloc-là appelle `revalidatePath` pour de vrai
  // en cas de succès, ce que le vrai `next/cache` refuse hors requête Next (« static generation
  // store missing »).
  afterAll(() => {
    restoreSession();
  });

  it("un journaliste (sans video/configure) ne peut pas créer de catégorie", async () => {
    setUser(FAKE_JOURNALIST);
    await expect(createVideoCategory({
      name: `Test-RBAC-Create-${Date.now()}`, description: null, instructions: "x", position: 0,
    })).rejects.toThrow();
  });

  it("un journaliste (sans video/configure) ne peut pas modifier de catégorie", async () => {
    setUser(FAKE_JOURNALIST);
    await expect(updateVideoCategory({
      id: crypto.randomUUID(), name: "x", description: null, instructions: "x", position: 0,
    })).rejects.toThrow();
  });

  it("un journaliste (sans video/configure) ne peut pas supprimer de catégorie", async () => {
    setUser(FAKE_JOURNALIST);
    await expect(deleteVideoCategory({ id: crypto.randomUUID() })).rejects.toThrow();
  });
});

describe("garde video/manage sur setProjectCategory (Server Action)", () => {
  const projects: string[] = [];

  afterAll(async () => {
    restoreSession();
    mock.module("next/cache", () => ({ revalidatePath: realRevalidatePath, revalidateTag: realRevalidateTag }));
    if (projects.length) await db.delete(videoProjects).where(inArray(videoProjects.id, projects));
  });

  it("un rôle sans video/manage ne peut pas changer la catégorie d'un projet", async () => {
    setUser(FAKE_ADMIN);
    const projectId = await createVideoProjectCore({
      title: `Test RBAC — sans manage ${Date.now()}`, subject: null, platform: "youtube_long",
      targetDurationSec: null, aspectRatio: "16:9", articleId: null, categoryId: null, userId: null,
    });
    projects.push(projectId);

    setUser(FAKE_NO_MANAGE);
    await expect(setProjectCategory({ projectId, categoryId: null })).rejects.toThrow();
  });

  it("le journaliste (avec video/manage) PEUT changer la catégorie d'un projet — contrôle de non-régression", async () => {
    setUser(FAKE_ADMIN);
    const projectId = await createVideoProjectCore({
      title: `Test RBAC — avec manage ${Date.now()}`, subject: null, platform: "youtube_long",
      targetDurationSec: null, aspectRatio: "16:9", articleId: null, categoryId: null, userId: null,
    });
    projects.push(projectId);

    setUser(FAKE_JOURNALIST);
    const res = await setProjectCategory({ projectId, categoryId: null });
    expect(res.ok).toBe(true);
  });
});
