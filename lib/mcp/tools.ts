import { z } from "zod";
import { and, asc, desc, eq, ilike, inArray } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  db, articles, beatInserts, distributions, scriptBeats, scriptJournal, scriptVariants, videoProjects,
} from "@/db";
import { TOOL_REGISTRY, type ToolSpec } from "@/lib/mcp/registry";
import { requirePermission } from "@/lib/rbac";
import type { McpActor } from "@/lib/mcp/auth";
import {
  applyImportCore, createVideoProjectCore, prepareImportCore, reorderBeatsCore, updateBeatCore,
  updateBeatInsertCore,
} from "@/lib/video/persist";
import { buildBrief, type BriefVars } from "@/lib/video/brief";
import { getVideoSettings } from "@/lib/queries/video-settings";
import { getVariantBeats, listVideoProjects } from "@/lib/queries/video";
import { getArticle } from "@/lib/queries/article";
import { payloadSchema, type Payload } from "@/lib/video/schema";
import type { Diff } from "@/lib/video/import";
import { getWpConfig } from "@/lib/wp/config";
import { wpPostUrl } from "@/lib/wp/post-url";

// Ce module ne contient AUCUNE logique de contrat, de fusion ni de persistance : il traduit un
// appel d'outil en appel du cœur du SP1, et rien d'autre. C'est la raison pour laquelle
// lib/video/persist.ts n'a jamais reçu de directive "use server".
//
// Corollaire de conception : AUCUN `db.transaction` ici. L'ordre de verrouillage
// (`video_projects` < `script_variants` < `script_journal` < `script_beats` < `beat_inserts`,
// `FOR UPDATE` sur la variante en tête) est tenu par le cœur, qui a demandé quatre rounds de
// correction pour éliminer deux interblocages ABBA. Une transaction ouverte ici rouvrirait ce
// cycle. Les seules écritures directes de ce fichier portent sur `script_journal` — une ligne, hors
// de la chaîne des beats, et jamais dans la même transaction qu'une écriture du cœur.

// ─────────────────────────────────────────────────────────────────────────────
// Schémas d'enregistrement
// ─────────────────────────────────────────────────────────────────────────────

// Le contrat, tel qu'annoncé dans `tools/list`. `$schema` retiré : il serait imbriqué à l'intérieur
// du schéma d'entrée de l'outil, où il n'a pas de sens.
const CONTRAT_JSON: Record<string, unknown> = (() => {
  const json = z.toJSONSchema(payloadSchema, { io: "input" }) as Record<string, unknown>;
  delete json.$schema;
  return json;
})();

// Le payload est ANNONCÉ strictement (le contrat ci-dessus part tel quel dans `tools/list`) mais
// n'est PAS validé par le SDK : c'est `parseIncoming` (lib/video/import.ts), appelé par le cœur, qui
// le valide et rend `path` / `message` / `received` pour chaque erreur. Laisser le SDK valider
// transformerait ce rapport structuré en une seule erreur JSON-RPC -32602 au message aplati : l'agent
// perdrait précisément ce qui lui permet de se corriger et de resoumettre — tout l'intérêt du MCP
// par rapport au copier-coller. Le registre (lib/mcp/registry.ts) reste la source unique de vérité :
// on n'en change pas le contenu, seulement le validateur qui l'applique.
const payloadTolerant = z.unknown().meta(CONTRAT_JSON);

function schemaEnregistrable(spec: ToolSpec): z.ZodRawShape {
  if (!("payload" in spec.inputSchema)) return spec.inputSchema;
  return { ...spec.inputSchema, payload: payloadTolerant };
}

