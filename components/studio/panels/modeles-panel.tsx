"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { RoleGate } from "@/components/role-gate";
import { PanelHost } from "@/components/studio/panel-host";
import { CreateTemplateDialog, TemplatesTable } from "@/components/studio/templates-table";
import type { CategoryOption, TemplateRow } from "@/lib/queries/studio";
import type { RailCategory } from "@/lib/studio/editor-prefs";

// components/studio/panels/modeles-panel.tsx — Tâche 2 (U1, spec §3) : le contenu de la catégorie
// « Modèles » du rail. Réutilise EXACTEMENT deux exports de templates-table.tsx — `CreateTemplateDialog`
// (action primaire « Nouveau gabarit vierge ») et `TemplatesTable` (les gabarits existants à dupliquer,
// groupés par contexte, spec §3) — plutôt que d'en réimplémenter une version étroite pour ce panneau.
// `showHeader={false}` masque uniquement le titre « Gabarits » + le second bouton de création que
// TemplatesTable affiche normalement en tête (redondant ici : ce panneau a déjà SA PROPRE instance de
// CreateTemplateDialog, désormais dans le slot `primaryAction` du skeleton commun de panel-host.tsx —
// voir son commentaire d'en-tête, Correctif revue finale, pour la répartition des deux slots entre
// panneaux) — les sections groupées par contexte restent, elles, identiques dans les deux cas.
//
// Correctif revue finale — Important 2 : ce panneau enrobe désormais LUI-MÊME `<PanelHost>` (il ne
// se contente plus d'être un simple `children` enrobé par editor-shell.tsx) — c'est ce qui lui
// permet de peupler `primaryAction` ET `search`, les deux slots que la revue a trouvés morts. La
// recherche filtre CÔTÉ CLIENT sur `templates`, déjà reçu en prop (aucune requête réseau ici) — voir
// `filterTemplatesBySearch` ci-dessous, exportée pure pour un test direct.
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
  onOpenChange?: (next: RailCategory | null) => void;
}

// PURE — exportée pour un test direct sans rendu (même discipline que imageSlotsFor,
// components/studio/panels/images-panel.tsx). Insensible à la casse, espaces de bord ignorés ; une
// requête vide renvoie la liste complète (une copie, pour ne jamais renvoyer la RÉFÉRENCE reçue en
// entrée — un appelant qui la muterait ne toucherait donc jamais `templates`).
export function filterTemplatesBySearch(templates: readonly TemplateRow[], query: string): TemplateRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...templates];
  return templates.filter((t) => t.name.toLowerCase().includes(q));
}

export function ModelesPanel({ templates, categories, onOpenChange = () => {} }: ModelesPanelProps) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => filterTemplatesBySearch(templates, query), [templates, query]);

  return (
    <PanelHost
      open="modeles"
      onOpenChange={onOpenChange}
      search={
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher un gabarit…"
            className="pl-7"
            data-testid="modeles-search"
          />
        </div>
      }
      primaryAction={
        <RoleGate allow={["admin", "editor"]}>
          <CreateTemplateDialog categories={categories} />
        </RoleGate>
      }
    >
      <div className="flex flex-col gap-3" data-testid="modeles-panel">
        <TemplatesTable templates={filtered} categories={categories} showHeader={false} />
      </div>
    </PanelHost>
  );
}
