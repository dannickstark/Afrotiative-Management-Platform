import { asc, eq } from "drizzle-orm";
import { db, scriptVariants, videoProjects } from "@/db";
import { resolveShare } from "@/lib/montage/access";
import { readConducteurCore } from "@/lib/montage/persist";
import { ConducteurView } from "@/components/video/conducteur-view";

// Vue imprimable (Task 10) : même lecture que app/(public)/montage/[token]/page.tsx, mais sans
// aucun lien d'action (annotate absent → ConducteurView reste strictement en lecture seule) et
// avec une feuille @media print qui masque la barre d'actions "no-print" — l'utilisateur imprime
// cette page et choisit « Enregistrer en PDF » dans la boîte de dialogue du navigateur.
export default async function MontagePrintPage(
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
      <style>{`
        @media print {
          .no-print { display: none !important; }
          @page { margin: 1.5cm; }
        }
      `}</style>
      <div className="no-print flex items-center justify-between gap-2 rounded-lg border bg-muted/30 px-4 py-3 text-sm">
        <span className="text-muted-foreground">
          Imprimez cette page (Ctrl/Cmd+P) puis « Enregistrer en PDF ».
        </span>
      </div>
      <h1 className="font-serif text-2xl">{project.title}</h1>
      {read ? (
        <ConducteurView conducteur={read.conducteur} />
      ) : (
        <p>Aucun conducteur.</p>
      )}
    </div>
  );
}
