"use client";
// components/studio/templates-gallery.tsx — Chantier A, Tâche 5 (spec §4) : la galerie de
// VIGNETTES RENDUES qui remplace le tableau-texte comme vue PAR DÉFAUT de /studio (coque admin —
// PAS l'éditeur, voir templates-table.tsx qui l'héberge). Une carte par gabarit, groupées par
// contexte dans le MÊME ordre que la vue tableau (groupTemplatesByContext, templates-table.tsx —
// réutilisée, jamais recopiée), chacune portant : une vignette rendue paresseusement (GalleryThumb
// ci-dessous), le nom, un badge de format, l'état (StateBadge), et le MÊME menu d'actions que la
// ligne de tableau (TemplateRowMenu — réutilisé lui aussi).
//
// Vignette PARESSEUSE — même recette que FilmstripThumb (components/studio/render-mode.tsx) :
// IntersectionObserver, `.disconnect()` dès la première apparition, `rootMargin: "200px"` pour
// amorcer un peu avant l'entrée réelle dans le viewport. Contrairement au filmstrip (qui appelle
// previewTemplate, sans cache — voir son commentaire d'en-tête sur le coût des rendus), CETTE
// vignette appelle renderTemplateThumbnail (lib/actions/studio-thumbnail-actions.ts), qui EST
// mise en cache process (lib/studio/thumbnail-core.ts) — une carte déjà rendue une fois (scène
// inchangée) ne redéclenche donc pas satori/resvg/sharp à chaque montage/démontage (ex. un
// changement de bascule grille→tableau→grille, ou une nouvelle navigation vers /studio).
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { FORMAT_PRESETS, type FormatKey } from "@/lib/studio/formats";
import { renderTemplateThumbnail } from "@/lib/actions/studio-thumbnail-actions";
import type { TemplateRow } from "@/lib/queries/studio";
import {
  CONTEXT_LABEL, StateBadge, TemplateRowMenu, dateFormatter, formatLabel, groupTemplatesByContext,
} from "@/components/studio/templates-shared";

type ThumbState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; dataUri: string }
  | { status: "error" };

// EXPORTÉ pour un test direct (tests/studio-templates-gallery.test.ts) sans avoir à monter toute la
// galerie — même motif que sceneForFormat (render-mode.tsx), une petite fonction pure au milieu
// d'un fichier client par ailleurs plein d'effets.
function GalleryThumb({ templateId, format, name }: { templateId: string; format: FormatKey; name: string }) {
  const preset = FORMAT_PRESETS[format];
  const [state, setState] = useState<ThumbState>({ status: "idle" });
  const elRef = useRef<HTMLDivElement>(null);

  // IntersectionObserver — voir le commentaire d'en-tête pour pourquoi (même correctif que
  // FilmstripThumb : ne PAS rendre les cartes hors champ d'une galerie potentiellement longue).
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = elRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setVisible(true); // repli : pas d'IntersectionObserver (jamais le cas en navigateur réel) -> rendu immédiat.
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setState({ status: "loading" });
    renderTemplateThumbnail(templateId)
      .then((res) => {
        if (cancelled) return;
        setState(res.ok ? { status: "ready", dataUri: res.dataUri } : { status: "error" });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [templateId, visible]);

  return (
    <div
      ref={elRef}
      data-testid="gallery-thumb"
      data-template-id={templateId}
      className="flex items-center justify-center overflow-hidden rounded-md bg-muted/30"
      style={{ aspectRatio: `${preset.width} / ${preset.height}` }}
    >
      {state.status === "ready" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={state.dataUri} alt={`Aperçu — ${name}`} className="h-full w-full object-contain" />
      )}
      {state.status === "loading" && <span className="text-[11px] text-muted-foreground">…</span>}
      {state.status === "error" && <span className="text-[11px] text-destructive">Échec</span>}
      {state.status === "idle" && <span className="text-[11px] text-muted-foreground">En attente…</span>}
    </div>
  );
}

// Le bouton d'actions est un FRÈRE du lien, pas un ENFANT — un <button> (le déclencheur du menu,
// via DropdownMenuTrigger) imbriqué dans un <a> (Link) serait un élément interactif dans un élément
// interactif, invalide en HTML et ambigu au clavier/lecteur d'écran (quel élément le focus/l'Entrée
// activent-ils ?). Positionné en absolu dans le coin, au-dessus du lien qui couvre le reste de la
// carte — même schéma que la plupart des galeries de cartes cliquables (le titre/la vignette mènent
// à la page, un bouton dédié ouvre les actions).
function TemplateCard({
  row, isPending, onDuplicate, onArchiveToggle, onRequestRename,
}: {
  row: TemplateRow;
  isPending: boolean;
  onDuplicate: (row: TemplateRow) => void;
  onArchiveToggle: (row: TemplateRow) => void;
  onRequestRename: (row: TemplateRow) => void;
}) {
  return (
    <div
      className="group relative rounded-lg border p-2 transition-colors hover:border-primary"
      data-testid="template-card"
      data-template-id={row.id}
    >
      <div className="absolute right-2 top-2 z-10">
        <TemplateRowMenu
          row={row} isPending={isPending}
          onDuplicate={onDuplicate} onArchiveToggle={onArchiveToggle} onRequestRename={onRequestRename}
        />
      </div>
      <Link href={`/studio/${row.id}`} className="flex flex-col gap-2">
        <GalleryThumb templateId={row.id} format={row.format} name={row.name} />
        <div className="space-y-1">
          <p className="truncate text-sm font-medium" title={row.name}>{row.name}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="text-[10px] font-normal">{formatLabel(row)}</Badge>
            <StateBadge row={row} />
          </div>
          <p className="text-[10px] text-muted-foreground">Modifié le {dateFormatter.format(row.updatedAt)}</p>
        </div>
      </Link>
    </div>
  );
}

export interface TemplatesGalleryProps {
  templates: TemplateRow[];
  isPending: boolean;
  onDuplicate: (row: TemplateRow) => void;
  onArchiveToggle: (row: TemplateRow) => void;
  onRequestRename: (row: TemplateRow) => void;
}

// Groupée par contexte (spec §4 : « Grouped by context as today ») — groupTemplatesByContext est LA
// MÊME fonction que la vue tableau utilise (templates-table.tsx), donc l'ordre et l'ensemble des
// groupes visibles sont garantis identiques entre les deux vues, jamais deux règles qui pourraient
// diverger. L'état vide (« aucun gabarit ») reste géré par l'APPELANT (templates-table.tsx, qui
// affiche déjà sa propre Card vide AVANT de choisir entre galerie et tableau) : ce composant ne
// rend donc jamais rien de spécial pour une liste vide, un `groups` vide produit simplement un
// conteneur sans enfants.
export function TemplatesGallery({
  templates, isPending, onDuplicate, onArchiveToggle, onRequestRename,
}: TemplatesGalleryProps) {
  const groups = groupTemplatesByContext(templates);

  return (
    <div className="space-y-6" data-testid="templates-gallery">
      {groups.map((group) => (
        <section key={group.context} className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground">{CONTEXT_LABEL[group.context]}</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
            {group.rows.map((row) => (
              <TemplateCard
                key={row.id} row={row} isPending={isPending}
                onDuplicate={onDuplicate} onArchiveToggle={onArchiveToggle} onRequestRename={onRequestRename}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
