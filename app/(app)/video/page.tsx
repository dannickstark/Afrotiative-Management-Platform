import { db, articles } from "@/db";
import { desc, inArray } from "drizzle-orm";
import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { listVideoProjects } from "@/lib/queries/video";
import { listVideoCategoryOptions } from "@/lib/queries/video-categories";
import { PageHeader } from "@/components/shell/page-header";
import { ProjectListFilters } from "@/components/video/project-list";
import { NewProjectDialog } from "@/components/video/new-project-dialog";

// Task 10 — écran de liste des projets vidéo. "read" pour l'affichage : "manage" reste réservé aux
// actions d'écriture (création, montage), "configure" aux réglages du module (/settings/video).
export default async function VideoPage() {
  const user = await requireUser();
  requirePermission(user.role, "video", "read");

  const [projects, sourceArticles, categories] = await Promise.all([
    listVideoProjects(),
    db.select({ id: articles.id, title: articles.title }).from(articles)
      .where(inArray(articles.status, ["approved", "published"]))
      .orderBy(desc(articles.updatedAt))
      .limit(200),
    listVideoCategoryOptions(),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Vidéo"
        description="Scripts, briefs et montage des projets vidéo."
        actions={<NewProjectDialog articles={sourceArticles} categories={categories} />}
      />
      <ProjectListFilters projects={projects} />
    </div>
  );
}
