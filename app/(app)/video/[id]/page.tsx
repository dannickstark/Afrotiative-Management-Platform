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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// Task 11 — page projet, premier onglet (Brief). Les Tasks 12/13 ajoutent les onglets Script et
// Importer dans ces mêmes <Tabs> ; ce fichier ne fait rien pour anticiper leur contenu, il se
// contente de laisser la place.
export default async function VideoProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  requirePermission(user.role, "video", "read");

  const project = await getVideoProject(id);
  if (!project) notFound();

  const settings = await getVideoSettings();

  // Onglet Brief : la variante de tête (position la plus basse) fixe la plateforme, la durée
  // cible et le cadrage montrés au modèle — un projet naît avec une seule variante (Task 9), les
  // suivantes (dérivées, SP6) ne changent rien à cette lecture.
  const variant = project.variants[0] ?? null;

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

  return (
    <div className="space-y-6">
      <PageHeader title={project.title} description={project.subject ?? undefined} />
      <Tabs defaultValue="brief">
        <TabsList>
          <TabsTrigger value="brief">Brief</TabsTrigger>
        </TabsList>
        <TabsContent value="brief">
          <BriefPanel brief={brief.text} unknownVars={brief.unknown} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
