import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, scriptVariants, scriptBeats, scriptJournal } from "@/db";
import { asc, eq } from "drizzle-orm";
import { EXAMPLE_PAYLOAD, beatPayloadSchema, insertPayloadSchema, payloadSchema } from "@/lib/video/schema";
import { prepareImportCore } from "@/lib/video/persist";
import { callTool, makeActor, cleanupProject, type TestActor } from "./mcp-harness";

let projectId: string | undefined;
let variantId: string;
let actor: TestActor;
// Déclaré ici, et non dans le test qui le crée : la base Neon est PARTAGÉE, donc le nettoyage doit
// avoir lieu même si le test échoue en cours de route.
let lecteur: TestActor | null = null;
// L'aller-retour (C1) travaille sur SON PROPRE projet : sur celui des autres tests, une retouche
// humaine a fait diverger l'état actuel de l'instantané du dernier import, et une relecture fidèle
// y produirait légitimement une modification. Le défaut visé se mesure sur un script fraîchement
// appliqué, où relire puis resoumettre ne peut RIEN changer.
let projetAllerRetour: string | undefined;

beforeAll(async () => { actor = await makeActor("editor"); });
afterAll(async () => {
  // try/finally : la base Neon est PARTAGÉE. Si la suppression du projet échoue, l'utilisateur de
  // test et son jeton doivent tout de même partir — sinon ils s'accumulent, run après run.
  try {
    await cleanupProject(projectId);
    await cleanupProject(projetAllerRetour);
  } finally {
    if (lecteur) await lecteur.cleanup();
    if (actor) await actor.cleanup();
  }
});

