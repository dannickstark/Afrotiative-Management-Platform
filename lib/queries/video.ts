import { db, videoProjects, scriptVariants, scriptBeats, beatInserts, scriptJournal, articles } from "@/db";
import { asc, desc, eq, inArray } from "drizzle-orm";

// Lectures pour les écrans du module vidéo. Aucune écriture ici — le cœur d'écriture vit dans
// lib/video/persist.ts.

export type VideoProjectListRow = {
  id: string;
  title: string;
  status: string;
  platforms: string[];
  estimatedSec: number;
  articleTitle: string | null;
  updatedAt: Date;
};

// Liste des projets avec la durée cumulée (toutes variantes confondues) — consommée par l'écran
// /video (Task 10).
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
      variantId: scriptBeats.variantId, estimatedDurationSec: scriptBeats.estimatedDurationSec,
    }).from(scriptBeats).where(inArray(scriptBeats.variantId, variantIds))
    : [];

  const durationByVariant = new Map<string, number>();
  for (const b of beats) {
    durationByVariant.set(b.variantId, (durationByVariant.get(b.variantId) ?? 0) + b.estimatedDurationSec);
  }

  const variantsByProject = new Map<string, typeof variants>();
  for (const v of variants) {
    const list = variantsByProject.get(v.projectId) ?? [];
    list.push(v);
    variantsByProject.set(v.projectId, list);
  }

  return projects.map((p) => {
    const vs = variantsByProject.get(p.id) ?? [];
    const estimatedSec = vs.reduce((sum, v) => sum + (durationByVariant.get(v.id) ?? 0), 0);
    return {
      id: p.id, title: p.title, status: p.status, platforms: vs.map((v) => v.platform),
      estimatedSec, articleTitle: p.articleTitle, updatedAt: p.updatedAt,
    };
  });
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
