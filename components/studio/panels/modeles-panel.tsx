"use client";

import { RoleGate } from "@/components/role-gate";
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
// <RoleGate allow={["admin", "editor"]}> — SYMÉTRIQUE avec le même déclencheur dans
// templates-table.tsx (celui de /studio). Revue Tâche 2, Important 2 : la version précédente
// omettait ce garde en argumentant que le RBAC serveur (createTemplate → requirePermission(),
// lib/actions/studio-actions.ts) et le garde de page (template:read, app/(app)/studio/[id]/page.tsx)
// rendaient déjà toute tentative sans droit inopérante — vrai AUJOURD'HUI (lib/rbac.ts +
// tests/studio-rbac.test.ts prouvent qu'aucun rôle n'a jamais template:read sans template:manage),
// mais cette preuve ne vit dans AUCUN fichier que ce composant référence : si la matrice RBAC
// changeait un jour, ce panneau divergerait silencieusement de son frère sans le moindre signal de
// compilation ou de lint. Le wrap coûte peu et rétablit la symétrie plutôt que de reposer sur un
// invariant externe non tracé ici.
export interface ModelesPanelProps {
  templates: TemplateRow[];
  categories: CategoryOption[];
}

export function ModelesPanel({ templates, categories }: ModelesPanelProps) {
  return (
    <div className="flex flex-col gap-3" data-testid="modeles-panel">
      <RoleGate allow={["admin", "editor"]}>
        <CreateTemplateDialog categories={categories} />
      </RoleGate>
      <TemplatesTable templates={templates} categories={categories} showHeader={false} />
    </div>
  );
}
