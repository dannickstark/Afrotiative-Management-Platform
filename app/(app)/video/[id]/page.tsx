import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { requirePermission, can } from "@/lib/rbac";
import { briefVarsFor, getVideoProject, listSpeakers } from "@/lib/queries/video";
import { getVideoSettings } from "@/lib/queries/video-settings";
import { buildBrief, type BriefVars } from "@/lib/video/brief";
import { hasBeforeState, markProjectReviewedCore } from "@/lib/video/persist";
import { ProjectHeader } from "@/components/video/project-header";
import { BriefPanel } from "@/components/video/brief-panel";
import { ProjectCategorySelect } from "@/components/video/project-category-select";
import { getBriefCategory, listVideoCategoryOptions } from "@/lib/queries/video-categories";
import { BeatList, type BeatView } from "@/components/video/beat-list";
import { VerifyAllLinks } from "@/components/video/verify-all-links";
import { ImportPanel } from "@/components/video/import-panel";
import { JournalHistory, type JournalEntryView } from "@/components/video/journal-history";
import { ConducteurView } from "@/components/video/conducteur-view";
import { TournageView } from "@/components/video/tournage-view";
import { readConducteurCore } from "@/lib/montage/persist";
import { readTournageCore } from "@/lib/video/takes-core";
import { listSharesCore } from "@/lib/montage/access";
import { MontageShareDialog } from "@/components/video/montage-share-dialog";
import { MontageExportBar } from "@/components/video/montage-export-bar";
import { SpeakersManager } from "@/components/video/speakers-manager";
import { VariantManager } from "@/components/video/variant-manager";
import { AspectRatioGuide } from "@/components/video/aspect-ratio-guide";
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

  // Task 8 : ouvrir ce projet marque « relues » toutes les écritures d'agent (source "mcp")
  // encore non relues. Volontairement APRÈS le chargement de `project` ci-dessus (le brief
  // l'exige) : `journalEntries` plus bas est construit à partir de CET instantané, donc les
  // badges « Non relue » rendus pendant CETTE visite reflètent encore fidèlement l'état
  // d'avant-marquage — c'est précisément la visite où l'humain doit les voir. La promesse n'est
  // PAS awaited : un marquage lent ou en échec ne doit ni retarder ni faire échouer le rendu de
  // la page (comportement imposé, brief Task 8) ; une écriture d'agent qui arrive après ce point
  // reste "non relue" pour la prochaine ouverture, comme voulu.
  markProjectReviewedCore(id, user.id).catch((e) => {
    console.error("Marquage « relue » du projet a échoué :", e);
  });

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

  // Onglet Montage (Task 4, SP2) : la projection en lecture seule du conducteur pour la variante
  // active — même `readConducteurCore` que celui écrit Task 3, qui recalcule tout depuis la DB
  // (aucun état dérivé stocké).
  const conducteur = activeVariant ? (await readConducteurCore(activeVariant.id))?.conducteur ?? null : null;

  // Onglet Tournage (Task 5, SP4) : le journal de prises + prompteur pour la variante active —
  // même lecture recalculée-depuis-la-DB que readConducteurCore ci-dessus.
  const tournage = activeVariant ? await readTournageCore(activeVariant.id) : null;

  // Panneau « Accès monteur » (Task 7) : les liens de partage existants pour CE projet — chargés
  // inconditionnellement, la garde `video:manage` ne s'applique qu'au rendu du panneau ci-dessous
  // (même motif que les jetons MCP de /settings/mcp).
  const shares = await listSharesCore(project.id);

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
      rightsNote: ins.rightsNote,
      r2Key: ins.r2Key,
      linkCheckedAt: ins.linkCheckedAt,
    })),
    sources: b.sources,
    speakerId: b.speakerId,
    answersBeatId: b.answersBeatId,
  }));

  // Les variables du brief viennent de `briefVarsFor` (lib/queries/video.ts) — LA même fonction que
  // celle qu'appelle l'outil MCP (round de correction 1, Task 5 du SP1 bis). Construites ici ligne à
  // ligne, elles auraient divergé de celles remises à l'agent dès la première retouche.
  const vars: BriefVars = await briefVarsFor(project, variant ?? null);

  // La catégorie du projet — mêmes instructions que celles remises à l'agent MCP, parce que les deux
  // chemins passent par getBriefCategory + buildBrief.
  const [briefCategory, categoryOptions, speakers] = await Promise.all([
    getBriefCategory(project.categoryId),
    listVideoCategoryOptions(),
    listSpeakers(project.id),
  ]);

  const brief = buildBrief(settings.briefTemplate, vars, briefCategory);

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
    reviewedAt: j.reviewedAt ? j.reviewedAt.toISOString() : null,
    // Round de correction final, I3 : le MÊME prédicat que la garde serveur
    // (lib/video/persist.ts#hasBeforeState), pas une seconde lecture du jsonb écrite ici — sinon
    // l'écran et le serveur pourraient un jour ne plus s'accorder sur ce qui est annulable.
    revertable: hasBeforeState(j.applied),
  }));

  // Reprise par le sélecteur de variante du bandeau (ProjectHeader) : un lien `?variant=` doit
  // garder l'utilisateur sur l'onglet qu'il regardait plutôt que de le renvoyer sur Brief — même
  // valeur que celle qui pilote `defaultValue` de `<Tabs>` juste en dessous.
  const currentTab = sp.tab === "intervenants" ? "intervenants" : sp.tab === "tournage" ? "tournage" : sp.tab === "montage" ? "montage" : sp.tab === "importer" ? "importer" : sp.tab === "ecriture" ? "ecriture" : "brief";

  return (
    <div className="space-y-6">
      <ProjectHeader
        projectId={project.id}
        title={project.title}
        subject={project.subject}
        status={project.status}
        variants={project.variants.map((v) => ({
          id: v.id,
          platform: v.platform,
          aspectRatio: v.aspectRatio,
          targetDurationSec: v.targetDurationSec,
          beats: v.beats.map((b) => ({
            durationOverrideSec: b.durationOverrideSec,
            estimatedDurationSec: b.estimatedDurationSec,
            inserts: b.inserts.map((ins) => ({ linkStatus: ins.linkStatus })),
          })),
        }))}
        activeVariantId={activeVariant?.id ?? null}
        currentTab={currentTab}
        journal={project.journal.map((j) => ({ source: j.source, reviewedAt: j.reviewedAt ? j.reviewedAt.toISOString() : null }))}
        speakers={speakers.map((s) => ({ id: s.id, name: s.name, consentGiven: s.consentGiven }))}
        canManage={can(user.role, "video", "manage")}
      />
      <Tabs defaultValue={currentTab}>
        <TabsList>
          <TabsTrigger value="brief">Brief</TabsTrigger>
          <TabsTrigger value="ecriture">Écriture</TabsTrigger>
          <TabsTrigger value="importer">Importer</TabsTrigger>
          <TabsTrigger value="montage">Montage</TabsTrigger>
          <TabsTrigger value="tournage">Tournage</TabsTrigger>
          <TabsTrigger value="intervenants">Intervenants</TabsTrigger>
        </TabsList>
        <TabsContent value="brief">
          <div className="space-y-4">
            <ProjectCategorySelect
              projectId={project.id}
              categoryId={project.categoryId}
              categories={categoryOptions}
            />
            <BriefPanel brief={brief.text} unknownVars={brief.unknown} />
          </div>
        </TabsContent>
        <TabsContent value="ecriture">
          <div className="space-y-4">
            <div className="flex justify-end">
              <VerifyAllLinks projectId={project.id} />
            </div>
            <VariantManager
              projectId={project.id}
              variants={project.variants.map((v) => ({
                id: v.id, platform: v.platform, aspectRatio: v.aspectRatio,
                derivedFromId: v.derivedFromId, position: v.position,
              }))}
              activeVariantId={activeVariant?.id ?? null}
            />
            {activeVariant && <AspectRatioGuide ratio={activeVariant.aspectRatio} />}
            {activeVariant ? (
              <BeatList
                beats={beats}
                variantId={activeVariant.id}
                speakers={speakers.map((s) => ({ id: s.id, name: s.name }))}
              />
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
        <TabsContent value="montage">
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>{activeVariant && <MontageExportBar variantId={activeVariant.id} />}</div>
              {can(user.role, "video", "manage") && (
                <MontageShareDialog projectId={project.id} shares={shares} canManage />
              )}
            </div>
            {conducteur ? (
              <ConducteurView
                conducteur={conducteur}
                annotate={can(user.role, "video", "annotate") ? { projectId: project.id } : undefined}
              />
            ) : (
              <p className="text-sm text-muted-foreground">Aucune variante.</p>
            )}
          </div>
        </TabsContent>
        <TabsContent value="tournage">
          {tournage ? (
            <TournageView beats={tournage.beats} aspectRatio={activeVariant?.aspectRatio ?? "16:9"} />
          ) : (
            <p className="text-sm text-muted-foreground">Aucune variante.</p>
          )}
        </TabsContent>
        <TabsContent value="intervenants">
          <SpeakersManager projectId={project.id} speakers={speakers} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
