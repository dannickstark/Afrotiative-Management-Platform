import { z } from "zod";
import { and, asc, desc, eq, ilike, inArray } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  db, articles, beatInserts, scriptBeats, scriptJournal, scriptVariants, videoCategories, videoProjects,
} from "@/db";
import { TOOL_REGISTRY, type ToolSpec } from "@/lib/mcp/registry";
import { requirePermission } from "@/lib/rbac";
import type { McpActor } from "@/lib/mcp/auth";
import { refusPourPortee } from "@/lib/mcp/scope";
import {
  applyImportCore, createVideoProjectCore, prepareImportCore, readScriptCore, reorderBeatsCore,
  updateBeatCore, updateBeatInsertCore,
} from "@/lib/video/persist";
import { buildBrief } from "@/lib/video/brief";
import { getVideoSettings } from "@/lib/queries/video-settings";
import { briefVarsFor, listVideoProjects } from "@/lib/queries/video";
import { getBriefCategory, listVideoCategoryOptions } from "@/lib/queries/video-categories";
import { getArticle } from "@/lib/queries/article";
import { payloadSchema, type Payload } from "@/lib/video/schema";
import { defaultAccept, type Diff } from "@/lib/video/import";

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
        // Le RÔLE d'abord, la PORTÉE ensuite : la portée d'un jeton ne doit jamais pouvoir accorder
        // ce que le rôle refuse — elle ne fait que retirer (lib/mcp/scope.ts).
        if (spec.kind === "ecriture") requirePermission(actor.role, "video", "manage");
        const refus = refusPourPortee(spec, actor.scope);
        if (refus) throw new Error(refus);
        const payload = await dispatch(spec.name, args, actor);
        return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
      },
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Journal
// ─────────────────────────────────────────────────────────────────────────────

// `submit_script` passe désormais `toolName`/`toolArgs` directement à `prepareImportCore`, qui les
// écrit avec la ligne. Cette apposition ne sert plus qu'à `apply_script` : submit et apply agissent
// sur la MÊME ligne de journal (le cœur la fait passer d'"en_attente" à "applique", il n'en crée pas
// une seconde), et `toolName` porte donc le dernier outil qui l'a touchée. L'appelant est tenu de
// reporter les clés qu'il ne veut pas perdre — `variantUpdatedAt` au premier chef.
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