export function registerTools(server: McpServer, actor: McpActor): void {
  for (const spec of TOOL_REGISTRY) {
    server.registerTool(
      spec.name,
      { title: spec.name, description: spec.description, inputSchema: schemaEnregistrable(spec) },
      async (args: Record<string, unknown>) => {
        if (spec.kind === "ecriture") requirePermission(actor.role, "video", "manage");
        const payload = await dispatch(spec.name, args, actor);
        return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
      },
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Journal
// ─────────────────────────────────────────────────────────────────────────────

// Les écritures d'import (submit_script / apply_script) sont déjà journalisées par le cœur, qui
// écrit `source`, `actorUserId`, le payload brut et le diff. Il ne connaît en revanche ni le nom de
// l'outil ni ses arguments : on les appose ici, sur la ligne qu'il vient d'écrire. `toolName` porte
// le DERNIER outil qui a touché l'entrée (submit puis apply agissent sur la même ligne de journal —
// c'est le cœur qui la fait passer d'"en_attente" à "applique", il n'en crée pas une seconde).
async function apposerOutil(
  journalId: string, toolName: string, toolArgs: Record<string, unknown>,
): Promise<void> {
  await db.update(scriptJournal).set({ toolName, toolArgs }).where(eq(scriptJournal.id, journalId));
}

// Les écritures DIRECTES (création de projet, retouche de beat, réordonnancement, correction
// d'insert) ne passent par aucun journal côté cœur : sans cette ligne, l'activité d'un agent serait
// invisible dans l'historique du projet. `diff`/`applied` restent vides — il n'y a pas de fusion à
// décrire, seulement un acte à attribuer.
async function journaliserEcritureDirecte(args: {
  projectId: string; variantId: string | null; toolName: string;
  toolArgs: Record<string, unknown>; actorUserId: string;
}): Promise<void> {
  await db.insert(scriptJournal).values({
    projectId: args.projectId,
    variantId: args.variantId,
    source: "mcp",
    toolName: args.toolName,
    toolArgs: args.toolArgs,
    actorUserId: args.actorUserId,
    schemaVersion: null,
    rawPayload: null,
    errorReport: [],
    diff: {},
    applied: {},
    outcome: "applique",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Résolutions (lectures d'appoint)
// ─────────────────────────────────────────────────────────────────────────────

async function variantesDuProjet(projectId: string) {
  return db.select().from(scriptVariants)
    .where(eq(scriptVariants.projectId, projectId))
    .orderBy(asc(scriptVariants.position));
}

async function projetDeLaVariante(variantId: string): Promise<string> {
  const [v] = await db.select({ projectId: scriptVariants.projectId }).from(scriptVariants)
    .where(eq(scriptVariants.id, variantId));
  if (!v) throw new Error("Variante introuvable.");
  return v.projectId;
}

async function localiserBeat(beatId: string): Promise<{ variantId: string; projectId: string }> {
  const [b] = await db.select({ variantId: scriptBeats.variantId }).from(scriptBeats)
    .where(eq(scriptBeats.id, beatId));
  if (!b) throw new Error("Beat introuvable.");
  return { variantId: b.variantId, projectId: await projetDeLaVariante(b.variantId) };
}

// Le brief, construit exactement comme la page projet le fait (app/(app)/video/[id]/page.tsx) :
// mêmes variables, même repli « gracieux » sur l'URL publique de l'article, qui n'existe qu'après
// diffusion WordPress. La plateforme part en valeur brute (`youtube_long`) et non en libellé : le
// libellé vit dans un composant client, qu'un module serveur n'a pas à importer.
async function construireBrief(projectId: string, variantId?: string): Promise<{
  brief: string; variantId: string | null;
}> {
  const [project] = await db.select().from(videoProjects).where(eq(videoProjects.id, projectId));
  if (!project) throw new Error("Projet introuvable.");

  const variants = await variantesDuProjet(projectId);
  const variant = variantId ? variants.find((v) => v.id === variantId) : variants[0];

  let articleTitre = "";
  let articleUrl = "";
  let articleExtrait = "";
  if (project.articleId) {
    const [article] = await db.select().from(articles).where(eq(articles.id, project.articleId));
    if (article) {
      articleTitre = article.title;
      articleExtrait = article.excerpt ?? "";
      const [dist] = await db.select().from(distributions)
        .where(and(eq(distributions.articleId, project.articleId), eq(distributions.channel, "wordpress")))
        .limit(1);
      articleUrl = wpPostUrl(getWpConfig()?.baseUrl ?? null, dist?.externalId ?? null) ?? "";
    }
  }

  const vars: BriefVars = {
    titre: project.title,
    sujet: project.subject ?? "",
    plateforme: variant?.platform ?? "",
    duree_cible: variant?.targetDurationSec ? `${Math.round(variant.targetDurationSec / 60)} min` : "",
    ratio: variant?.aspectRatio ?? "",
    article_titre: articleTitre,
    article_url: articleUrl,
    article_extrait: articleExtrait,
  };

  const settings = await getVideoSettings();
  return { brief: buildBrief(settings.briefTemplate, vars).text, variantId: variant?.id ?? null };
}

// Cadrage par défaut quand l'agent ne le précise pas : vertical pour les formats courts, horizontal
// sinon. Même règle que celle qu'un humain applique dans la boîte de dialogue de création.
const RATIO_PAR_DEFAUT: Record<string, string> = {
  youtube_long: "16:9", interview: "16:9", youtube_short: "9:16", tiktok: "9:16", reel: "9:16",
};

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────────────────────────────────────

async function dispatch(
  name: string, args: Record<string, unknown>, actor: McpActor,
): Promise<unknown> {
  switch (name) {
    // ── Lectures ──────────────────────────────────────────────────────────
    case "list_video_projects":
      return listVideoProjects();

    case "get_script": {
      const variantId = args.variantId as string;
      const beats = await getVariantBeats(variantId);
      return beats.map((b) => ({
        id: b.id,
        externalId: b.externalId,
        position: b.position,
        kind: b.kind,
        spokenText: b.spokenText,
        directionNote: b.directionNote,
        screenText: b.screenText,
        transitionIn: b.transitionIn,
        transitionOut: b.transitionOut,
        sources: b.sources,
        estimatedDurationSec: b.durationOverrideSec ?? b.estimatedDurationSec,
        inserts: b.inserts.map((i) => ({
          id: i.id, type: i.kind, url: i.url, tc_in: i.tcIn, tc_out: i.tcOut,
          duree_affichage_sec: i.displayDurationSec, credit: i.credit, droits: i.rightsNote,
          linkStatus: i.linkStatus,
        })),
      }));
    }

    case "get_video_brief": {
      const projectId = args.projectId as string;
      const { brief, variantId } = await construireBrief(projectId);
      return { projectId, variantId, brief };
    }

    case "list_articles": {
      const search = args.search as string | undefined;
      const limit = (args.limit as number | undefined) ?? 20;
      return db.select({
        id: articles.id, title: articles.title, excerpt: articles.excerpt,
        status: articles.status, updatedAt: articles.updatedAt,
      }).from(articles)
        .where(and(
          inArray(articles.status, ["approved", "published"]),
          search ? ilike(articles.title, `%${search}%`) : undefined,
        ))
        .orderBy(desc(articles.updatedAt))
        .limit(limit);
    }

    case "get_article": {
      const article = await getArticle(args.articleId as string);
      if (!article) throw new Error("Article introuvable.");
      return {
        id: article.id, title: article.title, excerpt: article.excerpt,
        bodyHtml: article.bodyHtml, status: article.status,
        sources: article.sources.map((s) => ({ media: s.mediaName, url: s.url })),
      };
    }

    // ── Écritures ─────────────────────────────────────────────────────────
    case "create_video_project": {
      const platform = args.platform as string;
      const projectId = await createVideoProjectCore({
        title: args.title as string,
        subject: (args.subject as string | undefined) ?? null,
        platform,
        targetDurationSec: (args.targetDurationSec as number | undefined) ?? null,
        aspectRatio: (args.aspectRatio as string | undefined) ?? RATIO_PAR_DEFAUT[platform] ?? "16:9",
        articleId: (args.articleId as string | undefined) ?? null,
        userId: actor.userId,
      });
      // Le brief part dans la MÊME réponse que la création : c'est ce qui évite à l'agent un
      // aller-retour pour connaître le contrat auquel sa prochaine réponse doit obéir.
      const { brief, variantId } = await construireBrief(projectId);
      await journaliserEcritureDirecte({
        projectId, variantId, toolName: name, toolArgs: args, actorUserId: actor.userId,
      });
      return { projectId, variantId, brief };
    }

    case "submit_script": {
      const projectId = args.projectId as string;
      const payload = args.payload;

      // Résolution du variantId : celui fourni, sinon la variante dont la plateforme correspond à
      // celle du payload, sinon la première du projet. Il est RENDU à l'agent parce qu'il en a
      // besoin pour enchaîner sur apply_script — sans lui, il devrait le deviner.
      const variants = await variantesDuProjet(projectId);
      if (variants.length === 0) throw new Error("Ce projet n'a aucune variante.");
      const plateformeVoulue = (payload as Partial<Payload> | null)?.variantes?.[0]?.plateforme;
      const variant = variants.find((v) => v.id === (args.variantId as string | undefined))
        ?? variants.find((v) => v.platform === plateformeVoulue)
        ?? variants[0];
      const variantId = (args.variantId as string | undefined) ?? variant.id;

      // `raw` est une chaîne côté cœur : `prepareImportCore` la journalise telle quelle en cas de
      // JSON illisible. Le payload MCP arrive déjà désérialisé, on le re-sérialise donc — l'aller-
      // retour est sans perte sur une valeur issue de JSON.
      const result = await prepareImportCore({
        projectId, variantId, raw: JSON.stringify(payload), userId: actor.userId, source: "mcp",
      });

      // `variantUpdatedAt` mémorisé dans `toolArgs` : c'est l'état de la variante sur lequel ce diff
      // a été calculé. apply_script le rendra au cœur, dont le contrôle de péremption compare par
      // égalité stricte. Sans cette mémoire, apply_script relirait la valeur du moment et le contrôle
      // ne pourrait plus rien détecter — une édition humaine survenue entre les deux appels serait
      // écrasée en silence.
      const toolArgs = { projectId, variantId, variantUpdatedAt: variant.updatedAt.toISOString() };

      // Journalisé dans les DEUX cas : un rejet de validation est justement ce qu'un humain doit
      // pouvoir relire quand un agent tourne en rond. En rejet, le cœur n'a rendu aucun identifiant
      // de ligne — on retrouve celle qu'il vient d'écrire par la plus récente du projet.
      const journalId = result.ok ? result.journalId : await derniereEntree(projectId);
      if (journalId) await apposerOutil(journalId, name, toolArgs);

      if (!result.ok) return { ok: false, issues: result.issues };
      return { ok: true, journalId: result.journalId, variantId, diff: result.diff };
    }

    case "apply_script": {
      const journalId = args.journalId as string;
      const variantId = args.variantId as string;

      const [entry] = await db.select().from(scriptJournal).where(eq(scriptJournal.id, journalId));
      if (!entry) return { ok: false, message: "Entrée de journal introuvable." };
      const [variant] = await db.select().from(scriptVariants).where(eq(scriptVariants.id, variantId));
      if (!variant) return { ok: false, message: "Variante introuvable." };

      // Péremption : le contrôle est celui du cœur, à qui l'on rend l'état de la variante tel qu'il
      // était au submit (mémorisé alors dans `toolArgs`). Relire la valeur du moment reviendrait à
      // désarmer le contrôle — il ne pourrait plus jamais différer. Le repli sur la valeur courante
      // ne concerne que les entrées écrites avant cette mémorisation.
      const memorise = (entry.toolArgs as { variantUpdatedAt?: string } | null)?.variantUpdatedAt;
      const variantUpdatedAt = memorise ? new Date(memorise) : variant.updatedAt;

      // LA règle produit : sans sélection explicite, on applique les ajouts et les modifications,
      // JAMAIS les suppressions ni les conflits. Un modèle qui abrège sa réponse ne doit pas pouvoir
      // effacer un beat par omission, et un conflit ne se tranche jamais tout seul.
      const diff = entry.diff as unknown as Diff;
      const accept = (args.accept as string[] | undefined) ?? [
        ...(diff.added ?? []).map((a) => a.externalId),
        ...(diff.modified ?? []).map((m) => m.externalId),
      ];

      const result = await applyImportCore({ journalId, variantId, accept, variantUpdatedAt });
      await apposerOutil(journalId, name, { journalId, variantId, accept });
      if (!result.ok) return { ok: false, message: result.message };

      // L'ordre RÉELLEMENT en base après application — pas celui que la fusion visait : c'est ce que
      // l'agent doit reprendre pour son prochain envoi.
      const beats = await db.select({ externalId: scriptBeats.externalId }).from(scriptBeats)
        .where(eq(scriptBeats.variantId, variantId)).orderBy(asc(scriptBeats.position));
      return { ok: true, applied: result.applied, order: beats.map((b) => b.externalId) };
    }

    case "update_beat": {
      const beatId = args.beatId as string;
      // Le registre annonce `kind`, que `updateBeatCore` ne sait pas écrire. Refus explicite plutôt
      // que silence : un agent qui croirait avoir changé le type d'un beat construirait la suite de
      // son script sur une fausse certitude. Le type se change par submit_script, qui repasse par la
      // fusion.
      if (args.kind !== undefined) {
        throw new Error("Le type d'un beat ne se change pas par update_beat : renvoie le beat corrigé par submit_script.");
      }
      const { variantId, projectId } = await localiserBeat(beatId);
      const beat = await updateBeatCore({
        beatId,
        spokenText: args.spokenText as string | undefined,
        directionNote: args.directionNote as string | null | undefined,
        screenText: args.screenText as string | null | undefined,
        transitionIn: args.transitionIn as string | null | undefined,
        transitionOut: args.transitionOut as string | null | undefined,
      });
      await journaliserEcritureDirecte({
        projectId, variantId, toolName: name, toolArgs: args, actorUserId: actor.userId,
      });
      return { ok: true, ...beat };
    }

    case "reorder_beats": {
      const variantId = args.variantId as string;
      const order = args.order as string[];
      // Le registre exige des UUID (les identifiants de LIGNE, ceux que rend get_script) tandis que
      // `reorderBeatsCore` travaille sur les `externalId` du contrat (« b-01-accroche »). La
      // traduction se fait ici, sur une lecture — c'est une adaptation d'interface, pas une règle.
      const beats = await db.select({ id: scriptBeats.id, externalId: scriptBeats.externalId })
        .from(scriptBeats).where(eq(scriptBeats.variantId, variantId));
      const parId = new Map(beats.map((b) => [b.id, b.externalId]));
      const externalIds = order.map((id) => {
        const externalId = parId.get(id);
        if (!externalId) throw new Error(`Beat « ${id} » absent de cette variante.`);
        return externalId;
      });

      await reorderBeatsCore({ variantId, order: externalIds });
      await journaliserEcritureDirecte({
        projectId: await projetDeLaVariante(variantId), variantId, toolName: name,
        toolArgs: args, actorUserId: actor.userId,
      });
      return { ok: true, order: externalIds };
    }

    case "update_insert": {
      const insertId = args.insertId as string;
      const [ins] = await db.select({ beatId: beatInserts.beatId }).from(beatInserts)
        .where(eq(beatInserts.id, insertId));
      if (!ins) throw new Error("Insert introuvable.");
      const { variantId, projectId } = await localiserBeat(ins.beatId);

      await updateBeatInsertCore({ insertId, url: args.url as string | null });
      await journaliserEcritureDirecte({
        projectId, variantId, toolName: name, toolArgs: args, actorUserId: actor.userId,
      });
      return { ok: true };
    }

    default:
      // Inatteignable : le dispatch est piloté par TOOL_REGISTRY, et un test vérifie que chaque
      // outil du registre y a sa branche. Le garde existe pour que l'ajout d'un outil au registre
      // sans branche ici échoue bruyamment plutôt que de renvoyer `undefined`.
      throw new Error(`Outil sans implémentation : ${name}`);
  }
}

// `prepareImportCore` écrit sa ligne de journal lui-même et ne rend son identifiant qu'en cas de
// succès — sur un rejet, il n'y a pas d'autre moyen de retrouver la ligne qu'il vient d'écrire que
// de relire la plus récente du projet. Lecture immédiatement consécutive à l'écriture, sur la même
// base : la fenêtre de course est celle d'un second import du MÊME projet lancé dans l'intervalle,
// ce qui n'échangerait que l'étiquette d'outil de deux lignes par ailleurs identiques.
async function derniereEntree(projectId: string): Promise<string | null> {
  const [row] = await db.select({ id: scriptJournal.id }).from(scriptJournal)
    .where(eq(scriptJournal.projectId, projectId))
    .orderBy(desc(scriptJournal.createdAt)).limit(1);
  return row?.id ?? null;
}