describe("outils MCP", () => {
  it("create_video_project crée l'espace ET renvoie le brief", async () => {
    const r = await callTool(actor, "create_video_project", {
      title: "Test MCP — Babadampulu", platform: "youtube_long", targetDurationSec: 720,
    });
    expect(r.projectId).toBeString();
    expect(r.brief).toContain("schema_version");
    projectId = r.projectId;
    const variants = await db.select().from(scriptVariants).where(eq(scriptVariants.projectId, r.projectId));
    expect(variants).toHaveLength(1);
    expect(r.variantId).toBe(variants[0].id);
  }, 30_000);

  it("submit_script renvoie le diff pour un payload valide", async () => {
    const r = await callTool(actor, "submit_script", { projectId, payload: EXAMPLE_PAYLOAD });
    expect(r.ok).toBe(true);
    expect(r.diff.added.length).toBeGreaterThan(0);
    expect(r.journalId).toBeString();
    // Sans ce `variantId` rendu, l'agent ne pourrait pas enchaîner sur apply_script.
    expect(r.variantId).toBeString();
  }, 30_000);

  it("submit_script renvoie les erreurs AVEC leur chemin, pour que l'agent se corrige", async () => {
    const bad = structuredClone(EXAMPLE_PAYLOAD);
    bad.variantes[0].beats[0].type = "bviroll" as never;
    const r = await callTool(actor, "submit_script", { projectId, payload: bad });
    expect(r.ok).toBe(false);
    expect(r.issues[0].path).toContain("beats[0].type");
    expect(r.issues[0].received).toBe("bviroll");
  }, 30_000);

  it("apply_script sans sélection n'applique ni suppression ni conflit", async () => {
    const prep = await callTool(actor, "submit_script", { projectId, payload: EXAMPLE_PAYLOAD });
    variantId = prep.variantId;
    const applied = await callTool(actor, "apply_script", { journalId: prep.journalId, variantId });
    expect(applied.ok).toBe(true);
    expect(applied.applied).toBe(EXAMPLE_PAYLOAD.variantes[0].beats.length);
    expect(applied.order).toHaveLength(EXAMPLE_PAYLOAD.variantes[0].beats.length);

    const reduced = structuredClone(EXAMPLE_PAYLOAD);
    reduced.variantes[0].beats.pop(); // un beat disparaît → suppression proposée
    const prep2 = await callTool(actor, "submit_script", { projectId, payload: reduced });
    expect(prep2.diff.removed.length).toBe(1);
    // Assertion indispensable : sans elle, un `{ ok: false }` pour n'importe quelle autre raison
    // laisserait le nombre de beats inchangé et le test resterait vert sans jamais avoir éprouvé la
    // sélection par défaut.
    const applied2 = await callTool(actor, "apply_script", { journalId: prep2.journalId, variantId });
    expect(applied2.ok).toBe(true);
    expect(applied2.applied).toBe(0);

    const beats = await db.select().from(scriptBeats).where(eq(scriptBeats.variantId, variantId));
    // Le point : la suppression a été PROPOSÉE, jamais appliquée sans demande nommée.
    expect(beats.length).toBe(EXAMPLE_PAYLOAD.variantes[0].beats.length);
  }, 30_000);

  it("apply_script applique une suppression quand elle est nommément demandée", async () => {
    // Le pendant du test précédent : la règle est « jamais par défaut », pas « jamais ».
    const reduced = structuredClone(EXAMPLE_PAYLOAD);
    const supprime = reduced.variantes[0].beats.pop()!;
    const prep = await callTool(actor, "submit_script", { projectId, payload: reduced });
    const r = await callTool(actor, "apply_script", {
      journalId: prep.journalId, variantId: prep.variantId, accept: [supprime.id],
    });
    expect(r).toMatchObject({ ok: true });
    const beats = await db.select().from(scriptBeats).where(eq(scriptBeats.variantId, prep.variantId));
    expect(beats.map((b) => b.externalId)).not.toContain(supprime.id);
  }, 30_000);

  it("reorder_beats réordonne avec les identifiants du contrat, pas des UUID", async () => {
    const avant = (await db.select().from(scriptBeats)
      .where(eq(scriptBeats.variantId, variantId)).orderBy(asc(scriptBeats.position)))
      .map((b) => b.externalId);
    const voulu = [...avant].reverse();

    const r = await callTool(actor, "reorder_beats", { variantId, order: voulu });
    expect(r.order).toEqual(voulu);

    const apres = (await db.select().from(scriptBeats)
      .where(eq(scriptBeats.variantId, variantId)).orderBy(asc(scriptBeats.position)))
      .map((b) => b.externalId);
    expect(apres).toEqual(voulu);
  }, 30_000);

  it("reorder_beats refuse un identifiant inconnu plutôt que de l'ignorer en silence", async () => {
    // Le cœur apparie par `WHERE external_id = ...` : un identifiant inconnu n'affecte aucune ligne.
    // Sans ce refus, l'agent croirait avoir réordonné ce qu'il n'a pas touché.
    await expect(callTool(actor, "reorder_beats", { variantId, order: ["b-99-inexistant"] }))
      .rejects.toThrow(/absents de cette variante/);
  }, 30_000);

  it("un refus de péremption reste un refus au second essai", async () => {
    // Le déroulé complet : l'agent prépare, un humain édite, l'agent applique (refus), puis
    // réessaie — ce que fait un agent qui ne sait que réessayer. Si le second appel passait,
    // l'édition humaine serait écrasée sans que personne ne l'ait vue.
    const beatsAvant = await db.select().from(scriptBeats)
      .where(eq(scriptBeats.variantId, variantId)).orderBy(asc(scriptBeats.position));
    const payload = structuredClone(EXAMPLE_PAYLOAD);
    payload.variantes[0].beats = payload.variantes[0].beats
      .filter((b) => beatsAvant.some((x) => x.externalId === b.id));

    const prep = await callTool(actor, "submit_script", { projectId, payload });
    expect(prep.ok).toBe(true);

    // L'édition humaine, postérieure à la préparation du diff.
    await callTool(actor, "update_beat", {
      beatId: beatsAvant[0].id, spokenText: "Correction humaine entre la préparation et l'application.",
    });

    const premier = await callTool(actor, "apply_script", { journalId: prep.journalId, variantId });
    expect(premier.ok).toBe(false);
    expect(premier.message).toContain("périmé");

    const second = await callTool(actor, "apply_script", { journalId: prep.journalId, variantId });
    expect(second.ok).toBe(false);
    expect(second.message).toContain("périmé");

    // Et la correction humaine est toujours là.
    const [beat] = await db.select().from(scriptBeats).where(eq(scriptBeats.id, beatsAvant[0].id));
    expect(beat.spokenText).toContain("Correction humaine");
  }, 30_000);

  it("apply_script sans sélection n'applique pas un conflit", async () => {
    // L'autre moitié de la règle produit. Un conflit se fabrique en faisant diverger les DEUX côtés
    // du même champ depuis le dernier import : l'humain retouche le texte, l'agent en propose un
    // autre.
    const beats = await db.select().from(scriptBeats)
      .where(eq(scriptBeats.variantId, variantId)).orderBy(asc(scriptBeats.position));
    const cible = beats[0];
    await callTool(actor, "update_beat", {
      beatId: cible.id, spokenText: "Version écrite par la rédaction, à ne pas perdre.",
    });

    const payload = structuredClone(EXAMPLE_PAYLOAD);
    payload.variantes[0].beats = payload.variantes[0].beats
      .filter((b) => beats.some((x) => x.externalId === b.id));
    const propose = payload.variantes[0].beats.find((b) => b.id === cible.externalId)!;
    propose.texte = "Version proposée par l'agent, en concurrence avec celle de la rédaction.";

    const prep = await callTool(actor, "submit_script", { projectId, payload });
    expect(prep.diff.conflicts.map((c: { externalId: string }) => c.externalId)).toContain(cible.externalId);

    const r = await callTool(actor, "apply_script", { journalId: prep.journalId, variantId: prep.variantId });
    expect(r.ok).toBe(true);

    const [apres] = await db.select().from(scriptBeats).where(eq(scriptBeats.id, cible.id));
    // Le point : un conflit ne se tranche jamais tout seul.
    expect(apres.spokenText).toContain("rédaction");
  }, 30_000);

  it("apply_script refuse une entrée préparée hors du canal MCP", async () => {
    // Un humain prépare un import dans l'application, ne l'applique pas, et colle l'identifiant de
    // journal dans son chat. Sans refus, l'outil se replierait sur la valeur COURANTE de
    // `variant.updatedAt` — relue juste avant la comparaison, donc égale par construction : le
    // contrôle de péremption ne pourrait plus jamais différer, et une édition humaine postérieure
    // serait écrasée. Une garde qui ne peut pas échouer n'est pas une garde.
    const avant = await db.select().from(scriptBeats)
      .where(eq(scriptBeats.variantId, variantId)).orderBy(asc(scriptBeats.position));
    const payload = structuredClone(EXAMPLE_PAYLOAD);
    payload.variantes[0].beats = payload.variantes[0].beats
      .filter((b) => avant.some((x) => x.externalId === b.id));
    payload.variantes[0].beats[0].texte = "Texte que cette entrée poserait si elle était appliquée.";

    const humain = await prepareImportCore({
      projectId: projectId!, variantId, raw: JSON.stringify(payload),
      userId: actor.userId, source: "copier_coller",
    });
    expect(humain.ok).toBe(true);
    if (!humain.ok) throw new Error("préparation humaine inattendue en échec");

    const r = await callTool(actor, "apply_script", { journalId: humain.journalId, variantId });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("hors du canal MCP");

    // Et rien n'a bougé.
    const apres = await db.select().from(scriptBeats)
      .where(eq(scriptBeats.variantId, variantId)).orderBy(asc(scriptBeats.position));
    expect(apres.map((b) => b.spokenText)).toEqual(avant.map((b) => b.spokenText));
  }, 30_000);

  it("chaque écriture est journalisée avec sa source, son outil et son auteur", async () => {
    const rows = await db.select().from(scriptJournal).where(eq(scriptJournal.projectId, projectId!));
    const mcp = rows.filter((r) => r.source === "mcp");
    expect(mcp.length).toBeGreaterThan(0);
    expect(mcp[0].toolName).toBeString();
    expect(mcp[0].actorUserId).toBe(actor.userId);
    expect(mcp[0].toolArgs).not.toBeNull();
  }, 30_000);

  it("une application par agent reste « non relue »", async () => {
    const rows = await db.select().from(scriptJournal).where(eq(scriptJournal.projectId, projectId!));
    const applied = rows.filter((r) => r.source === "mcp" && r.outcome === "applique");
    expect(applied.length).toBeGreaterThan(0);
    expect(applied.every((r) => r.reviewedAt === null)).toBe(true);
  }, 30_000);

  // ── Round de correction final, C1 ──────────────────────────────────────────
  // Le test qui manquait, et qui aurait attrapé le défaut : `get_script` rendait le vocabulaire
  // INTERNE (`id` = l'UUID de ligne, `kind`, `spokenText`, `directionNote`…) alors que le contrat
  // attend `id` = l'externalId, `type`, `texte`, `note_realisation`… L'agent qui lit, révise et
  // resoumet en reportant `id` → `id` envoyait des UUID comme identifiants de beats ; un UUID
  // satisfait BEAT_ID_RE, donc rien ne le refusait. computeMerge y voyait N suppressions et N
  // ajouts ; les suppressions ne s'appliquent pas par défaut, les ajouts oui — et le script était
  // DUPLIQUÉ, sans erreur visible nulle part. C'est exactement le mode d'échec que get_script
  // existait pour supprimer.
  it("aller-retour get_script → submit_script : la charge utile relue, resoumise telle quelle, ne produit AUCUN diff", async () => {
    const cree = await callTool(actor, "create_video_project", {
      title: "Test MCP — aller-retour", platform: "youtube_long", targetDurationSec: 720,
    });
    projetAllerRetour = cree.projectId;

    const prep = await callTool(actor, "submit_script", { projectId: cree.projectId, payload: EXAMPLE_PAYLOAD });
    expect(prep.ok).toBe(true);
    const applique = await callTool(actor, "apply_script", { journalId: prep.journalId, variantId: prep.variantId });
    expect(applique.ok).toBe(true);
    expect(applique.applied).toBe(EXAMPLE_PAYLOAD.variantes[0].beats.length);

    const lu = await callTool(actor, "get_script", { variantId: prep.variantId });

    // 1. Ce qui est rendu EST le contrat — pas une forme qui lui ressemble.
    expect(payloadSchema.safeParse(lu.payload).success).toBe(true);
    const beatLu = lu.payload.variantes[0].beats[0];
    expect(Object.keys(beatLu).sort()).toEqual(Object.keys(beatPayloadSchema.shape).sort());
    const insertLu = lu.payload.variantes[0].beats
      .flatMap((b: { inserts: unknown[] }) => b.inserts)[0] as Record<string, unknown>;
    expect(Object.keys(insertLu).sort()).toEqual(Object.keys(insertPayloadSchema.shape).sort());
    // `id` est l'identifiant du CONTRAT, jamais l'UUID de ligne.
    expect(lu.payload.variantes[0].beats.map((b: { id: string }) => b.id))
      .toEqual(EXAMPLE_PAYLOAD.variantes[0].beats.map((b) => b.id));

    // 2. L'UUID reste accessible — sous un nom qui ne peut pas être confondu avec la clé du
    //    contrat, et qui est exactement l'argument attendu par update_beat / update_insert.
    const interne = lu.identifiantsInternes.find((x: { id: string }) => x.id === beatLu.id);
    expect(interne.beatId).toMatch(/^[0-9a-f-]{36}$/);
    await callTool(actor, "update_beat", { beatId: interne.beatId, spokenText: beatLu.texte });

    // 3. LE point : resoumettre ce qu'on vient de lire, sans y toucher, ne propose RIEN.
    const relu = await callTool(actor, "get_script", { variantId: prep.variantId });
    const resoumis = await callTool(actor, "submit_script", {
      projectId: cree.projectId, payload: relu.payload,
    });
    expect(resoumis.ok).toBe(true);
    expect(resoumis.diff.added).toEqual([]);
    expect(resoumis.diff.modified).toEqual([]);
    expect(resoumis.diff.conflicts).toEqual([]);
    expect(resoumis.diff.removed).toEqual([]);

    // 4. Et le script n'a pas doublé : c'était le symptôme silencieux.
    const beats = await db.select().from(scriptBeats).where(eq(scriptBeats.variantId, prep.variantId));
    expect(beats.length).toBe(EXAMPLE_PAYLOAD.variantes[0].beats.length);
  }, 60_000);

  it("un porteur sans droit d'écriture est refusé", async () => {
    lecteur = await makeActor("journalist", { revokeVideoManage: true });
    await expect(callTool(lecteur, "update_beat", { beatId: crypto.randomUUID(), spokenText: "x" }))
      .rejects.toThrow();
  }, 30_000);

  it("un porteur sans droit d'écriture garde ses lectures", async () => {
    // La garde porte sur les écritures, pas sur l'outil : sans ce test, refuser TOUT passerait.
    const r = await callTool(lecteur!, "list_video_projects", {});
    expect(Array.isArray(r)).toBe(true);
  }, 30_000);

  it("l'annulation n'est pas exposée", async () => {
    await expect(callTool(actor, "revert_journal_entry", { journalId: crypto.randomUUID() }))
      .rejects.toThrow();
  }, 30_000);
});
