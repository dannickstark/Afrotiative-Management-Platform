import { asc, eq } from "drizzle-orm";
import { db, scriptVariants, videoProjects } from "@/db";
import { resolveShare } from "@/lib/montage/access";
import { readConducteurCore } from "@/lib/montage/persist";
import { ConducteurView } from "@/components/video/conducteur-view";

export default async function MontagePublicPage(
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const share = await resolveShare(token);
  if (!share.ok) {
    return <p className="text-sm text-muted-foreground">Lien invalide ou expiré.</p>;
  }
  const [project] = await db.select().from(videoProjects).where(eq(videoProjects.id, share.projectId));
  const [variant] = await db.select().from(scriptVariants)
    .where(eq(scriptVariants.projectId, share.projectId)).orderBy(asc(scriptVariants.position)).limit(1);
  if (!project || !variant) {
    return <p className="text-sm text-muted-foreground">Projet indisponible.</p>;
  }
  const read = await readConducteurCore(variant.id);
  return (
    <div className="space-y-4">
      <h1 className="font-serif text-2xl">{project.title}</h1>
      {read ? (
        <ConducteurView conducteur={read.conducteur} annotate={{ shareToken: token }} />
      ) : (
        <p>Aucun conducteur.</p>
      )}
    </div>
  );
}
