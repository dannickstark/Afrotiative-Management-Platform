import { db, videoProjects, scriptVariants, scriptBeats, beatInserts, scriptJournal, articles, distributions, interviewSpeakers } from "@/db";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { PLATFORM_LABEL } from "@/lib/video/labels";
import { getWpConfig } from "@/lib/wp/config";
import { wpPostUrl } from "@/lib/wp/post-url";
import type { BriefVars } from "@/lib/video/brief";

// Lectures pour les écrans du module vidéo. Aucune écriture ici — le cœur d'écriture vit dans
// lib/video/persist.ts.

/**
 * LES variables du brief, pour ses DEUX consommateurs : la page projet (app/(app)/video/[id]/page.tsx,
 * qui l'affiche à l'humain) et l'outil MCP (lib/mcp/tools.ts, qui le remet à l'agent). Rassemblées ici
 * au round de correction 1 de la Task 5 (SP1 bis) : les deux chemins construisaient le même objet
 * ligne à ligne — même arrondi en minutes, même repli sur l'URL WordPress — et auraient divergé à la
 * première retouche de l'un des deux, sans que rien ne le signale. L'agent aurait alors écrit sous un
 * brief que l'humain ne voit pas.
 *
 * Le repli sur l'URL de l'article est volontairement « gracieux » : l'URL publique n'existe qu'après
 * diffusion WordPress et n'est jamais reconstruite autrement.
 */
export async function briefVarsFor(
  project: { title: string; subject: string | null; articleId: string | null },
  variant: { platform: string; targetDurationSec: number | null; aspectRatio: string } | null,
): Promise<BriefVars> {
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

  return {
    titre: project.title,
    sujet: project.subject ?? "",
    plateforme: variant ? (PLATFORM_LABEL[variant.platform] ?? variant.platform) : "",
    duree_cible: variant?.targetDurationSec ? `${Math.round(variant.targetDurationSec / 60)} min` : "",
    ratio: variant?.aspectRatio ?? "",
    article_titre: articleTitre,
    article_url: articleUrl,
    article_extrait: articleExtrait,
  };
}

export type VideoProjectListRow = {
  id: string;
  title: string;
  status: string;
  platforms: string[];
  // Durée cumulée des beats de la VARIANTE DE TÊTE (la position la plus basse), pas la somme de
  // toutes les variantes : les variantes sont des rendus ALTERNATIFS d'une même histoire (un
  // montage YouTube de 10 min et un TikTok de 60 s), pas des segments qui s'additionnent. Additionner
  // faisait lire « 11:00 » sur /video pendant que /video/[id] affichait « 10:00 » un clic plus loin
  // (revue finale, F3). La variante de tête est déjà celle qui fixe le brief côté
  // app/(app)/video/[id]/page.tsx.
  estimatedSec: number;
  articleTitle: string | null;
  updatedAt: Date;
  // Task 8 — nombre d'écritures d'agent (source "mcp") de ce projet dont `reviewedAt` est encore
  // `null`. Le marqueur « non relue » : voir lib/video/persist.ts#markProjectReviewedCore.
  unreviewedCount: number;
  // Task 1 (SP 014 — UX pass) — ce qui réclame un humain, par projet. `deadLinkCount` et
  // `missingConsentCount` alimentent la colonne « À traiter » (Task 2) et se comptent bien sur TOUT
  // le projet. `targetSec`, lui, est la cible propre à la variante de tête — même portée
  // qu'`estimatedSec` ci-dessus, pour que les deux moitiés de la cellule « Durée / cible » parlent
  // du même montage. `null` quand cette variante n'a pas de cible (ou qu'il n'y a aucune variante).
  targetSec: number | null;
  deadLinkCount: number;
  missingConsentCount: number;
};

// Pure : la « variante de tête » d'un projet — celle de position la plus basse, celle que
// app/(app)/video/[id]/page.tsx tient déjà pour la variante de référence du brief. Départage à
// position égale par `id` pour rester déterministe (la contrainte d'unicité
// script_variants_project_position_uq rend le cas théorique, mais un tri instable ferait clignoter
// la colonne « Durée / cible » d'un rendu à l'autre). `null` pour un projet sans variante.
// Extraite pour être testable sans DB (voir tests/video-project-list.test.ts).
export function pickHeadVariant<T extends { id: string; position: number }>(variants: T[]): T | null {
  if (variants.length === 0) return null;
  return variants.reduce((head, v) => {
    if (v.position !== head.position) return v.position < head.position ? v : head;
    return v.id < head.id ? v : head;
  });
}

