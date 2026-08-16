import { describe, it, expect, beforeAll, afterAll, spyOn } from "bun:test";
import { db, apiTokens, videoSettings, user } from "@/db";
import { eq } from "drizzle-orm";
import { generateToken, PREFIX_LENGTH } from "@/lib/mcp/token";
import { authenticateMcp } from "@/lib/mcp/auth";
import { getVideoSettings } from "@/lib/queries/video-settings";

let tokenId: string;
let plain: string;
let userId: string;

beforeAll(async () => {
  const users = await db.query.user.findMany({ limit: 1 });
  if (!users[0]) {
    throw new Error(
      "Aucun utilisateur en base : ce test a besoin d'au moins une ligne dans `user` pour créer un jeton MCP à son nom.",
    );
  }
  userId = users[0].id;
  const t = generateToken();
  plain = t.token;
  const [row] = await db.insert(apiTokens)
    .values({ userId, name: "Test MCP", prefix: t.prefix, tokenHash: t.tokenHash })
    .returning();
  tokenId = row.id;
  // getVideoSettings() crée la ligne de réglages si elle est absente (comportement voulu par
  // ailleurs) : on force sa création ici plutôt que de compter sur un test précédent du même
  // fichier pour le faire à notre place.
  await getVideoSettings();
});

afterAll(async () => {
  await db.delete(apiTokens).where(eq(apiTokens.id, tokenId));
  const [s] = await db.select().from(videoSettings).limit(1);
  if (s) await db.update(videoSettings).set({ mcpEnabled: true }).where(eq(videoSettings.id, s.id));
});

describe("authenticateMcp", () => {
  it("accepte un jeton valide et rend son porteur", async () => {
    const [owner] = await db.select().from(user).where(eq(user.id, userId));
    const r = await authenticateMcp(`Bearer ${plain}`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.actor.userId).toBe(userId);
      expect(r.actor.tokenId).toBe(tokenId);
      // Le rôle rendu doit être celui lu en base pour ce porteur, pas une valeur par défaut.
      expect(r.actor.role).toBe(owner.role);
    }
  });

  it("met à jour la date de dernière utilisation sur un succès", async () => {
    await authenticateMcp(`Bearer ${plain}`);
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, tokenId));
    expect(row.lastUsedAt).not.toBeNull();
  });

  it("n'actualise PAS la date de dernière utilisation sur un échec", async () => {
    // Si un échec touchait lastUsedAt, la colonne deviendrait elle-même un oracle : il suffirait de
    // comparer sa valeur avant/après un essai pour savoir si un préfixe correspond à un jeton réel.
    const [avant] = await db.select().from(apiTokens).where(eq(apiTokens.id, tokenId));
    const mauvaisSecret = plain.slice(0, PREFIX_LENGTH) + "x".repeat(plain.length - PREFIX_LENGTH);
    const r = await authenticateMcp(`Bearer ${mauvaisSecret}`);
    expect(r.ok).toBe(false);
    const [apres] = await db.select().from(apiTokens).where(eq(apiTokens.id, tokenId));
    expect(apres.lastUsedAt?.getTime()).toBe(avant.lastUsedAt?.getTime());
  });

  it("refuse un en-tête absent", async () => {
    const r = await authenticateMcp(null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it("refuse un jeton d'un autre espace de noms sans interroger la table des jetons", async () => {
    const selectSpy = spyOn(db, "select");
    const r = await authenticateMcp("Bearer sk-quelque-chose-etranger-et-long");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
    // getVideoSettings() effectue déjà UN select (sur videoSettings) avant même de lire l'en-tête.
    // Le point vérifié ici : le court-circuit prefixOf() empêche toute requête SUPPLÉMENTAIRE sur
    // apiTokens. Si ce court-circuit disparaissait, ce compteur passerait à 2 et le test échouerait
    // — contrairement à une simple assertion sur le statut, qui resterait vraie dans les deux cas.
    expect(selectSpy).toHaveBeenCalledTimes(1);
    selectSpy.mockRestore();
  });

  it("donne LE MÊME statut et message pour les quatre chemins d'échec 401 : jeton inconnu, mauvais secret, jeton révoqué, porteur banni", async () => {
    const inconnu = await authenticateMcp(`Bearer ${generateToken().token}`);

    const mauvaisSecret = plain.slice(0, PREFIX_LENGTH) + "x".repeat(plain.length - PREFIX_LENGTH);
    const secretInvalide = await authenticateMcp(`Bearer ${mauvaisSecret}`);

    let revoque: Awaited<ReturnType<typeof authenticateMcp>>;
    try {
      await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, tokenId));
      revoque = await authenticateMcp(`Bearer ${plain}`);
    } finally {
      await db.update(apiTokens).set({ revokedAt: null }).where(eq(apiTokens.id, tokenId));
    }

    let banni: Awaited<ReturnType<typeof authenticateMcp>>;
    try {
      await db.update(user).set({ banned: true }).where(eq(user.id, userId));
      banni = await authenticateMcp(`Bearer ${plain}`);
    } finally {
      await db.update(user).set({ banned: false }).where(eq(user.id, userId));
    }

    expect(inconnu.ok).toBe(false);
    expect(secretInvalide.ok).toBe(false);
    expect(revoque.ok).toBe(false);
    expect(banni.ok).toBe(false);

    // Le point : distinguer un de ces quatre cas dirait à un attaquant lequel de ses essais s'est
    // rapproché d'un jeton réel. L'uniformité du statut ET du message est ce qui empêche l'oracle —
    // un futur refactor qui renverrait, disons, 403 pour le porteur banni doit faire échouer ceci.
    if (!inconnu.ok && !secretInvalide.ok && !revoque.ok && !banni.ok) {
      expect(secretInvalide.status).toBe(inconnu.status);
      expect(revoque.status).toBe(inconnu.status);
      expect(banni.status).toBe(inconnu.status);
      expect(secretInvalide.message).toBe(inconnu.message);
      expect(revoque.message).toBe(inconnu.message);
      expect(banni.message).toBe(inconnu.message);
    }
  });

  it("refuse tout, avec 503, quand l'interrupteur est fermé — même un jeton parfaitement valide", async () => {
    const [s] = await db.select().from(videoSettings).limit(1);
    if (!s) throw new Error("Ligne `videoSettings` absente : le beforeAll aurait dû la créer via getVideoSettings().");
    let r: Awaited<ReturnType<typeof authenticateMcp>>;
    try {
      await db.update(videoSettings).set({ mcpEnabled: false }).where(eq(videoSettings.id, s.id));
      r = await authenticateMcp(`Bearer ${plain}`);
    } finally {
      await db.update(videoSettings).set({ mcpEnabled: true }).where(eq(videoSettings.id, s.id));
    }

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(503);
      expect(r.message).toContain("désactivé");
    }
  });
});
