import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db, articles, distributions } from "@/db";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { getVideoProject } from "@/lib/queries/video";
import { getVideoSettings } from "@/lib/queries/video-settings";
import { buildBrief, type BriefVars } from "@/lib/video/brief";
import { getWpConfig } from "@/lib/wp/config";
import { wpPostUrl } from "@/lib/wp/post-url";
import { PageHeader } from "@/components/shell/page-header";
import { PLATFORM_LABEL } from "@/components/video/project-list";
import { BriefPanel } from "@/components/video/brief-panel";
import { BeatList, type BeatView } from "@/components/video/beat-list";
import { ImportPanel } from "@/components/video/import-panel";
import { JournalHistory, type JournalEntryView } from "@/components/video/journal-history";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Issue } from "@/lib/video/import";

// Task 11 (Brief) + Task 12 (Écriture) + Task 13 (Importer) — les trois onglets de la page projet.
export default async function VideoProjectPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  // `tab`/`variant` en recherche plutôt qu'en état client : la page reste un Server Component pur
  // (comme Task 11 le voulait déjà) et le sélecteur de variante devient de simples liens plutôt
  // qu'un composant client dédié à cette seule fin.
  searchParams: Promise<{ tab?: string; variant?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await requireUser();
  requirePermission(user.role, "video", "read");

  const project = await getVideoProject(id);
  if (!project) notFound();

  const settings = await getVideoSettings();

  // Onglet Brief : la variante de tête (position la plus basse) fixe la plateforme, la durée
  // cible et le cadrage montrés au modèle — un projet naît avec une seule variante (Task 9), les
  // suivantes (dérivées, SP6) ne changent rien à cette lecture.
  const variant = project.variants[0] ?? null;

  // Onglet Écriture : la variante choisie par le sélecteur (`?variant=`), sinon la première.
  // `project.variants` ne compte aujourd'hui qu'un seul élément par projet (les variantes dérivées
  // arrivent au SP6) — le sélecteur n'a donc pas encore d'effet visible, mais la lecture est déjà
  // prête pour ce jour-là plutôt que de figer un seul `project.variants[0]`.
  const activeVariant = project.variants.find((v) => v.id === sp.variant) ?? project.variants[0] ?? null;
  const beats: BeatView[] = (activeVariant?.beats ?? []).map((b) => ({
    id: b.id,
    externalId: b.externalId,
    position: b.position,
    kind: b.kind,
    spokenText: b.spokenText,
    directionNote: b.directionNote,
    screenText: b.screenText,
    transitionIn: b.transitionIn,
    transitionOut: b.transitionOut,
    estimatedDurationSec: b.estimatedDurationSec,
    durationOverrideSec: b.durationOverrideSec,
    // `locallyEditedAt` non nul = modifié à la main depuis le dernier import (brief Task 12).
    locallyEdited: b.locallyEditedAt !== null,
    inserts: b.inserts.map((ins) => ({
      id: ins.id,
      kind: ins.kind,
      url: ins.url,
      tcIn: ins.tcIn,
      tcOut: ins.tcOut,
      displayDurationSec: ins.displayDurationSec,
      credit: ins.credit,
      linkStatus: ins.linkStatus,
    })),
    sources: b.sources,
  }));

  // Champs article : vides quand aucun article n'est lié (Task 11 brief) — même motif d'absence
  // « gracieuse » que lib/studio/bindings.ts#articleTokenValues pour {{article.url}} : l'URL
  // publique n'existe qu'après diffusion WordPress, jamais reconstruite autrement.
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
      const baseUrl = getWpConfig()?.baseUrl ?? null;
      articleUrl = wpPostUrl(baseUrl, dist?.externalId ?? null) ?? "";
    }
  }

  const vars: BriefVars = {
    titre: project.title,
    sujet: project.subject ?? "",
    plateforme: variant ? (PLATFORM_LABEL[variant.platform] ?? variant.platform) : "",
    duree_cible: variant?.targetDurationSec ? `${Math.round(variant.targetDurationSec / 60)} min` : "",
    ratio: variant?.aspectRatio ?? "",
    article_titre: articleTitre,
    article_url: articleUrl,
    article_extrait: articleExtrait,
  };

  const brief = buildBrief(settings.briefTemplate, vars);

  // Onglet Importer (Task 13) : l'historique du journal (le plus récent en premier, déjà trié par
  // getVideoProject) et l'état de la variante active au moment où la page a été rendue —
  // `variantUpdatedAt` part avec ImportPanel jusqu'à applyImport, pour que le garde de péremption
  // serveur (lib/video/persist.ts#applyImportCore) puisse détecter une édition survenue entre la
  // préparation du diff et son application.
  const journalEntries: JournalEntryView[] = project.journal.map((j) => ({
    id: j.id,
    createdAt: j.createdAt.toISOString(),
    source: j.source,
    outcome: j.outcome,
    errorReport: (j.errorReport ?? []) as Issue[],
    rawPayload: j.rawPayload,
    revertedAt: j.revertedAt ? j.revertedAt.toISOString() : null,
  }));

  return (
    <div className="space-y-6">
      <PageHeader title={project.title} description={project.subject ?? undefined} />
      <Tabs defaultValue={sp.tab === "importer" ? "importer" : sp.tab === "ecriture" ? "ecriture" : "brief"}>
        <TabsList>
          <TabsTrigger value="brief">Brief</TabsTrigger>
          <TabsTrigger value="ecriture">Écriture</TabsTrigger>
          <TabsTrigger value="importer">Importer</TabsTrigger>
        </TabsList>
        <TabsContent value="brief">
          <BriefPanel brief={brief.text} unknownVars={brief.unknown} />
        </TabsContent>
        <TabsContent value="ecriture">
          <div className="space-y-4">
            {project.variants.length > 1 && (
              <div className="flex flex-wrap gap-2">
                {project.variants.map((v) => (
                  <Link key={v.id} href={`/video/${id}?tab=ecriture&variant=${v.id}`}>
                    <Badge variant={v.id === activeVariant?.id ? "default" : "outline"}>
                      {PLATFORM_LABEL[v.platform] ?? v.platform}
                    </Badge>
                  </Link>
                ))}
              </div>
            )}
            {activeVariant ? (
              <BeatList beats={beats} targetDurationSec={activeVariant.targetDurationSec} variantId={activeVariant.id} />
            ) : (
              <p className="text-sm text-muted-foreground">Aucune variante pour ce projet.</p>
            )}
          </div>
        </TabsContent>
        <TabsContent value="importer">
          <div className="space-y-8">
            {activeVariant ? (
              <ImportPanel
                projectId={id}
                variantId={activeVariant.id}
                variantUpdatedAt={activeVariant.updatedAt.toISOString()}
              />
            ) : (
              <p className="text-sm text-muted-foreground">Aucune variante pour ce projet.</p>
            )}
            <div className="space-y-2">
              <h2 className="text-sm font-medium">Historique des imports</h2>
              <JournalHistory entries={journalEntries} />
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