// Liste des projets avec la durée cumulée de leur variante de tête — consommée par l'écran /video
// (Task 10) et par l'outil MCP `list_video_projects` (lib/mcp/tools.ts).
export async function listVideoProjects(): Promise<VideoProjectListRow[]> {
  const projects = await db.select({
    id: videoProjects.id, title: videoProjects.title, status: videoProjects.status,
    updatedAt: videoProjects.updatedAt, articleTitle: articles.title,
  }).from(videoProjects)
    .leftJoin(articles, eq(videoProjects.articleId, articles.id))
    .orderBy(desc(videoProjects.updatedAt));

  if (projects.length === 0) return [];

  const projectIds = projects.map((p) => p.id);
  const variants = await db.select().from(scriptVariants).where(inArray(scriptVariants.projectId, projectIds));
  const variantIds = variants.map((v) => v.id);
  const beats = variantIds.length > 0
    ? await db.select({
      id: scriptBeats.id,
      variantId: scriptBeats.variantId,
      estimatedDurationSec: scriptBeats.estimatedDurationSec,
      durationOverrideSec: scriptBeats.durationOverrideSec,
    }).from(scriptBeats).where(inArray(scriptBeats.variantId, variantIds))
    : [];

  const durationByVariant = new Map<string, number>();
  for (const b of beats) {
    // Round de correction final, I2 : `durationOverrideSec ?? estimatedDurationSec`, la MÊME règle
    // que la vue Écriture (components/video/beat-list.tsx#storedSeconds) et que
    // lib/video/duration.ts#beatSeconds. Sommer `estimatedDurationSec` seul faisait afficher à
    // /video l'estimation d'un beat à durée forcée, pendant que /video/[id] en affichait l'override
    // — deux totaux contradictoires pour le même script. Spec §4 : « `durationOverrideSec`, quand
    // il est posé, l'emporte partout ». `??` et non `||` : une durée forcée à 0 (un beat muet) est
    // un choix humain légitime.
    const seconds = b.durationOverrideSec ?? b.estimatedDurationSec;
    durationByVariant.set(b.variantId, (durationByVariant.get(b.variantId) ?? 0) + seconds);
  }

  const variantsByProject = new Map<string, typeof variants>();
  const projectIdByVariant = new Map<string, string>();
  for (const v of variants) {
    const list = variantsByProject.get(v.projectId) ?? [];
    list.push(v);
    variantsByProject.set(v.projectId, list);
    projectIdByVariant.set(v.id, v.projectId);
  }

  // Task 1 (SP 014) — inserts « morts » ou « interdits » par projet, en UNE requête groupée. Les
  // inserts pendent des beats, qui pendent des variantes (aucune colonne projectId directe sur
  // beat_inserts) : on remonte donc la chaîne variante→beat→insert déjà construite ci-dessus plutôt
  // que d'interroger par variante — même motif anti-N+1 que unreviewedByProject plus bas.
  const projectIdByBeat = new Map<string, string>();
  for (const b of beats) {
    const projectId = projectIdByVariant.get(b.variantId);
    if (projectId) projectIdByBeat.set(b.id, projectId);
  }
  const beatIds = beats.map((b) => b.id);
  const deadInsertRows = beatIds.length > 0
    ? await db.select({ beatId: beatInserts.beatId }).from(beatInserts)
      .where(and(
        inArray(beatInserts.beatId, beatIds),
        inArray(beatInserts.linkStatus, ["mort", "interdit"]),
      ))
    : [];
  const deadLinkCountByProject = new Map<string, number>();
  for (const r of deadInsertRows) {
    const projectId = projectIdByBeat.get(r.beatId);
    if (!projectId) continue;
    deadLinkCountByProject.set(projectId, (deadLinkCountByProject.get(projectId) ?? 0) + 1);
  }

  // Intervenants sans consentement, par projet — interview_speakers porte déjà project_id, donc pas
  // besoin de remonter de chaîne : une seule requête groupée sur inArray(projectIds).
  const missingConsentRows = await db.select({ projectId: interviewSpeakers.projectId })
    .from(interviewSpeakers)
    .where(and(
      inArray(interviewSpeakers.projectId, projectIds),
      eq(interviewSpeakers.consentGiven, false),
    ));
  const missingConsentByProject = new Map<string, number>();
  for (const r of missingConsentRows) {
    missingConsentByProject.set(r.projectId, (missingConsentByProject.get(r.projectId) ?? 0) + 1);
  }

  // Compteur « non relue » par projet, en UNE requête groupée plutôt qu'un `unreviewedAgentWrites`
  // par ligne (même motif que `durationByVariant` ci-dessus) : un N+1 sur une liste de projets
  // ferait autant d'aller-retours DB que de projets affichés.
  const unreviewedRows = await db.select({ projectId: scriptJournal.projectId }).from(scriptJournal)
    .where(and(
      inArray(scriptJournal.projectId, projectIds),
      eq(scriptJournal.source, "mcp"),
      isNull(scriptJournal.reviewedAt),
    ));
  const unreviewedByProject = new Map<string, number>();
  for (const r of unreviewedRows) {
    unreviewedByProject.set(r.projectId, (unreviewedByProject.get(r.projectId) ?? 0) + 1);
  }

  return projects.map((p) => {
    const vs = variantsByProject.get(p.id) ?? [];
    // Durée ET cible décrivent la MÊME variante — celle de tête. Voir VideoProjectListRow.
    const head = pickHeadVariant(vs);
    const estimatedSec = head ? (durationByVariant.get(head.id) ?? 0) : 0;
    return {
      id: p.id, title: p.title, status: p.status, platforms: vs.map((v) => v.platform),
      estimatedSec, articleTitle: p.articleTitle, updatedAt: p.updatedAt,
      unreviewedCount: unreviewedByProject.get(p.id) ?? 0,
      targetSec: head?.targetDurationSec ?? null,
      deadLinkCount: deadLinkCountByProject.get(p.id) ?? 0,
      missingConsentCount: missingConsentByProject.get(p.id) ?? 0,
    };
  });
}

