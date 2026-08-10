"use client";

import { CreateTemplateDialog, TemplatesTable } from "@/components/studio/templates-table";
import type { CategoryOption, TemplateRow } from "@/lib/queries/studio";

// components/studio/panels/modeles-panel.tsx — Tâche 2 (U1, spec §3) : le contenu de la catégorie
// « Modèles » du rail. Réutilise EXACTEMENT deux exports de templates-table.tsx — `CreateTemplateDialog`
// (action primaire « Nouveau gabarit vierge ») et `TemplatesTable` (les gabarits existants à dupliquer,
// groupés par contexte, spec §3) — plutôt que d'en réimplémenter une version étroite pour ce panneau.
// `showHeader={false}` masque uniquement le titre « Gabarits » + le second bouton de création que
// TemplatesTable affiche normalement en tête (redondant ici : ce panneau a déjà SA PROPRE instance de
// CreateTemplateDialog juste au-dessus, dans le rôle d'action primaire du skeleton commun de
// panel-host.tsx) — les sections groupées par contexte restent, elles, identiques dans les deux cas.
//
// PAS de <RoleGate> autour de ce déclencheur, contrairement à celui que TemplatesTable garde pour
// /studio (app/(app)/studio/page.tsx) : RoleGate lit useSession() (lib/auth-client.ts), qui n'a pas
// de session à lire sous `renderToStaticMarkup` (pas de Provider, pas de réseau) et masquerait donc
// le bouton même en test — voir tests/studio-templates-table.test.ts pour la vérification empirique.
// Ce n'est pas un relâchement de la sécurité réelle : createTemplate (lib/actions/studio-actions.ts)
// appelle requirePermission() côté serveur quoi qu'il arrive, et app/(app)/studio/[id]/page.tsx exige
// déjà template:read pour atteindre CETTE page — dans la matrice RBAC (lib/rbac.ts), aucun rôle n'a
// jamais template:read SANS template:manage, donc quiconque voit ce panneau a déjà le droit de créer.
export interface ModelesPanelProps {
  templates: TemplateRow[];
  categories: CategoryOption[];
}

export function ModelesPanel({ templates, categories }: ModelesPanelProps) {
  return (
    <div className="flex flex-col gap-3" data-testid="modeles-panel">
      <CreateTemplateDialog categories={categories} />
      <TemplatesTable templates={templates} categories={categories} showHeader={false} />
    </div>
  );
}