// Le brief remis à l'agent, construit à partir des MÊMES variables que celui affiché à l'humain :
// `briefVarsFor` (lib/queries/video.ts) est le producteur unique depuis le round de correction 2 (I4).
// Les deux chemins les assemblaient auparavant ligne à ligne et auraient divergé à la première
// retouche — l'agent aurait écrit sous un brief que personne ne voit.
async function construireBrief(projectId: string, variantId?: string): Promise<{
  brief: string; variantId: string | null;
}> {
  const [project] = await db.select().from(videoProjects).where(eq(videoProjects.id, projectId));
  if (!project) throw new Error("Projet introuvable.");

  const variants = await variantesDuProjet(projectId);
  const variant = (variantId ? variants.find((v) => v.id === variantId) : variants[0]) ?? null;

  const vars = await briefVarsFor(project, variant);
  const settings = await getVideoSettings();
  // L'agent reçoit EXACTEMENT le brief affiché à l'humain, instructions de catégorie comprises :
  // même producteur (buildBrief), mêmes entrées. Sans cette ligne, l'agent écrirait sous un brief
  // que personne ne voit.
  const category = await getBriefCategory(project.categoryId);
  return { brief: buildBrief(settings.briefTemplate, vars, category).text, variantId: variant?.id ?? null };
}

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
      // Rendu par le CŒUR (readScriptCore), dans le vocabulaire du CONTRAT, et non recomposé ici à
      // la main (round de correction final, C1). L'ancienne version rendait le vocabulaire interne
      // pour les beats (`id` = l'UUID de ligne, `kind`, `spokenText`, `directionNote`…) et celui du
      // contrat pour les inserts (`type`, `tc_in`, `droits`) : DEUX conventions dans une seule charge
      // utile. L'agent qui lisait, révisait et resoumettait en reportant `id` → `id` envoyait des
      // UUID comme identifiants de beats ; un UUID satisfait BEAT_ID_RE, donc rien ne le refusait,
      // computeMerge y voyait N suppressions (non appliquées par défaut) et N ajouts (appliqués) —
      // le script était DUPLIQUÉ, sans erreur visible. `payload` se resoumet désormais tel quel à
      // `submit_script`, et un test d'aller-retour verrouille le diff vide.
      const script = await readScriptCore(args.variantId as string);
      if (!script) throw new Error("Variante introuvable.");
      return script;
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

    case "list_video_categories": {
      // Projection à TROIS champs seulement (id, nom, description) — jamais `instructions`. Ce
      // sont des instructions éditoriales, gardées par la permission `video`/`configure`, alors
      // que les outils MCP de lecture n'exigent que `video`/`read` (voir registerTools) : les
      // rendre ici accorderait à tout porteur d'un jeton API un accès à du contenu qui exige
      // ailleurs un droit supérieur. L'agent reçoit les instructions par la voie prévue — le brief
      // — une fois le projet effectivement rattaché à la catégorie. Ne PAS "utilement" ajouter
      // `instructions` à cette réponse : ce serait recréer le contournement que cette séparation
      // existe pour empêcher.
      return listVideoCategoryOptions();
    }

    // ── Écritures ─────────────────────────────────────────────────────────
    case "create_video_project": {
      const categoryId = (args.categoryId as string | undefined) ?? null;
      // Pré-lecture délibérée avant l'écriture, malgré la fenêtre de concurrence qu'elle laisse
      // ouverte (une catégorie supprimée entre ce SELECT et l'INSERT ferait alors échouer la
      // contrainte de clé étrangère malgré tout) : l'alternative est de laisser remonter à l'agent
      // une violation Postgres brute, qu'il ne peut ni comprendre ni corriger. Un refus explicite
      // et français ("Catégorie introuvable.") est actionnable ; une erreur SQL ne l'est pas.
      if (categoryId) {
        const [cat] = await db.select({ id: videoCategories.id }).from(videoCategories)
          .where(eq(videoCategories.id, categoryId));
        if (!cat) throw new Error("Catégorie introuvable.");
      }
      const projectId = await createVideoProjectCore({
        title: args.title as string,
        subject: (args.subject as string | undefined) ?? null,
        platform: args.platform as string,
        targetDurationSec: (args.targetDurationSec as number | undefined) ?? null,
        // Même défaut que la boîte de dialogue de création (components/video/new-project-dialog.tsx) :
        // "16:9", fixe.
        aspectRatio: (args.aspectRatio as string | undefined) ?? "16:9",
        articleId: (args.articleId as string | undefined) ?? null,
        categoryId,
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

      // `variantUpdatedAt` mémorisé dans `toolArgs` : c'est l'état de la variante sur lequel ce diff
      // a été calculé. apply_script le rendra au cœur, dont le contrôle de péremption compare par
      // égalité stricte. Sans cette mémoire, apply_script relirait la valeur du moment et le contrôle
      // ne pourrait plus rien détecter — une édition humaine survenue entre les deux appels serait
      // écrasée en silence.
      //
      // Passés AU cœur (round de correction 2, I2) plutôt qu'apposés après coup : sur un rejet, le
      // cœur ne rend aucun identifiant de ligne, et retrouver « la plus récente du projet » pouvait
      // écrire ces arguments sur l'entrée d'un import concurrent — donc lui donner la mémoire d'un
      // AUTRE état de variante. La ligne est désormais écrite juste, du premier coup.
      //
      // `raw` est une chaîne côté cœur : `prepareImportCore` la journalise telle quelle en cas de
      // JSON illisible. Le payload MCP arrive déjà désérialisé, on le re-sérialise donc — l'aller-
      // retour est sans perte sur une valeur issue de JSON.
      const toolArgs = { projectId, variantId, variantUpdatedAt: variant.updatedAt.toISOString() };
      const result = await prepareImportCore({
        projectId, variantId, raw: JSON.stringify(payload), userId: actor.userId, source: "mcp",
        toolName: name, toolArgs,
      });

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
      // était au submit (mémorisé alors dans `toolArgs`). AUCUN repli sur la valeur du moment : relue
      // juste avant la comparaison, elle serait égale par construction et le contrôle ne pourrait
      // plus jamais différer — une garde qui ne peut pas échouer est un décor. Une entrée préparée
      // hors du canal MCP (un humain, dans l'application) n'a pas cette mémoire : on la refuse, elle
      // s'applique depuis l'écran où elle a été préparée et où son diff est visible.
      const memorise = (entry.toolArgs as { variantUpdatedAt?: string } | null)?.variantUpdatedAt;
      if (entry.source !== "mcp" || !memorise) {
        return {
          ok: false,
          message: "Cette entrée de journal a été préparée hors du canal MCP : applique-la depuis l'application, ou resoumets le script par submit_script.",
        };
      }
      const variantUpdatedAt = new Date(memorise);

      // LA règle produit (ajouts et modifications retenus, jamais les suppressions ni les conflits)
      // vient de lib/video/import.ts#defaultAccept — la MÊME fonction que la revue humaine
      // (components/video/diff-review.tsx), pas une seconde copie (round de correction final, I1).
      // C'est le garde-fou n°1 contre l'effacement d'un beat par omission, et il s'applique ici sans
      // aucune revue humaine : le voir diverger de l'autre canal était le risque le plus coûteux.
      const diff = entry.diff as unknown as Partial<Diff>;
      const accept = (args.accept as string[] | undefined) ?? defaultAccept(diff);

      const result = await applyImportCore({ journalId, variantId, accept, variantUpdatedAt });

      // L'apposition n'a lieu QU'APRÈS un succès, et elle CONSERVE `variantUpdatedAt` (round de
      // correction 2, C1). Un refus du cœur (« aperçu périmé ») annule sa transaction : l'entrée
      // reste "en_attente", donc applicable. Écraser `toolArgs` au passage effaçait la mémoire de
      // l'état d'origine — au second essai, l'outil se repliait sur la valeur COURANTE de la
      // variante, le contrôle ne pouvait plus différer, et l'édition humaine qui venait d'être
      // signalée était écrasée sans que personne ne l'ait vue.
      if (!result.ok) return { ok: false, message: result.message };
      await apposerOutil(journalId, name, {
        ...(entry.toolArgs ?? {}), journalId, variantId, accept,
      });

      // L'ordre RÉELLEMENT en base après application — pas celui que la fusion visait : c'est ce que
      // l'agent doit reprendre pour son prochain envoi.
      const beats = await db.select({ externalId: scriptBeats.externalId }).from(scriptBeats)
        .where(eq(scriptBeats.variantId, variantId)).orderBy(asc(scriptBeats.position));
      return { ok: true, applied: result.applied, order: beats.map((b) => b.externalId) };
    }

    case "update_beat": {
      const beatId = args.beatId as string;
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
      // `order` porte les `externalId` du contrat, exactement ce que `reorderBeatsCore` apparie
      // (`script_beats.external_id`) : aucune traduction, on passe au cœur tel quel.
      //
      // Le seul contrôle est celui du périmètre : le cœur apparie par `UPDATE ... WHERE
      // external_id = ...`, donc un identifiant inconnu n'affecte aucune ligne — il serait ignoré
      // en silence et l'agent croirait avoir réordonné ce qu'il n'a pas touché.
      const connus = new Set((await db.select({ externalId: scriptBeats.externalId }).from(scriptBeats)
        .where(eq(scriptBeats.variantId, variantId))).map((b) => b.externalId));
      const inconnus = order.filter((externalId) => !connus.has(externalId));
      if (inconnus.length > 0) {
        throw new Error(`Beats absents de cette variante : ${inconnus.join(", ")}.`);
      }

      await reorderBeatsCore({ variantId, order });
      await journaliserEcritureDirecte({
        projectId: await projetDeLaVariante(variantId), variantId, toolName: name,
        toolArgs: args, actorUserId: actor.userId,
      });
      return { ok: true, order };
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