// Version à UN SEUL projet du compteur ci-dessus — consommée par les tests (tests/mcp-review-marker.
// test.ts) et par tout futur appelant qui n'a besoin que d'un projet à la fois plutôt que de la
// liste entière. `listVideoProjects` ne l'appelle PAS en boucle : elle calcule le même total en lot
// pour éviter le N+1 documenté au-dessus.
export async function unreviewedAgentWrites(projectId: string): Promise<number> {
  const rows = await db.select({ id: scriptJournal.id }).from(scriptJournal)
    .where(and(
      eq(scriptJournal.projectId, projectId),
      eq(scriptJournal.source, "mcp"),
      isNull(scriptJournal.reviewedAt),
    ));
  return rows.length;
}

// Beats + inserts d'une variante, dans l'ordre de montage — consommée par l'écran d'écriture
// (Task 11+).
export async function getVariantBeats(variantId: string) {
  const beats = await db.select().from(scriptBeats)
    .where(eq(scriptBeats.variantId, variantId))
    .orderBy(asc(scriptBeats.position));
  if (beats.length === 0) return [];

  const beatIds = beats.map((b) => b.id);
  const inserts = await db.select().from(beatInserts)
    .where(inArray(beatInserts.beatId, beatIds))
    .orderBy(asc(beatInserts.position));

  const insertsByBeat = new Map<string, typeof inserts>();
  for (const ins of inserts) {
    const list = insertsByBeat.get(ins.beatId) ?? [];
    list.push(ins);
    insertsByBeat.set(ins.beatId, list);
  }

  return beats.map((b) => ({ ...b, inserts: insertsByBeat.get(b.id) ?? [] }));
}

// Projet complet : variantes, beats + inserts par variante, et historique du journal d'import (le
// plus récent en premier) — consommée par l'écran de projet (Task 11+).
export async function getVideoProject(id: string) {
  const [project] = await db.select().from(videoProjects).where(eq(videoProjects.id, id));
  if (!project) return null;

  const variants = await db.select().from(scriptVariants)
    .where(eq(scriptVariants.projectId, id))
    .orderBy(asc(scriptVariants.position));
  const variantIds = variants.map((v) => v.id);

  const beats = variantIds.length > 0
    ? await db.select().from(scriptBeats).where(inArray(scriptBeats.variantId, variantIds)).orderBy(asc(scriptBeats.position))
    : [];
  const beatIds = beats.map((b) => b.id);
  const inserts = beatIds.length > 0
    ? await db.select().from(beatInserts).where(inArray(beatInserts.beatId, beatIds)).orderBy(asc(beatInserts.position))
    : [];

  const insertsByBeat = new Map<string, typeof inserts>();
  for (const ins of inserts) {
    const list = insertsByBeat.get(ins.beatId) ?? [];
    list.push(ins);
    insertsByBeat.set(ins.beatId, list);
  }

  const beatsByVariant = new Map<string, (typeof beats[number] & { inserts: typeof inserts })[]>();
  for (const b of beats) {
    const list = beatsByVariant.get(b.variantId) ?? [];
    list.push({ ...b, inserts: insertsByBeat.get(b.id) ?? [] });
    beatsByVariant.set(b.variantId, list);
  }

  const journal = await db.select().from(scriptJournal)
    .where(eq(scriptJournal.projectId, id))
    .orderBy(desc(scriptJournal.createdAt));

  return {
    ...project,
    variants: variants.map((v) => ({ ...v, beats: beatsByVariant.get(v.id) ?? [] })),
    journal,
  };
}

export type VideoProjectDetail = NonNullable<Awaited<ReturnType<typeof getVideoProject>>>;

export type SpeakerRow = {
  id: string; name: string; role: string | null;
  consentGiven: boolean; consentNote: string | null; createdAt: Date;
};

// Intervenants d'un projet (mode interview, SP5), du plus ancien au plus récent — consommée par
// l'écran de gestion des intervenants et par le cœur d'écriture (lib/video/speakers-persist.ts).
export async function listSpeakers(projectId: string): Promise<SpeakerRow[]> {
  return db.select({
    id: interviewSpeakers.id, name: interviewSpeakers.name, role: interviewSpeakers.role,
    consentGiven: interviewSpeakers.consentGiven, consentNote: interviewSpeakers.consentNote,
    createdAt: interviewSpeakers.createdAt,
  }).from(interviewSpeakers).where(eq(interviewSpeakers.projectId, projectId))
    .orderBy(asc(interviewSpeakers.createdAt));
}
