import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, scriptVariants, scriptBeats, scriptJournal } from "@/db";
import { asc, eq } from "drizzle-orm";
import { EXAMPLE_PAYLOAD } from "@/lib/video/schema";
import { callTool, makeActor, cleanupProject, type TestActor } from "./mcp-harness";

let projectId: string | undefined;
let variantId: string;
let actor: TestActor;
// Déclaré ici, et non dans le test qui le crée : la base Neon est PARTAGÉE, donc le nettoyage doit
// avoir lieu même si le test échoue en cours de route.
let lecteur: TestActor | null = null;

beforeAll(async () => { actor = await makeActor("editor"); });
afterAll(async () => {
  await cleanupProject(projectId);
  if (lecteur) await lecteur.cleanup();
  if (actor) await actor.cleanup();
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
    await callTool(actor, "apply_script", { journalId: prep2.journalId, variantId });

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
