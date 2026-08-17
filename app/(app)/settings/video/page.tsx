import { requireUser } from "@/lib/session";
import { requirePermission } from "@/lib/rbac";
import { getVideoSettings } from "@/lib/queries/video-settings";
import { listVideoCategories } from "@/lib/queries/video-categories";
import { PageHeader } from "@/components/shell/page-header";
import { CategoryManager } from "@/components/video/category-manager";
import { VideoSettingsForm } from "@/components/video/video-settings-form";

export default async function Page() {
  const user = await requireUser();
  requirePermission(user.role, "video", "configure");
  const [settings, categories] = await Promise.all([getVideoSettings(), listVideoCategories()]);
  return (
    <div className="space-y-6">
      <PageHeader title="Vidéo" />
      <CategoryManager categories={categories} />
      <VideoSettingsForm settings={settings} />
    </div>
  );
}
